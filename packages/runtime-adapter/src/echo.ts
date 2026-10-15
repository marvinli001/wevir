import { randomUUID } from 'node:crypto';
import type { AgentRuntimeAdapter, CancelOptions } from './adapter.js';
import { AdapterError } from './errors.js';
import { EventHub } from './event-hub.js';
import type { AgentEvent, ApprovalCancelledEvent, EngineExitedEvent } from './events.js';
import type {
  AgentInput,
  ApprovalDecision,
  ApprovalOption,
  EngineSession,
  PendingApproval,
  PermissionMode,
  ReviewRequest,
  SessionConfig,
  UserQuestion,
} from './types.js';

export interface EchoAdapterOptions {
  /** 每个增量分片的字符数，默认 4。 */
  chunkSize?: number;
  /**
   * 每一步（一个分片、一次工具执行）前的延迟毫秒数，默认 2。为 0 时仍经过一次 setTimeout，让出
   * 事件循环。计时器都走全局 setTimeout，测试里可以用 `vi.useFakeTimers()` 逐步推进。
   */
  stepDelayMs?: number;
  /** false 时不发 `assistant.delta`，只发已提交消息（模拟 stream-tap 旁路缺失）。默认 true。 */
  incrementalStream?: boolean;
  /** `createSession` / `resumeSession` 报的引擎版本（`EngineSession.engineVersion`）；默认不报。 */
  engineVersion?: string;
}

/** `simulateEngineExit` 的参数，对应真实进程的退出信息。 */
export interface EchoExitInfo {
  exitCode?: number | null;
  /** 默认 'SIGKILL'。 */
  signal?: string | null;
  stderrTail?: string;
  /** 模拟适配器主动重启：应用新配置（T3.4）、取消得不到确认（T3.5）。 */
  reason?: EngineExitedEvent['reason'];
}

/** Echo 的审批选项，取 dsh 的值（T0.3 §5.2）。 */
/** `plan` 关键词的清单（U20）。 */
export const ECHO_PLAN = ['Read the relevant files', 'Make the change', 'Run the tests and report'];

/** `suggest` 关键词建议的后续任务（U23）。`prompt` 带关键词，开出来的会话照样有可看的过程。 */
export const ECHO_SUGGESTIONS: ReadonlyArray<{ title: string; prompt: string; reason: string }> = [
  {
    title: 'Add tests for the export functions',
    prompt: 'tool: add unit tests for the three export functions and run them',
    reason: 'The export format changed and nothing covers it yet',
  },
  {
    title: 'Update the README usage section',
    prompt: 'plan: update the README usage section for the new export format',
    reason: 'The README still shows the old flags',
  },
];

