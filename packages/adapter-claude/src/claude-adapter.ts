// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts（每个 thread 一个常驻的 query、`makeClaudeQueryOptions`、`spawnClaudeProcessGroup`、流式 / 快照 / 工具结果 / 结果的处理、`canUseTool`、中断、插话与 `forkThread`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS，实现 Wevir 的 `AgentRuntimeAdapter`；插话用 priority next（T3 用 now）；关掉后台任务；不移植 T3 编排专用的部分（唤醒回合、prompt 回声的门控、后台任务名单、goal、回滚、编排用的 MCP 工具）。
//
// Claude Agent 引擎（docs/architecture/claude-event-mapping.md）：每个会话一个 `claude` 进程，由 Claude Agent SDK 的 `query()`
// 以流式输入的方式驱动（T3 的做法）。会话 ID 由适配器事先定好（`sessionId`），恢复用 `resume`，支线用 `forkSession`。进程在
// 第一次发消息时才起，空闲时一直留着；中途退出了下次发消息时再以 `resume` 起一个，不报 `engine.exited`（§6.1）。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  AdapterError,
  type AgentEvent,
  type AgentInput,
  type AgentRuntimeAdapter,
  type ApprovalDecision,
  type CancelOptions,
  type EngineSession,
  EventHub,
  type PendingApproval,
  type PermissionMode,
  type ProviderConfig,
  type ProviderIssue,
  type SessionConfig,
  type TitleRequest,
  type TurnFailedEvent,
  type TurnSettledEvent,
} from '@wevir/runtime-adapter';
import {
  HISTORY_TOOL_NAME,
  HISTORY_TOOL_SERVER,
  type HistoryToolServer,
  historyToolCommand,
  writeHistoryToolScript,
} from '@wevir/runtime-adapter/history-tool';
import { ClaudeAccounts, type ClaudeInstallation } from './account.js';
import { claudeEnv } from './env.js';
import {
  type ClaudeEffort,
  canonicalClaudeModel,
  claudeApiModelId,
  claudeContextWindow,
  claudeEffort,
  lowestClaudeEffort,
} from './model-catalog.js';
import {
  APPROVAL_OPTIONS,
  type ApprovalDecisionId,
  claudePermissionMode,
  PERMISSION_MODES,
  permissionResult,
} from './permissions.js';
import {
  type CanUseTool,
  type ClaudeSdk,
  type Options,
  type PermissionResult,
  type Query,
  realClaudeSdk,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SdkPermissionMode,
} from './sdk.js';
import { SIDE_BOUNDARY_NOTE } from './side.js';
import {
  applyTaskTool,
  askUserAnswers,
  askUserQuestions,
  TASK_TOOLS,
  type TaskList,
  todoWriteItems,
} from './todos.js';
import { claudeToolDisplay, isSubagentTool } from './tool-display.js';
import { isAbortedResult, resultFailure } from './turn-result.js';

/** `cancel` 等回合结算的时限；超过就关掉进程（照样算取消成功，进程没了回合必然已停）。 */
export const CANCEL_TIMEOUT_MS = 10_000;
/** 关进程时等消息循环结束的时限。 */
export const CLOSE_TIMEOUT_MS = 5_000;
/** `engine.raw` 的协议名。 */
export const ENGINE_RAW_PROTOCOL = 'claude-agent-sdk';
/** 压缩上下文（0.24.0）：照 T3 的 `compactThread`，`claude` 在本地执行这条斜杠命令。 */
export const COMPACT_COMMAND = '/compact';

/** 不映射、也不保留为 `engine.raw` 的消息（高频的进度与状态）。 */
const IGNORED_MESSAGES: ReadonlySet<string> = new Set([
  'command_lifecycle',
  'tool_progress',
  'tool_use_summary',
  'auth_status',
  'prompt_suggestion',
  'system/status',
  'system/session_state_changed',
  'system/thinking_tokens',
  'system/hook_started',
  'system/hook_progress',
  'system/hook_response',
  'system/task_progress',
  'system/task_updated',
  'system/background_tasks_changed',
  'system/commands_changed',
  'system/files_persisted',
  'system/ui_status',
]);

export interface ClaudeAdapterLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
}

export interface ClaudeAdapterOptions {
  /** Wevir 的数据目录；探测与生成标题在 `<home>/engines/claude` 里跑。 */
  home: string;
  logger?: ClaudeAdapterLogger;
  /** 环境变量的继承来源，默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 测试用：替换 Claude Agent SDK。 */
  sdk?: ClaudeSdk;
  /** 测试用：替换账号（默认按 `sdk` 与 `env` 新建）。 */
  accounts?: ClaudeAccounts;
  cancelTimeoutMs?: number;
  /**
   * 读历史的本机 MCP 服务（0.25.0，接力）：挂进每个会话的 `mcpServers`，它的工具不用审批（`allowedTools`）。省略时不挂。
   */
  historyTool?: HistoryToolServer;
}

