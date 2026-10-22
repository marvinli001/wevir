// 通知意图（0.106.0，Host 功能 `notification_intents`，domain-model §3.48，host-api.md §3.1 `notification.subscribe`）：“这件事该不该
// 提醒”在 Host 统一判定，规则同此前桌面渲染进程的 `notificationKind` 与自动化提醒。怎样提醒（正看着就不提醒、系统通知、提示音、角标）
// 由客户端决定。意图不存储、不补发。
//
// 来源：审批、提问、失败回合与自动化的失败、完成取收件箱新出现的项（`InboxService.watch`）；回合正常完成不进收件箱，取事件库的
// `turn.finished`；自动化进入 `waiting` 取自动化的变化。Host 启动重建收件箱时不发批次，所以重启前就有的事不产生意图。

import {
  type Automation,
  type AutomationNotify,
  type AutomationRun,
  type HostSettings,
  type InboxItem,
  NOTIFICATION_MAX_AGE_MS,
  NOTIFICATION_TITLE_MAX_LENGTH,
  type NotificationIntent,
  type NotificationKind,
  type NotificationParams,
  type Session,
  type SessionId,
  type WevirEvent,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import type { EventStore } from './event-store.js';
import { cut, type InboxService } from './inbox.js';

/** 通知意图要的自动化：全部自动化（含最近一次运行）与它们的变化。 */
export interface NotificationAutomations {
  list(): Automation[];
  watch(listener: (change: NotificationParams<'automation.changed'>) => void): () => void;
}

export interface NotificationServiceOptions {
  storage: Storage;
  events: Pick<EventStore, 'listenAll' | 'snapshot'>;
  inbox: Pick<InboxService, 'watch'>;
  automations?: NotificationAutomations;
  /** 当前的 Host 设置（读 `notifications` 种类开关）。 */
  settings: () => HostSettings;
  /** 只给测试。 */
  now?: () => number;
  onError?: (error: unknown) => void;
}

/** 会话的提醒要的东西。 */
interface SessionFacts {
  session: Session;
  archived: boolean;
}

/**
 * 整个 Host 的通知判定。`start()` 之后才收变化；`watch` 的监听者同步收到每条意图。同一个意图 ID 只发一次：发过的记到它事发后
 * `NOTIFICATION_MAX_AGE_MS`，过了这段时间它本来也会被时效挡住。
 */
export class NotificationService {
  readonly #storage: Storage;
  readonly #events: Pick<EventStore, 'listenAll' | 'snapshot'>;
  readonly #inbox: Pick<InboxService, 'watch'>;
  readonly #automations: NotificationAutomations | undefined;
  readonly #settings: () => HostSettings;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #listeners = new Set<(intent: NotificationIntent) => void>();
  /** 判定过的意图 ID 与事发时刻（毫秒）。 */
  readonly #seen = new Map<string, number>();
  /** 提醒过 `waiting` 的运行：一次运行只提醒一次，运行结束时删掉。 */
  readonly #waitingRuns = new Set<string>();
  readonly #unlisten: Array<() => void> = [];
  #started = false;

  constructor(options: NotificationServiceOptions) {
    this.#storage = options.storage;
    this.#events = options.events;
    this.#inbox = options.inbox;
    this.#automations = options.automations;
    this.#settings = options.settings;
    this.#now = options.now ?? Date.now;
    this.#onError =
      options.onError ?? ((error) => console.error('[wevir-host] notifications:', error));
  }

  /** 开始收变化（收件箱建好之后调一次）。 */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#unlisten.push(
      this.#inbox.watch((change) => this.#guard(() => this.#onInbox(change.upserted))),
      this.#events.listenAll((event) => {
        if (event.type !== 'turn.finished' || event.payload.outcome !== 'completed') return;
        this.#guard(() => this.#onCompleted(event));
      }),
    );
    if (this.#automations !== undefined) {
      const automations = this.#automations;
      this.#unlisten.push(
        automations.watch((change) => {
          if (change.run === undefined) return;
          const run = change.run;
          this.#guard(() => this.#onRun(change.automationId, run));
        }),
      );
    }
  }

  /** 收此后的每条意图，返回取消函数。`listener` 同步调用，不要在里面做慢的事。 */
  watch(listener: (intent: NotificationIntent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    for (const unlisten of this.#unlisten.splice(0)) unlisten();
    this.#listeners.clear();
    this.#seen.clear();
    this.#waitingRuns.clear();
  }

  #guard(work: () => void): void {
    try {
      work();
    } catch (error) {
      this.#onError(error);
    }
  }

  #onInbox(items: readonly InboxItem[]): void {
    this.#prune();
    for (const item of items) {
      if (this.#seen.has(item.id)) continue;
      const at = Date.parse(item.createdAt);
      this.#seen.set(item.id, at);
      if (!this.#fresh(at)) continue;
      if (item.kind === 'automation') {
        if (!this.#enabled('automation')) continue;
        const automationId = item.ref.automationId;
        this.#emit({
          id: item.id,
          kind: 'automation',
          ...(item.sessionId !== undefined && { sessionId: item.sessionId }),
          ...(item.workspaceId !== undefined && { workspaceId: item.workspaceId }),
          automationId,
          automationStatus: item.ref.status,
          title: item.title,
          body: item.summary,
          createdAt: item.createdAt,
          collapseKey: collapseKey(item.sessionId, automationId),
        });
        continue;
      }
      const kind: NotificationKind = item.kind === 'turn_failed' ? 'failed' : item.kind;
      // 子会话与支线的项带 parentSessionId。
      if (item.sessionId === undefined || item.parentSessionId !== undefined) continue;
      if (!this.#enabled(kind) || !this.#attended(item.sessionId, item.createdAt)) continue;
      this.#emit({
        id: item.id,
        kind,
        sessionId: item.sessionId,
        ...(item.workspaceId !== undefined && { workspaceId: item.workspaceId }),
        title: item.title,
        body: item.summary,
        createdAt: item.createdAt,
        collapseKey: collapseKey(item.sessionId),
      });
    }
  }

  #onCompleted(event: Extract<WevirEvent, { type: 'turn.finished' }>): void {
    const id = `completed:${event.payload.turnId}`;
    if (this.#seen.has(id)) return;
    this.#prune();
    const at = Date.parse(event.ts);
    this.#seen.set(id, at);
    if (!this.#fresh(at) || !this.#enabled('completed')) return;
    if (!this.#attended(event.sessionId, event.ts)) return;
    const facts = this.#sessionFacts(event.sessionId);
    if (facts === undefined) return;
    this.#emit({
      id,
      kind: 'completed',
      sessionId: event.sessionId,
      workspaceId: facts.session.workspaceId,
      title: cut(facts.session.title, NOTIFICATION_TITLE_MAX_LENGTH),
      body: '',
      createdAt: event.ts,
      collapseKey: collapseKey(event.sessionId),
    });
  }

  /** 自动化的运行进入 `waiting`（等审批或回答）：失败与完成走收件箱。 */
  #onRun(automationId: string, run: AutomationRun): void {
    if (run.status !== 'waiting') {
      if (!isRunActive(run)) this.#waitingRuns.delete(run.id);
      return;
    }
    if (this.#waitingRuns.has(run.id)) return;
    this.#waitingRuns.add(run.id);
    const automation = this.#automations?.list().find((entry) => entry.id === automationId);
    if (automation === undefined || !shouldNotifyWaiting(automation.notify)) return;
    if (!this.#enabled('automation')) return;
    const record =
      run.sessionId === undefined ? undefined : this.#storage.sessions.get(run.sessionId);
    const workspaceId = record?.workspaceId ?? automation.workspaceId;
    const now = new Date(this.#now()).toISOString();
    this.#emit({
      id: `automation:${run.id}:waiting`,
      kind: 'automation',
      ...(run.sessionId !== undefined && { sessionId: run.sessionId }),
      ...(workspaceId !== undefined && { workspaceId: workspaceId as Session['workspaceId'] }),
      automationId: automation.id,
      automationStatus: 'waiting',
      title: cut(automation.title, NOTIFICATION_TITLE_MAX_LENGTH),
      body: '',
      createdAt: now,
      collapseKey: collapseKey(run.sessionId, automation.id),
    });
  }

  /**
   * 这个会话的事要不要按会话提醒：顶层、不是支线、没归档、项目没移除；不是自动化开的；自动化发进这个会话的运行进行中（按事发时刻
   * 落在运行的 `startedAt`–`finishedAt` 里）的事也不按会话提醒，由自动化的提醒代表。
   */
  #attended(sessionId: SessionId, at: string): boolean {
    const facts = this.#sessionFacts(sessionId);
    if (facts === undefined || facts.archived) return false;
    const { session } = facts;
    if (session.parentSessionId !== undefined || session.side === true) return false;
    if (session.automation !== undefined) return false;
    for (const automation of this.#automations?.list() ?? []) {
      const run = automation.lastRun;
      if (run?.sessionId !== sessionId) continue;
      if (run.startedAt <= at && (run.finishedAt === undefined || at <= run.finishedAt)) {
        return false;
      }
    }
    return true;
  }

  #sessionFacts(sessionId: SessionId): SessionFacts | undefined {
    const record = this.#storage.sessions.get(sessionId);
    if (record === undefined) return undefined;
    const workspace = this.#storage.workspaces.get(record.workspaceId);
    if (workspace === undefined || workspace.removedAt !== undefined) return undefined;
    const snapshot = this.#events.snapshot(sessionId);
    if (snapshot === undefined) return undefined;
    return { session: snapshot.session, archived: record.archivedAt !== undefined };
  }

  #enabled(kind: NotificationKind): boolean {
    return this.#settings().notifications?.[kind] !== false;
  }

  #fresh(at: number): boolean {
    return Number.isFinite(at) && this.#now() - at <= NOTIFICATION_MAX_AGE_MS;
  }

  /** 忘掉事发早于时效的 ID：它们再出现也会被时效挡住。 */
  #prune(): void {
    const before = this.#now() - NOTIFICATION_MAX_AGE_MS;
    for (const [id, at] of this.#seen) {
      if (!(at >= before)) this.#seen.delete(id);
    }
  }

  #emit(intent: NotificationIntent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(intent);
      } catch (error) {
        this.#onError(error);
      }
    }
  }
}

function collapseKey(sessionId: SessionId | undefined, automationId?: string): string {
  return sessionId !== undefined ? `session:${sessionId}` : `automation:${automationId}`;
}

/** 等审批或回答的运行：除了“从不”都提醒（同桌面的 `shouldNotify`；失败与完成由收件箱的 `needsAttention` 判定）。 */
function shouldNotifyWaiting(notify: AutomationNotify): boolean {
  return notify !== 'never';
}

function isRunActive(run: AutomationRun): boolean {
  return run.status === 'running' || run.status === 'waiting' || run.status === 'checking';
}