export const ECHO_APPROVAL_OPTIONS: readonly ApprovalOption[] = Object.freeze([
  { optionId: 'allow-once', label: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', label: 'Reject', kind: 'reject_once' },
]);

/** 上下文窗口的假值，`usage.updated` 用。 */
const ECHO_CONTEXT_SIZE = 128_000;

type AbortKind = 'cancel' | 'exit' | 'dispose';

/** 回合被打断的原因，作为 AbortSignal 的 reason。 */
class TurnAbort extends Error {
  readonly kind: AbortKind;

  constructor(kind: AbortKind) {
    super(`echo turn aborted: ${kind}`);
    this.kind = kind;
  }
}

interface PendingDecision {
  info: PendingApproval;
  decide(optionId: string): void;
}

interface PendingQuestionReply {
  requestId: string;
  engineSessionId: string;
  answer(answers: Record<string, string[]>): void;
}

interface EchoTurn {
  readonly abort: AbortController;
  /** `ask` 关键词提的问题（0.10.0），等 `respondToQuestion`。 */
  question?: PendingQuestionReply;
  /** 回合开始时会话的事件扇出。会话 resume 后换了新的，旧回合的残余事件不会串进去。 */
  readonly hub: EventHub<AgentEvent>;
  approval?: PendingDecision;
  cancelRequested: boolean;
  /** 交出来、还没放进回合的插话（R11），每次回复之后一并放进去。 */
  readonly steers: Array<{ steerId: string; text: string }>;
  /** 回合循环；永不 reject。 */
  done: Promise<void>;
}

interface EchoSession {
  readonly id: string;
  /** 模型与推理档位可由 `configureSession` 改（0.9.0），下一个回合起生效。 */
  config: SessionConfig;
  /** 子会话的父会话（`subagent` 关键词派出的）。 */
  readonly parentId?: string;
  status: 'open' | 'closed' | 'detached';
  hub: EventHub<AgentEvent>;
  turn?: EchoTurn;
  turnCount: number;
  /** `injectNote` 补进来、还没用上的说明（U23），下一个回合的回复末尾写出来。 */
  notes: string[];
  /** `fork` 分出的支线（U23.1）。 */
  readonly side?: true;
}

interface ReplyBlock {
  kind: 'text' | 'reasoning';
  full: string;
  /** 已“生成”的部分；取消时以它为准补发已提交消息。 */
  generated: string;
}

/**
 * 开发用的假引擎，让 Host（M2）不依赖 dsh 就能开发和测试。回复 `Echo: <输入>`，先按分片发增量，
 * 再发替换它们的已提交消息。输入里的关键词（不分大小写）触发其他行为：
 *
 * | 关键词 | 行为 |
 * |---|---|
 * | `tool` | 回复前模拟一次工具调用（`echo`，不需要审批） |
 * | `approve` | 模拟一次需要审批的写文件（`echo_write`）：先发审批请求，等决定后继续；允许则工具完成，拒绝则工具失败，回合照常结束 |
 * | `ask` | 向用户提两个问题（0.10.0：一个单选可填其他、一个多选），等 `respondToQuestion` 后在回复末尾写出回答 |
 * | `think` | 回复前先发一段思考（reasoning 增量 → `assistant.thought`） |
 * | `fail` | 回合以 `turn.failed` 结束（模拟 dsh 的 -32603 回合失败） |
 * | `slow` | 回复的每个分片前多等九步，回合持续得久一些，测试插话与排队用（R11） |
 * | `compact` | 回复前像引擎自己压缩一次上下文（`context.compacting` → `context.compacted`，`auto`，0.24.0） |
 * | `plan` | 回合里带一份三步的清单（`todo.updated`，像 Codex 的计划）：开始时第一步进行中，工具与审批之后第二步、回复前第三步，回复完全部完成（U20） |
 * | `suggest` | 回复前调一次 `suggest_tasks` 工具，建议两项后续任务（`tasks.suggested`，`ECHO_SUGGESTIONS`，U23） |
 * | `subagent` | 模拟 Codex 的子 agent（R4）：调 `spawn_agent` 派出一个子会话（父会话的流里 `subagent.started`），子会话以
 *   `turn.started` 开始一个回合，输入是 `Helper task: <输入，subagent 换成 helper>`，所以输入里的其他关键词由子会话执行
 *   （例如 `approve` 让子会话请求审批）；父回合 `wait_agent` 等它结束再回复。再有 `close` 时父 agent 随后关掉它
 *   （`subagent.updated` 的 `closed`）。父回合被取消时子会话照常跑完（与 Codex 相同，Host 自己级联取消） |
 *
 * `fork`（U23.1）分出的支线回复 `Echo (side): <输入>`。`injectNote`（U23）补进来的说明在下一个回合的回复末尾写成 `Notes: <每条的第一行>`，像模型在上下文里看到了它。
 *
 * 插话（R11，`steer`）：回合进行中交来的输入在当前这次回复之后放进回合（`turn.steered`），再回复一次
 * `Echo: <插话>`（新的 attempt），像 Codex 在一次采样之后用上待处理的输入；回合被取消或引擎退出时丢掉没用上的。
 *
 * 取消时：未决审批以 `approval.cancelled` 结束，未完成的工具以 failed 结束，已生成的半段回复作为
 * 已提交消息补发（与 dsh 相同，T0.3 E2），回合以 `turn.settled`（`cancelled`）结束。
 * `simulateEngineExit()` 模拟引擎进程退出，供 Host 测试 `engine.exited` 的处理。
 */
export class EchoAdapter implements AgentRuntimeAdapter {
  /** 三种权限模式都认（0.11.0）：`approve` 关键词在 `on_request` 下请求审批，另外两种直接写（auto_review 当作审查通过）。 */
  readonly permissionModes: readonly PermissionMode[] = [
    'on_request',
    'auto_review',
    'full_access',
  ];
  readonly #chunkSize: number;
  readonly #stepDelayMs: number;
  readonly #incremental: boolean;
  readonly #engineVersion: string | undefined;
  readonly #sessions = new Map<string, EchoSession>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #idCounter = 0;
  #disposed: Promise<void> | undefined;

  constructor(options: EchoAdapterOptions = {}) {
    this.#chunkSize = Math.max(1, options.chunkSize ?? 4);
    this.#stepDelayMs = Math.max(0, options.stepDelayMs ?? 2);
    this.#incremental = options.incrementalStream ?? true;
    this.#engineVersion = options.engineVersion;
  }

  /** 未触发的计时器数；dispose 之后应为 0。 */
  get pendingTimerCount(): number {
    return this.#timers.size;
  }

  /** 适配器记得的会话数（含已关闭、已脱开的）；dispose 之后为 0。 */
  get sessionCount(): number {
    return this.#sessions.size;
  }

  async createSession(config: SessionConfig): Promise<EngineSession> {
    this.#assertUsable();
    if (!config.cwd) throw new AdapterError('invalid_input', 'cwd is required');
    const session: EchoSession = {
      id: `echo-${randomUUID()}`,
      config: { ...config },
      status: 'open',
      hub: new EventHub(),
      turnCount: 0,
      notes: [],
    };
    this.#sessions.set(session.id, session);
    return this.#describe(session);
  }

  /**
   * 会话只在内存里：不认识的 ID（例如 Host 重启后的新实例）报 `session_lost`（`not_found`），与 dsh 的会话日志
   * 被删除时相同。
   */
  async resumeSession(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    this.#assertUsable();
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_lost', `session is not resumable: ${engineSessionId}`, {
        lostReason: 'not_found',
      });
    }
    if (session.status === 'open') return this.#describe(session);
    if (config.cwd !== session.config.cwd) {
      throw new AdapterError('session_unavailable', `session cwd does not match: ${config.cwd}`);
    }
    session.status = 'open';
    session.hub = new EventHub();
    // 恢复后 Provider、模型、档位与权限模式按 `config` 重新选定（0.25.0 的接力换回用过的来源时用得到）。
    const { permissionMode: _mode, reasoningEffort: _effort, ...rest } = session.config;
    session.config = {
      ...rest,
      providerId: config.providerId,
      modelId: config.modelId,
      ...(config.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
      ...(config.permissionMode !== undefined && { permissionMode: config.permissionMode }),
    };
    return this.#describe(session);
  }

  subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    this.#assertUsable();
    return this.#openSession(engineSessionId).hub.subscribe();
  }

  async send(engineSessionId: string, input: AgentInput): Promise<void> {
    const { session, turn } = this.#beginTurn(engineSessionId, () => {
      if (input.content.length === 0) throw new AdapterError('invalid_input', 'content is empty');
    });
    turn.done = this.#runTurn(session, turn, input.content.map((part) => part.text).join('\n'));
  }

  /** 压缩上下文（0.24.0）：一个回合，`context.compacting` → `context.compacted`（`manual`），用量随之降下来。 */
  async compact(engineSessionId: string): Promise<void> {
    const { session, turn } = this.#beginTurn(engineSessionId);
    turn.done = this.#runCompact(session, turn);
  }

  /** 代码审查（0.24.0）：普通的回合，回复 `Echo: Review …`。 */
  async review(engineSessionId: string, request: ReviewRequest): Promise<void> {
    const { session, turn } = this.#beginTurn(engineSessionId);
    const text =
      request.target === 'branch'
        ? `Review the changes against ${request.baseBranch}`
        : 'Review the uncommitted changes';
    turn.done = this.#runTurn(session, turn, text);
  }

  #beginTurn(
    engineSessionId: string,
    check?: () => void,
  ): { session: EchoSession; turn: EchoTurn } {
    this.#assertUsable();
    const session = this.#openSession(engineSessionId);
    if (session.parentId !== undefined) {
      throw new AdapterError('invalid_input', 'a sub-agent session is driven by its parent agent');
    }
    if (session.turn) throw new AdapterError('session_busy', 'a turn is already running');
    check?.();
    session.turnCount += 1;
    const turn: EchoTurn = {
      abort: new AbortController(),
      hub: session.hub,
      cancelRequested: false,
      steers: [],
      done: Promise.resolve(),
    };
    session.turn = turn;
    return { session, turn };
  }

  async steer(engineSessionId: string, steerId: string, input: AgentInput): Promise<void> {
    this.#assertUsable();
    const session = this.#openSession(engineSessionId);
    if (session.parentId !== undefined) {
      throw new AdapterError('invalid_input', 'a sub-agent session is driven by its parent agent');
    }
    if (input.content.length === 0) throw new AdapterError('invalid_input', 'content is empty');
    const turn = session.turn;
    if (!turn || turn.cancelRequested) {
      throw new AdapterError('steer_rejected', 'no active turn to steer');
    }
    turn.steers.push({ steerId, text: input.content.map((part) => part.text).join('\n') });
  }

  async configureSession(
    engineSessionId: string,
    config: { modelId: string; reasoningEffort?: string; permissionMode?: PermissionMode },
  ): Promise<void> {
    this.#assertUsable();
    const session = this.#session(engineSessionId);
    if (session.parentId !== undefined) {
      throw new AdapterError('invalid_input', 'a sub-agent session is driven by its parent agent');
    }
    const { reasoningEffort: _effort, permissionMode: _mode, ...rest } = session.config;
    session.config = {
      ...rest,
      modelId: config.modelId,
      ...(config.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
      ...(config.permissionMode !== undefined && { permissionMode: config.permissionMode }),
    };
  }

  async respondToQuestion(
    engineSessionId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    this.#assertUsable();
    const turn = this.#session(engineSessionId).turn;
    const question = turn?.question;
    if (!turn || !question || question.requestId !== requestId) {
      throw new AdapterError('question_not_found', `no pending question ${requestId}`);
    }
    turn.question = undefined;
    question.answer(answers);
  }

  async respondToApproval(
    engineSessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    this.#assertUsable();
    const turn = this.#session(engineSessionId).turn;
    const approval = turn?.approval;
    if (!turn || !approval || approval.info.requestId !== requestId) {
      throw new AdapterError('approval_not_found', `no pending approval ${requestId}`);
    }
    if (!approval.info.options.some((option) => option.optionId === decision.optionId)) {
      throw new AdapterError('invalid_option', `unknown option ${decision.optionId}`);
    }
    turn.approval = undefined;
    approval.decide(decision.optionId);
  }

  async listPendingApprovals(engineSessionId?: string): Promise<PendingApproval[]> {
    this.#assertUsable();
    const pending: PendingApproval[] = [];
    for (const session of this.#sessions.values()) {
      if (engineSessionId !== undefined && session.id !== engineSessionId) continue;
      const info = session.turn?.approval?.info;
      if (info) pending.push(copyApproval(info));
    }
    return pending;
  }

  /** 额外的可写目录（0.15.0）只记下，假引擎不读写文件。 */
  readonly additionalRoots = true;

  /** `suggest` 关键词（U23）。 */
  readonly suggestedTasks = true;

  /**
   * 支线（U23.1）：新会话沿用 `config`，假引擎没有历史可带；原会话还没开始过回合时报 `invalid_input`（同 Codex 没有第一条
   * 用户消息时 fork 失败）。支线的回复写成 `Echo (side): <输入>`。
   */
  async fork(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    this.#assertUsable();
    const source = this.#openSession(engineSessionId);
    if (source.parentId !== undefined) {
      throw new AdapterError('invalid_input', 'a sub-agent session cannot be forked');
    }
    if (source.turnCount === 0) throw new AdapterError('invalid_input', 'nothing to fork yet');
    const session: EchoSession = {
      id: `echo-${randomUUID()}`,
      config: { ...config },
      status: 'open',
      hub: new EventHub(),
      turnCount: 0,
      notes: [],
      side: true,
    };
    this.#sessions.set(session.id, session);
    return this.#describe(session);
  }

  async injectNote(engineSessionId: string, text: string): Promise<void> {
    this.#assertUsable();
    this.#openSession(engineSessionId).notes.push(text);
  }

  /** 子会话的回合跟父回合在同一个进程里，单独停掉时父 agent 自然在等它结束（`notifyParent` 不用另外处理）。 */
  async cancel(engineSessionId: string, _options?: CancelOptions): Promise<void> {
    const turn = this.#sessions.get(engineSessionId)?.turn;
    if (!turn) return;
    if (!turn.cancelRequested) {
      turn.cancelRequested = true;
      cancelPendingApproval(turn, 'turn_cancelled');
      cancelPendingQuestion(turn, 'turn_cancelled');
      turn.abort.abort(new TurnAbort('cancel'));
    }
    await turn.done;
  }

  async close(engineSessionId: string): Promise<void> {
    this.#assertUsable();
    const session = this.#session(engineSessionId);
    if (session.status === 'closed') return;
    await this.cancel(engineSessionId);
    session.status = 'closed';
    session.hub.end();
  }

  dispose(): Promise<void> {
    this.#disposed ??= this.#dispose();
    return this.#disposed;
  }

  /**
   * 模拟引擎进程退出（不是 AgentRuntimeAdapter 的方法）。每个挂着的会话：未决审批以
   * `approval.cancelled`（`engine_exited`）结束，进行中的回合不再有终结事件，然后发 `engine.exited`
   * 并结束订阅；会话转为脱开，`resumeSession` 后可继续。
   */
  async simulateEngineExit(info: EchoExitInfo = {}): Promise<void> {
    this.#assertUsable();
    const turns: Promise<void>[] = [];
    for (const session of this.#sessions.values()) {
      if (session.status !== 'open') continue;
      const turn = session.turn;
      if (turn) {
        cancelPendingApproval(turn, 'engine_exited');
        cancelPendingQuestion(turn, 'engine_exited');
        turn.abort.abort(new TurnAbort('exit'));
        turns.push(turn.done);
      }
      session.hub.emit({
        type: 'engine.exited',
        engineSessionId: session.id,
        exitCode: info.exitCode ?? null,
        signal: info.signal === undefined ? 'SIGKILL' : info.signal,
        ...(info.stderrTail !== undefined && { stderrTail: info.stderrTail }),
        ...(info.reason !== undefined && { reason: info.reason }),
      });
      session.hub.end();
      session.status = 'detached';
    }
    await Promise.all(turns);
  }

  #describe(session: EchoSession): EngineSession {
    const { modelId, reasoningEffort } = session.config;
    return {
      engineSessionId: session.id,
      modelId,
      ...(reasoningEffort !== undefined && { reasoningEffort }),
      ...(this.#engineVersion !== undefined && { engineVersion: this.#engineVersion }),
    };
  }

  async #dispose(): Promise<void> {
    const turns: Promise<void>[] = [];
    for (const session of this.#sessions.values()) {
      const turn = session.turn;
      if (turn) {
        cancelPendingApproval(turn, 'disposed');
        cancelPendingQuestion(turn, 'disposed');
        turn.abort.abort(new TurnAbort('dispose'));
        turns.push(turn.done);
      }
      session.hub.end();
    }
    this.#sessions.clear();
    await Promise.all(turns);
  }

  async #runTurn(session: EchoSession, turn: EchoTurn, text: string): Promise<void> {
    const engineSessionId = session.id;
    const signal = turn.abort.signal;
    const emit = (event: AgentEvent) => turn.hub.emit(event);
    let attemptId = `${engineSessionId}:${session.turnCount}`;
    let blocks: ReplyBlock[] = [];
    const slowSteps = /slow/i.test(text) ? 10 : 1;
    const notes = session.notes.splice(0);
    /** 进行中的工具调用 → 被取消时的失败文本（措辞取 dsh，T0.3 E1、D）。 */
    const openTools = new Map<string, string>();

    try {
      await this.#step(signal);
      if (/fail/i.test(text)) {
        emit({
          type: 'turn.failed',
          engineSessionId,
          category: 'unknown',
          message: `turn failed: echo simulated failure for ${JSON.stringify(text)}`,
          code: -32603,
        });
        return;
      }

      const subagent = session.parentId === undefined && /subagent/i.test(text);
      // 清单（U20）：像 Codex 的 `turn/plan/updated`，每次发完整的列表，来源是合成的工具调用 ID。
      const planCallId = /\bplan\b/i.test(text) ? this.#nextId('plan_echo') : undefined;
      const plan = (done: number) => {
        if (planCallId === undefined) return;
        emit({
          type: 'todo.updated',
          engineSessionId,
          toolCallId: planCallId,
          items: ECHO_PLAN.map((content, index) => ({
            content,
            status: index < done ? 'completed' : index === done ? 'in_progress' : 'pending',
          })),
        });
      };
      plan(0);
      if (subagent) await this.#runSubagent(session, turn, text, openTools);

      if (!subagent && /tool/i.test(text)) {
        const toolCallId = this.#nextId('call_echo');
        emit({
          type: 'tool.started',
          engineSessionId,
          toolCallId,
          toolName: 'echo',
          display: { kind: 'unknown', summary: 'echo' },
          input: { text },
        });
        openTools.set(toolCallId, 'Error: tool call aborted');
        await this.#step(signal);
        openTools.delete(toolCallId);
        emit({
          type: 'tool.finished',
          engineSessionId,
          toolCallId,
          status: 'completed',
          output: text,
        });
      }

      if (!subagent && /approve/i.test(text)) {
        const toolCallId = this.#nextId('call_echo');
        const path = '/outside-workspace/echo.txt';
        emit({
          type: 'tool.started',
          engineSessionId,
          toolCallId,
          toolName: 'echo_write',
          display: { kind: 'write', summary: path, paths: [path] },
          input: { file_path: path, content: text },
        });
        openTools.set(toolCallId, 'Error: approval for echo_write was cancelled');
        // 只有 on_request 问用户；auto_review 当作审查通过，full_access 不问。
        let allowed = true;
        if ((session.config.permissionMode ?? 'on_request') === 'on_request') {
          const optionId = await this.#requestApproval(turn, engineSessionId, toolCallId);
          allowed =
            ECHO_APPROVAL_OPTIONS.find((option) => option.optionId === optionId)?.kind.startsWith(
              'allow',
            ) ?? false;
        }
        openTools.delete(toolCallId);
        emit(
          allowed
            ? {
                type: 'tool.finished',
                engineSessionId,
                toolCallId,
                status: 'completed',
                output: `Wrote ${path}`,
              }
            : {
                type: 'tool.finished',
                engineSessionId,
                toolCallId,
                status: 'failed',
                output: 'Error: the user rejected echo_write',
              },
        );
      }

      if (!subagent && /\bsuggest\b/i.test(text)) {
        const toolCallId = this.#nextId('call_echo');
        emit({
          type: 'tool.started',
          engineSessionId,
          toolCallId,
          toolName: 'suggest_tasks',
          display: { kind: 'unknown', summary: 'suggest_tasks' },
          input: { tasks: ECHO_SUGGESTIONS },
        });
        openTools.set(toolCallId, 'Error: tool call aborted');
        await this.#step(signal);
        openTools.delete(toolCallId);
        emit({
          type: 'tool.finished',
          engineSessionId,
          toolCallId,
          status: 'completed',
          output: `Handed ${ECHO_SUGGESTIONS.length} tasks to the user`,
        });
        emit({
          type: 'tasks.suggested',
          engineSessionId,
          toolCallId,
          tasks: ECHO_SUGGESTIONS.map((task) => ({ ...task })),
        });
      }

      plan(1);
      // 自动压缩（0.24.0）：像引擎在上下文快满时自己压缩，在回合中间。
      if (!subagent && /compact/i.test(text))
        await this.#compaction(signal, emit, engineSessionId, 'auto');
      let answered = '';
      if (!subagent && /\bask\b/i.test(text)) {
        const answers = await this.#askUser(turn, engineSessionId);
        answered = `\n\nAnswers: ${ECHO_QUESTIONS.map((q) => `${q.id}=${(answers[q.id] ?? []).join(', ')}`).join('; ')}`;
      }

      if (!subagent && /think/i.test(text)) {
        blocks.push({ kind: 'reasoning', full: `Thinking about: ${text}`, generated: '' });
      }
      const noted =
        notes.length > 0
          ? `\n\nNotes: ${notes.map((note) => note.split('\n')[0]).join(' | ')}`
          : '';
      const echo = session.side ? 'Echo (side)' : 'Echo';
      blocks.push({ kind: 'text', full: `${echo}: ${text}${answered}${noted}`, generated: '' });
      plan(2);
      await this.#reply(signal, emit, engineSessionId, attemptId, blocks, slowSteps);
      this.#commit(emit, engineSessionId, attemptId, blocks);
      blocks = [];
      plan(ECHO_PLAN.length);
      // 插话：这次回复之后放进回合，再回复一次（像 Codex 在一次采样之后用上待处理的输入）。
      for (let round = 1; turn.steers.length > 0; round += 1) {
        const steers = turn.steers.splice(0);
        for (const { steerId } of steers) emit({ type: 'turn.steered', engineSessionId, steerId });
        attemptId = `${engineSessionId}:${session.turnCount}:${round}`;
        blocks = [
          {
            kind: 'text',
            full: `Echo: ${steers.map((steer) => steer.text).join('\n')}`,
            generated: '',
          },
        ];
        await this.#reply(signal, emit, engineSessionId, attemptId, blocks, 1);
        this.#commit(emit, engineSessionId, attemptId, blocks);
        blocks = [];
      }
      emit({
        type: 'usage.updated',
        engineSessionId,
        contextUsed: 100 * session.turnCount,
        contextSize: ECHO_CONTEXT_SIZE,
        totalTokens: 1200 * session.turnCount,
      });
      emit({ type: 'turn.settled', engineSessionId, outcome: 'completed', stopReason: 'end_turn' });
    } catch (error) {
      if (!(error instanceof TurnAbort)) {
        emit({ type: 'turn.failed', engineSessionId, category: 'unknown', message: String(error) });
        return;
      }
      // 进程“死了”或 dispose：没有引擎再发事件。
      if (error.kind !== 'cancel') return;
      for (const [toolCallId, output] of openTools) {
        emit({ type: 'tool.finished', engineSessionId, toolCallId, status: 'failed', output });
      }
      this.#commit(emit, engineSessionId, attemptId, blocks);
      emit({
        type: 'turn.settled',
        engineSessionId,
        outcome: 'cancelled',
        stopReason: 'cancelled',
      });
    } finally {
      if (session.turn === turn) session.turn = undefined;
    }
  }

  /** `compact`（0.24.0）开的回合：只压缩上下文，不回复。取消时同普通回合。 */
  async #runCompact(session: EchoSession, turn: EchoTurn): Promise<void> {
    const engineSessionId = session.id;
    const signal = turn.abort.signal;
    const emit = (event: AgentEvent) => turn.hub.emit(event);
    try {
      await this.#step(signal);
      await this.#compaction(signal, emit, engineSessionId, 'manual');
      emit({
        type: 'usage.updated',
        engineSessionId,
        contextUsed: 50,
        contextSize: ECHO_CONTEXT_SIZE,
        totalTokens: 1200 * session.turnCount,
      });
      emit({
        type: 'turn.settled',
        engineSessionId,
        outcome: 'completed',
        stopReason: 'compacted',
      });
    } catch (error) {
      if (!(error instanceof TurnAbort)) {
        emit({ type: 'turn.failed', engineSessionId, category: 'unknown', message: String(error) });
        return;
      }
      if (error.kind !== 'cancel') return;
      emit({
        type: 'turn.settled',
        engineSessionId,
        outcome: 'cancelled',
        stopReason: 'cancelled',
      });
    } finally {
      if (session.turn === turn) session.turn = undefined;
    }
  }

  /** 一次上下文压缩：开始、过几步、完成。 */
  async #compaction(
    signal: AbortSignal,
    emit: (event: AgentEvent) => void,
    engineSessionId: string,
    trigger: 'manual' | 'auto',
  ): Promise<void> {
    const compactionId = this.#nextId('compact_echo');
    emit({ type: 'context.compacting', engineSessionId, compactionId, trigger });
    for (let step = 0; step < 5; step += 1) await this.#step(signal);
    emit({ type: 'context.compacted', engineSessionId, compactionId, trigger });
  }

  /**
   * `subagent` 关键词：派出子会话（`spawn_agent` + `subagent.started`），让它跑一个回合，`wait_agent` 等它结束；有
   * `close` 时再关掉它。父回合被打断时，等待随之结束，子会话不受影响。
   */
  async #runSubagent(
    parent: EchoSession,
    turn: EchoTurn,
    text: string,
    openTools: Map<string, string>,
  ): Promise<void> {
    const engineSessionId = parent.id;
    const signal = turn.abort.signal;
    const emit = (event: AgentEvent) => turn.hub.emit(event);
    const prompt = `Helper task: ${text.replace(/subagent/gi, 'helper')}`;
    const title = prompt.split('\n')[0] ?? prompt;
    const tool = async (
      toolName: string,
      input: unknown,
      body: (toolCallId: string) => Promise<string>,
    ): Promise<void> => {
      const toolCallId = this.#nextId('call_echo');
      emit({
        type: 'tool.started',
        engineSessionId,
        toolCallId,
        toolName,
        display: { kind: 'sub_agent', summary: title },
        input,
      });
      openTools.set(toolCallId, 'Error: tool call aborted');
      const output = await body(toolCallId);
      openTools.delete(toolCallId);
      emit({ type: 'tool.finished', engineSessionId, toolCallId, status: 'completed', output });
    };

    const child: EchoSession = {
      id: `echo-${randomUUID()}`,
      config: { ...parent.config },
      parentId: parent.id,
      status: 'open',
      hub: new EventHub({ bufferUntilSubscribed: true }),
      turnCount: 0,
      notes: [],
    };
    let done: Promise<void> = Promise.resolve();
    await tool('spawn_agent', { message: prompt }, async (toolCallId) => {
      await this.#step(signal);
      this.#sessions.set(child.id, child);
      // 派出的工具调用结束之前报出子会话，与 Codex 的 collabAgentToolCall 完成时一致。
      emit({
        type: 'subagent.started',
        engineSessionId,
        childEngineSessionId: child.id,
        parentToolCallId: toolCallId,
        title,
        prompt,
        modelId: child.config.modelId,
        ...(child.config.reasoningEffort !== undefined && {
          reasoningEffort: child.config.reasoningEffort,
        }),
        nickname: 'Echo helper',
      });
      done = this.#startChildTurn(child, prompt);
      return JSON.stringify({ agent_id: child.id });
    });
    await tool('wait_agent', { targets: [child.id] }, async () => {
      await untilAborted(done, signal);
      return JSON.stringify({ status: { [child.id]: 'done' } });
    });
    if (/close/i.test(text)) {
      await tool('close_agent', { target: child.id }, async () => {
        await this.#step(signal);
        emit({
          type: 'subagent.updated',
          engineSessionId,
          childEngineSessionId: child.id,
          closed: true,
        });
        return '{}';
      });
    }
  }

  /** 子会话的一个回合：由“引擎”开始，先 `turn.started`（带输入），之后同普通回合。返回回合结束的 Promise。 */
  #startChildTurn(child: EchoSession, prompt: string): Promise<void> {
    child.turnCount += 1;
    const turn: EchoTurn = {
      abort: new AbortController(),
      hub: child.hub,
      cancelRequested: false,
      steers: [],
      done: Promise.resolve(),
    };
    child.turn = turn;
    child.hub.emit({
      type: 'turn.started',
      engineSessionId: child.id,
      input: [{ type: 'text', text: prompt }],
    });
    turn.done = this.#runTurn(child, turn, prompt);
    return turn.done;
  }

  /** 发出已提交的思考与消息（同一 messageId），替换已发的增量块。 */
  /** 按分片“生成”回复：每片前等 `stepsPerChunk` 步，发增量。 */
  async #reply(
    signal: AbortSignal,
    emit: (event: AgentEvent) => void,
    engineSessionId: string,
    attemptId: string,
    blocks: ReplyBlock[],
    stepsPerChunk: number,
  ): Promise<void> {
    for (const [blockIndex, block] of blocks.entries()) {
      for (let start = 0; start < block.full.length; start += this.#chunkSize) {
        for (let step = 0; step < stepsPerChunk; step += 1) await this.#step(signal);
        const piece = block.full.slice(start, start + this.#chunkSize);
        block.generated += piece;
        if (this.#incremental) {
          emit({
            type: 'assistant.delta',
            engineSessionId,
            attemptId,
            blockIndex,
            kind: block.kind,
            text: piece,
          });
        }
      }
    }
  }

  #commit(
    emit: (event: AgentEvent) => void,
    engineSessionId: string,
    attemptId: string,
    blocks: ReplyBlock[],
  ): void {
    const generated = [...blocks.entries()].filter(([, block]) => block.generated.length > 0);
    if (generated.length === 0) return;
    if (this.#incremental) {
      emit({ type: 'assistant.stream_ended', engineSessionId, attemptId, outcome: 'committed' });
    }
    const messageId = randomUUID();
    for (const kind of ['reasoning', 'text'] as const) {
      const parts = generated.filter(([, block]) => block.kind === kind);
      if (parts.length === 0) continue;
      emit({
        type: kind === 'text' ? 'assistant.message' : 'assistant.thought',
        engineSessionId,
        messageId,
        text: parts.map(([, block]) => block.generated).join(''),
        replaces: this.#incremental ? parts.map(([blockIndex]) => ({ attemptId, blockIndex })) : [],
      });
    }
  }

  #requestApproval(turn: EchoTurn, engineSessionId: string, toolCallId: string): Promise<string> {
    const signal = turn.abort.signal;
    const info: PendingApproval = {
      engineSessionId,
      requestId: this.#nextId('apr_echo'),
      toolCallId,
      options: ECHO_APPROVAL_OPTIONS.map((option) => ({ ...option })),
    };
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      turn.approval = {
        info,
        decide: (optionId) => {
          signal.removeEventListener('abort', onAbort);
          resolve(optionId);
        },
      };
      turn.hub.emit({ type: 'approval.requested', ...copyApproval(info) });
    });
  }

  #askUser(turn: EchoTurn, engineSessionId: string): Promise<Record<string, string[]>> {
    const signal = turn.abort.signal;
    const requestId = this.#nextId('qst_echo');
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      turn.question = {
        requestId,
        engineSessionId,
        answer: (answers) => {
          signal.removeEventListener('abort', onAbort);
          resolve(answers);
        },
      };
      turn.hub.emit({
        type: 'question.requested',
        engineSessionId,
        requestId,
        questions: ECHO_QUESTIONS.map((question) => ({
          ...question,
          options: question.options.map((option) => ({ ...option })),
        })),
      });
    });
  }

  /** 等一步；回合被打断时以 TurnAbort reject，并清掉计时器。 */
  #step(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        this.#timers.delete(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, this.#stepDelayMs);
      this.#timers.add(timer);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #nextId(prefix: string): string {
    this.#idCounter += 1;
    return `${prefix}_${this.#idCounter}`;
  }

  #assertUsable(): void {
    if (this.#disposed) throw new AdapterError('disposed', 'adapter is disposed');
  }

  #session(engineSessionId: string): EchoSession {
    const session = this.#sessions.get(engineSessionId);
    if (!session) throw new AdapterError('session_not_found', `unknown session ${engineSessionId}`);
    return session;
  }

  #openSession(engineSessionId: string): EchoSession {
    const session = this.#session(engineSessionId);
    if (session.status !== 'open') {
      throw new AdapterError('session_closed', `session ${engineSessionId} is ${session.status}`);
    }
    return session;
  }
}