/** 推给 `query()` 的输入：异步迭代的队列。 */
class PushQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiter: ((result: IteratorResult<T>) => void) | undefined;
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiter;
    if (waiter !== undefined) {
      this.#waiter = undefined;
      waiter({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
  }

  close(): void {
    this.#closed = true;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiter = resolve;
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

interface ApprovalEntry {
  info: PendingApproval;
  decide(decision: ApprovalDecisionId): void;
  /** 没经过 `respondToApproval` 就结束：发 `approval.cancelled`，回给 Claude 拒绝。 */
  end(reason: 'turn_cancelled' | 'turn_ended' | 'engine_exited' | 'disposed'): void;
}

interface QuestionEntry {
  answer(answers: Record<string, string[]>): void;
  end(reason: 'turn_cancelled' | 'turn_ended' | 'engine_exited' | 'disposed'): void;
}

/** 流式增量的一个块（只有顶层会话有增量，子 agent 的输出整段到）。 */
interface StreamBlock {
  kind: 'text' | 'reasoning';
  text: string;
  replaced: boolean;
}

/** 事件的归属：顶层会话或一个子 agent。 */
interface Owner {
  id: string;
  hub: EventHub<AgentEvent>;
  approvals: Map<string, ApprovalEntry>;
  questions: Map<string, QuestionEntry>;
  /** 已报过 `tool.started` 的工具调用 → 工具名与输入。 */
  tools: Map<string, { name: string; input: unknown }>;
  finished: Set<string>;
  /** 每条 API 消息已处理的内容块数（快照按块到，块的序号与流式的 index 对应）。 */
  blockCounts: Map<string, number>;
  tasks: TaskList;
}

interface Turn {
  promptUuid: string;
  /** `compact` 开的回合（0.24.0）：它的压缩记为 `manual`，结果不按 uuid 对。 */
  readonly kind?: 'compact';
  /** 进行中的压缩（`status` 是 `compacting`，0.24.0），等 `compact_boundary`。 */
  compaction?: { id: string; trigger: 'manual' | 'auto' };
  settled: boolean;
  cancelRequested: boolean;
  cancelPromise?: Promise<void>;
  /** 用户选了“拒绝并停止”：回合随后的中断按取消结算。 */
  stoppedByUser: boolean;
  authFailed: boolean;
  steers: Array<{ steerId: string; uuid: string; folded: boolean; dropped?: boolean }>;
  /** 插话还没进回合时到的结果：等插话那一轮结束（或插话被 Claude 丢掉）再结算。 */
  deferredResult?: SDKResultMessage;
  /** 这个回合最后一条顶层消息的 uuid（会话记录里的条目，支线从这里分）。 */
  lastEntryUuid?: string;
  usageMessages: Set<string>;
  lastContextUsed?: number;
  waiters: Array<() => void>;
  /** 跑这个回合的进程（消息推给它之后才有）：别的进程退出不结算这个回合。 */
  live?: LiveQuery;
}

interface LiveQuery {
  query: Query;
  input: PushQueue<SDKUserMessage>;
  applied: Applied;
  done: Promise<void>;
  /** 由适配器主动关掉（取消超时、换设置、关闭会话、dispose）。 */
  closing: boolean;
}

/** 进程启动时定下的设置（有的能在进程里改，有的要重起，见 `#applyLive`）。 */
interface Applied {
  model: string;
  effort: ClaudeEffort | undefined;
  mode: SdkPermissionMode;
  dangerous: boolean;
}

interface RootSession extends Owner {
  kind: 'root';
  config: SessionConfig;
  open: boolean;
  /** 会话记录已在磁盘上（之后起进程用 `resume`）。 */
  persisted: boolean;
  side: boolean;
  /** 支线的第一条消息前面要放边界说明。 */
  sideNotePending: boolean;
  live?: LiveQuery;
  turn?: Turn;
  /** 最近一个完成的回合的最后一条记录（`forkSession` 的 `upToMessageId`）。 */
  lastSettledUuid?: string;
  /** `injectNote` 补进来、还没交给 `claude` 的说明。 */
  pendingNotes: string[];
  /** 子 agent：派出它的工具调用 ID → 子会话（各层都登记在顶层会话上）。 */
  children: Map<string, ChildSession>;
  stream?: { attemptId: string; blocks: Map<number, StreamBlock> };
  engineVersion?: string;
}

interface ChildSession extends Owner {
  kind: 'child';
  root: RootSession;
  parent: Owner;
  toolUseId: string;
  taskId?: string;
  running: boolean;
  /** Agent 工具立即返回、子 agent 在后台跑（等 `task_notification` 结束）。 */
  background: boolean;
  sawMessage: boolean;
}

type Session = RootSession | ChildSession;

function textOf(input: AgentInput): string {
  return input.content
    .map((part) => part.text)
    .filter((text) => text !== '')
    .join('\n\n');
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** 工具结果的文本：字符串，或内容块里的文本拼起来。 */
export function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((part) => {
    const fields = record(part);
    return fields.type === 'text' && typeof fields.text === 'string' ? [fields.text] : [];
  });
  return texts.length === 0 ? undefined : texts.join('\n');
}

/** 后台启动的子 agent 的确认（T3 的 `isClaudeSubagentAsyncLaunchAck`）。 */
function isAsyncLaunchAck(structured: unknown, text: string | undefined): boolean {
  const status = record(structured).status;
  if (status === 'async_launched') return true;
  return text !== undefined && /launched in the background|running in the background/i.test(text);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * 让 `claude` 自成进程组（T3 的 `spawnClaudeProcessGroup`）：它退出时只停它起的 MCP 服务器，不停它们的子进程，所以退出后
 * 给整个组发 SIGKILL。Agent 的 Bash 工具起的命令自成一组，不受影响。stderr 丢掉（SDK 自己起进程时也只在退出错误里带尾部）。
 */
function spawnProcessGroup(options: {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}) {
  const child = spawn(options.command, options.args, {
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    env: options.env as NodeJS.ProcessEnv,
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
  });
  child.once('exit', () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // 组里已经没有进程了。
    }
  });
  return child;
}

export class ClaudeAdapter implements AgentRuntimeAdapter {
  readonly accounts: ClaudeAccounts;
  readonly permissionModes: readonly PermissionMode[] = PERMISSION_MODES;
  readonly additionalRoots = true;
  /** 读历史的工具（0.25.0）：给了 `historyTool` 时挂上。 */
  readonly historyTool: boolean;

  readonly #sdk: ClaudeSdk;
  readonly #historyTool: HistoryToolServer | undefined;
  #historyScriptWritten = false;
  readonly #env: NodeJS.ProcessEnv;
  readonly #logger: ClaudeAdapterLogger | undefined;
  readonly #workDir: string;
  readonly #cancelTimeoutMs: number;
  readonly #sessions = new Map<string, Session>();
  #disposed = false;

  constructor(options: ClaudeAdapterOptions) {
    this.#sdk = options.sdk ?? realClaudeSdk;
    this.#env = options.env ?? process.env;
    this.#logger = options.logger;
    this.#workDir = path.join(options.home, 'engines', 'claude');
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
    this.#historyTool = options.historyTool;
    this.historyTool = options.historyTool !== undefined;
    this.accounts =
      options.accounts ??
      new ClaudeAccounts({ sdk: this.#sdk, workDir: this.#workDir, env: this.#env });
  }

  // ── 会话 ──────────────────────────────────────────────────────────────────

  async createSession(config: SessionConfig): Promise<EngineSession> {
    this.#ensureAlive();
    this.#validateConfig(config);
    const installation = await this.accounts.installation();
    this.#ensureAlive();
    const session = this.#newRoot(randomUUID(), config, { persisted: false, side: false });
    session.engineVersion = installation.version;
    return this.#engineSession(session);
  }

  async resumeSession(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    this.#ensureAlive();
    this.#validateConfig(config);
    const existing = this.#sessions.get(engineSessionId);
    if (existing?.kind === 'child') {
      throw new AdapterError('invalid_input', 'subagent sessions are not resumed');
    }
    if (existing?.open === true) return this.#engineSession(existing);
    const installation = await this.accounts.installation();
    this.#ensureAlive();
    // 本实例里关掉的会话不用再问磁盘（没发过消息的会话还没有记录，下次照样用 sessionId 起）。
    if (existing === undefined) {
      const found =
        UUID_RE.test(engineSessionId) &&
        (await this.#sdk.sessionExists(engineSessionId, config.cwd).catch(() => false));
      if (!found) {
        throw new AdapterError(
          'session_lost',
          `Claude has no session ${engineSessionId} for ${config.cwd}`,
          { lostReason: 'not_found' },
        );
      }
    }
    const session =
      existing ?? this.#newRoot(engineSessionId, config, { persisted: true, side: false });
    session.config = { ...config };
    session.open = true;
    session.hub = new EventHub();
    session.engineVersion = installation.version;
    this.#sessions.set(engineSessionId, session);
    return this.#engineSession(session);
  }

  subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    this.#ensureAlive();
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `unknown session ${engineSessionId}`);
    }
    const root = session.kind === 'root' ? session : session.root;
    if (!root.open)
      throw new AdapterError('session_closed', `session ${engineSessionId} is closed`);
    return session.hub.subscribe();
  }

  async send(engineSessionId: string, input: AgentInput): Promise<void> {
    this.#ensureAlive();
    const session = this.#root(engineSessionId, 'send');
    const text = textOf(input);
    if (text === '') throw new AdapterError('invalid_input', 'the message is empty');
    await this.#startTurn(session, text);
  }

  /**
   * 压缩上下文（0.24.0，claude-event-mapping.md）：照 T3 的 `compactThread` 把 `/compact` 当一条消息发出，`claude` 在本地压缩；
   * `status` 的 `compacting` 与 `compact_boundary` 映射成 `context.compacting` / `context.compacted`。
   */
  async compact(engineSessionId: string): Promise<void> {
    this.#ensureAlive();
    await this.#startTurn(this.#root(engineSessionId, 'compact'), COMPACT_COMMAND, 'compact');
  }

  async #startTurn(session: RootSession, text: string, kind?: Turn['kind']): Promise<void> {
    if (session.turn !== undefined) {
      throw new AdapterError('session_busy', `session ${session.id} has a turn in progress`);
    }
    const turn: Turn = {
      ...(kind !== undefined && { kind }),
      promptUuid: randomUUID(),
      settled: false,
      cancelRequested: false,
      stoppedByUser: false,
      authFailed: false,
      steers: [],
      usageMessages: new Set(),
      waiters: [],
    };
    session.turn = turn;
    try {
      const installation = await this.accounts.installation();
      this.#ensureAlive();
      if (!session.open)
        throw new AdapterError('session_closed', `session ${session.id} is closed`);
      const live = await this.#liveFor(session, installation);
      for (const note of session.pendingNotes.splice(0)) {
        live.input.push(this.#userMessage(note, { shouldQuery: false }));
      }
      // 斜杠命令前面不能有别的字：支线的边界说明留给下一条消息。
      const boundary = session.sideNotePending && kind === undefined;
      const prompt = boundary ? `${SIDE_BOUNDARY_NOTE}\n\n${text}` : text;
      if (boundary) session.sideNotePending = false;
      live.input.push(this.#userMessage(prompt, { uuid: turn.promptUuid }));
      turn.live = live;
      session.persisted = true;
    } catch (error) {
      if (session.turn === turn) session.turn = undefined;
      throw error;
    }
  }

  async steer(engineSessionId: string, steerId: string, input: AgentInput): Promise<void> {
    this.#ensureAlive();
    const session = this.#root(engineSessionId, 'steer');
    const text = textOf(input);
    if (text === '') throw new AdapterError('invalid_input', 'the message is empty');
    const turn = session.turn;
    const live = session.live;
    if (turn === undefined || turn.settled || turn.cancelRequested || live === undefined) {
      throw new AdapterError('steer_rejected', `session ${engineSessionId} has no turn to steer`);
    }
    // 排在当前这一步之后（`next`）：Claude Code 在下一次工具调用的间隙把它并进回合；没有工具调用时这一轮照常答完，再以它
    // 开下一轮（Wevir 当作同一个回合，见 `#result`）。T3 用 `now`，会打断正在进行的输出。
    const uuid = randomUUID();
    turn.steers.push({ steerId, uuid, folded: false });
    live.input.push(this.#userMessage(text, { uuid, priority: 'next' }));
  }

  async configureSession(
    engineSessionId: string,
    config: { modelId: string; reasoningEffort?: string; permissionMode?: PermissionMode },
  ): Promise<void> {
    this.#ensureAlive();
    const session = this.#root(engineSessionId, 'configure');
    const { reasoningEffort: _effort, permissionMode: _mode, ...rest } = session.config;
    // 下一个回合起生效：进程在 `send` 时再按新的值调整（`#liveFor`）。
    session.config = {
      ...rest,
      modelId: config.modelId,
      ...(config.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
      ...(config.permissionMode !== undefined && { permissionMode: config.permissionMode }),
    };
  }

  async fork(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    this.#ensureAlive();
    const source = this.#root(engineSessionId, 'fork');
    if (!source.open)
      throw new AdapterError('session_closed', `session ${engineSessionId} is closed`);
    // 回合进行中只分到最近一个完成的回合；没有完成的回合时分不了。
    const upTo = source.lastSettledUuid;
    if (upTo === undefined && (source.turn !== undefined || !source.persisted)) {
      throw new AdapterError('invalid_input', 'the session has no finished turn to fork from');
    }
    const installation = await this.accounts.installation();
    this.#ensureAlive();
    let forked: { sessionId: string };
    try {
      forked = await this.#sdk.forkSession(source.id, {
        dir: source.config.cwd,
        ...(upTo !== undefined && { upToMessageId: upTo }),
      });
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `Claude could not fork the session: ${describe(error)}`,
        {
          cause: error,
        },
      );
    }
    const side = this.#newRoot(forked.sessionId, config, { persisted: true, side: true });
    side.sideNotePending = true;
    side.engineVersion = installation.version;
    return this.#engineSession(side);
  }

  async injectNote(engineSessionId: string, text: string): Promise<void> {
    this.#ensureAlive();
    const session = this.#root(engineSessionId, 'injectNote');
    if (!session.open)
      throw new AdapterError('session_closed', `session ${engineSessionId} is closed`);
    // `shouldQuery: false` 的消息只写进会话记录，不开回合，随下一条消息交给模型。
    if (session.live !== undefined) {
      session.live.input.push(this.#userMessage(text, { shouldQuery: false }));
    } else {
      session.pendingNotes.push(text);
    }
  }

  async respondToApproval(
    engineSessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    this.#ensureAlive();
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `unknown session ${engineSessionId}`);
    }
    const entry = session.approvals.get(requestId);
    if (entry === undefined) {
      throw new AdapterError('approval_not_found', `no pending approval ${requestId}`);
    }
    if (!entry.info.options.some((option) => option.optionId === decision.optionId)) {
      throw new AdapterError(
        'invalid_option',
        `not an option of ${requestId}: ${decision.optionId}`,
      );
    }
    entry.decide(decision.optionId as ApprovalDecisionId);
  }

  async respondToQuestion(
    engineSessionId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    this.#ensureAlive();
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `unknown session ${engineSessionId}`);
    }
    const entry = session.questions.get(requestId);
    if (entry === undefined) {
      throw new AdapterError('question_not_found', `no pending question ${requestId}`);
    }
    entry.answer(answers);
  }

  async listPendingApprovals(engineSessionId?: string): Promise<PendingApproval[]> {
    this.#ensureAlive();
    const sessions =
      engineSessionId === undefined
        ? [...this.#sessions.values()]
        : [this.#sessions.get(engineSessionId)].filter((session) => session !== undefined);
    return sessions.flatMap((session) =>
      [...session.approvals.values()].map(({ info }) => ({
        ...info,
        options: info.options.map((option) => ({ ...option })),
      })),
    );
  }

  async cancel(engineSessionId: string, options?: CancelOptions): Promise<void> {
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined || this.#disposed) return;
    if (session.kind === 'child') {
      // 用户单独停掉子 agent（0.14.0）：`stopTask` 之后 Agent 工具的结果照常交回父 agent，它自然知道，不另外补说明。
      void options;
      this.#cancelChild(session);
      return;
    }
    const turn = session.turn;
    if (turn === undefined || turn.settled) return;
    if (turn.cancelPromise !== undefined) return turn.cancelPromise;
    turn.cancelRequested = true;
    turn.cancelPromise = (async () => {
      this.#endRequests(session, 'turn_cancelled');
      const live = session.live;
      if (live !== undefined) {
        await withTimeout(
          live.query.interrupt().catch(() => undefined),
          this.#cancelTimeoutMs,
        );
      }
      if (!(await this.#waitSettled(turn, this.#cancelTimeoutMs))) {
        // 得不到中断的确认：关掉进程（下次发消息时以 resume 重起），回合按取消结算。
        this.#logger?.warn('claude interrupt was not confirmed; closing the process', {
          engineSessionId: session.id,
        });
        if (session.live !== undefined) await this.#closeLive(session, session.live);
        this.#settle(session, turn, {
          type: 'turn.settled',
          outcome: 'cancelled',
          stopReason: 'cancelled',
        });
      }
    })();
    return turn.cancelPromise;
  }

  async close(engineSessionId: string): Promise<void> {
    this.#ensureAlive();
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `unknown session ${engineSessionId}`);
    }
    if (session.kind === 'child') {
      this.#cancelChild(session);
      return;
    }
    if (!session.open) return;
    if (session.turn !== undefined) await this.cancel(engineSessionId);
    if (session.live !== undefined) await this.#closeLive(session, session.live);
    session.open = false;
    this.#endHubs(session);
  }

  validateProvider(provider: ProviderConfig): ProviderIssue[] {
    return provider.kind === 'claude'
      ? []
      : [
          {
            path: ['kind'],
            message: `the Claude engine only runs claude providers, not ${provider.kind}`,
          },
        ];
  }

  async configureProviders(): Promise<void> {
    // Claude 的 Provider 只有一种（ID 与种类都是 claude，模型来自 accounts.models），没有要交给引擎的配置。
  }

  async generateTitle(engineSessionId: string, request: TitleRequest): Promise<string> {
    this.#ensureAlive();
    const session = this.#root(engineSessionId, 'generateTitle');
    if (!session.open)
      throw new AdapterError('session_closed', `session ${engineSessionId} is closed`);
    const installation = await this.accounts.installation();
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      mkdirSync(this.#workDir, { recursive: true });
      const model = session.config.modelId;
      const effort = lowestClaudeEffort(model);
      // 同 T3 的标题生成（claude -p --json-schema、不给工具、dontAsk、不跑 hooks、不连 MCP），不写会话记录。
      const q = this.#sdk.query({
        prompt: request.input,
        options: {
          pathToClaudeCodeExecutable: installation.executablePath,
          env: claudeEnv(this.#env, installation.executablePath),
          cwd: this.#workDir,
          abortController,
          model: claudeApiModelId(model),
          ...(effort !== undefined && { effort }),
          systemPrompt: request.instructions,
          tools: [],
          allowedTools: [],
          persistSession: false,
          settingSources: [],
          settings: { disableAllHooks: true },
          mcpServers: {},
          strictMcpConfig: true,
          permissionMode: 'dontAsk',
          outputFormat: { type: 'json_schema', schema: request.outputSchema },
          stderr: () => {},
        },
      });
      for await (const message of iterate(q)) {
        if (message.type !== 'result') continue;
        const failure = resultFailure(message, false);
        if (failure !== undefined) throw new Error(failure.message);
        if (message.subtype === 'success') {
          return message.structured_output !== undefined
            ? JSON.stringify(message.structured_output)
            : message.result;
        }
      }
      throw new Error('Claude ended without a result');
    } catch (error) {
      if (isAdapterErrorLike(error)) throw error;
      throw new AdapterError(
        'engine_unavailable',
        `Claude could not generate a title: ${describe(error)}`,
        {
          cause: error,
        },
      );
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      abortController.abort();
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const roots = [...this.#sessions.values()].filter(
      (session): session is RootSession => session.kind === 'root',
    );
    for (const session of roots) this.#endRequests(session, 'disposed');
    await Promise.all(
      roots.map(async (session) => {
        if (session.live !== undefined) await this.#closeLive(session, session.live);
      }),
    );
    for (const session of roots) {
      if (session.turn !== undefined) {
        session.turn.settled = true;
        for (const waiter of session.turn.waiters) waiter();
        session.turn = undefined;
      }
      session.open = false;
      this.#endHubs(session);
    }
    this.accounts.dispose();
  }

  // ── 内部：会话与进程 ─────────────────────────────────────────────────────────

  #ensureAlive(): void {
    if (this.#disposed) throw new AdapterError('disposed', 'the Claude engine has been disposed');
  }

  #validateConfig(config: SessionConfig): void {
    if (config.cwd.trim() === '') throw new AdapterError('invalid_input', 'cwd is empty');
    if (config.modelId.trim() === '') throw new AdapterError('invalid_input', 'modelId is empty');
  }

  #newRoot(
    id: string,
    config: SessionConfig,
    flags: { persisted: boolean; side: boolean },
  ): RootSession {
    const session: RootSession = {
      kind: 'root',
      id,
      hub: new EventHub(),
      approvals: new Map(),
      questions: new Map(),
      tools: new Map(),
      finished: new Set(),
      blockCounts: new Map(),
      tasks: new Map(),
      config: { ...config },
      open: true,
      persisted: flags.persisted,
      side: flags.side,
      sideNotePending: false,
      pendingNotes: [],
      children: new Map(),
    };
    this.#sessions.set(id, session);
    return session;
  }

  #engineSession(session: RootSession): EngineSession {
    return {
      engineSessionId: session.id,
      modelId: session.config.modelId,
      ...(session.config.reasoningEffort !== undefined && {
        reasoningEffort: session.config.reasoningEffort,
      }),
      ...(session.engineVersion !== undefined && { engineVersion: session.engineVersion }),
    };
  }

  /** 顶层会话；子会话报 `invalid_input`（由父 agent 驱动），关闭的报 `session_closed`。 */
  #root(engineSessionId: string, what: string): RootSession {
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `unknown session ${engineSessionId}`);
    }
    if (session.kind === 'child') {
      throw new AdapterError('invalid_input', `${what} is not available on a subagent session`);
    }
    if (!session.open && what !== 'fork' && what !== 'injectNote' && what !== 'generateTitle') {
      throw new AdapterError('session_closed', `session ${engineSessionId} is closed`);
    }
    return session;
  }

  #desired(session: RootSession): Applied {
    const mode = claudePermissionMode(session.config.permissionMode);
    return {
      model: claudeApiModelId(session.config.modelId),
      effort: claudeEffort(session.config.modelId, session.config.reasoningEffort),
      mode,
      dangerous: mode === 'bypassPermissions',
    };
  }

  /** 这个会话可用的进程：没有就起一个；设置变了就在进程里改，改不了就重起（只在回合之间）。 */
  async #liveFor(session: RootSession, installation: ClaudeInstallation): Promise<LiveQuery> {
    const desired = this.#desired(session);
    const live = session.live;
    if (live !== undefined && (await this.#applyLive(live, desired))) return live;
    if (live !== undefined) await this.#closeLive(session, live);
    const opened = this.#openLive(session, installation, desired);
    session.live = opened;
    return opened;
  }

  /** 在进程里换模型、档位与权限模式（T3 的 `canApplyClaudeSelectionLive`）；要重起时返回 false。 */
  async #applyLive(live: LiveQuery, desired: Applied): Promise<boolean> {
    const applied = live.applied;
    // 清掉档位、换到完全访问（要带启动参数 allowDangerouslySkipPermissions）只能重起。
    if (desired.effort === undefined && applied.effort !== undefined) return false;
    if (desired.dangerous && !applied.dangerous) return false;
    try {
      if (desired.model !== applied.model) await live.query.setModel(desired.model);
      if (desired.effort !== undefined && desired.effort !== applied.effort) {
        await live.query.applyFlagSettings({ effortLevel: desired.effort });
      }
      if (desired.mode !== applied.mode) await live.query.setPermissionMode(desired.mode);
    } catch (error) {
      this.#logger?.warn('claude could not apply settings live; restarting the process', {
        error: describe(error),
      });
      return false;
    }
    live.applied = { ...desired, dangerous: applied.dangerous || desired.dangerous };
    return true;
  }

  #openLive(session: RootSession, installation: ClaudeInstallation, desired: Applied): LiveQuery {
    if (this.#historyTool !== undefined && !this.#historyScriptWritten) {
      writeHistoryToolScript(this.#historyTool);
      this.#historyScriptWritten = true;
    }
    const input = new PushQueue<SDKUserMessage>();
    const options: Options = {
      pathToClaudeCodeExecutable: installation.executablePath,
      env: claudeEnv(this.#env, installation.executablePath),
      cwd: session.config.cwd,
      ...(session.config.additionalRoots !== undefined &&
        session.config.additionalRoots.length > 0 && {
          additionalDirectories: [...session.config.additionalRoots],
        }),
      model: desired.model,
      ...(desired.effort !== undefined && { effort: desired.effort }),
      permissionMode: desired.mode,
      ...(desired.dangerous && { allowDangerouslySkipPermissions: true }),
      canUseTool: this.#canUseTool(session),
      ...(this.#historyTool !== undefined && {
        mcpServers: {
          [HISTORY_TOOL_SERVER]: { type: 'stdio', ...historyToolCommand(this.#historyTool) },
        },
        allowedTools: [`mcp__${HISTORY_TOOL_SERVER}__${HISTORY_TOOL_NAME}`],
      }),
      includePartialMessages: true,
      forwardSubagentText: true,
      // T3：要思考的摘要（新模型默认不显示思考内容）。
      thinking: { type: 'adaptive', display: 'summarized' },
      settings: { showThinkingSummaries: true },
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      ...(session.persisted ? { resume: session.id } : { sessionId: session.id }),
      ...(session.side && { persistSession: false }),
      ...(process.platform !== 'win32' && { spawnClaudeCodeProcess: spawnProcessGroup }),
      stderr: () => {},
    };
    let query: Query;
    try {
      query = this.#sdk.query({ prompt: input, options });
    } catch (error) {
      throw new AdapterError('engine_unavailable', `Claude could not start: ${describe(error)}`, {
        cause: error,
      });
    }
    const live: LiveQuery = {
      query,
      input,
      applied: desired,
      done: Promise.resolve(),
      closing: false,
    };
    live.done = this.#pump(session, live);
    return live;
  }

  async #pump(session: RootSession, live: LiveQuery): Promise<void> {
    let failure: unknown;
    try {
      for await (const message of iterate(live.query)) {
        if (this.#disposed) break;
        if (session.live !== live) continue;
        try {
          this.#handle(session, live, message);
        } catch (error) {
          this.#logger?.warn('claude message could not be mapped', {
            engineSessionId: session.id,
            type: message.type,
            error: describe(error),
          });
        }
      }
    } catch (error) {
      failure = error;
    }
    this.#liveEnded(session, live, failure);
  }

  /** 进程的消息流结束（退出、被关掉）：未结算的回合按取消或失败结算，下次发消息时再起进程。 */
  #liveEnded(session: RootSession, live: LiveQuery, failure: unknown): void {
    if (session.live === live) session.live = undefined;
    live.input.close();
    if (this.#disposed) return;
    const turn = session.turn;
    // 只结算跑在这个进程上的回合（换设置重起进程时，旧进程结束在新回合推消息之前）。
    if (turn === undefined || turn.settled || turn.live !== live) return;
    if (turn.cancelRequested || live.closing) {
      this.#settle(session, turn, {
        type: 'turn.settled',
        outcome: 'cancelled',
        stopReason: 'cancelled',
      });
      return;
    }
    this.#endRequests(session, 'engine_exited');
    const message = failure === undefined ? 'claude exited during the turn' : describe(failure);
    this.#settle(session, turn, {
      type: 'turn.failed',
      category: /log ?in|authenticat|credential/i.test(message) ? 'missing_credentials' : 'unknown',
      message,
    });
  }

  async #closeLive(session: RootSession, live: LiveQuery): Promise<void> {
    live.closing = true;
    live.input.close();
    try {
      live.query.close();
    } catch {
      // 已经关了。
    }
    await withTimeout(live.done, CLOSE_TIMEOUT_MS);
    if (session.live === live) session.live = undefined;
  }

  #waitSettled(turn: Turn, ms: number): Promise<boolean> {
    if (turn.settled) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(turn.settled), ms);
      turn.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  #userMessage(
    text: string,
    extra: { uuid?: string; priority?: 'now' | 'next' | 'later'; shouldQuery?: boolean },
  ): SDKUserMessage {
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      ...(extra.priority !== undefined && { priority: extra.priority }),
      ...(extra.shouldQuery !== undefined && { shouldQuery: extra.shouldQuery }),
      ...(extra.uuid !== undefined && { uuid: extra.uuid as SDKUserMessage['uuid'] }),
    };
  }

  #endHubs(session: RootSession): void {
    session.hub.end();
    for (const child of session.children.values()) {
      child.hub.end();
      this.#sessions.delete(child.id);
    }
    session.children.clear();
  }

  /** 结掉顶层会话与它的子 agent 未决的审批与提问。 */
  #endRequests(session: RootSession, reason: Parameters<ApprovalEntry['end']>[0]): void {
    for (const owner of [session, ...session.children.values()]) {
      for (const entry of [...owner.approvals.values()]) entry.end(reason);
      for (const entry of [...owner.questions.values()]) entry.end(reason);
    }
  }

  // ── 内部：审批与提问（canUseTool）─────────────────────────────────────────────

  #canUseTool(session: RootSession): CanUseTool {
    return async (toolName, toolInput, options): Promise<PermissionResult> => {
      const turn = session.turn;
      if (turn === undefined || turn.settled || turn.cancelRequested || this.#disposed) {
        return {
          behavior: 'deny',
          message: 'No turn is in progress.',
          toolUseID: options.toolUseID,
        };
      }
      const owner = this.#requestOwner(session, options.toolUseID, options.agentID);
      this.#toolStarted(session, owner, options.toolUseID, toolName, toolInput);

      if (toolName === 'AskUserQuestion') {
        return this.#ask(owner, options.toolUseID, toolInput, options.signal);
      }
      if (session.config.permissionMode === 'full_access') {
        return { behavior: 'allow', updatedInput: toolInput, toolUseID: options.toolUseID };
      }
      const requestId = options.toolUseID;
      const info: PendingApproval = {
        engineSessionId: owner.id,
        requestId,
        toolCallId: options.toolUseID,
        options: APPROVAL_OPTIONS.map((option) => ({ ...option })),
      };
      return new Promise<PermissionResult>((resolve) => {
        let done = false;
        const finish = (result: PermissionResult) => {
          if (done) return;
          done = true;
          owner.approvals.delete(requestId);
          options.signal.removeEventListener('abort', onAbort);
          resolve(result);
        };
        const entry: ApprovalEntry = {
          info,
          decide: (decision) => {
            if (decision === 'cancel') turn.stoppedByUser = true;
            finish(
              permissionResult({
                decision,
                toolName,
                toolInput,
                toolUseID: options.toolUseID,
                ...(options.suggestions !== undefined && { suggestions: options.suggestions }),
              }),
            );
          },
          end: (reason) => {
            if (done) return;
            owner.hub.emit({
              type: 'approval.cancelled',
              engineSessionId: owner.id,
              requestId,
              reason,
            });
            finish({
              behavior: 'deny',
              message: 'The turn ended before the user decided.',
              toolUseID: options.toolUseID,
              interrupt: true,
            });
          },
        };
        const onAbort = () => entry.end(turn.cancelRequested ? 'turn_cancelled' : 'turn_ended');
        options.signal.addEventListener('abort', onAbort, { once: true });
        owner.approvals.set(requestId, entry);
        owner.hub.emit({
          type: 'approval.requested',
          ...info,
          options: info.options.map((o) => ({ ...o })),
        });
        if (options.signal.aborted) onAbort();
      });
    };
  }

  /** AskUserQuestion：问用户，回答作为工具的输入交回去（T3 的做法）。 */
  #ask(
    owner: Owner,
    toolUseID: string,
    toolInput: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const requestId = toolUseID;
    return new Promise<PermissionResult>((resolve) => {
      let done = false;
      const finish = (result: PermissionResult) => {
        if (done) return;
        done = true;
        owner.questions.delete(requestId);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const entry: QuestionEntry = {
        answer: (answers) =>
          finish({
            behavior: 'allow',
            updatedInput: { questions: toolInput.questions, answers: askUserAnswers(answers) },
            toolUseID,
          }),
        end: (reason) => {
          if (done) return;
          owner.hub.emit({
            type: 'question.cancelled',
            engineSessionId: owner.id,
            requestId,
            reason,
          });
          finish({ behavior: 'deny', message: 'User cancelled tool execution.', toolUseID });
        },
      };
      const onAbort = () => entry.end('turn_cancelled');
      signal.addEventListener('abort', onAbort, { once: true });
      owner.questions.set(requestId, entry);
      owner.hub.emit({
        type: 'question.requested',
        engineSessionId: owner.id,
        requestId,
        toolCallId: toolUseID,
        questions: askUserQuestions(toolInput),
      });
      if (signal.aborted) onAbort();
    });
  }

  /** 审批属于哪个会话：子 agent 的请求带 `agentID`（它的任务 ID），也可能已经从消息里认出了这次工具调用。 */
  #requestOwner(session: RootSession, toolUseID: string, agentID: string | undefined): Owner {
    for (const child of session.children.values()) {
      if (child.tools.has(toolUseID)) return child;
    }
    if (agentID !== undefined) {
      for (const child of session.children.values()) {
        if (child.taskId === agentID) return child;
      }
    }
    return session;
  }

  /** 报 `tool.started`（一次工具调用只报一次；审批可能先于消息到）。 */
  #toolStarted(
    session: RootSession,
    owner: Owner,
    toolCallId: string,
    toolName: string,
    input: unknown,
  ): void {
    if (owner.tools.has(toolCallId)) return;
    owner.tools.set(toolCallId, { name: toolName, input });
    owner.hub.emit({
      type: 'tool.started',
      engineSessionId: owner.id,
      toolCallId,
      toolName,
      display: claudeToolDisplay(toolName, input),
      input,
    });
    if (toolName === 'TodoWrite') {
      const items = todoWriteItems(input);
      if (items !== undefined) {
        owner.hub.emit({ type: 'todo.updated', engineSessionId: owner.id, toolCallId, items });
      }
    }
    if (isSubagentTool(toolName) && !session.children.has(toolCallId)) {
      this.#startChild(session, owner, toolCallId, input);
    }
  }

  // ── 内部：子 agent ───────────────────────────────────────────────────────────

  #startChild(session: RootSession, parent: Owner, toolUseId: string, input: unknown): void {
    const fields = record(input);
    const prompt = typeof fields.prompt === 'string' ? fields.prompt : undefined;
    const description = typeof fields.description === 'string' ? fields.description.trim() : '';
    const role = typeof fields.subagent_type === 'string' ? fields.subagent_type : undefined;
    const model = typeof fields.model === 'string' ? canonicalClaudeModel(fields.model) : undefined;
    const child: ChildSession = {
      kind: 'child',
      id: `${session.id}/${toolUseId}`,
      root: session,
      parent,
      toolUseId,
      hub: new EventHub({ bufferUntilSubscribed: true }),
      approvals: new Map(),
      questions: new Map(),
      tools: new Map(),
      finished: new Set(),
      blockCounts: new Map(),
      tasks: new Map(),
      running: true,
      background: false,
      sawMessage: false,
    };
    session.children.set(toolUseId, child);
    this.#sessions.set(child.id, child);
    const title = description !== '' ? description : (prompt?.split('\n')[0]?.trim() ?? '');
    parent.hub.emit({
      type: 'subagent.started',
      engineSessionId: parent.id,
      childEngineSessionId: child.id,
      parentToolCallId: toolUseId,
      title,
      ...(prompt !== undefined && { prompt }),
      ...(model !== undefined && { modelId: model }),
      ...(role !== undefined && { role }),
    });
    child.hub.emit({
      type: 'turn.started',
      engineSessionId: child.id,
      ...(prompt !== undefined && { input: [{ type: 'text', text: prompt }] }),
    });
  }

  #settleChild(
    child: ChildSession,
    terminal:
      | { type: 'turn.settled'; outcome: TurnSettledEvent['outcome']; stopReason: string }
      | Omit<TurnFailedEvent, 'engineSessionId'>,
    finalText?: string,
  ): void {
    if (!child.running) return;
    child.running = false;
    for (const entry of [...child.approvals.values()]) {
      entry.end(
        terminal.type === 'turn.settled' && terminal.outcome === 'cancelled'
          ? 'turn_cancelled'
          : 'turn_ended',
      );
    }
    for (const entry of [...child.questions.values()]) entry.end('turn_ended');
    if (!child.sawMessage && finalText !== undefined && finalText.trim() !== '') {
      child.hub.emit({
        type: 'assistant.message',
        engineSessionId: child.id,
        messageId: `${child.toolUseId}:result`,
        text: finalText,
        replaces: [],
      });
    }
    child.hub.emit({ ...terminal, engineSessionId: child.id } as AgentEvent);
  }

  #cancelChild(child: ChildSession): void {
    if (!child.running) return;
    const live = child.root.live;
    if (child.taskId !== undefined && live !== undefined) {
      live.query.stopTask(child.taskId).catch((error: unknown) => {
        this.#logger?.warn('claude could not stop a subagent', { error: describe(error) });
      });
    }
    this.#settleChild(child, {
      type: 'turn.settled',
      outcome: 'cancelled',
      stopReason: 'cancelled',
    });
  }

  // ── 内部：消息映射 ────────────────────────────────────────────────────────────

  #handle(session: RootSession, live: LiveQuery, message: SDKMessage): void {
    const key = message.type === 'system' ? `system/${message.subtype}` : message.type;
    // 排队的用户消息的进度（新版 `claude`，SDK 的类型里还没有）：插话被取消时不再等它。
    const lifecycle = message as unknown as { type: string; command_uuid?: string; state?: string };
    if (lifecycle.type === 'command_lifecycle') {
      if (lifecycle.state === 'cancelled') this.#steerDropped(session, lifecycle.command_uuid);
      return;
    }
    switch (message.type) {
      case 'stream_event':
        if (message.parent_tool_use_id === null && session.turn !== undefined) {
          this.#noteSteers(session, message);
          this.#streamEvent(session, message.event);
        }
        return;
      case 'assistant':
        this.#assistant(session, message);
        return;
      case 'user':
        if ('isReplay' in message && message.isReplay === true) return;
        this.#user(session, message);
        return;
      case 'result':
        this.#result(session, message);
        return;
      case 'rate_limit_event':
        this.accounts.applyRateLimit(message.rate_limit_info);
        return;
      case 'system':
        if (message.subtype === 'init') {
          if (message.permissionMode !== live.applied.mode) {
            this.#logger?.warn('claude started in a different permission mode', {
              requested: live.applied.mode,
              actual: message.permissionMode,
            });
          }
          return;
        }
        if (message.subtype === 'task_started') {
          const child =
            message.tool_use_id === undefined
              ? undefined
              : session.children.get(message.tool_use_id);
          if (child !== undefined) child.taskId = message.task_id;
          return;
        }
        if (message.subtype === 'task_notification') {
          const child =
            message.tool_use_id === undefined
              ? undefined
              : session.children.get(message.tool_use_id);
          if (child?.background === true) {
            this.#settleChild(
              child,
              message.status === 'completed'
                ? { type: 'turn.settled', outcome: 'completed', stopReason: 'end_turn' }
                : message.status === 'stopped'
                  ? { type: 'turn.settled', outcome: 'cancelled', stopReason: 'stopped' }
                  : { type: 'turn.failed', category: 'unknown', message: message.summary },
              message.summary,
            );
          }
          return;
        }
        if (message.subtype === 'status') {
          this.#compactionStatus(session, message);
          return;
        }
        if (message.subtype === 'compact_boundary') {
          this.#compacted(session, message);
          return;
        }
        if (message.subtype === 'api_retry' && session.stream !== undefined) {
          session.hub.emit({
            type: 'assistant.stream_ended',
            engineSessionId: session.id,
            attemptId: session.stream.attemptId,
            outcome: 'abandoned',
          });
          session.stream = undefined;
          return;
        }
        break;
      default:
        break;
    }
    if (IGNORED_MESSAGES.has(key)) return;
    session.hub.emit({
      type: 'engine.raw',
      engineSessionId: session.id,
      protocol: ENGINE_RAW_PROTOCOL,
      method: message.type,
      ...(message.type === 'system' && { kind: message.subtype }),
      params: message,
    });
  }

  /**
   * `status`（0.24.0）：`compacting` 是压缩开始（`compact` 开的回合是 `manual`，其余是 Claude 自己压缩）；压缩失败
   * （`compact_result: 'failed'`）时丢掉，回合照常结算。其余状态不出事件。
   */
  #compactionStatus(
    session: RootSession,
    message: Extract<SDKMessage, { type: 'system'; subtype: 'status' }>,
  ): void {
    const turn = session.turn;
    if (turn === undefined || turn.settled) return;
    if (message.status === 'compacting') {
      if (turn.compaction !== undefined) return;
      const compaction = {
        id: message.uuid,
        trigger: turn.kind === 'compact' ? ('manual' as const) : ('auto' as const),
      };
      turn.compaction = compaction;
      session.hub.emit({
        type: 'context.compacting',
        engineSessionId: session.id,
        compactionId: compaction.id,
        trigger: compaction.trigger,
      });
      return;
    }
    if (message.compact_result === 'failed') turn.compaction = undefined;
  }

  /** `compact_boundary`（0.24.0）：压缩完成；`post_tokens` 是压缩后的上下文用量（T3 同样拿它更新用量）。 */
  #compacted(
    session: RootSession,
    message: Extract<SDKMessage, { type: 'system'; subtype: 'compact_boundary' }>,
  ): void {
    const turn = session.turn;
    if (turn === undefined || turn.settled) {
      this.#raw(session, message);
      return;
    }
    const compactionId = turn.compaction?.id ?? message.uuid;
    turn.compaction = undefined;
    session.hub.emit({
      type: 'context.compacted',
      engineSessionId: session.id,
      compactionId,
      trigger: message.compact_metadata.trigger,
    });
    const post = message.compact_metadata.post_tokens;
    if (typeof post === 'number' && Number.isFinite(post) && post > 0) {
      turn.lastContextUsed = Math.round(post);
      session.hub.emit({
        type: 'usage.updated',
        engineSessionId: session.id,
        contextUsed: turn.lastContextUsed,
        contextSize: claudeContextWindow(session.config.modelId) ?? 200_000,
      });
    }
  }

  /** Claude 取消了排队的插话：不再等它，之前推迟的结果照常结算。 */
  #steerDropped(session: RootSession, uuid: string | undefined): void {
    const turn = session.turn;
    const steer = turn?.steers.find((candidate) => candidate.uuid === uuid && !candidate.folded);
    if (turn === undefined || steer === undefined) return;
    steer.dropped = true;
    const deferred = turn.deferredResult;
    if (
      deferred !== undefined &&
      !turn.steers.some((item) => !item.folded && item.dropped !== true)
    ) {
      turn.deferredResult = undefined;
      this.#result(session, deferred);
    }
  }

  /** 插话进了回合：消息带上了它的 uuid（Claude 的 `user_message_uuids`）。 */
  #noteSteers(
    session: RootSession,
    message: { user_message_uuids?: string[]; user_message_uuid?: string },
  ): void {
    const turn = session.turn;
    if (turn === undefined || turn.steers.length === 0) return;
    const uuids =
      message.user_message_uuids ??
      (message.user_message_uuid === undefined ? [] : [message.user_message_uuid]);
    for (const steer of turn.steers) {
      if (steer.folded || !uuids.includes(steer.uuid)) continue;
      steer.folded = true;
      this.#flushStream(session);
      session.hub.emit({
        type: 'turn.steered',
        engineSessionId: session.id,
        steerId: steer.steerId,
      });
    }
  }

  #streamEvent(
    session: RootSession,
    event: Extract<SDKMessage, { type: 'stream_event' }>['event'],
  ): void {
    switch (event.type) {
      case 'message_start':
        this.#flushStream(session);
        session.stream = { attemptId: event.message.id, blocks: new Map() };
        return;
      case 'content_block_start': {
        const block = event.content_block;
        if (session.stream === undefined) return;
        if (block.type === 'text' || block.type === 'thinking') {
          const kind = block.type === 'text' ? 'text' : 'reasoning';
          session.stream.blocks.set(event.index, { kind, text: '', replaced: false });
          const initial = block.type === 'text' ? block.text : block.thinking;
          if (initial !== '') this.#delta(session, event.index, kind, initial);
        }
        return;
      }
      case 'content_block_delta': {
        const delta = event.delta;
        if (delta.type === 'text_delta') this.#delta(session, event.index, 'text', delta.text);
        else if (delta.type === 'thinking_delta')
          this.#delta(session, event.index, 'reasoning', delta.thinking);
        return;
      }
      default:
        return;
    }
  }

  #delta(session: RootSession, blockIndex: number, kind: 'text' | 'reasoning', text: string): void {
    const block = session.stream?.blocks.get(blockIndex);
    if (session.stream === undefined || block === undefined || block.kind !== kind || text === '')
      return;
    block.text += text;
    session.hub.emit({
      type: 'assistant.delta',
      engineSessionId: session.id,
      attemptId: session.stream.attemptId,
      blockIndex,
      kind,
      text,
    });
  }

  /** 没等到快照的增量块按已收到的文本提交（中断时的半截输出）。 */
  #flushStream(session: RootSession): void {
    const stream = session.stream;
    if (stream === undefined) return;
    for (const [blockIndex, block] of stream.blocks) {
      if (block.replaced) continue;
      block.replaced = true;
      session.hub.emit({
        type: block.kind === 'text' ? 'assistant.message' : 'assistant.thought',
        engineSessionId: session.id,
        messageId: `${stream.attemptId}:${blockIndex}`,
        text: block.text,
        replaces: [{ attemptId: stream.attemptId, blockIndex }],
      });
    }
  }

  #owner(session: RootSession, parentToolUseId: string | null): Owner | undefined {
    if (parentToolUseId === null) return session;
    return session.children.get(parentToolUseId);
  }

  #assistant(session: RootSession, message: Extract<SDKMessage, { type: 'assistant' }>): void {
    const turn = session.turn;
    const owner = this.#owner(session, message.parent_tool_use_id);
    if (owner === undefined || turn === undefined) {
      this.#raw(session, message);
      return;
    }
    if (owner === session) {
      this.#noteSteers(session, message);
      turn.lastEntryUuid = message.uuid;
      if (message.error === 'authentication_failed') {
        turn.authFailed = true;
        this.accounts.markSignedOut('Claude is not signed in or the login expired');
      }
      this.#usage(session, turn, message);
    }
    // CLI 自己生成的错误消息（`<synthetic>` 且带 error）：错误进回合的 turn.failed，不当回答显示（T3 同）。
    if (message.message.model === '<synthetic>' && message.error !== undefined) return;
    const messageId = message.message.id;
    let index = owner.blockCounts.get(messageId) ?? 0;
    for (const block of message.message.content as unknown[]) {
      const blockIndex = index;
      index += 1;
      const fields = record(block);
      if (fields.type === 'text' && typeof fields.text === 'string') {
        this.#committed(session, owner, 'text', messageId, blockIndex, fields.text);
      } else if (fields.type === 'thinking' && typeof fields.thinking === 'string') {
        this.#committed(session, owner, 'reasoning', messageId, blockIndex, fields.thinking);
      } else if (
        (fields.type === 'tool_use' ||
          fields.type === 'server_tool_use' ||
          fields.type === 'mcp_tool_use') &&
        typeof fields.id === 'string' &&
        typeof fields.name === 'string'
      ) {
        this.#toolStarted(session, owner, fields.id, fields.name, fields.input);
      }
    }
    owner.blockCounts.set(messageId, index);
  }

  /** 已提交的文本或思考：替换同一块的增量（只有顶层会话有增量）。 */
  #committed(
    session: RootSession,
    owner: Owner,
    kind: 'text' | 'reasoning',
    messageId: string,
    blockIndex: number,
    snapshotText: string,
  ): void {
    const block =
      owner === session && session.stream?.attemptId === messageId
        ? session.stream.blocks.get(blockIndex)
        : undefined;
    const matched = block !== undefined && block.kind === kind && !block.replaced;
    // 思考的快照可能不带文本（不显示思考时），以增量拼出的为准。
    const text = snapshotText !== '' ? snapshotText : matched ? block.text : '';
    if (matched) block.replaced = true;
    if (text === '' && !matched) return;
    if (owner !== session) (owner as ChildSession).sawMessage ||= kind === 'text';
    owner.hub.emit({
      type: kind === 'text' ? 'assistant.message' : 'assistant.thought',
      engineSessionId: owner.id,
      messageId: `${messageId}:${blockIndex}`,
      text,
      replaces: matched ? [{ attemptId: messageId, blockIndex }] : [],
    });
  }

  #usage(
    session: RootSession,
    turn: Turn,
    message: Extract<SDKMessage, { type: 'assistant' }>,
  ): void {
    const usage = message.message.usage as unknown as Record<string, unknown> | undefined;
    if (usage === undefined || message.message.model === '<synthetic>') return;
    if (turn.usageMessages.has(message.message.id)) return;
    turn.usageMessages.add(message.message.id);
    const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
    // 同 T3 的 `claudeProviderTurnTokenUsage`：输入（含缓存的读写）加输出。
    const contextUsed =
      count('input_tokens') +
      count('cache_creation_input_tokens') +
      count('cache_read_input_tokens') +
      count('output_tokens');
    turn.lastContextUsed = contextUsed;
    session.hub.emit({
      type: 'usage.updated',
      engineSessionId: session.id,
      contextUsed,
      contextSize: claudeContextWindow(session.config.modelId) ?? 200_000,
    });
  }

  #user(session: RootSession, message: Extract<SDKMessage, { type: 'user' }>): void {
    const turn = session.turn;
    const owner = this.#owner(session, message.parent_tool_use_id);
    if (owner === undefined || turn === undefined) {
      this.#raw(session, message);
      return;
    }
    if (owner === session && typeof message.uuid === 'string') turn.lastEntryUuid = message.uuid;
    const content = message.message.content;
    if (!Array.isArray(content)) return;
    const results = content.filter((part) => record(part).type === 'tool_result');
    for (const part of results) {
      const fields = record(part);
      const toolCallId = fields.tool_use_id;
      if (typeof toolCallId !== 'string' || owner.finished.has(toolCallId)) continue;
      owner.finished.add(toolCallId);
      const text = toolResultText(fields.content);
      const failed = fields.is_error === true;
      owner.hub.emit({
        type: 'tool.finished',
        engineSessionId: owner.id,
        toolCallId,
        status: failed ? 'failed' : 'completed',
        ...(text !== undefined && { output: text }),
      });
      const tool = owner.tools.get(toolCallId);
      const structured = results.length === 1 ? message.tool_use_result : undefined;
      if (tool !== undefined && !failed && TASK_TOOLS.has(tool.name)) {
        const tasks = applyTaskTool(owner.tasks, tool.name, tool.input, structured);
        if (tasks !== undefined) {
          owner.tasks = tasks;
          owner.hub.emit({
            type: 'todo.updated',
            engineSessionId: owner.id,
            toolCallId,
            items: [...tasks.values()].map((item) => ({ ...item })),
          });
        }
      }
      const child = session.children.get(toolCallId);
      if (child !== undefined) {
        if (!failed && isAsyncLaunchAck(structured, text)) {
          child.background = true;
        } else {
          this.#settleChild(
            child,
            failed
              ? { type: 'turn.failed', category: 'unknown', message: text ?? 'the subagent failed' }
              : { type: 'turn.settled', outcome: 'completed', stopReason: 'end_turn' },
            text,
          );
        }
      }
    }
  }

  #result(session: RootSession, message: SDKResultMessage): void {
    const turn = session.turn;
    if (turn === undefined || turn.settled) {
      this.#raw(session, message);
      return;
    }
    // 回答的是别的一轮（Claude 自己开的，如后台任务结束后的唤醒）：结果带的 uuid 里没有这个回合的消息（T3 的
    // `isClaudeResultForOtherTurn`）。
    const echoed =
      message.user_message_uuids ??
      (message.user_message_uuid === undefined ? [] : [message.user_message_uuid]);
    // `/compact` 是本地命令（0.24.0），它的结果不一定带这条消息的 uuid。
    if (
      turn.kind !== 'compact' &&
      echoed.length > 0 &&
      !echoed.includes(turn.promptUuid) &&
      !turn.steers.some((steer) => echoed.includes(steer.uuid))
    ) {
      this.#raw(session, message);
      return;
    }
    this.#noteSteers(session, message);
    // 插话排进了下一轮（这一轮在它并进来之前就结束了，`now` 时是被它打断）：Claude 接着以它开一轮，Wevir 当作同一个回合。
    // `queued_turn_count` 不数这种消息（实测为 0），所以只看插话有没有进回合。
    const pendingSteer = turn.steers.some((steer) => !steer.folded && steer.dropped !== true);
    if (pendingSteer && !turn.cancelRequested) {
      turn.deferredResult = message;
      return;
    }

    const totalTokens = Object.values(message.modelUsage ?? {}).reduce(
      (sum, usage) =>
        sum +
        usage.inputTokens +
        usage.outputTokens +
        usage.cacheReadInputTokens +
        usage.cacheCreationInputTokens,
      0,
    );
    if (turn.lastContextUsed !== undefined && totalTokens > 0) {
      session.hub.emit({
        type: 'usage.updated',
        engineSessionId: session.id,
        contextUsed: turn.lastContextUsed,
        contextSize: claudeContextWindow(session.config.modelId) ?? 200_000,
        totalTokens,
      });
    }
    if (turn.cancelRequested || turn.stoppedByUser || isAbortedResult(message)) {
      this.#settle(session, turn, {
        type: 'turn.settled',
        outcome: 'cancelled',
        stopReason: message.terminal_reason ?? 'interrupted',
      });
      return;
    }
    const failure = resultFailure(message, turn.authFailed);
    if (failure !== undefined) {
      this.#settle(session, turn, { type: 'turn.failed', ...failure });
      return;
    }
    session.lastSettledUuid = turn.lastEntryUuid ?? session.lastSettledUuid;
    this.#settle(session, turn, {
      type: 'turn.settled',
      outcome: 'completed',
      stopReason: message.stop_reason ?? message.terminal_reason ?? 'end_turn',
    });
  }

  #settle(
    session: RootSession,
    turn: Turn,
    terminal:
      | { type: 'turn.settled'; outcome: TurnSettledEvent['outcome']; stopReason: string }
      | Omit<TurnFailedEvent, 'engineSessionId'>,
  ): void {
    if (turn.settled) return;
    turn.settled = true;
    this.#flushStream(session);
    session.stream = undefined;
    const cancelled = terminal.type === 'turn.settled' && terminal.outcome === 'cancelled';
    for (const entry of [...session.approvals.values()])
      entry.end(cancelled ? 'turn_cancelled' : 'turn_ended');
    for (const entry of [...session.questions.values()])
      entry.end(cancelled ? 'turn_cancelled' : 'turn_ended');
    for (const child of session.children.values()) {
      if (child.running && !child.background) {
        this.#settleChild(child, {
          type: 'turn.settled',
          outcome: 'cancelled',
          stopReason: 'parent_turn_ended',
        });
      }
    }
    if (session.turn === turn) session.turn = undefined;
    session.hub.emit({ ...terminal, engineSessionId: session.id } as AgentEvent);
    for (const waiter of turn.waiters.splice(0)) waiter();
  }

  #raw(session: RootSession, message: SDKMessage): void {
    session.hub.emit({
      type: 'engine.raw',
      engineSessionId: session.id,
      protocol: ENGINE_RAW_PROTOCOL,
      method: message.type,
      ...(message.type === 'system' && { kind: message.subtype }),
      params: message,
    });
  }
}

/**
 * 逐条读 `Query`（T3 的 `claudeQueryMessages`）：迭代 Query 本身而不是它的 `[Symbol.asyncIterator]()`——后者的 `return()`
 * 排在进行中的读后面，`claude` 空闲时永远不结束；Query 的 `return()` 先关掉传输。
 */
function iterate(query: Query): AsyncIterable<SDKMessage> {
  return { [Symbol.asyncIterator]: () => query };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAdapterErrorLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'AdapterError';
}
