import { stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type {
  ApprovalDetail,
  ApprovalId,
  ApprovalOption,
  ApprovalRequest,
  ApprovalResolution,
  ClientIdentity,
  EngineErrorCategory,
  EngineErrorInfo,
  MethodParams,
  MethodResult,
  PendingMessage,
  PendingMessageId,
  ProviderId,
  ResolvedApprovalStatus,
  Session,
  SessionId,
  SessionReadOnlyReason,
  SessionSnapshot,
  SessionState,
  StateChangeReason,
  StreamBlockRef,
  StreamId,
  SubagentSummary,
  ToolDisplay,
  TurnId,
  TurnOutcome,
  UserContentPart,
  WorkspaceId,
} from '@wevir/protocol';
import {
  type AgentEvent,
  type AgentRuntimeAdapter,
  type ApprovalCancelledEvent,
  type ApprovalRequestedEvent,
  type DeltaBlockRef,
  type EngineSession,
  isAdapterError,
  type SessionConfig,
  type SessionLostReason,
  type SubagentStartedEvent,
  type SubagentUpdatedEvent,
  type TurnStartedEvent,
  type TurnSteeredEvent,
} from '@wevir/runtime-adapter';
import {
  type ApprovalRecord,
  requestFingerprint,
  type SessionRecord,
  type Storage,
} from '@wevir/storage';
import { HostError, isHostError } from './errors.js';
import type { AppendInput, EventStore } from './event-store.js';
import { newId } from './ids.js';
import { TERMINAL_PENDING_STATUSES } from './snapshot.js';
import { parseGeneratedTitle, TITLE_OUTPUT_SCHEMA, TITLE_TIMEOUT_MS, titleInput } from './title.js';

/**
 * 取消后等回合结算的时限（domain-model §4.1 #9）。T0.3 实测 dsh 3–64 ms 结算；超过它仍没有终结
 * 事件，就当作无法确认已停止。
 */
export const CANCEL_TIMEOUT_MS = 5000;

/** 标题取首条用户消息的前多少个字符（按码点计，空白折叠成一个空格）。 */
export const TITLE_MAX_LENGTH = 50;

export interface SessionManagerOptions {
  storage: Storage;
  /** 与 `storage` 同一个数据库上的事件库；会话事件都经它写入。 */
  events: EventStore;
  /** 由 Host 独占的引擎适配器。SessionManager 不 `dispose` 它。 */
  adapter: AgentRuntimeAdapter;
  /** `sessions.engine` 列的值（`codex`、`dsh`、`echo`），默认 `dsh`（测试沿用）。 */
  engine?: string;
  /** 默认 `CANCEL_TIMEOUT_MS`。 */
  cancelTimeoutMs?: number;
  /** 后台错误：处理引擎事件失败、丢弃的引擎事件等。默认打到 stderr。 */
  onError?: (error: unknown) => void;
  /**
   * 生成会话标题用的说明（prompts/thread-title.md，`loadTitleInstructions`）。给了、并且适配器实现了
   * `generateTitle` 时，第一个回合开始后用会话的模型生成标题；否则只有首条消息截断的标题。
   */
  titleInstructions?: string;
  /** 不影响状态的告警（生成标题失败等）。默认打到 stderr。 */
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

/** `recover()` 的结果：启动对账修正了什么。 */
export interface RecoveryReport {
  /** 结为 `expired` 的审批数。 */
  expiredApprovals: number;
  /** 由活动状态修正为 `idle` 的会话（#15）。 */
  interruptedSessions: SessionId[];
  /** 标为结果未知的发送回执数。 */
  unknownSends: number;
}

interface ToolInfo {
  toolName: string;
  display: ToolDisplay;
  input?: unknown;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

/** 进行中的回合在 Host 内存里的部分：引擎 ID 到 Host ID 的映射、未收尾的工具。 */
interface TurnRuntime {
  readonly turnId: TurnId;
  /** 引擎的 attemptId → StreamId。 */
  readonly streams: Map<string, StreamId>;
  /** 已开始、未结束的工具调用，回合结束时补 `unknown`（domain-model §6.4）。 */
  readonly openTools: Set<string>;
  /** 本回合 `tool.started` 的内容，审批详情从这里取（domain-model §5 第 1 条）。 */
  readonly tools: Map<string, ToolInfo>;
  /** `turn.finished` 写入时完成。 */
  readonly finished: Deferred;
  /**
   * 回合在 `cancelling` 时加入的待发消息（R11，domain-model §4.6）：用户按了停止之后又发的，取消结算后不暂停、照常发出。
   * 只在内存里：Host 重启后一律暂停。
   */
  readonly addedWhileCancelling: Set<PendingMessageId>;
}

/** 一次对引擎事件流的订阅。 */
interface Attachment {
  readonly iterator: AsyncIterator<AgentEvent>;
  /** Host 主动断开（关闭、引擎异常、dispose）。之后到达的事件丢弃，流结束也不算中断。 */
  detached: boolean;
}

interface SessionRuntime {
  readonly id: SessionId;
  readonly engineSessionId: string;
  /** 子会话的父会话（R4，domain-model §3.3.1）。 */
  readonly parentId?: SessionId;
  /** 命令串行：每个命令排在上一个之后（ADR-0002 §4）。永不 reject。 */
  tail: Promise<unknown>;
  /** 没有时引擎会话尚未挂上：Host 重启后、关闭后、引擎异常后。 */
  attachment?: Attachment;
  turn?: TurnRuntime;
  /** 大于 0 时引擎事件先缓冲，等审批结算写入后再处理（domain-model §5 第 4 条）。 */
  holds: number;
  readonly held: Array<() => void>;
  /** 引擎的审批 requestId ↔ Host 的 ApprovalId，只保留未决的。 */
  readonly approvalIds: Map<string, ApprovalId>;
  readonly requestIds: Map<ApprovalId, string>;
}

const ACTIVE_STATES: readonly SessionState[] = ['running', 'awaiting_approval', 'cancelling'];

/** 引擎会话恢复不了的原因（适配器的 `session_lost`）→ 会话只读的原因。 */
const READ_ONLY_REASONS = {
  not_found: 'engine_session_not_found',
  incompatible: 'engine_session_incompatible',
  corrupted: 'engine_session_corrupted',
} as const satisfies Record<SessionLostReason, SessionReadOnlyReason>;

/**
 * 基于一个会话的历史新建会话（T3.5 只定接口，domain-model §4.4）：引擎会话恢复不了、会话只读之后的出路。
 * 新会话在原会话的工作区里建新的引擎会话，Provider 与模型默认沿用原会话；原会话的历史从事件库读，怎样交给新的
 * 引擎会话（整理成首个提示、摘要等）由实现决定，新会话的 `session.created` 记下来源。实现时 Host API 加对应的
 * 方法，并在 `HOST_FEATURES` 里声明，客户端据此显示入口。
 */
export interface SessionFromHistory {
  createFromHistory(
    sourceSessionId: SessionId,
    options?: { providerId?: ProviderId; modelId?: string; reasoningEffort?: string },
  ): Promise<Session>;
}

/** 适配器结掉审批的原因 → Host 的审批结算原因。 */
const ENGINE_CANCEL_REASONS = {
  turn_cancelled: 'turn_cancelled',
  turn_ended: 'turn_cancelled',
  engine_exited: 'engine_exited',
  disposed: 'host_shutdown',
} as const satisfies Record<ApprovalCancelledEvent['reason'], ApprovalResolution['reason']>;

/**
 * 会话管理器（T2.3）：把 `AgentRuntimeAdapter` 与事件库连起来，落地会话状态机（domain-model §4）与
 * 审批生命周期（§5）。
 *
 * - **映射。** Wevir 会话与引擎会话一一对应，映射存在 `sessions` 表；适配器的事件按会话订阅，
 *   Host 配上 `turnId`、`StreamId`、`ApprovalId` 写成 WevirEvent。
 * - **命令串行。** 每个会话的 `send`、`cancel`、`respondToApproval`、`close`、`resume` 排队执行。
 *   引擎事件不排队，随到随写；两者都是同步写库，不会交错出半个状态转换。
 * - **状态机。** 每次转换的全部事件在一个事务里写入，事件库按 §4.1 的表校验。命令在不允许的状态下
 *   返回 `SESSION_BUSY` / `INVALID_STATE` / `ALREADY_DECIDED`（§4.2）。
 * - **引擎异常。** 进程退出、适配器调用失败、事件流中断都当作引擎不可用：未决审批结为 `cancelled`、
 *   回合以 `interrupted` 结束、写 `engine.error`（`fatal: true`），会话转 `error`（#10），历史保留，
 *   `resume` 可恢复。
 * - **启动对账。** `recover()` 在服务客户端之前调用一次（#15、§5 第 6 条、ADR-0002 §4）。
 * - **恢复（T3.5）。** 引擎会话由 `resume` 或 send 前的自动 resume 重新挂上，成功写 `session.resumed`（带引擎
 *   版本）。引擎不回放历史，界面历史、会话列表与标题都来自事件库。引擎报 `session_lost`（会话日志没了、格式
 *   不兼容或损坏）时写 `session.read_only`：之后 send 返回 `INVALID_STATE` 并带上原因，resume 仍会重试引擎。
 * - **子会话（R4，domain-model §3.3.1、§4.5）。** 适配器在父会话的流里报 `subagent.started` 时建子会话（写它自己的
 *   事件流与父会话的 `subagent.started`）并订阅它；它的回合由引擎开始（`turn.started`）；它的标题、状态、未决审批
 *   每变一次，在父会话的流里写 `subagent.updated`。客户端对子会话的 send、cancel、close、resume 一律
 *   `INVALID_STATE`；父会话被取消、关闭时级联取消它活动中的子会话（Codex 自己不级联）。
 */
export class SessionManager {
  readonly #storage: Storage;
  readonly #events: EventStore;
  readonly #adapter: AgentRuntimeAdapter;
  readonly #engine: string;
  readonly #cancelTimeoutMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #onWarning: (message: string, fields?: Record<string, unknown>) => void;
  readonly #titleInstructions: string | undefined;
  readonly #runtimes = new Map<SessionId, SessionRuntime>();
  /** `dispose` 时完成，让还在等引擎的命令（取消）不再等下去。 */
  readonly #whenDisposed = deferred();
  /** `shutdown()` 开始后为 true：新命令一律 `HOST_SHUTTING_DOWN`，已排队的照常执行。 */
  #shuttingDown = false;
  #shutdown: Promise<void> | undefined;
  #disposed = false;

  constructor(options: SessionManagerOptions) {
    this.#storage = options.storage;
    this.#events = options.events;
    this.#adapter = options.adapter;
    this.#engine = options.engine ?? 'dsh';
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
    this.#onError =
      options.onError ?? ((error) => console.error('[wevir-host] session manager:', error));
    this.#onWarning =
      options.onWarning ??
      ((message, fields) => console.warn('[wevir-host] session manager:', message, fields ?? ''));
    this.#titleInstructions = options.titleInstructions;
  }

  /**
   * Host 启动对账，在接受任何命令之前调用一次。上次 Host 非正常退出时：残留的未决审批结为
   * `expired`（`host_restarted`）；停在活动状态的会话补齐未收尾的工具、以 `interrupted` 结束回合并
   * 回到 `idle`（#15）；“已接受、未确认引擎收到”的发送回执标为 `unknown`，不自动重发。引擎会话都
   * 没有挂上，下一次 `send` 前自动 resume。
   */
  recover(): RecoveryReport {
    this.#assertOpen();
    const report: RecoveryReport = {
      expiredApprovals: 0,
      interruptedSessions: [],
      unknownSends: 0,
    };
    const records = this.#storage.sessions.list({
      includeRemovedWorkspaces: true,
      includeChildren: true,
    });
    for (const record of records) {
      const sessionId = record.id as SessionId;
      const snapshot = this.#events.snapshot(sessionId);
      if (!snapshot) continue;
      const { state, activeTurn, subagent } = snapshot.session;
      const active = ACTIVE_STATES.includes(state);
      if (!active && state === 'idle' && subagent?.status === 'running') {
        // 子会话还没开始过回合就随 Host 退出了：引擎侧的子 agent 不在了，免得一直显示“运行中”（domain-model §4.5）。
        this.#events.appendMany(sessionId, [
          engineError(
            {
              category: 'engine_exited',
              message: 'host restarted before the sub-agent session started a turn',
            },
            true,
          ),
          stateChanged('idle', 'error', 'engine_exited'),
        ]);
        this.#mirror(sessionId, record.parentSessionId as SessionId);
        continue;
      }
      // 等待中的待发消息（含回合刚完成、下一条还没来得及发出的）一律暂停，等用户继续（domain-model §4.6）。
      const holds = settlePendings(snapshot, () => 'held');
      if (!active && snapshot.pendingApprovals.length === 0) {
        if (holds.length > 0) this.#events.appendMany(sessionId, holds);
        continue;
      }

      const inputs = resolveAll(snapshot.pendingApprovals, 'expired', { reason: 'host_restarted' });
      if (active) {
        if (activeTurn) {
          inputs.push(
            ...finishTurn(
              activeTurn.turnId,
              this.#openToolsFromEvents(sessionId, activeTurn.turnId),
              'interrupted',
              durationSince(activeTurn.startedAt),
            ),
          );
        }
        inputs.push(stateChanged(state, 'idle', 'host_restarted'));
        report.interruptedSessions.push(sessionId);
      }
      inputs.push(...holds);
      this.#events.appendMany(sessionId, inputs);
      report.expiredApprovals += snapshot.pendingApprovals.length;
      if (record.parentSessionId !== undefined) {
        this.#mirror(sessionId, record.parentSessionId as SessionId);
      }
    }
    report.unknownSends = this.#storage.sendReceipts.markAcceptedAsUnknown(isoNow());
    return report;
  }

  /**
   * `session.create`：先建引擎会话，成功后才写 `session.created`（#1）。返回的会话是 `idle`、
   * `lastSeq` 为 1。
   */
  async create(params: MethodParams<'session.create'>): Promise<Session> {
    this.#assertOpen();
    const workspace = this.#storage.workspaces.get(params.workspaceId);
    if (!workspace || workspace.removedAt !== undefined) {
      throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${params.workspaceId} not found`);
    }
    const provider = this.#storage.providers.get(params.providerId);
    if (!provider) {
      throw new HostError('PROVIDER_NOT_FOUND', `provider ${params.providerId} not found`);
    }
    await assertDirectory(workspace.rootPath);

    const config: SessionConfig = {
      cwd: workspace.rootPath,
      providerId: provider.id,
      modelId: params.modelId ?? provider.defaultModelId,
    };
    if (params.reasoningEffort !== undefined) config.reasoningEffort = params.reasoningEffort;
    let engineSession: Awaited<ReturnType<AgentRuntimeAdapter['createSession']>>;
    try {
      engineSession = await this.#adapter.createSession(config);
    } catch (error) {
      const info = engineErrorInfo(error);
      throw new HostError('ENGINE_ERROR', info.message, info);
    }

    const sessionId = newId('ses');
    const now = isoNow();
    const modelId = engineSession.modelId ?? config.modelId;
    const reasoningEffort = engineSession.reasoningEffort ?? config.reasoningEffort;
    try {
      const record: SessionRecord = {
        id: sessionId,
        workspaceId: workspace.id,
        cwd: config.cwd,
        engine: this.#engine,
        engineSessionId: engineSession.engineSessionId,
        providerId: provider.id,
        modelId,
        title: '',
        titleSource: 'first_prompt',
        state: 'idle',
        lastSeq: 0,
        createdAt: now,
        updatedAt: now,
      };
      if (reasoningEffort !== undefined) record.reasoningEffort = reasoningEffort;
      this.#storage.sessions.insert(record);
      this.#events.append(sessionId, {
        type: 'session.created',
        source: 'host',
        payload: {
          workspaceId: params.workspaceId,
          cwd: config.cwd,
          providerId: provider.id,
          modelId,
          ...(reasoningEffort !== undefined && { reasoningEffort }),
          ...(engineSession.engineVersion !== undefined && {
            engineVersion: engineSession.engineVersion,
          }),
        },
      });
    } catch (error) {
      // 会话没建成，尽力回收引擎会话。
      await this.#adapter.close(engineSession.engineSessionId).catch(this.#onError);
      throw error;
    }

    const runtime = this.#runtime(sessionId);
    try {
      this.#attach(runtime);
    } catch (error) {
      this.#engineFailed(runtime, engineErrorInfo(error));
    }
    return this.#snapshot(runtime).session;
  }

  /**
   * `session.send`。`clientMessageId` 的幂等检查排在状态检查之前（domain-model §4.2）：同一 ID、同样
   * 的内容返回原结果，不再发给引擎；内容不同返回 `CLIENT_MESSAGE_CONFLICT`。会话活动中时，带 `delivery` 的成为待发消息
   * （R11，domain-model §4.6，不排进命令队列），不带的返回 `SESSION_BUSY`；`error` / `closed` 返回 `INVALID_STATE`。
   *
   * 接受后先写 `user.message`、`turn.started`、（首个回合的）`session.title_changed` 和
   * idle→running，同一事务里记回执 `accepted`，再交给引擎；引擎确认收到后回执改为 `confirmed`。
   * 引擎拒收时会话转 `error`（#10），本次仍返回已接受的 `turnId` 与 `seq`，与重发时的“原结果”一致。
   */
  async send(
    params: MethodParams<'session.send'>,
    sentBy: ClientIdentity,
  ): Promise<MethodResult<'session.send'>> {
    this.#assertOpen();
    const runtime = this.#runtime(params.sessionId);
    const { clientMessageId } = params;
    const fingerprint = requestFingerprint(params.content);
    // 到达时先查一遍：会话忙就立即返回，不排在进行中的命令（例如等结算的取消）后面。回执只增不删，
    // 在命令队列外读也安全；进入队列后再查一遍。
    const replayed = this.#replay(runtime, clientMessageId, fingerprint);
    if (replayed) return replayed;
    this.#assertNotChild(runtime);
    const snapshot = this.#snapshot(runtime);
    if (params.delivery !== undefined && ACTIVE_STATES.includes(snapshot.session.state)) {
      return this.#addPending(runtime, params, sentBy, fingerprint);
    }
    assertSendable(snapshot);
    return this.#serial(runtime, async () => {
      const replayed = this.#replay(runtime, clientMessageId, fingerprint);
      if (replayed) return replayed;
      const snapshot = this.#snapshot(runtime);
      if (params.delivery !== undefined && ACTIVE_STATES.includes(snapshot.session.state)) {
        return this.#addPending(runtime, params, sentBy, fingerprint);
      }
      assertSendable(snapshot);
      return this.#startTurn(runtime, {
        content: params.content,
        sentBy,
        ...(clientMessageId !== undefined && { clientMessageId, fingerprint }),
      });
    });
  }

  /**
   * 开始一个回合（#2）：普通的 `send`，或发出一条排队的待发消息（R11，`pending`）。必要时先自动 resume（#11）；写
   * `user.message`、`turn.started`、（首个回合的）标题与 idle→running，普通发送在同一事务里记回执，发出待发消息时同一
   * 事务里把它标为 `sent`；再交给引擎。引擎拒收时会话转 `error`（#10），仍返回已接受的 `turnId` 与 `seq`。
   */
  async #startTurn(
    runtime: SessionRuntime,
    input: {
      content: UserContentPart[];
      sentBy: ClientIdentity;
      clientMessageId?: string;
      /** 普通发送带 `clientMessageId` 时记回执用。 */
      fingerprint?: string;
      pending?: PendingMessage;
    },
  ): Promise<{ turnId: TurnId; seq: number }> {
    const { content, sentBy, clientMessageId, fingerprint, pending } = input;
    if (!runtime.attachment) {
      await this.#autoResume(runtime);
      // 等待期间引擎可能已经报了退出。
      assertSendable(this.#snapshot(runtime));
    }

    const snapshot = this.#snapshot(runtime);
    const turnId = newId('trn');
    const inputs: AppendInput[] = [
      {
        type: 'user.message',
        source: 'host',
        payload: {
          turnId,
          content,
          sentBy,
          ...(clientMessageId !== undefined && { clientMessageId }),
          ...(pending !== undefined && { pendingId: pending.id }),
        },
      },
      { type: 'turn.started', source: 'host', payload: { turnId } },
    ];
    if (pending !== undefined) {
      inputs.push(pendingUpdated({ ...pending, status: 'sent', turnId, updatedAt: isoNow() }));
    }
    const title = makeTitle(content);
    const firstTitle =
      title !== '' &&
      snapshot.session.title === '' &&
      snapshot.session.titleSource === 'first_prompt';
    if (firstTitle) {
      inputs.push({
        type: 'session.title_changed',
        source: 'host',
        payload: { title, source: 'first_prompt' },
      });
    }
    inputs.push(stateChanged('idle', 'running', 'turn_started'));
    const receipt =
      pending === undefined && fingerprint !== undefined ? clientMessageId : undefined;
    const [message] = this.#write(runtime, inputs, {
      inTransaction: (events) => {
        const event = events[0];
        if (receipt === undefined || fingerprint === undefined || !event) return;
        this.#storage.sendReceipts.insert({
          sessionId: runtime.id,
          clientMessageId: receipt,
          fingerprint,
          status: 'accepted',
          turnId,
          seq: event.seq,
          createdAt: event.ts,
          updatedAt: event.ts,
        });
      },
    });
    if (!message) throw new Error('user.message 未写入');
    runtime.turn = {
      turnId,
      streams: new Map(),
      openTools: new Set(),
      tools: new Map(),
      finished: deferred(),
      addedWhileCancelling: new Set(),
    };

    try {
      await this.#adapter.send(runtime.engineSessionId, { content });
    } catch (error) {
      // 引擎没有接受这个回合。等待期间回合可能已经以别的方式结束（例如引擎退出）。
      if (runtime.turn?.turnId === turnId) this.#engineFailed(runtime, engineErrorInfo(error));
      return { turnId, seq: message.seq };
    }
    if (receipt !== undefined) {
      this.#storage.sendReceipts.setStatus(runtime.id, receipt, 'confirmed', isoNow());
    }
    // 截断的标题已经写下；引擎接受了第一个回合，再用会话的模型生成标题（不等它）。
    if (firstTitle) this.#generateTitle(runtime, content);
    return { turnId, seq: message.seq };
  }

  // ── 待发消息（R11，domain-model §3.3.2、§4.6） ──────────────────────────────────

  /**
   * 回合进行中带 `delivery` 的 `send`：写 `pending.added`（同一事务里记回执，回执的 `turnId` 列放待发消息 ID），插话且
   * 引擎能插话时再交给引擎。引擎不能插话、或回合正在取消时直接以排队加入并记下原因。不排进命令队列。
   */
  async #addPending(
    runtime: SessionRuntime,
    params: MethodParams<'session.send'>,
    sentBy: ClientIdentity,
    fingerprint: string,
  ): Promise<MethodResult<'session.send'>> {
    const { state } = this.#snapshot(runtime).session;
    const wantsSteer = params.delivery === 'steer';
    const steerable = wantsSteer && state !== 'cancelling' && this.#adapter.steer !== undefined;
    const now = isoNow();
    const pending: PendingMessage = {
      id: newId('pnd'),
      content: params.content,
      delivery: steerable ? 'steer' : 'queue',
      status: 'waiting',
      sentBy,
      createdAt: now,
      updatedAt: now,
    };
    if (params.clientMessageId !== undefined) pending.clientMessageId = params.clientMessageId;
    if (wantsSteer && !steerable) {
      pending.fallback = { reason: state === 'cancelling' ? 'turn_ended' : 'unsupported' };
    }
    const { clientMessageId } = params;
    const [event] = this.#write(
      runtime,
      [{ type: 'pending.added', source: 'host', payload: { pending } }],
      {
        inTransaction: (events) => {
          const added = events[0];
          if (clientMessageId === undefined || !added) return;
          this.#storage.sendReceipts.insert({
            sessionId: runtime.id,
            clientMessageId,
            fingerprint,
            status: 'confirmed',
            turnId: pending.id,
            seq: added.seq,
            createdAt: added.ts,
            updatedAt: added.ts,
          });
        },
      },
    );
    if (!event) throw new Error('pending.added 未写入');
    if (state === 'cancelling') runtime.turn?.addedWhileCancelling.add(pending.id);
    if (steerable) await this.#handOver(runtime, pending);
    return { pendingId: pending.id, seq: event.seq };
  }

  /**
   * 把插话交给引擎（`steer`）。引擎拒绝（或调用失败）时，它若仍是等待中的插话，就改为排队并记下原因；等待期间回合
   * 可能已经结束、它已被改为排队或已插入，那时什么都不做。
   */
  async #handOver(runtime: SessionRuntime, pending: PendingMessage): Promise<void> {
    const steer = this.#adapter.steer?.bind(this.#adapter);
    if (steer === undefined) return;
    try {
      await steer(runtime.engineSessionId, pending.id, { content: pending.content });
    } catch (error) {
      if (this.#disposed) return;
      const current = this.#events.pending(runtime.id, pending.id);
      if (current?.status !== 'waiting' || current.delivery !== 'steer') return;
      this.#write(runtime, [
        pendingUpdated({
          ...current,
          delivery: 'queue',
          fallback: { reason: 'rejected', message: errorText(error) },
          updatedAt: isoNow(),
        }),
      ]);
    }
  }

  /** `pending.update`：改内容或方式（domain-model §4.6 的表）。 */
  async updatePending(params: MethodParams<'pending.update'>): Promise<PendingMessage> {
    this.#assertOpen();
    const runtime = this.#runtime(params.sessionId);
    const pending = this.#requirePending(runtime, params.pendingId);
    if (isTerminalPending(pending)) throw notEditable(pending);
    const handedOver = pending.status === 'waiting' && pending.delivery === 'steer';
    if (handedOver) {
      // 插话已交给引擎，没有撤回的办法；只有“改成插话”是无操作。
      if (params.content !== undefined || params.delivery === 'queue') throw notEditable(pending);
      return pending;
    }
    const next: PendingMessage = { ...pending };
    let changed = false;
    if (params.content !== undefined && !isDeepStrictEqual(params.content, pending.content)) {
      next.content = params.content;
      changed = true;
    }
    let handOver = false;
    if (params.delivery === 'steer') {
      if (pending.status === 'held') throw notEditable(pending);
      const { state } = this.#snapshot(runtime).session;
      if (state === 'running' || state === 'awaiting_approval') {
        if (this.#adapter.steer !== undefined) {
          next.delivery = 'steer';
          delete next.fallback;
          handOver = true;
        } else {
          next.fallback = { reason: 'unsupported' };
        }
      } else {
        next.fallback = { reason: 'turn_ended' };
      }
      changed ||= !isDeepStrictEqual(next, pending);
    }
    if (!changed) return pending;
    next.updatedAt = isoNow();
    this.#write(runtime, [pendingUpdated(next)]);
    if (handOver) await this.#handOver(runtime, next);
    return this.#events.pending(runtime.id, next.id) ?? next;
  }

  /** `pending.cancel`：删掉排队的或暂停的；已取消的无操作，交出去的插话与已到终态的不行。 */
  cancelPending(params: MethodParams<'pending.cancel'>): PendingMessage {
    this.#assertOpen();
    const runtime = this.#runtime(params.sessionId);
    const pending = this.#requirePending(runtime, params.pendingId);
    if (pending.status === 'cancelled') return pending;
    if (
      isTerminalPending(pending) ||
      (pending.status === 'waiting' && pending.delivery === 'steer')
    ) {
      throw notEditable(pending);
    }
    const cancelled: PendingMessage = { ...pending, status: 'cancelled', updatedAt: isoNow() };
    this.#write(runtime, [pendingUpdated(cancelled)]);
    return cancelled;
  }

  /**
   * `pending.resume`：暂停的全部转为等待；会话空闲时随后发出第一条（排进命令队列，等它开始再返回），活动中时等回合
   * 结束。`error` / `closed` 回 `INVALID_STATE`。返回未到终态的待发消息。
   */
  async resumePending(sessionId: SessionId): Promise<PendingMessage[]> {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    this.#assertNotChild(runtime);
    const snapshot = this.#snapshot(runtime);
    const { state } = snapshot.session;
    if (state === 'error' || state === 'closed') {
      throw new HostError('INVALID_STATE', `session is ${state}; resume it first`, { state });
    }
    const now = isoNow();
    const held = (snapshot.pendingMessages ?? []).filter((pending) => pending.status === 'held');
    if (held.length > 0) {
      this.#write(
        runtime,
        held.map((pending) => pendingUpdated({ ...pending, status: 'waiting', updatedAt: now })),
      );
      // 停止过程中让它们继续的：与停止过程中发的一样，取消结算后照常发出。
      if (state === 'cancelling') {
        for (const pending of held) runtime.turn?.addedWhileCancelling.add(pending.id);
      }
    }
    if (state === 'idle') await this.#scheduleDispatch(runtime);
    return this.#snapshot(runtime).pendingMessages ?? [];
  }

  /** 排进命令队列：会话空闲、有等待中的排队消息时发出第一条。失败经事件体现，这里只记下。 */
  #scheduleDispatch(runtime: SessionRuntime): Promise<void> {
    return this.#serial(runtime, () => this.#dispatchNext(runtime)).catch((error: unknown) => {
      if (!isHostError(error)) this.#onError(error);
    });
  }

  async #dispatchNext(runtime: SessionRuntime): Promise<void> {
    if (this.#shuttingDown || this.#disposed) return;
    const before = this.#snapshot(runtime);
    if (before.session.state !== 'idle') return;
    if (!before.pendingMessages?.some((pending) => pending.status === 'waiting')) return;
    // 先把引擎会话挂上（失败时 #11 会把等待中的暂停），之后到写事件之间没有等待，取的就是此刻的第一条。
    if (!runtime.attachment) await this.#autoResume(runtime);
    const snapshot = this.#snapshot(runtime);
    if (snapshot.session.state !== 'idle') return;
    const next = snapshot.pendingMessages?.find((pending) => pending.status === 'waiting');
    if (next === undefined) return;
    await this.#startTurn(runtime, {
      content: next.content,
      sentBy: next.sentBy,
      ...(next.clientMessageId !== undefined && { clientMessageId: next.clientMessageId }),
      pending: next,
    });
  }

  /** 插话进了回合（适配器的 `turn.steered`）：写 `user.steered` 并把它标为已插入。 */
  #steered(runtime: SessionRuntime, turn: TurnRuntime, event: TurnSteeredEvent): void {
    const pending = this.#events.pending(runtime.id, event.steerId as PendingMessageId);
    if (pending === undefined || isTerminalPending(pending)) {
      this.#onWarning('引擎报告插话进了回合，但没有对应的待发消息', {
        sessionId: runtime.id,
        steerId: event.steerId,
      });
      return;
    }
    const { fallback: _fallback, ...rest } = pending;
    this.#write(runtime, [
      {
        type: 'user.steered',
        source: 'host',
        payload: {
          turnId: turn.turnId,
          pendingId: pending.id,
          content: pending.content,
          sentBy: pending.sentBy,
          ...(pending.clientMessageId !== undefined && {
            clientMessageId: pending.clientMessageId,
          }),
        },
      },
      pendingUpdated({
        ...rest,
        delivery: 'steer',
        status: 'inserted',
        turnId: turn.turnId,
        updatedAt: isoNow(),
      }),
    ]);
  }

  #requirePending(runtime: SessionRuntime, pendingId: PendingMessageId): PendingMessage {
    const pending = this.#events.pending(runtime.id, pendingId);
    if (pending === undefined) {
      throw new HostError('PENDING_NOT_FOUND', `pending message ${pendingId} not found`);
    }
    return pending;
  }

  /**
   * `session.cancel`。活动中：未决审批结为 `cancelled`（`turn_cancelled`），会话转 `cancelling`，
   * 再让引擎取消（#5）；等到回合结算（#8）才返回，超过 `cancelTimeoutMs` 或引擎报
   * `cancel_unconfirmed` 时转 `error`（#9）。其他状态成功、无操作。
   */
  async cancel(sessionId: SessionId): Promise<void> {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    this.#assertNotChild(runtime);
    await Promise.all([
      this.#serial(runtime, () => this.#cancelTurn(runtime, 'turn_cancelled')),
      this.#cancelChildren(runtime, 'turn_cancelled'),
    ]);
  }

  /**
   * `session.configure`（0.9.0）：换模型或推理档位，从下一个回合起生效，进行中的回合不受影响。`modelId` 要在会话所用
   * Provider 的模型列表里（Provider 列了模型时）；`reasoningEffort` 为 null、或换了模型而没给时清掉。值变了时先交给引擎
   * （引擎会话没挂着时不交，之后 resume 的配置里就是新的值），再写 `session.configured`。子会话与只读会话回
   * `INVALID_STATE`；引擎不支持时回 `ENGINE_ERROR`。
   */
  async configure(params: MethodParams<'session.configure'>): Promise<Session> {
    this.#assertOpen();
    const runtime = this.#runtime(params.sessionId);
    this.#assertNotChild(runtime);
    const configureSession = this.#adapter.configureSession?.bind(this.#adapter);
    if (configureSession === undefined) {
      const message =
        'this host engine cannot change the model of a session (use the Codex engine)';
      throw new HostError('ENGINE_ERROR', message, { category: 'unknown', message });
    }
    return this.#serial(runtime, async () => {
      const { session } = this.#snapshot(runtime);
      if (session.readOnly !== undefined) {
        throw new HostError('INVALID_STATE', 'session is read-only', {
          state: session.state,
          readOnly: session.readOnly,
        });
      }
      const modelId = params.modelId ?? session.modelId;
      const models = (this.#storage.providers.get(session.providerId)?.models ?? []) as {
        id: string;
      }[];
      if (models.length > 0 && !models.some((model) => model.id === modelId)) {
        throw new HostError('INVALID_PARAMS', `provider has no model ${modelId}`, {
          issues: [
            {
              path: ['modelId'],
              message: `provider ${session.providerId} has no model ${modelId}`,
            },
          ],
        });
      }
      const reasoningEffort =
        params.reasoningEffort === null
          ? undefined
          : (params.reasoningEffort ??
            (modelId === session.modelId ? session.reasoningEffort : undefined));
      if (modelId === session.modelId && reasoningEffort === session.reasoningEffort) {
        return session;
      }
      if (runtime.attachment) {
        try {
          await configureSession(runtime.engineSessionId, {
            modelId,
            ...(reasoningEffort !== undefined && { reasoningEffort }),
          });
        } catch (error) {
          if (isAdapterError(error, 'invalid_input')) {
            throw new HostError('INVALID_PARAMS', errorText(error), {
              issues: [{ path: ['modelId'], message: errorText(error) }],
            });
          }
          const info = engineErrorInfo(error, 'unknown');
          throw new HostError('ENGINE_ERROR', info.message, info);
        }
      }
      this.#write(runtime, [
        {
          type: 'session.configured',
          source: 'host',
          payload: { modelId, ...(reasoningEffort !== undefined && { reasoningEffort }) },
        },
      ]);
      return this.#snapshot(runtime).session;
    });
  }

  /**
   * `session.close`。活动中先按 #5 取消（审批原因 `session_closed`）并等结算（#8 / #9），然后关闭引擎
   * 会话、转 `closed`（#13、#14）。引擎关闭失败不阻止关闭，记一条 `engine.error`。已关闭时成功、
   * 无操作。
   */
  async close(sessionId: SessionId): Promise<void> {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    this.#assertNotChild(runtime);
    // 活动中的子会话一并取消，但不关闭（domain-model §4.5）。
    await this.#cancelChildren(runtime, 'turn_cancelled');
    await this.#serial(runtime, async () => {
      let { state } = this.#snapshot(runtime).session;
      if (state === 'closed') return;
      if (ACTIVE_STATES.includes(state)) {
        await this.#cancelTurn(runtime, 'session_closed');
        state = this.#snapshot(runtime).session.state;
      }
      if (state !== 'idle' && state !== 'error') {
        throw new Error(`会话 ${runtime.id} 取消后仍是 ${state}`);
      }

      const inputs: AppendInput[] = [];
      const attachment = runtime.attachment;
      if (attachment) {
        // 关闭会结束事件流，这是预期的。
        attachment.detached = true;
        try {
          await this.#adapter.close(runtime.engineSessionId);
        } catch (error) {
          inputs.push(engineError(engineErrorInfo(error, 'session_unavailable'), false));
        }
        this.#detach(runtime);
      }
      inputs.push(
        stateChanged(state, 'closed', 'closed'),
        ...settlePendings(this.#snapshot(runtime), () => 'held'),
      );
      this.#write(runtime, inputs);
    });
  }

  /**
   * `session.resume`：`error` / `closed` 时把引擎会话重新挂上（创建时的 cwd），成功后写 `session.resumed` 并转
   * `idle`（#12）；其他状态成功、无操作。工作区目录不在了返回 `WORKSPACE_PATH_INVALID`，不写事件。引擎拒绝时
   * 追加一条 `engine.error`（`session_unavailable`）、状态不变，返回 `ENGINE_ERROR`；引擎会话恢复不了
   * （`session_lost`）时另写 `session.read_only`。只读的会话照样重试引擎（引擎数据可能已经找回），成功即解除。
   */
  async resume(sessionId: SessionId): Promise<Session> {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    this.#assertNotChild(runtime);
    return this.#serial(runtime, async () => {
      const snapshot = this.#snapshot(runtime);
      const { session } = snapshot;
      if (session.state !== 'error' && session.state !== 'closed') return session;
      const record = this.#record(runtime);
      if (!this.#storage.providers.get(record.providerId)) {
        throw new HostError('PROVIDER_NOT_FOUND', `provider ${record.providerId} not found`);
      }
      await assertDirectory(record.cwd);
      let engine: EngineSession;
      try {
        engine = await this.#adapter.resumeSession(runtime.engineSessionId, sessionConfig(record));
        if (!runtime.attachment) this.#attach(runtime);
      } catch (error) {
        const info = engineErrorInfo(error, 'session_unavailable');
        this.#write(runtime, [engineError(info, false), ...readOnlyInputs(snapshot, error)]);
        throw new HostError('ENGINE_ERROR', info.message, info);
      }
      this.#write(runtime, [resumedEvent(engine), stateChanged(session.state, 'idle', 'resumed')]);
      return this.#snapshot(runtime).session;
    });
  }

  /**
   * `approval.respond`，按会话串行，首个决定生效（domain-model §5）。提交到引擎期间暂扣该会话的引擎
   * 事件，引擎确认后先写 `approval.resolved`（带 `decidedBy`）、必要时 awaiting_approval→running，
   * 再处理暂扣的事件。审批已结算时返回 `ALREADY_DECIDED` 与既有决定；`optionId` 不在选项里返回
   * `INVALID_PARAMS`，审批不变。引擎回复失败当作引擎异常（#10），审批随之结为 `cancelled`，本次
   * 同样返回 `ALREADY_DECIDED`。
   */
  async respondToApproval(
    params: MethodParams<'approval.respond'>,
    decidedBy: ClientIdentity,
  ): Promise<MethodResult<'approval.respond'>> {
    this.#assertOpen();
    const { approvalId, optionId } = params;
    const found = this.#storage.approvals.get(approvalId);
    if (!found) throw new HostError('APPROVAL_NOT_FOUND', `approval ${approvalId} not found`);
    const runtime = this.#runtime(found.sessionId as SessionId, 'APPROVAL_NOT_FOUND');
    return this.#serial(runtime, async () => {
      const approval = this.#approvalRecord(approvalId);
      if (approval.status !== 'pending') throw alreadyDecided(approval);
      const option = (approval.options as ApprovalOption[]).find((o) => o.optionId === optionId);
      if (!option) throw invalidOption(approvalId, optionId);
      const requestId = runtime.requestIds.get(approvalId);
      if (requestId === undefined) throw new Error(`审批 ${approvalId} 没有对应的引擎请求`);

      const status: ResolvedApprovalStatus = option.category === 'allow' ? 'approved' : 'denied';
      const resolution: ApprovalResolution = { reason: 'user', optionId, decidedBy };
      let failure: { error: unknown } | undefined;
      runtime.holds += 1;
      try {
        try {
          await this.#adapter.respondToApproval(runtime.engineSessionId, requestId, { optionId });
        } catch (error) {
          failure = { error };
        }
        if (!failure) {
          const snapshot = this.#snapshot(runtime);
          const inputs: AppendInput[] = [resolved(approvalId, status, resolution)];
          if (
            snapshot.session.state === 'awaiting_approval' &&
            snapshot.pendingApprovals.every((pending) => pending.id === approvalId)
          ) {
            inputs.push(stateChanged('awaiting_approval', 'running', 'approvals_settled'));
          }
          this.#write(runtime, inputs);
        } else if (
          // approval_not_found：引擎侧已经结束了这个审批，它的 approval.cancelled 在暂扣的事件里。
          !isAdapterError(failure.error, 'invalid_option') &&
          !isAdapterError(failure.error, 'approval_not_found')
        ) {
          this.#engineFailed(runtime, engineErrorInfo(failure.error));
        }
      } finally {
        this.#release(runtime);
      }

      if (!failure) return { approvalId, status, resolution };
      if (isAdapterError(failure.error, 'invalid_option'))
        throw invalidOption(approvalId, optionId);
      const after = this.#approvalRecord(approvalId);
      if (after.status !== 'pending') throw alreadyDecided(after);
      throw new Error(`引擎报告审批 ${approvalId} 已不在未决状态，但没有上报结束事件`);
    });
  }

  /**
   * Host 优雅退出的“取消运行中的回合”一步（ADR-0002 §6）：之后到达的命令返回
   * `HOST_SHUTTING_DOWN`；每个会话排在已有命令之后，活动中的按 #5 取消，未决审批结为 `cancelled`
   * （`host_shutdown`，domain-model §5 第 5 条），等结算（#8）或判定无法确认（#9）；最后 `dispose()`。
   * 各会话并行，单个会话最多等 `cancelTimeoutMs`。不 `dispose` 适配器。可重复调用，返回同一个
   * Promise。
   */
  shutdown(): Promise<void> {
    this.#shutdown ??= this.#runShutdown();
    return this.#shutdown;
  }

  async #runShutdown(): Promise<void> {
    this.#shuttingDown = true;
    await Promise.all(
      [...this.#runtimes.values()].map((runtime) =>
        this.#serial(runtime, () => this.#cancelTurn(runtime, 'host_shutdown')).catch(
          this.#onError,
        ),
      ),
    );
    await this.dispose();
  }

  /**
   * 停止消费引擎事件，之后不再写任何事件（不 `dispose` 适配器），等进行中的命令结束：还在等引擎的
   * 命令照常等适配器返回，然后以 `HOST_SHUTTING_DOWN` 失败。之后的调用同样返回
   * `HOST_SHUTTING_DOWN`。Host 优雅退出时用 `shutdown()`，它先取消回合再调用这里。
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#whenDisposed.resolve();
    for (const runtime of this.#runtimes.values()) this.#detach(runtime);
    await Promise.all([...this.#runtimes.values()].map((runtime) => runtime.tail));
  }

  /**
   * 用会话的模型生成标题（prompts/README.md「会话标题」）：适配器发一次不带工具的请求，Host 解析并整理输出。成功、
   * 且这时标题仍是首条消息截断的那个（用户没有改过名）才写 `session.title_changed`（`generated`，带检索摘要）；
   * 失败或超时只记告警，保留截断的标题。不排进会话的命令队列，也不影响状态机。
   */
  #generateTitle(runtime: SessionRuntime, content: readonly UserContentPart[]): void {
    const instructions = this.#titleInstructions;
    const generate = this.#adapter.generateTitle?.bind(this.#adapter);
    if (instructions === undefined || generate === undefined) return;
    const prompt = content.map((part) => part.text).join('\n');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TITLE_TIMEOUT_MS);
    const stop = () => abort.abort();
    void this.#whenDisposed.promise.then(stop);
    generate(runtime.engineSessionId, {
      instructions,
      input: titleInput(prompt),
      outputSchema: { ...TITLE_OUTPUT_SCHEMA },
      signal: abort.signal,
    })
      .then((output) => {
        if (this.#disposed || abort.signal.aborted) return;
        const generated = parseGeneratedTitle(output);
        if (generated === undefined) {
          this.#onWarning('生成的会话标题无法解析，保留截断的标题', {
            sessionId: runtime.id,
            output: output.slice(0, 500),
          });
          return;
        }
        // 等待期间用户可能改了名，或者标题已经不是这次截断的那个。
        const { session } = this.#snapshot(runtime);
        if (session.titleSource !== 'first_prompt') return;
        this.#write(runtime, [
          {
            type: 'session.title_changed',
            source: 'host',
            payload: {
              title: generated.title,
              source: 'generated',
              ...(generated.description !== undefined && { description: generated.description }),
            },
          },
        ]);
      })
      .catch((error: unknown) => {
        if (this.#disposed) return;
        this.#onWarning('生成会话标题失败，保留截断的标题', {
          sessionId: runtime.id,
          error: abort.signal.aborted ? `${TITLE_TIMEOUT_MS} ms 内没有结果` : errorText(error),
        });
      })
      .finally(() => clearTimeout(timer));
  }

  // ── 命令的组成部分 ──────────────────────────────────────────────────

  /** `clientMessageId` 已有回执时：内容相同返回原结果，不同抛 `CLIENT_MESSAGE_CONFLICT`。 */
  #replay(
    runtime: SessionRuntime,
    clientMessageId: string | undefined,
    fingerprint: string,
  ): MethodResult<'session.send'> | undefined {
    if (clientMessageId === undefined) return undefined;
    const receipt = this.#storage.sendReceipts.get(runtime.id, clientMessageId);
    if (!receipt) return undefined;
    if (receipt.fingerprint !== fingerprint) {
      throw new HostError(
        'CLIENT_MESSAGE_CONFLICT',
        `clientMessageId ${clientMessageId} was used with a different request`,
        { clientMessageId },
      );
    }
    // 成为待发消息的发送（R11）：回执的 turnId 列放的是待发消息 ID。
    if (receipt.turnId.startsWith('pnd_')) {
      return { pendingId: receipt.turnId as PendingMessageId, seq: receipt.seq };
    }
    return { turnId: receipt.turnId as TurnId, seq: receipt.seq };
  }

  /**
   * send 前把尚未挂上的引擎会话挂上，成功写 `session.resumed`（状态仍是 idle）。工作区目录不在了返回
   * `WORKSPACE_PATH_INVALID`，状态不变；引擎失败时 idle→error（#11），返回 `ENGINE_ERROR`，引擎会话恢复不了时
   * 另写 `session.read_only`。
   */
  async #autoResume(runtime: SessionRuntime): Promise<void> {
    const record = this.#record(runtime);
    await assertDirectory(record.cwd);
    let engine: EngineSession;
    try {
      engine = await this.#adapter.resumeSession(runtime.engineSessionId, sessionConfig(record));
      this.#attach(runtime);
    } catch (error) {
      const info = engineErrorInfo(error, 'session_unavailable');
      const snapshot = this.#snapshot(runtime);
      if (snapshot.session.state === 'idle') {
        this.#write(runtime, [
          engineError(info, true),
          stateChanged('idle', 'error', 'resume_failed'),
          ...readOnlyInputs(snapshot, error),
          ...settlePendings(snapshot, () => 'held'),
        ]);
      }
      throw new HostError('ENGINE_ERROR', info.message, info);
    }
    // 等待期间引擎可能已经报了退出（会话转 error），那时不再记恢复。
    if (this.#snapshot(runtime).session.state === 'idle')
      this.#write(runtime, [resumedEvent(engine)]);
  }

  /** #5，然后等结算（#8）或判定无法确认（#9）。不在活动状态时什么都不做。 */
  async #cancelTurn(
    runtime: SessionRuntime,
    reason: 'turn_cancelled' | 'session_closed' | 'host_shutdown',
  ): Promise<void> {
    const snapshot = this.#snapshot(runtime);
    const { state } = snapshot.session;
    if (state === 'running' || state === 'awaiting_approval') {
      this.#write(runtime, [
        ...resolveAll(snapshot.pendingApprovals, 'cancelled', { reason }),
        stateChanged(state, 'cancelling', 'cancel_requested'),
      ]);
    } else if (state !== 'cancelling') {
      return;
    }
    // 等到回合结算（turn.finished 写入，可能经由引擎退出等别的路径）为止。引擎报取消失败、超时，
    // 或者没有内存里的回合可等，都按无法确认处理。
    const turn = runtime.turn;
    const deadline = Date.now() + this.#cancelTimeoutMs;
    const finished = turn ? turn.finished.promise.then(() => 'finished' as const) : never();
    const disposed = this.#whenDisposed.promise.then(() => 'disposed' as const);
    const engine = this.#adapter.cancel(runtime.engineSessionId).then(
      () => (turn ? ('confirmed' as const) : ('failed' as const)),
      () => 'failed' as const,
    );
    let outcome = await settleBy(Promise.race([finished, engine, disposed]), deadline);
    // 适配器返回时终结事件已经发出，等 Host 处理完。
    if (outcome === 'confirmed')
      outcome = await settleBy(Promise.race([finished, disposed]), deadline);
    if (outcome === 'finished' || outcome === 'disposed' || runtime.turn !== turn) return;

    // #9
    const { session } = this.#snapshot(runtime);
    if (session.state !== 'cancelling') return;
    const turnId = session.activeTurn?.turnId;
    this.#detach(runtime);
    this.#write(runtime, [
      engineError(
        {
          category: 'cancel_unconfirmed',
          message: `engine did not confirm the cancellation within ${this.#cancelTimeoutMs} ms`,
        },
        true,
        turnId,
      ),
      ...(turnId !== undefined
        ? finishTurn(turnId, turn?.openTools ?? [], 'interrupted', this.#turnDuration(runtime))
        : []),
      stateChanged('cancelling', 'error', 'cancel_unconfirmed'),
      ...settlePendings(this.#snapshot(runtime), () => 'held'),
    ]);
  }

  // ── 引擎事件 ──────────────────────────────────────────────────────

  /** 订阅引擎会话的事件并开始消费。`subscribe` 同步抛出的错误交给调用方。 */
  #attach(runtime: SessionRuntime): void {
    const iterator = this.#adapter.subscribe(runtime.engineSessionId)[Symbol.asyncIterator]();
    const attachment: Attachment = { iterator, detached: false };
    runtime.attachment = attachment;
    void this.#consume(runtime, attachment);
  }

  /** Host 主动断开当前订阅：之后的事件丢弃，流结束不算中断。 */
  #detach(runtime: SessionRuntime): void {
    const attachment = runtime.attachment;
    if (!attachment) return;
    runtime.attachment = undefined;
    attachment.detached = true;
    attachment.iterator.return?.().catch(this.#onError);
  }

  async #consume(runtime: SessionRuntime, attachment: Attachment): Promise<void> {
    let failure: EngineErrorInfo;
    try {
      for (;;) {
        const result = await attachment.iterator.next();
        if (attachment.detached) return;
        if (result.done) break;
        const event = result.value;
        this.#dispatch(runtime, () => this.#handle(runtime, event));
        // engine.exited 是该会话订阅的最后一个事件。
        if (event.type === 'engine.exited') return;
      }
      failure = { category: 'unknown', message: 'engine event stream ended unexpectedly' };
    } catch (error) {
      if (attachment.detached) return;
      failure = { category: 'unknown', message: `engine event stream failed: ${errorText(error)}` };
    }
    this.#dispatch(runtime, () => {
      if (runtime.attachment === attachment) this.#engineFailed(runtime, failure);
    });
  }

  /** 审批提交期间先缓冲，否则立即处理。处理失败交给 `onError`。 */
  #dispatch(runtime: SessionRuntime, task: () => void): void {
    if (runtime.holds > 0) {
      runtime.held.push(task);
      return;
    }
    try {
      task();
    } catch (error) {
      this.#onError(error);
    }
  }

  /** 解除一层暂扣；全部解除后按到达顺序处理缓冲的事件。 */
  #release(runtime: SessionRuntime): void {
    runtime.holds -= 1;
    // dispose 之后不再写事件，暂扣的事件随之丢弃。
    if (this.#disposed) runtime.held.length = 0;
    while (runtime.holds === 0 && runtime.held.length > 0) {
      const task = runtime.held.shift() as () => void;
      try {
        task();
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  /** 把一个引擎事件写成 WevirEvent（domain-model §6、§9）。 */
  #handle(runtime: SessionRuntime, event: AgentEvent): void {
    const sessionId = runtime.id;
    switch (event.type) {
      case 'engine.exited':
        this.#engineFailed(runtime, exitInfo(event), { exited: true });
        return;
      case 'engine.raw':
        this.#write(runtime, [
          {
            type: 'engine.raw',
            source: 'engine',
            payload: {
              protocol: event.protocol,
              method: event.method,
              ...(event.kind !== undefined && { kind: event.kind }),
              ...(event.params !== undefined && { params: event.params }),
            },
          },
        ]);
        return;
      case 'usage.updated':
        this.#write(runtime, [
          {
            type: 'usage.updated',
            source: 'engine',
            payload: { contextUsed: event.contextUsed, contextSize: event.contextSize },
          },
        ]);
        return;
      case 'subagent.started':
        this.#subagentStarted(runtime, event);
        return;
      case 'subagent.updated':
        this.#subagentUpdated(runtime, event);
        return;
      case 'turn.started':
        this.#engineTurnStarted(runtime, event);
        return;
    }

    // 其余事件都属于进行中的回合。
    const turn = runtime.turn;
    if (!turn) {
      // Host 已判定回合结束（取消超时、引擎异常、关闭）之后，引擎的残余事件是预期的。
      const { state } = this.#snapshot(runtime).session;
      if (state !== 'error' && state !== 'closed') {
        this.#onError(new Error(`会话 ${sessionId} 没有进行中的回合，丢弃引擎事件 ${event.type}`));
      }
      return;
    }
    const { turnId } = turn;
    switch (event.type) {
      case 'assistant.delta':
        this.#events.appendDelta(sessionId, {
          turnId,
          streamId: streamOf(turn, event.attemptId),
          blockIndex: event.blockIndex,
          kind: event.kind,
          text: event.text,
        });
        return;
      case 'assistant.stream_ended':
        this.#write(runtime, [
          {
            type: 'assistant.stream_ended',
            source: 'engine',
            payload: { turnId, streamId: streamOf(turn, event.attemptId), outcome: event.outcome },
          },
        ]);
        return;
      case 'assistant.message':
      case 'assistant.thought':
        this.#write(runtime, [
          {
            type: event.type,
            source: 'engine',
            payload: {
              turnId,
              messageId: event.messageId,
              text: event.text,
              replaces: blockRefs(turn, event.replaces),
            },
          },
        ]);
        return;
      case 'tool.started': {
        const info: ToolInfo = { toolName: event.toolName, display: event.display };
        if (event.input !== undefined) info.input = event.input;
        turn.tools.set(event.toolCallId, info);
        turn.openTools.add(event.toolCallId);
        this.#write(runtime, [
          {
            type: 'tool.started',
            source: 'engine',
            payload: { turnId, toolCallId: event.toolCallId, ...info },
          },
        ]);
        return;
      }
      case 'tool.updated': {
        // 审批详情取工具最新的展示与输入（Codex 在请求审批前补上命令的理由，codex-event-mapping.md §6.6）。
        const info = turn.tools.get(event.toolCallId);
        if (info) {
          if (event.display !== undefined) info.display = event.display;
          if (event.input !== undefined) info.input = event.input;
        }
        this.#write(runtime, [
          {
            type: 'tool.updated',
            source: 'engine',
            payload: {
              turnId,
              toolCallId: event.toolCallId,
              ...(event.display !== undefined && { display: event.display }),
              ...(event.input !== undefined && { input: event.input }),
              ...(event.output !== undefined && {
                output: { text: event.output, truncated: false },
              }),
            },
          },
        ]);
        return;
      }
      case 'tool.finished': {
        // 取消期间的 failed 记为 cancelled，原文保留（domain-model §6.4）。
        const cancelling = this.#snapshot(runtime).session.state === 'cancelling';
        turn.openTools.delete(event.toolCallId);
        this.#write(runtime, [
          {
            type: 'tool.finished',
            source: 'engine',
            payload: {
              turnId,
              toolCallId: event.toolCallId,
              status: event.status === 'failed' && cancelling ? 'cancelled' : event.status,
              ...(event.output !== undefined && {
                output: { text: event.output, truncated: false },
              }),
            },
          },
        ]);
        return;
      }
      case 'todo.updated':
        this.#write(runtime, [
          {
            type: 'todo.updated',
            source: 'host',
            payload: { turnId, toolCallId: event.toolCallId, items: event.items },
          },
        ]);
        return;
      case 'approval.requested':
        this.#approvalRequested(runtime, turn, event);
        return;
      case 'approval.cancelled':
        this.#approvalCancelled(runtime, event);
        return;
      case 'turn.steered':
        this.#steered(runtime, turn, event);
        return;
      case 'turn.settled':
        this.#turnEnded(runtime, turn, event.outcome, event.stopReason);
        return;
      case 'turn.failed':
        this.#turnEnded(runtime, turn, 'failed', undefined, {
          category: event.category,
          message: event.message,
          ...(event.code !== undefined && { code: event.code }),
        });
        return;
    }
  }

  /** #3：分配 ApprovalId，详情取自同一 toolCallId 的 `tool.started`。 */
  #approvalRequested(
    runtime: SessionRuntime,
    turn: TurnRuntime,
    event: ApprovalRequestedEvent,
  ): void {
    const { state } = this.#snapshot(runtime).session;
    const approvalId = newId('apr');
    const tool = turn.tools.get(event.toolCallId);
    const approval: ApprovalRequest = {
      id: approvalId,
      sessionId: runtime.id,
      turnId: turn.turnId,
      toolCallId: event.toolCallId,
      options: event.options.map((option) => ({
        optionId: option.optionId,
        label: option.label,
        kind: option.kind,
        category: option.kind.startsWith('allow_') ? 'allow' : 'reject',
      })),
      detail: tool ? approvalDetail(tool) : null,
      status: 'pending',
      createdAt: isoNow(),
    };
    runtime.approvalIds.set(event.requestId, approvalId);
    runtime.requestIds.set(approvalId, event.requestId);
    const inputs: AppendInput[] = [
      { type: 'approval.requested', source: 'engine', payload: { approval } },
    ];
    if (state === 'running') {
      inputs.push(stateChanged('running', 'awaiting_approval', 'approval_requested'));
    } else if (state === 'cancelling') {
      // 取消已经开始：照记这次请求，并立即结掉；引擎侧由适配器的取消一并回复。
      inputs.push(resolved(approvalId, 'cancelled', { reason: 'turn_cancelled' }));
    }
    this.#write(runtime, inputs);
  }

  /**
   * 引擎侧结掉的审批。Host 已经结算过的（取消、关闭）不再重复。原因是引擎退出时不在这里结算：随后的
   * `engine.exited` 一并处理，会话从 awaiting_approval 直接转 error（#10），不经过 running。
   */
  #approvalCancelled(runtime: SessionRuntime, event: ApprovalCancelledEvent): void {
    if (event.reason === 'engine_exited') return;
    const approvalId = runtime.approvalIds.get(event.requestId);
    if (approvalId === undefined) return;
    const snapshot = this.#snapshot(runtime);
    if (!snapshot.pendingApprovals.some((pending) => pending.id === approvalId)) return;
    const inputs: AppendInput[] = [
      resolved(approvalId, 'cancelled', { reason: ENGINE_CANCEL_REASONS[event.reason] }),
    ];
    if (snapshot.session.state === 'awaiting_approval' && snapshot.pendingApprovals.length === 1) {
      inputs.push(stateChanged('awaiting_approval', 'running', 'approvals_settled'));
    }
    this.#write(runtime, inputs);
  }

  // ── 子会话（R4，domain-model §3.3.1、§4.5） ─────────────────────────────

  /**
   * 适配器在父会话的流里报出一个子 agent（C1、C5）。没见过的引擎会话：建子会话（父会话的工作区、cwd 与 Provider，模型取
   * 适配器报的），写它的 `session.created`（带 `parent`）与兜底标题，再写父会话的 `subagent.started`，然后订阅它、用会话
   * 的模型生成标题。见过的（引擎重启后父 agent 又用到它）：重新订阅，`closed` / `error` 时恢复。
   */
  #subagentStarted(parent: SessionRuntime, event: SubagentStartedEvent): void {
    const existing = this.#storage.sessions.getByEngineSessionId(
      this.#engine,
      event.childEngineSessionId,
    );
    if (existing !== undefined) {
      if (existing.parentSessionId !== parent.id) {
        this.#onError(
          new Error(
            `引擎会话 ${event.childEngineSessionId} 已属于会话 ${existing.id}，不能当作 ${parent.id} 的子会话`,
          ),
        );
        return;
      }
      this.#reattachChild(this.#runtime(existing.id as SessionId));
      return;
    }
    const parentRecord = this.#record(parent);
    const childId = newId('ses');
    const now = isoNow();
    const modelId = event.modelId ?? parentRecord.modelId;
    const reasoningEffort =
      event.reasoningEffort ??
      (event.modelId === undefined ? parentRecord.reasoningEffort : undefined);
    const parentTurnId = parent.turn?.turnId;
    const record: SessionRecord = {
      id: childId,
      workspaceId: parentRecord.workspaceId,
      cwd: parentRecord.cwd,
      engine: this.#engine,
      engineSessionId: event.childEngineSessionId,
      providerId: parentRecord.providerId,
      modelId,
      parentSessionId: parent.id,
      parentToolCallId: event.parentToolCallId,
      title: '',
      titleSource: 'first_prompt',
      state: 'idle',
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (reasoningEffort !== undefined) record.reasoningEffort = reasoningEffort;
    this.#storage.sessions.insert(record);
    const child = this.#runtime(childId);
    const title = makeTitle([{ type: 'text', text: event.title }]);
    this.#write(child, [
      {
        type: 'session.created',
        source: 'host',
        payload: {
          workspaceId: parentRecord.workspaceId as WorkspaceId,
          cwd: parentRecord.cwd,
          providerId: parentRecord.providerId,
          modelId,
          ...(reasoningEffort !== undefined && { reasoningEffort }),
          parent: {
            sessionId: parent.id,
            toolCallId: event.parentToolCallId,
            ...(parentTurnId !== undefined && { turnId: parentTurnId }),
          },
        },
      },
      ...(title === ''
        ? []
        : [
            {
              type: 'session.title_changed',
              source: 'host',
              payload: { title, source: 'first_prompt' },
            } satisfies AppendInput,
          ]),
    ]);
    const summary = this.#summary(childId, {
      parentToolCallId: event.parentToolCallId,
      ...(parentTurnId !== undefined && { parentTurnId }),
      ...(event.nickname !== undefined && { nickname: event.nickname }),
      ...(event.role !== undefined && { role: event.role }),
    });
    this.#write(parent, [
      { type: 'subagent.started', source: 'host', payload: { subagent: summary } },
    ]);
    try {
      this.#attach(child);
    } catch (error) {
      this.#engineFailed(child, engineErrorInfo(error));
      return;
    }
    if (event.prompt !== undefined)
      this.#generateTitle(child, [{ type: 'text', text: event.prompt }]);
  }

  /** 子会话又被报出：重新订阅；`closed` / `error` 时恢复（C5）。 */
  #reattachChild(child: SessionRuntime): void {
    if (!child.attachment) {
      try {
        this.#attach(child);
      } catch (error) {
        this.#onError(error);
        return;
      }
    }
    const { state } = this.#snapshot(child).session;
    if (state === 'closed' || state === 'error') {
      this.#write(child, [
        { type: 'session.resumed', source: 'host', payload: {} },
        stateChanged(state, 'idle', 'resumed'),
      ]);
    }
  }

  /**
   * 子 agent 晚到的信息：新的兜底标题（标题仍是兜底的才换）、昵称与角色（只在父会话的摘要里）；`closed` 是父 agent 关掉了
   * 它（C4）。
   */
  #subagentUpdated(parent: SessionRuntime, event: SubagentUpdatedEvent): void {
    const record = this.#storage.sessions.getByEngineSessionId(
      this.#engine,
      event.childEngineSessionId,
    );
    if (record === undefined || record.parentSessionId !== parent.id) {
      this.#onError(
        new Error(`会话 ${parent.id} 没有引擎会话为 ${event.childEngineSessionId} 的子会话`),
      );
      return;
    }
    const child = this.#runtime(record.id as SessionId);
    if (event.title !== undefined) {
      const title = makeTitle([{ type: 'text', text: event.title }]);
      const { session } = this.#snapshot(child);
      if (title !== '' && session.titleSource === 'first_prompt' && session.title !== title) {
        this.#write(child, [
          {
            type: 'session.title_changed',
            source: 'host',
            payload: { title, source: 'first_prompt' },
          },
        ]);
      }
    }
    if (event.nickname !== undefined || event.role !== undefined) {
      this.#mirror(child.id, parent.id, {
        ...(event.nickname !== undefined && { nickname: event.nickname }),
        ...(event.role !== undefined && { role: event.role }),
      });
    }
    if (event.closed) this.#closeChild(child);
  }

  /**
   * 父 agent 关掉了子会话（C4）：回合进行中时先结掉（未决审批 `session_closed`、未收尾工具 `unknown`、回合 `cancelled`），
   * 再转 `closed`。不断开订阅：父 agent 可能又用到它（C5）；引擎随后报的这个回合的结算没有回合可对，丢弃。
   */
  #closeChild(child: SessionRuntime): void {
    const snapshot = this.#snapshot(child);
    let { state } = snapshot.session;
    const { activeTurn } = snapshot.session;
    if (state === 'closed') return;
    const inputs: AppendInput[] = [];
    if (activeTurn) {
      inputs.push(
        ...resolveAll(snapshot.pendingApprovals, 'cancelled', { reason: 'session_closed' }),
      );
      if (state === 'awaiting_approval') {
        inputs.push(stateChanged('awaiting_approval', 'running', 'approvals_settled'));
        state = 'running';
      }
      inputs.push(
        ...finishTurn(
          activeTurn.turnId,
          child.turn?.openTools ?? [],
          'cancelled',
          durationSince(activeTurn.startedAt),
        ),
        stateChanged(state, 'idle', 'turn_finished'),
      );
      state = 'idle';
    }
    inputs.push(stateChanged(state, 'closed', 'closed'));
    this.#write(child, inputs);
  }

  /** 子会话的回合由引擎开始（C2）：`closed` / `error` 时先恢复（C5），再 `turn.started`（带输入）并转 `running`。 */
  #engineTurnStarted(child: SessionRuntime, event: TurnStartedEvent): void {
    if (child.parentId === undefined) {
      this.#onError(new Error(`会话 ${child.id} 不是子会话，丢弃引擎开始的回合`));
      return;
    }
    if (child.turn) {
      this.#onError(
        new Error(`子会话 ${child.id} 的回合 ${child.turn.turnId} 尚未结束，丢弃引擎开始的回合`),
      );
      return;
    }
    const { state } = this.#snapshot(child).session;
    const inputs: AppendInput[] = [];
    if (state === 'closed' || state === 'error') {
      inputs.push(
        { type: 'session.resumed', source: 'host', payload: {} },
        stateChanged(state, 'idle', 'resumed'),
      );
    } else if (state !== 'idle') {
      this.#onError(new Error(`子会话 ${child.id} 是 ${state}，丢弃引擎开始的回合`));
      return;
    }
    const turnId = newId('trn');
    const input = event.input?.filter((part) => part.text !== '');
    inputs.push(
      {
        type: 'turn.started',
        source: 'host',
        payload: { turnId, ...(input !== undefined && input.length > 0 && { input }) },
      },
      stateChanged('idle', 'running', 'turn_started'),
    );
    this.#write(child, inputs);
    child.turn = {
      turnId,
      streams: new Map(),
      openTools: new Set(),
      tools: new Map(),
      finished: deferred(),
      addedWhileCancelling: new Set(),
    };
  }

  /**
   * 子会话的摘要变了就在父会话的流里写 `subagent.updated`（完整摘要）。父会话还没有这个子会话的摘要（`subagent.started`
   * 写下之前）时不写。`meta` 是适配器晚报的昵称与角色。
   */
  #mirror(
    childId: SessionId,
    parentId: SessionId | undefined,
    meta: Pick<SubagentSummary, 'nickname' | 'role'> = {},
  ): void {
    if (parentId === undefined || this.#disposed) return;
    const previous = this.#events
      .snapshot(parentId)
      ?.subagents?.find((summary) => summary.sessionId === childId);
    if (previous === undefined) return;
    const next = this.#summary(childId, { ...previous, ...meta });
    if (isDeepStrictEqual(next, previous)) return;
    this.#events.appendMany(parentId, [
      { type: 'subagent.updated', source: 'host', payload: { subagent: next } },
    ]);
  }

  /** 子会话的摘要：标题、模型、状态、起止时间与未决审批取自子会话的快照，其余取 `base`。 */
  #summary(
    childId: SessionId,
    base: Pick<SubagentSummary, 'parentToolCallId' | 'parentTurnId' | 'nickname' | 'role'>,
  ): SubagentSummary {
    const snapshot = this.#events.snapshot(childId);
    if (!snapshot) throw new Error(`会话 ${childId} 不存在`);
    const { session, pendingApprovals } = snapshot;
    const info = session.subagent;
    return {
      sessionId: childId,
      parentToolCallId: base.parentToolCallId,
      ...(base.parentTurnId !== undefined && { parentTurnId: base.parentTurnId }),
      title: session.title,
      modelId: session.modelId,
      ...(session.reasoningEffort !== undefined && { reasoningEffort: session.reasoningEffort }),
      ...(base.nickname !== undefined && { nickname: base.nickname }),
      ...(base.role !== undefined && { role: base.role }),
      status: info?.status ?? 'running',
      startedAt: info?.startedAt ?? session.createdAt,
      ...(info?.endedAt !== undefined && { endedAt: info.endedAt }),
      pendingApprovals,
    };
  }

  /**
   * 父会话被取消或关闭时级联取消子会话（domain-model §4.5：Codex 取消父回合时不动子 agent，ADR-0005 决策 6.1 要求取消
   * 父回合即取消它）：每个活动中的子会话（递归）排进它自己的命令队列按 #5 取消，等它们都结算。
   */
  async #cancelChildren(
    parent: SessionRuntime,
    reason: 'turn_cancelled' | 'host_shutdown',
  ): Promise<void> {
    const children = this.#storage.sessions.list({
      parentSessionId: parent.id,
      includeRemovedWorkspaces: true,
    });
    await Promise.all(
      children.map(async (record) => {
        const child = this.#runtime(record.id as SessionId);
        await Promise.all([
          this.#serial(child, () => this.#cancelTurn(child, reason)),
          this.#cancelChildren(child, reason),
        ]);
      }),
    );
  }

  /** 子会话由父 agent 驱动，客户端的 send、cancel、close、resume 都不接受（domain-model §3.3.1）。 */
  #assertNotChild(runtime: SessionRuntime): void {
    if (runtime.parentId === undefined) return;
    throw new HostError(
      'INVALID_STATE',
      'session is a sub-agent session; it is driven by its parent agent',
      { state: this.#snapshot(runtime).session.state, parentSessionId: runtime.parentId },
    );
  }

  /**
   * 回合结算（#6、#7、#8）：回合失败先写 `engine.error`（`fatal: false`）；仍未决的审批结为
   * `cancelled`；未收尾的工具补 `unknown`；`turn.finished`；回到 `idle`。取消期间的失败记为
   * `cancelled`。
   */
  #turnEnded(
    runtime: SessionRuntime,
    turn: TurnRuntime,
    outcome: TurnOutcome,
    engineStopReason?: string,
    error?: EngineErrorInfo & { code?: number },
  ): void {
    const snapshot = this.#snapshot(runtime);
    let state = snapshot.session.state;
    const inputs: AppendInput[] = [];
    if (error) {
      inputs.push({
        type: 'engine.error',
        source: 'engine',
        payload: { ...error, turnId: turn.turnId, fatal: false },
      });
    }
    // 适配器本应先发 approval.cancelled（turn_ended）；没发的话由 Host 结掉。
    inputs.push(
      ...resolveAll(snapshot.pendingApprovals, 'cancelled', { reason: 'turn_cancelled' }),
    );
    if (state === 'awaiting_approval') {
      inputs.push(stateChanged('awaiting_approval', 'running', 'approvals_settled'));
      state = 'running';
    }
    const finalOutcome = outcome === 'failed' && state === 'cancelling' ? 'cancelled' : outcome;
    inputs.push(
      ...finishTurn(
        turn.turnId,
        turn.openTools,
        finalOutcome,
        this.#turnDuration(runtime),
        engineStopReason,
      ),
      stateChanged(state, 'idle', 'turn_finished'),
      // 待发消息（domain-model §4.6）：没插进去的插话改为排队；回合没完成就暂停（取消过程中加入的除外）。
      ...settlePendings(snapshot, (pending) =>
        finalOutcome === 'completed' || turn.addedWhileCancelling.has(pending.id)
          ? 'waiting'
          : 'held',
      ),
    );
    this.#write(runtime, inputs);
    // 还有等待中的排队消息：随后发出第一条，排在命令队列里。
    if (this.#snapshot(runtime).pendingMessages?.some((pending) => pending.status === 'waiting')) {
      void this.#scheduleDispatch(runtime);
    }
  }

  /**
   * 引擎不可用（#10）：进程退出、适配器调用失败、事件流中断。断开订阅；会话已是 `error` / `closed`
   * 时只断开。否则未决审批结为 `cancelled`（`engine_exited`）、有回合时补齐工具并以 `interrupted`
   * 结束、写 `engine.error`（`fatal: true`），转 `error`。不是进程退出时，再尽力让引擎停下可能还在
   * 跑的回合。
   */
  #engineFailed(
    runtime: SessionRuntime,
    info: EngineErrorInfo,
    options: { exited?: boolean } = {},
  ): void {
    this.#detach(runtime);
    const snapshot = this.#snapshot(runtime);
    const { state, activeTurn } = snapshot.session;
    if (state === 'error' || state === 'closed') return;
    const inputs = resolveAll(snapshot.pendingApprovals, 'cancelled', { reason: 'engine_exited' });
    if (activeTurn) {
      inputs.push(
        ...finishTurn(
          activeTurn.turnId,
          runtime.turn?.openTools ?? [],
          'interrupted',
          durationSince(activeTurn.startedAt),
        ),
      );
    }
    inputs.push(
      engineError(info, true, activeTurn?.turnId),
      stateChanged(state, 'error', 'engine_exited'),
      ...settlePendings(snapshot, () => 'held'),
    );
    this.#write(runtime, inputs);
    if (!options.exited) this.#adapter.cancel(runtime.engineSessionId).catch(() => {});
  }

  // ── 工具 ─────────────────────────────────────────────────────────

  /**
   * 写一批事件，并同步内存里的回合与审批映射：`turn.finished` 清掉进行中的回合，`approval.resolved`
   * 去掉 requestId 映射（之后引擎再报这个审批就忽略）。`dispose` 之后不再写。
   */
  #write(
    runtime: SessionRuntime,
    inputs: readonly AppendInput[],
    options?: Parameters<EventStore['appendMany']>[2],
  ) {
    // 不用 #assertOpen：shutdown() 期间取消回合、处理引擎事件仍要写。
    if (this.#disposed) throw new HostError('HOST_SHUTTING_DOWN', 'host is shutting down');
    const events = this.#events.appendMany(runtime.id, inputs, options);
    for (const event of events) {
      if (event.type === 'turn.finished') {
        const turn = runtime.turn;
        if (turn?.turnId === event.payload.turnId) {
          runtime.turn = undefined;
          turn.finished.resolve();
        }
      } else if (event.type === 'approval.resolved') {
        const requestId = runtime.requestIds.get(event.payload.approvalId);
        if (requestId !== undefined) {
          runtime.requestIds.delete(event.payload.approvalId);
          runtime.approvalIds.delete(requestId);
        }
      }
    }
    // 子会话的标题、状态、审批变了：父会话的摘要跟着变。
    if (runtime.parentId !== undefined) this.#mirror(runtime.id, runtime.parentId);
    return events;
  }

  /** 排在该会话上一个命令之后执行。 */
  #serial<T>(runtime: SessionRuntime, command: () => Promise<T>): Promise<T> {
    const result = runtime.tail.then(command);
    runtime.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 会话的内存状态；会话不存在或所属工作区已移除时抛 `notFound`。 */
  #runtime(
    sessionId: SessionId,
    notFound: 'SESSION_NOT_FOUND' | 'APPROVAL_NOT_FOUND' = 'SESSION_NOT_FOUND',
  ): SessionRuntime {
    const record = this.#storage.sessions.get(sessionId);
    const workspace = record && this.#storage.workspaces.get(record.workspaceId);
    if (!record || !workspace || workspace.removedAt !== undefined) {
      throw notFound === 'SESSION_NOT_FOUND'
        ? new HostError('SESSION_NOT_FOUND', `session ${sessionId} not found`)
        : new HostError('APPROVAL_NOT_FOUND', `approval of session ${sessionId} not found`);
    }
    let runtime = this.#runtimes.get(sessionId);
    if (!runtime) {
      runtime = {
        id: sessionId,
        engineSessionId: record.engineSessionId,
        ...(record.parentSessionId !== undefined && {
          parentId: record.parentSessionId as SessionId,
        }),
        tail: Promise.resolve(),
        holds: 0,
        held: [],
        approvalIds: new Map(),
        requestIds: new Map(),
      };
      this.#runtimes.set(sessionId, runtime);
    }
    return runtime;
  }

  #record(runtime: SessionRuntime): SessionRecord {
    const record = this.#storage.sessions.get(runtime.id);
    if (!record) throw new Error(`会话 ${runtime.id} 不存在`);
    return record;
  }

  #snapshot(runtime: SessionRuntime): SessionSnapshot {
    const snapshot = this.#events.snapshot(runtime.id);
    if (!snapshot) throw new Error(`会话 ${runtime.id} 不存在`);
    return snapshot;
  }

  #approvalRecord(approvalId: ApprovalId): ApprovalRecord {
    const record = this.#storage.approvals.get(approvalId);
    if (!record) throw new HostError('APPROVAL_NOT_FOUND', `approval ${approvalId} not found`);
    return record;
  }

  #turnDuration(runtime: SessionRuntime): number {
    const activeTurn = this.#snapshot(runtime).session.activeTurn;
    return activeTurn ? durationSince(activeTurn.startedAt) : 0;
  }

  /** 启动对账用：从事件里找出回合中已开始、未结束的工具调用。 */
  #openToolsFromEvents(sessionId: SessionId, turnId: TurnId): Set<string> {
    const open = new Set<string>();
    for (const event of this.#events.readSince(sessionId, 0)) {
      if (event.type === 'tool.started' && event.payload.turnId === turnId) {
        open.add(event.payload.toolCallId);
      } else if (event.type === 'tool.finished' && event.payload.turnId === turnId) {
        open.delete(event.payload.toolCallId);
      }
    }
    return open;
  }

  #assertOpen(): void {
    if (this.#shuttingDown || this.#disposed) {
      throw new HostError('HOST_SHUTTING_DOWN', 'host is shutting down');
    }
  }
}

