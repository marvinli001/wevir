// 左栏的工作区与会话列表（T5.3 起实时）与 Provider 列表（T5.4）：连上 Host 时读 workspace.list、session.list 与
// provider.list，再给每个会话订阅一条
// 从它当前 lastSeq 开始的事件流，按事件跟上状态、标题与最近活动（client-sdk 的 applySessionEvent），所以另一个
// 客户端发起的回合、审批也会立即显示。别的客户端建、删、改名、归档的会话：Host 有 `session_list_push`（0.101.0）时经
// `sessions.changed` 到达，版本不连续就重读；没有时靠定时与窗口获得焦点时重读列表发现。事件按帧合并后再通知界面。

import {
  applySessionEvent,
  type EventSubscription,
  isRpcError,
  type SessionsChange,
  type WevirClient,
} from '@wevir/client-sdk';
import type { ProviderProfile, Session, SessionId, WevirEvent, Workspace } from '@wevir/protocol';
import { describe } from '@/host/host-connection';
import { frameBatcher } from '@/lib/frame';
import { recordBaselines } from './seen-sessions';
import {
  applySessionsChange,
  groupSessions,
  mergeSessions,
  type WorkbenchData,
} from './workbench-model';

/** 重读会话列表的间隔：只为发现别的客户端新建的会话，已知会话的变化走事件订阅。 */
export const LIST_REFRESH_MS = 10_000;

/** Host 推送会话列表的变化（`session_list_push`）时，定时重读只是兜底。 */
export const LIST_FALLBACK_REFRESH_MS = 60_000;

/** 列表里的会话收到一条事件（U31 的通知）：`session` 是应用这条事件之后的会话。 */
export type SessionEventListener = (event: WevirEvent, session: Session) => void;

export class WorkbenchStore {
  readonly #client: WevirClient;
  #workspaces: Workspace[] | undefined;
  #providers: ProviderProfile[] = [];
  #sessions = new Map<SessionId, Session>();
  #error: string | undefined;
  #data: WorkbenchData = { status: 'loading' };
  readonly #subscriptions = new Map<SessionId, EventSubscription>();
  readonly #pending: WevirEvent[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #eventListeners = new Set<SessionEventListener>();
  readonly #batch = frameBatcher(() => this.#flush());
  #refreshing: Promise<void> | undefined;
  #rerun: Promise<void> | undefined;
  /** 最近一次列表结果或推送的版本；旧 Host 没有。 */
  #listVersion: number | undefined;
  readonly #unlistenSessions: () => void;
  #disposed = false;

  constructor(client: WevirClient) {
    this.#client = client;
    this.#unlistenSessions = client.onSessionsChanged((change) => this.#onSessionsChanged(change));
  }

