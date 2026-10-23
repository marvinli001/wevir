// 会话列表推送（0.101.0，domain-model §3.46，host-api.md §3.1 `session.list`）：读过列表的连接在会话增、删、改时收
// `sessions.changed`，不必轮询。`SessionListFeed` 是整个 Host 一份，从事件库收变化、100 ms 合一批、按行的指纹判断真变了没有；
// `SessionListScope` 是一条连接一份，记着它调过的 `session.list` 参数与见过的会话，把一批变化裁成发给它的那条通知。

import { createHash } from 'node:crypto';
import type {
  MethodParams,
  NotificationParams,
  Session,
  SessionId,
  SessionSnapshot,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import type { EventStore } from './event-store.js';

/** 同一批里合并的时间窗。 */
export const SESSION_LIST_WINDOW_MS = 100;

/** 一批会话列表的变化。 */
export interface SessionListBatch {
  readonly listVersion: number;
  /** 变了的会话：列表里的行，或 `undefined`（已不在任何列表里：删了、工作区移除了）。 */
  readonly rows: ReadonlyMap<SessionId, Session | undefined>;
}

/** `session.list` 的一行：快照里的会话加上存储里的归档时刻与未决的审批、问题数（0 时省略）。 */
export function listRow(snapshot: SessionSnapshot, archivedAt: string | undefined): Session {
  const approvals = snapshot.pendingApprovals.length;
  const questions = snapshot.pendingQuestions?.length ?? 0;
  return {
    ...snapshot.session,
    ...(archivedAt !== undefined && { archivedAt }),
    ...(approvals > 0 && { pendingApprovalCount: approvals }),
    ...(questions > 0 && { pendingQuestionCount: questions }),
  };
}

export interface SessionListFeedOptions {
  storage: Storage;
  events: EventStore;
  /** 默认 `SESSION_LIST_WINDOW_MS`。 */
  windowMs?: number;
  /** 版本的起点，默认是现在的毫秒时间戳（每批至少隔一个窗口，版本跟不上时钟，重启后通常更大）。 */
  startVersion?: number;
  onError?: (error: unknown) => void;
}

const GONE = 'gone';

/**
 * 整个 Host 的会话列表变化。事件库写入的事件（跳过流式增量）与 `EventStore.touch` / `forget` 把会话记成“可能变了”，窗口结束时
 * 逐个算出它现在的行，与上次推出去的指纹比：没变的丢掉，剩下的成一批、版本加一，交给每个监听者。没有监听者时不记录，指纹也清空
 * （期间的变化没跟踪，不能再拿旧指纹比）。
 */
export class SessionListFeed {
  readonly #storage: Storage;
  readonly #events: EventStore;
  readonly #windowMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #listeners = new Set<(batch: SessionListBatch) => void>();
  readonly #dirty = new Set<SessionId>();
  readonly #fingerprints = new Map<SessionId, string>();
  readonly #unlisten: Array<() => void>;
  #version: number;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SessionListFeedOptions) {
    this.#storage = options.storage;
    this.#events = options.events;
    this.#windowMs = options.windowMs ?? SESSION_LIST_WINDOW_MS;
    this.#onError =
      options.onError ?? ((error) => console.error('[wevir-host] session list:', error));
    this.#version = options.startVersion ?? Date.now();
    this.#unlisten = [
      options.events.listenAll((event) => {
        if (event.type === 'assistant.delta' || event.type === 'plan.delta') return;
        this.#mark([event.sessionId]);
      }),
      options.events.listenTouched((sessionIds) => this.#mark(sessionIds)),
    ];
  }

  /** 当前的版本：`session.list` 的结果带它。 */
  get version(): number {
    return this.#version;
  }

  /** 收此后的每一批，返回取消函数。 */
  watch(listener: (batch: SessionListBatch) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size > 0) return;
      this.#dirty.clear();
      this.#fingerprints.clear();
    };
  }

  /** 不再收变化；还没发的一批丢掉。 */
  close(): void {
    for (const unlisten of this.#unlisten.splice(0)) unlisten();
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#listeners.clear();
    this.#dirty.clear();
  }

  #mark(sessionIds: readonly SessionId[]): void {
    if (this.#listeners.size === 0) return;
    for (const sessionId of sessionIds) this.#dirty.add(sessionId);
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      try {
        this.#flush();
      } catch (error) {
        this.#dirty.clear();
        this.#onError(error);
      }
    }, this.#windowMs);
    this.#timer.unref?.();
  }

  #flush(): void {
    const rows = new Map<SessionId, Session | undefined>();
    for (const sessionId of this.#dirty) {
      const row = this.#row(sessionId);
      const fingerprint = row === undefined ? GONE : fingerprintOf(row);
      if (this.#fingerprints.get(sessionId) === fingerprint) continue;
      this.#fingerprints.set(sessionId, fingerprint);
      rows.set(sessionId, row);
    }
    this.#dirty.clear();
    if (rows.size === 0) return;
    this.#version += 1;
    const batch: SessionListBatch = { listVersion: this.#version, rows };
    for (const listener of [...this.#listeners]) {
      try {
        listener(batch);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  /** 会话现在在列表里的行；删了、是支线、工作区移除了时 `undefined`。 */
  #row(sessionId: SessionId): Session | undefined {
    const record = this.#storage.sessions.get(sessionId);
    if (record === undefined || record.side === true) return undefined;
    const workspace = this.#storage.workspaces.get(record.workspaceId);
    if (workspace === undefined || workspace.removedAt !== undefined) return undefined;
    const snapshot = this.#events.snapshot(sessionId);
    return snapshot === undefined ? undefined : listRow(snapshot, record.archivedAt);
  }
}

/** 行的指纹：去掉 `lastSeq`；回合进行中也去掉 `updatedAt`（流式增量与工具进展不推）。 */
function fingerprintOf(row: Session): string {
  const { lastSeq: _lastSeq, updatedAt, ...rest } = row;
  const value = row.activeTurn === undefined ? { ...rest, updatedAt } : rest;
  return createHash('sha1').update(JSON.stringify(value)).digest('base64');
}

type ListParams = MethodParams<'session.list'>;

/**
 * 一条连接的列表范围：调过的 `session.list` 参数取并集，见过的会话是列表结果与推送里出现过的。一批变化里落在并集里的进
 * `upserted`；不在并集里但见过的进 `removed`；其余不发。
 */
export class SessionListScope {
  readonly #filters = new Map<string, ListParams>();
  readonly #seen = new Set<SessionId>();

  /** 一次 `session.list`：记下参数与结果里的会话。 */
  add(params: ListParams, sessions: readonly Session[]): void {
    const filter: ListParams = {
      ...(params.workspaceId !== undefined && { workspaceId: params.workspaceId }),
      ...(params.parentSessionId !== undefined && { parentSessionId: params.parentSessionId }),
      ...(params.archived === true && { archived: true }),
    };
    this.#filters.set(JSON.stringify(filter), filter);
    for (const session of sessions) this.#seen.add(session.id);
  }

  /** 这一批里给这条连接的部分（可能两个数组都是空的：版本照样连续）。 */
  apply(batch: SessionListBatch): NotificationParams<'sessions.changed'> {
    const upserted: Session[] = [];
    const removed: SessionId[] = [];
    for (const [sessionId, row] of batch.rows) {
      if (row !== undefined && this.#matches(row)) {
        upserted.push(row);
        this.#seen.add(sessionId);
      } else if (this.#seen.delete(sessionId)) {
        removed.push(sessionId);
      }
    }
    return { listVersion: batch.listVersion, upserted, removed };
  }

  /** 同 storage 的 `sessions.list`：工作区、父会话（不给时只要顶层）、归档与否都要对上。 */
  #matches(row: Session): boolean {
    // 频道的协调者与线程（0.120.0）不进会话列表。
    if (row.channel !== undefined) return false;
    for (const filter of this.#filters.values()) {
      if (filter.workspaceId !== undefined && row.workspaceId !== filter.workspaceId) continue;
      if (row.parentSessionId !== filter.parentSessionId) continue;
      if ((row.archivedAt !== undefined) !== (filter.archived === true)) continue;
      return true;
    }
    return false;
  }
}