// ── 事件构造 ─────────────────────────────────────────────────────────

function stateChanged(
  from: SessionState,
  to: SessionState,
  reason: StateChangeReason,
): AppendInput {
  return { type: 'session.state_changed', source: 'host', payload: { from, to, reason } };
}

function resolved(
  approvalId: ApprovalId,
  status: ResolvedApprovalStatus,
  resolution: ApprovalResolution,
): AppendInput {
  return { type: 'approval.resolved', source: 'host', payload: { approvalId, status, resolution } };
}

function resolveAll(
  pending: readonly ApprovalRequest[],
  status: ResolvedApprovalStatus,
  resolution: ApprovalResolution,
): AppendInput[] {
  return pending.map((approval) => resolved(approval.id, status, resolution));
}

function engineError(
  info: EngineErrorInfo & { code?: number },
  fatal: boolean,
  turnId?: TurnId,
): AppendInput {
  return {
    type: 'engine.error',
    source: 'host',
    payload: { ...info, fatal, ...(turnId !== undefined && { turnId }) },
  };
}

function resumedEvent(engine: EngineSession): AppendInput {
  return {
    type: 'session.resumed',
    source: 'host',
    payload: engine.engineVersion === undefined ? {} : { engineVersion: engine.engineVersion },
  };
}