  get = (): WorkbenchData => this.#data;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * 重读工作区、会话与 Provider 列表；同时只跑一次。读失败时保留已有数据，没有数据才显示错误。正在读的那次
   * 可能早于调用方刚做的修改（设置页添加工作区、保存 Provider 之后），所以这时等它结束再读一次，并发的调用方
   * 共用这一次；返回的 Promise 结束时，数据不早于调用的时刻。
   */
  refresh(): Promise<void> {
    if (this.#refreshing) {
      this.#rerun ??= this.#refreshing.then(() => {
        this.#rerun = undefined;
        return this.refresh();
      });
      return this.#rerun;
    }
    this.#refreshing = this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  /** 订阅列表里会话的新事件（订阅从会话当时的 lastSeq 开始，不含历史）；返回取消订阅的函数。 */
  onSessionEvent = (listener: SessionEventListener): (() => void) => {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  };

  /** 本端刚建好的会话（session.create 的结果）立即放进列表，不等下一次重读。 */
  upsertSession(session: Session): void {
    const current = this.#sessions.get(session.id);
    if (current && current.lastSeq >= session.lastSeq) return;
    this.#sessions.set(session.id, session);
    this.#follow(session);
    this.#publish();
  }

  dispose(): void {
    this.#disposed = true;
    this.#unlistenSessions();
    this.#batch.cancel();
    for (const subscription of this.#subscriptions.values()) subscription.close();
    this.#subscriptions.clear();
    this.#listeners.clear();
    this.#eventListeners.clear();
  }

  async #refresh(): Promise<void> {
    try {
      const [{ workspaces }, { sessions, listVersion }, { providers }] = await Promise.all([
        this.#client.request('workspace.list'),
        this.#client.request('session.list'),
        // 远程设备可能没有 `provider.read`：不列 Provider，其余照常。
        this.#client.can('provider.read')
          ? this.#client.request('provider.list')
          : Promise.resolve({ providers: [] }),
      ]);
      if (this.#disposed) return;
      recordBaselines(sessions);
      this.#workspaces = workspaces;
      this.#providers = providers;
      this.#sessions = mergeSessions(this.#sessions, sessions);
      this.#listVersion = listVersion;
      this.#error = undefined;
      for (const [id, subscription] of this.#subscriptions) {
        if (this.#sessions.has(id)) continue;
        subscription.close();
        this.#subscriptions.delete(id);
      }
      for (const session of this.#sessions.values()) this.#follow(session);
      this.#publish();
    } catch (error) {
      if (this.#disposed) return;
      this.#error = describe(error);
      this.#publish();
    }
  }

  /**
   * `sessions.changed`（0.101.0）：版本紧接着上一次就照它增删，否则（漏了、Host 重启、正在重读）重读一次列表。重连时的 `undefined`
   * 不管，连上之后本来就重读。
   */
  #onSessionsChanged(change: SessionsChange | undefined): void {
    if (change === undefined || this.#disposed || this.#listVersion === undefined) return;
    if (this.#refreshing !== undefined || change.listVersion !== this.#listVersion + 1) {
      void this.refresh();
      return;
    }
    this.#listVersion = change.listVersion;
    if (change.upserted.length === 0 && change.removed.length === 0) return;
    this.#sessions = applySessionsChange(this.#sessions, change);
    recordBaselines([...this.#sessions.values()]);
    for (const id of change.removed) {
      if (this.#sessions.has(id)) continue;
      this.#subscriptions.get(id)?.close();
      this.#subscriptions.delete(id);
    }
    for (const session of change.upserted) {
      const current = this.#sessions.get(session.id);
      if (current) this.#follow(current);
    }
    this.#publish();
  }

  /** 给会话开一条从当前 lastSeq 开始的订阅（已有就不重复开）。断线重连由 client-sdk 续订。 */
  #follow(session: Session): void {
    if (this.#subscriptions.has(session.id)) return;
    const subscription = this.#client.subscribe(session.id, { sinceSeq: session.lastSeq });
    this.#subscriptions.set(session.id, subscription);
    void (async () => {
      try {
        for await (const item of subscription) {
          if (item.type === 'event') {
            this.#pending.push(item.event);
            this.#batch.request();
          }
        }
      } catch (error) {
        // 会话已不存在（被移除的工作区）：下一次重读列表时会去掉它；其他错误同样等重读时重新订阅。
        if (!isRpcError(error, 'SESSION_NOT_FOUND'))
          console.warn('会话订阅结束', session.id, error);
      } finally {
        if (this.#subscriptions.get(session.id) === subscription) {
          this.#subscriptions.delete(session.id);
        }
      }
    })();
  }

  #flush(): void {
    let changed = false;
    for (const event of this.#pending.splice(0)) {
      const session = this.#sessions.get(event.sessionId);
      if (!session) continue;
      const next = applySessionEvent(session, event);
      for (const listener of this.#eventListeners) {
        try {
          listener(event, next);
        } catch (error) {
          console.warn('会话事件的监听出错', error);
        }
      }
      if (next === session) continue;
      this.#sessions.set(session.id, next);
      changed = true;
    }
    if (changed) this.#publish();
  }

  #publish(): void {
    if (this.#workspaces) {
      this.#data = {
        status: 'ready',
        workspaces: groupSessions(this.#workspaces, this.#sessions.values()),
        providers: this.#providers,
      };
    } else if (this.#error !== undefined) {
      this.#data = { status: 'error', error: this.#error };
    }
    for (const listener of this.#listeners) listener();
  }
}
