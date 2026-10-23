// 收件箱（0.105.0，Host 功能 `inbox`，domain-model §3.47，host-api.md §3.1 `inbox.*`）：跨所有会话等用户处理的事——未决审批、
// 等回答的问题、失败的回合、要关注的自动化运行。不单独存：启动时从事件、审批表与自动化的运行重建，之后从事件、`EventStore.touch`
// 与自动化的变化增量维护，100 ms 合一批。只有“收起”落库（`inbox_dismissals`）。
//
// `InboxService.watch` 是 Host 里收件箱变化的唯一入口：RPC 的 `inbox.changed` 用它，以后的通知判定也用它。

import {
  type ApprovalRequest,
  type Automation,
  type AutomationNotify,
  type AutomationRun,
  INBOX_ATTENTION_MAX_AGE_DAYS,
  INBOX_SUMMARY_MAX_LENGTH,
  INBOX_TITLE_MAX_LENGTH,
  type InboxItem,
  type InboxItemId,
  type NotificationParams,
  type QuestionRequest,
  type Session,
  type SessionId,
  type TurnId,
  type WorkspaceId,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { HostError } from './errors.js';
import type { EventStore } from './event-store.js';
import { REDACTED, redactSecrets } from './secret-patterns.js';

/** 同一批里合并的时间窗。 */
export const INBOX_WINDOW_MS = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 一批收件箱的变化：`inbox.changed` 的参数。 */
export type InboxChange = NotificationParams<'inbox.changed'>;

/** 收件箱要的自动化：全部自动化（含最近一次运行）与它们的变化。 */
export interface InboxAutomations {
  list(): Automation[];
  watch(listener: (change: NotificationParams<'automation.changed'>) => void): () => void;
}

export interface InboxServiceOptions {
  storage: Storage;
  events: EventStore;
  automations?: InboxAutomations;
  /** 连接器与插件的密钥值（`PluginRegistry.appToolSecrets()`）：说明里出现时换成 `[REDACTED]`。 */
  secrets?: () => readonly string[];
  /** 默认 `INBOX_WINDOW_MS`。 */
  windowMs?: number;
  /** 版本的起点，默认是现在的毫秒时间戳（同 `SessionListFeed`）。 */
  startVersion?: number;
  /** 只给测试。 */
  now?: () => number;
  onError?: (error: unknown) => void;
}

/** 一个会话里没被新回合盖住的失败回合。 */
interface FailedTurn {
  readonly turnId: TurnId;
  readonly at: string;
}

/**
 * 整个 Host 的收件箱。`start()` 之后才有内容、才收变化；之前 `list()` 是空的。项按会话与自动化分组记着，变化时只重算那一组，
 * 与上次的指纹比，没变的不推。收起的项不在 `#items` 里。
 */
export class InboxService {
  readonly #storage: Storage;
  readonly #events: EventStore;
  readonly #automations: InboxAutomations | undefined;
  readonly #secrets: () => readonly string[];
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #listeners = new Set<(change: InboxChange) => void>();
  /** 当前的项（不含收起的）与它们的指纹。 */
  readonly #items = new Map<InboxItemId, { item: InboxItem; fingerprint: string }>();
  /** 每个会话、每个自动化现在的项（含收起的）。 */
  readonly #bySession = new Map<SessionId, Set<InboxItemId>>();
  readonly #byAutomation = new Map<string, InboxItemId>();
  readonly #failedTurns = new Map<SessionId, FailedTurn>();
  #dismissed = new Set<string>();
  readonly #dirtySessions = new Set<SessionId>();
  readonly #dirtyAutomations = new Set<string>();
  readonly #unlisten: Array<() => void> = [];
  #version: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #started = false;

  constructor(options: InboxServiceOptions) {
    this.#storage = options.storage;
    this.#events = options.events;
    this.#automations = options.automations;
    this.#secrets = options.secrets ?? (() => []);
    this.#windowMs = options.windowMs ?? INBOX_WINDOW_MS;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((error) => console.error('[wevir-host] inbox:', error));
    this.#version = options.startVersion ?? this.#now();
  }

  /**
   * 重建并开始收变化（Host 启动、对账与自动化载入之后调一次）：未决审批与未答提问所在的会话、最近的失败回合、各自动化的最近一次
   * 运行，再减去收起过的；收起记录里已不是候选的删掉。
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#unlisten.push(
      this.#events.listenAll((event) => {
        if (event.type === 'assistant.delta' || event.type === 'plan.delta') return;
        if (event.type === 'turn.started') {
          this.#failedTurns.delete(event.sessionId);
        } else if (event.type === 'turn.finished' && event.payload.outcome === 'failed') {
          this.#failedTurns.set(event.sessionId, { turnId: event.payload.turnId, at: event.ts });
        }
        this.#markSession(event.sessionId);
      }),
      this.#events.listenTouched((sessionIds) => {
        for (const sessionId of sessionIds) this.#markSession(sessionId);
      }),
    );
    if (this.#automations !== undefined) {
      this.#unlisten.push(
        this.#automations.watch((change) => {
          this.#dirtyAutomations.add(change.automationId);
          this.#schedule();
        }),
      );
    }

    const since = new Date(this.#now() - INBOX_ATTENTION_MAX_AGE_DAYS * DAY_MS).toISOString();
    for (const failed of this.#storage.inbox.failedTurns({ since })) {
      this.#failedTurns.set(failed.sessionId as SessionId, {
        turnId: failed.turnId as TurnId,
        at: failed.finishedAt,
      });
    }
    const sessionIds = new Set<SessionId>([
      ...this.#storage.approvals.listPending().map((approval) => approval.sessionId as SessionId),
      ...(this.#storage.inbox.sessionsWithPendingQuestions() as SessionId[]),
      ...this.#failedTurns.keys(),
    ]);
    this.#dismissed = this.#storage.inbox.dismissed();
    for (const sessionId of sessionIds) this.#applySession(sessionId);
    for (const automation of this.#automations?.list() ?? [])
      this.#applyAutomation(automation.id, automation);
    // `#bySession` / `#byAutomation` 含收起的项：不在里面的收起记录已不可能再出现。
    const candidates = new Set<string>([
      ...[...this.#bySession.values()].flatMap((ids) => [...ids]),
      ...this.#byAutomation.values(),
    ]);
    const stale = this.#storage.inbox.retainDismissals(
      new Set([...this.#dismissed].filter((itemId) => candidates.has(itemId))),
    );
    if (stale > 0) this.#dismissed = this.#storage.inbox.dismissed();
  }

  /** 当前的版本：`inbox.list` 的结果带它。 */
  get version(): number {
    return this.#version;
  }

  /** 当前全部项（不按时效过滤），顺序不定。给 Host 内部用。 */
  items(): InboxItem[] {
    return [...this.#items.values()].map(({ item }) => item);
  }

  /** `inbox.list`：失败回合与自动化项只列 `INBOX_ATTENTION_MAX_AGE_DAYS` 天内的，新的在前。 */
  list(): InboxItem[] {
    const since = new Date(this.#now() - INBOX_ATTENTION_MAX_AGE_DAYS * DAY_MS).toISOString();
    return this.items()
      .filter(
        (item) =>
          (item.kind !== 'turn_failed' && item.kind !== 'automation') || item.createdAt >= since,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  /**
   * `inbox.dismiss`：收起失败回合或自动化项，记进数据库，推一条移除。审批与提问回 `INVALID_PARAMS`（回答后自己离开）；
   * 项不在收件箱时什么都不做。
   */
  dismiss(itemId: InboxItemId): void {
    const kind = itemId.slice(0, itemId.indexOf(':'));
    if (kind === 'approval' || kind === 'question') {
      const message = `${kind} items leave the inbox when answered and cannot be dismissed`;
      throw new HostError('INVALID_PARAMS', message, { issues: [{ path: ['itemId'], message }] });
    }
    if (!this.#items.has(itemId)) return;
    this.#storage.inbox.dismiss(itemId, new Date(this.#now()).toISOString());
    this.#dismissed.add(itemId);
    this.#items.delete(itemId);
    this.#emit([], [itemId]);
  }

  /** 收此后的每一批变化，返回取消函数。`listener` 同步调用，不要在里面做慢的事。 */
  watch(listener: (change: InboxChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 不再收变化；还没发的一批丢掉。 */
  close(): void {
    for (const unlisten of this.#unlisten.splice(0)) unlisten();
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#listeners.clear();
    this.#dirtySessions.clear();
    this.#dirtyAutomations.clear();
  }

  #markSession(sessionId: SessionId): void {
    this.#dirtySessions.add(sessionId);
    this.#schedule();
  }

  #schedule(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      try {
        this.#flush();
      } catch (error) {
        this.#dirtySessions.clear();
        this.#dirtyAutomations.clear();
        this.#onError(error);
      }
    }, this.#windowMs);
    this.#timer.unref?.();
  }

  #flush(): void {
    const upserted = new Map<InboxItemId, InboxItem>();
    const removed = new Set<InboxItemId>();
    const collect = (change: { upserted: InboxItem[]; removed: InboxItemId[] }) => {
      for (const item of change.upserted) {
        upserted.set(item.id, item);
        removed.delete(item.id);
      }
      for (const itemId of change.removed) {
        upserted.delete(itemId);
        removed.add(itemId);
      }
    };
    for (const sessionId of this.#dirtySessions) collect(this.#applySession(sessionId));
    this.#dirtySessions.clear();
    if (this.#dirtyAutomations.size > 0) {
      const automations = new Map<string, Automation>(
        (this.#automations?.list() ?? []).map((automation) => [automation.id, automation]),
      );
      for (const automationId of this.#dirtyAutomations) {
        collect(this.#applyAutomation(automationId, automations.get(automationId)));
      }
      this.#dirtyAutomations.clear();
    }
    this.#emit([...upserted.values()], [...removed]);
  }

  #emit(upserted: InboxItem[], removed: InboxItemId[]): void {
    if (upserted.length === 0 && removed.length === 0) return;
    this.#version += 1;
    const change: InboxChange = { inboxVersion: this.#version, upserted, removed };
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  /** 重算一个会话的项，换掉原来的，返回变了的。 */
  #applySession(sessionId: SessionId): { upserted: InboxItem[]; removed: InboxItemId[] } {
    const items = this.#sessionItems(sessionId);
    const before = this.#bySession.get(sessionId) ?? new Set<InboxItemId>();
    const after = new Set(items.map((item) => item.id));
    if (after.size > 0) this.#bySession.set(sessionId, after);
    else this.#bySession.delete(sessionId);
    return this.#replace(before, items);
  }

  #applyAutomation(
    automationId: string,
    automation: Automation | undefined,
  ): { upserted: InboxItem[]; removed: InboxItemId[] } {
    const item = automation === undefined ? undefined : this.#automationItem(automation);
    const previous = this.#byAutomation.get(automationId);
    if (item !== undefined) this.#byAutomation.set(automationId, item.id);
    else this.#byAutomation.delete(automationId);
    return this.#replace(new Set(previous === undefined ? [] : [previous]), item ? [item] : []);
  }

  /** 一组项从 `before` 换成 `items`：收起的跳过，指纹没变的不算变化。 */
  #replace(
    before: ReadonlySet<InboxItemId>,
    items: readonly InboxItem[],
  ): { upserted: InboxItem[]; removed: InboxItemId[] } {
    const upserted: InboxItem[] = [];
    const removed: InboxItemId[] = [];
    const ids = new Set(items.map((item) => item.id));
    for (const itemId of before) {
      if (ids.has(itemId) || !this.#items.delete(itemId)) continue;
      removed.push(itemId);
    }
    for (const item of items) {
      if (this.#dismissed.has(item.id)) continue;
      const fingerprint = JSON.stringify(item);
      if (this.#items.get(item.id)?.fingerprint === fingerprint) continue;
      this.#items.set(item.id, { item, fingerprint });
      upserted.push(item);
    }
    return { upserted, removed };
  }

  /** 一个会话现在的项：未决审批、未答提问、失败回合。会话删了、项目移除了时没有。 */
  #sessionItems(sessionId: SessionId): InboxItem[] {
    const record = this.#storage.sessions.get(sessionId);
    const workspace = record && this.#storage.workspaces.get(record.workspaceId);
    const snapshot =
      workspace === undefined || workspace.removedAt !== undefined
        ? undefined
        : this.#events.snapshot(sessionId);
    if (record === undefined || snapshot === undefined) {
      this.#failedTurns.delete(sessionId);
      return [];
    }
    const { session } = snapshot;
    const base = {
      sessionId,
      workspaceId: session.workspaceId,
      ...parentOf(session),
      title: this.#title(session.title),
    };
    const items: InboxItem[] = [];
    for (const approval of snapshot.pendingApprovals)
      items.push(this.#approvalItem(base, approval));
    for (const question of snapshot.pendingQuestions ?? [])
      items.push(this.#questionItem(base, question));
    const failed = this.#failedTurns.get(sessionId);
    const attended =
      session.parentSessionId === undefined &&
      session.side !== true &&
      session.automation === undefined &&
      // 协调者的失败回合由频道的 `notice: failed` 帖子代表（0.120.0）。
      session.channel?.role !== 'coordinator' &&
      record.archivedAt === undefined;
    if (failed !== undefined && attended) {
      items.push({
        ...base,
        id: `turn_failed:${failed.turnId}`,
        kind: 'turn_failed',
        summary: this.#summary(session.lastError?.message ?? ''),
        createdAt: failed.at,
        ref: { turnId: failed.turnId },
      });
    }
    return items;
  }

  #approvalItem(base: ItemBase, approval: ApprovalRequest): InboxItem {
    return {
      ...base,
      id: `approval:${approval.id}`,
      kind: 'approval',
      summary: this.#summary(approvalSummary(approval)),
      createdAt: approval.createdAt,
      ...(approval.expiresAt !== undefined && { expiresAt: approval.expiresAt }),
      ref: { approvalId: approval.id, turnId: approval.turnId, options: approval.options },
    };
  }

  #questionItem(base: ItemBase, question: QuestionRequest): InboxItem {
    return {
      ...base,
      id: `question:${question.id}`,
      kind: 'question',
      summary: this.#summary(question.questions[0]?.question ?? ''),
      createdAt: question.createdAt,
      ...(question.autoAnswerAt !== undefined && { expiresAt: question.autoAnswerAt }),
      ref: {
        questionId: question.id,
        turnId: question.turnId,
        questions: question.questions.map((item) => ({
          id: item.id,
          ...(item.header !== undefined && { header: item.header }),
          question: this.#summary(item.question),
          options: item.options.map((option) => ({ label: option.label })),
          ...(item.multiSelect !== undefined && { multiSelect: item.multiSelect }),
          ...(item.allowOther !== undefined && { allowOther: item.allowOther }),
          ...(item.secret !== undefined && { secret: item.secret }),
        })),
      },
    };
  }

  /** 自动化最近一次运行要不要进收件箱，要就给出那一项。 */
  #automationItem(automation: Automation): InboxItem | undefined {
    const run = automation.lastRun;
    if (run === undefined || !needsAttention(automation.notify, run)) return undefined;
    const session =
      run.sessionId === undefined ? undefined : this.#storage.sessions.get(run.sessionId);
    const workspaceId = session?.workspaceId ?? automation.workspaceId;
    return {
      id: `automation:${run.id}`,
      kind: 'automation',
      ...(run.sessionId !== undefined && { sessionId: run.sessionId }),
      ...(workspaceId !== undefined && { workspaceId: workspaceId as WorkspaceId }),
      title: this.#title(automation.title),
      summary: this.#summary(run.status === 'failed' ? (run.error ?? '') : (run.summary ?? '')),
      createdAt: run.finishedAt ?? run.startedAt,
      ref: {
        automationId: automation.id,
        runId: run.id,
        status: run.status as 'failed' | 'completed',
      },
    };
  }

  #title(text: string): string {
    return cut(text, INBOX_TITLE_MAX_LENGTH);
  }

  /** 打码（像密钥的片段与连接器、插件的密钥值）、折叠空白，再截断。 */
  #summary(text: string): string {
    let result = redactSecrets(text).text;
    const secrets = [...this.#secrets()].filter((secret) => secret.length >= 4);
    for (const secret of secrets.sort((a, b) => b.length - a.length))
      result = result.replaceAll(secret, REDACTED);
    return cut(result.replace(/\s+/g, ' ').trim(), INBOX_SUMMARY_MAX_LENGTH);
  }
}

type ItemBase = Pick<InboxItem, 'sessionId' | 'workspaceId' | 'parentSessionId' | 'title'>;

/** 子会话的父会话；支线是分出它的会话。 */
function parentOf(session: Session): { parentSessionId?: SessionId } {
  const parent =
    session.parentSessionId ?? (session.side === true ? session.forkedFrom?.sessionId : undefined);
  return parent === undefined ? {} : { parentSessionId: parent };
}

/** 审批的一行说明：命令、路径、URL、查询词，都没有时是工具名。 */
function approvalSummary(approval: ApprovalRequest): string {
  const detail = approval.detail;
  if (detail === null) return '';
  const { display } = detail;
  return (
    display.command ??
    display.summary ??
    display.url ??
    display.query ??
    display.paths?.join(', ') ??
    detail.toolName
  );
}

/**
 * 自动化的一次运行要不要关注（同桌面的自动化提醒）：失败的（`never` 除外）；完成的按通知设置——`always` 都要，`important` 不是
 * `quiet` 的，`changes` 不是 `quiet` 也不是 `unchanged` 的。`waiting` 不进，它的审批或提问自己会进。
 */
export function needsAttention(notify: AutomationNotify, run: AutomationRun): boolean {
  if (notify === 'never') return false;
  if (run.status === 'failed') return true;
  if (run.status !== 'completed') return false;
  if (notify === 'always') return true;
  if (notify === 'important') return run.quiet !== true;
  if (notify === 'changes') return run.quiet !== true && run.unchanged !== true;
  return false;
}

/** 截到 `max` 个 UTF-16 code unit 以内，截了的末尾是“…”，不切开代理对。 */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}