/**
 * 引擎报 `session_lost` 时的 `session.read_only`。已经因同一原因只读的不再重复写。写在会话转入 `error` 之后，
 * 或会话已是 `error` / `closed` 时。
 */
function readOnlyInputs(snapshot: SessionSnapshot, error: unknown): AppendInput[] {
  if (!isAdapterError(error, 'session_lost') || error.lostReason === undefined) return [];
  const reason = READ_ONLY_REASONS[error.lostReason];
  if (snapshot.session.readOnly?.reason === reason) return [];
  return [
    {
      type: 'session.read_only',
      source: 'host',
      payload: { reason, message: error.message },
    },
  ];
}

function pendingUpdated(pending: PendingMessage): AppendInput {
  return { type: 'pending.updated', source: 'host', payload: { pending } };
}

/**
 * 回合结束或会话出错、关闭、Host 重启时的待发消息（domain-model §4.6）：等待中的插话（交出去还没插进去）改为排队
 * （`turn_ended`）；每条等待中的按 `status` 留在等待或暂停。没有变化的不写。
 */
function settlePendings(
  snapshot: SessionSnapshot,
  status: (pending: PendingMessage) => 'waiting' | 'held',
): AppendInput[] {
  const now = isoNow();
  return (snapshot.pendingMessages ?? []).flatMap((pending) => {
    if (pending.status !== 'waiting') return [];
    const next: PendingMessage = { ...pending, status: status(pending) };
    if (pending.delivery === 'steer') {
      next.delivery = 'queue';
      next.fallback = { reason: 'turn_ended' };
    }
    if (isDeepStrictEqual(next, pending)) return [];
    return [pendingUpdated({ ...next, updatedAt: now })];
  });
}