/** 等 `promise`；`signal` 先被打断时以它的 reason reject。 */
function untilAborted(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

function copyApproval(info: PendingApproval): PendingApproval {
  return { ...info, options: info.options.map((option) => ({ ...option })) };
}

/** `ask` 关键词提的两个问题。 */
const ECHO_QUESTIONS: readonly UserQuestion[] = [
  {
    id: 'scope',
    header: 'Scope',
    question: 'How far should this change go?',
    options: [
      { label: 'UI only', description: 'Protocol work in a separate task' },
      { label: 'Full stack', description: 'Protocol, Host and UI together' },
    ],
    allowOther: true,
  },
  {
    id: 'targets',
    header: 'Targets',
    question: 'Which platforms should it cover?',
    options: [{ label: 'macOS' }, { label: 'Windows' }, { label: 'Linux' }],
    multiSelect: true,
  },
];

function cancelPendingQuestion(turn: EchoTurn, reason: ApprovalCancelledEvent['reason']): void {
  const question = turn.question;
  if (!question) return;
  turn.question = undefined;
  turn.hub.emit({
    type: 'question.cancelled',
    engineSessionId: question.engineSessionId,
    requestId: question.requestId,
    reason,
  });
}

function cancelPendingApproval(turn: EchoTurn, reason: ApprovalCancelledEvent['reason']): void {
  const approval = turn.approval;
  if (!approval) return;
  turn.approval = undefined;
  turn.hub.emit({
    type: 'approval.cancelled',
    engineSessionId: approval.info.engineSessionId,
    requestId: approval.info.requestId,
    reason,
  });
}

export * from './echo-accounts.js';