function isTerminalPending(pending: PendingMessage): boolean {
  return TERMINAL_PENDING_STATUSES.includes(pending.status);
}

function notEditable(pending: PendingMessage): HostError<'PENDING_NOT_EDITABLE'> {
  return new HostError(
    'PENDING_NOT_EDITABLE',
    pending.status === 'waiting' && pending.delivery === 'steer'
      ? 'the steer has been handed to the engine and cannot be changed'
      : `pending message is ${pending.status}`,
    { pendingId: pending.id, status: pending.status, delivery: pending.delivery },
  );
}

/** 结束回合：未收尾的工具补 `tool.finished`（`unknown`，domain-model §6.4），再 `turn.finished`。 */
function finishTurn(
  turnId: TurnId,
  openTools: Iterable<string>,
  outcome: TurnOutcome,
  durationMs: number,
  engineStopReason?: string,
): AppendInput[] {
  const inputs: AppendInput[] = [...openTools].map((toolCallId) => ({
    type: 'tool.finished',
    source: 'host',
    payload: { turnId, toolCallId, status: 'unknown' },
  }));
  inputs.push({
    type: 'turn.finished',
    source: 'host',
    payload: {
      turnId,
      outcome,
      durationMs,
      ...(engineStopReason !== undefined && { engineStopReason }),
    },
  });
  return inputs;
}

// ── 小工具 ───────────────────────────────────────────────────────────

function assertSendable(snapshot: SessionSnapshot): void {
  const { state, activeTurn } = snapshot.session;
  if (ACTIVE_STATES.includes(state)) {
    throw new HostError('SESSION_BUSY', 'session is busy', {
      state,
      ...(activeTurn !== undefined && { activeTurn }),
    });
  }
  const { readOnly } = snapshot.session;
  if (readOnly !== undefined) {
    throw new HostError(
      'INVALID_STATE',
      `session is read-only (${readOnly.reason}): its engine session cannot be resumed; start a new session from its history`,
      { state, readOnly },
    );
  }
  if (state !== 'idle') {
    throw new HostError('INVALID_STATE', `session is ${state}; resume it first`, { state });
  }
}

function alreadyDecided(approval: ApprovalRecord): HostError<'ALREADY_DECIDED'> {
  return new HostError('ALREADY_DECIDED', 'approval already decided', {
    approvalId: approval.id as ApprovalId,
    status: approval.status as ResolvedApprovalStatus,
    resolution: approval.resolution as ApprovalResolution,
  });
}

function invalidOption(approvalId: ApprovalId, optionId: string): HostError<'INVALID_PARAMS'> {
  return new HostError('INVALID_PARAMS', `option ${optionId} is not offered by ${approvalId}`, {
    issues: [{ path: ['optionId'], message: `not one of the approval's options: ${optionId}` }],
  });
}

/** 工作区目录必须还在（domain-model §3.1：目录被移动或删除后建会话会失败）。 */
async function assertDirectory(path: string): Promise<void> {
  let reason: 'not_found' | 'not_directory' | 'not_accessible' | undefined;
  try {
    if (!(await stat(path)).isDirectory()) reason = 'not_directory';
  } catch (error) {
    reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'not_accessible';
  }
  if (reason) {
    throw new HostError('WORKSPACE_PATH_INVALID', `workspace path is unusable: ${path}`, {
      path,
      reason,
    });
  }
}

function sessionConfig(record: SessionRecord): SessionConfig {
  const config: SessionConfig = {
    cwd: record.cwd,
    providerId: record.providerId,
    modelId: record.modelId,
  };
  if (record.reasoningEffort !== undefined) config.reasoningEffort = record.reasoningEffort;
  return config;
}

/** 适配器错误 → `engine.error` 的归类与原文。 */
function engineErrorInfo(
  error: unknown,
  fallback: EngineErrorCategory = 'unknown',
): EngineErrorInfo {
  const message = errorText(error);
  if (isAdapterError(error)) {
    switch (error.code) {
      case 'session_not_found':
      case 'session_closed':
      case 'session_unavailable':
      case 'session_lost':
        return { category: 'session_unavailable', message };
      case 'cancel_unconfirmed':
        return { category: 'cancel_unconfirmed', message };
      case 'missing_credentials':
        return { category: 'missing_credentials', message };
    }
  }
  return { category: fallback, message };
}

function exitInfo(event: Extract<AgentEvent, { type: 'engine.exited' }>): EngineErrorInfo {
  if (event.reason === 'config_changed') {
    return {
      category: 'engine_exited',
      message: 'engine restarted to apply provider changes; resume the session to continue',
    };
  }
  if (event.reason === 'cancel_unconfirmed') {
    return {
      category: 'engine_exited',
      message:
        'engine restarted because a cancellation could not be confirmed; resume the session to continue',
    };
  }
  const how = event.signal !== null ? `signal ${event.signal}` : `code ${event.exitCode}`;
  const tail = event.stderrTail ? `\n${event.stderrTail}` : '';
  return { category: 'engine_exited', message: `engine exited with ${how}${tail}` };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeTitle(content: readonly UserContentPart[]): string {
  const text = content
    .map((part) => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(text).slice(0, TITLE_MAX_LENGTH).join('');
}

function approvalDetail(tool: ToolInfo): ApprovalDetail {
  const detail: ApprovalDetail = { toolName: tool.toolName, display: tool.display };
  const { input } = tool;
  if (input === undefined) return detail;
  detail.input = input;
  if (input !== null && typeof input === 'object') {
    const { justification, sandbox_permissions: sandboxPermissions } = input as Record<
      string,
      unknown
    >;
    if (typeof justification === 'string') detail.justification = justification;
    if (typeof sandboxPermissions === 'string') detail.sandboxPermissions = sandboxPermissions;
  }
  return detail;
}

function streamOf(turn: TurnRuntime, attemptId: string): StreamId {
  let streamId = turn.streams.get(attemptId);
  if (!streamId) {
    streamId = newId('stm');
    turn.streams.set(attemptId, streamId);
  }
  return streamId;
}

/** 引擎的增量块引用换成 StreamId；对不上的（没见过的 attempt）丢掉。 */
function blockRefs(turn: TurnRuntime, refs: readonly DeltaBlockRef[]): StreamBlockRef[] {
  const result: StreamBlockRef[] = [];
  for (const ref of refs) {
    const streamId = turn.streams.get(ref.attemptId);
    if (streamId) result.push({ streamId, blockIndex: ref.blockIndex });
  }
  return result;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 在 `deadline`（`Date.now()` 毫秒）之前等到 `promise` 的结果，超时为 `'timeout'`。 */
async function settleBy<T>(promise: Promise<T>, deadline: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function never(): Promise<never> {
  return new Promise(() => {});
}

function durationSince(startedAt: string): number {
  return Math.max(0, Date.now() - Date.parse(startedAt));
}

function isoNow(): string {
  return new Date().toISOString();
}
