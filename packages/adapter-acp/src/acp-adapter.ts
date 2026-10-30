import { readFile } from 'node:fs/promises';
import {
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type McpServer,
  methods,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  AdapterError,
  type AgentEvent,
  type AgentInput,
  type AgentRuntimeAdapter,
  type ApprovalCancelledEvent,
  type ApprovalDecision,
  type ApprovalOption,
  type EngineExitedEvent,
  type EngineSession,
  type EngineToolClass,
  elicitationQuestions,
  elicitationResult,
  elicitationUrl,
  isAdapterError,
  MCP_URL_ELICITATION_TOOL,
  type PendingApproval,
  redactDiagnostics,
  type SessionConfig,
  type TurnFailedEvent,
  type TurnSettledEvent,
  URL_ELICITATION_OPTIONS,
  type UsageRecordedEvent,
  type UserQuestion,
} from '@wevir/runtime-adapter';
import {
  type AppToolsBridge,
  acpAppToolsServer,
  writeAppToolsBridgeScript,
} from '@wevir/runtime-adapter/app-tools-bridge';
import {
  type AcpSessionUpdate,
  isAcpSessionNotification,
  routeModelOption,
  sessionConfigInfo,
} from './acp-mapping.js';
import { type AcpExit, type AcpProcess, settledWithin } from './acp-process.js';
import type { AcpEngine } from './engine.js';
import {
  type AdapterLogger,
  SessionEventQueue,
  type WarnOnce,
  warnOnceVia,
} from './session-events.js';

/**
 * `cancel` 等回合结算的时限。dsh 实测 3–64 ms 结算（T0.3）；Host 自己的取消时限是 5 s（domain-model.md §4.1 #9），
 * 适配器先于它报 `cancel_unconfirmed`。
 */
export const CANCEL_TIMEOUT_MS = 4000;

const INVALID_PARAMS = -32602;

/** 审批的“取消”回复（ACP `RequestPermissionOutcome`）：dsh 把它记为 `approval … was cancelled`，工具失败。 */
const PERMISSION_CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

export interface AcpAdapterOptions<P extends AcpProcess> {
  engine: AcpEngine;
  /**
   * 建引擎进程（构造时调用一次）。`hooks` 里的回调要接到进程上：`onSessionUpdate`、`onRequestPermission`、
   * `onExtNotification` 与 `onExtRequest` 原样作 `AcpProcessOptions` 的同名项。`logger` 是适配器最终用的告警出口。
   */
  createProcess(hooks: AcpProcessHooks): P;
  /** 告警日志（Host 的 Logger 满足这个接口），默认写 stderr。 */
  logger?: AdapterLogger;
  cancelTimeoutMs?: number;
  /**
   * 交给每个 `session/new` 与 `session/resume` 的本机 MCP 服务（0.25.0：读历史的工具，Grok 用）。默认没有（dsh、Antigravity）。
   */
  mcpServers?: readonly McpServer[];
  /**
   * 应用级工具的 stdio 桥（0.30.0，`@wevir/runtime-adapter/app-tools-bridge`）：给了时适配器声明 `appTools`，带
   * `SessionConfig.appTools` 的会话在 `session/new` 与 `session/resume` 的 `mcpServers` 里多一项 `wevir`。
   */
  appToolsBridge?: AppToolsBridge;
}

export interface AcpProcessHooks {
  onSessionUpdate: (params: unknown) => void;
  onRequestPermission: (
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
  /** ACP `elicitation/create`（引擎的 MCP 服务要用户输入），原样作 `AcpProcessOptions.onElicitation`。 */
  onElicitation: (
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ) => Promise<CreateElicitationResponse>;
  onExtNotification: (method: string, params: unknown) => void;
  onExtRequest: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
  logger: AdapterLogger;
}

/**
 * 引擎自己报的回合结束（Grok 的 `prompt_complete`，`completeTurn`）：停止原因，或要归类的错误。停止原因是 `error` 时同
 * `session/prompt` 的结果，回合失败（`promptOutcome`）。
 */
export type TurnCompletion = { stopReason: string; error?: unknown } | { error: unknown };

/** 引擎报过的一个工具调用里审批要用的字段（`tool_call` / `tool_call_update` 最近一次给的）。 */
interface TrackedToolCall {
  kind?: string;
  title?: string;
  rawInput?: unknown;
}

interface Turn {
  cancelRequested: boolean;
  /** 回合结算（`session/prompt` 成功、失败，引擎报了结束，或被引擎退出打断）后兑现，永不 reject。 */
  done: Promise<void>;
  finish: () => void;
}

/** `session/new` / `session/resume` 的响应里引擎相关的部分（`afterActivation`）。 */
export interface AcpSessionSetup {
  /** 选定路由之后的 `configOptions`。 */
  configOptions: unknown;
  /** ACP 的 `modes`（只给模式、不给 mode 类 config option 的引擎用 `session/set_mode`）。 */
  modes?: unknown;
}

interface AcpSession {
  readonly id: string;
  readonly cwd: string;
  /** open：挂在当前引擎进程上；closed：已 close；detached：进程退出后脱开，要 resume。 */
  status: 'open' | 'closed' | 'detached';
  queue: SessionEventQueue;
  turn?: Turn;
  /** 未决审批，按 requestId。只在回合中有；回合结束、取消、引擎退出、dispose 时清空。 */
  readonly approvals: Map<string, PendingPermission>;
  /** 未决提问（`requestAnswers`），按 requestId；规则同审批。 */
  readonly questions: Map<string, PendingQuestion>;
  /** 引擎最近报的 `configOptions`（`session/new` / `session/resume`、选定路由、`config_option_update`）。 */
  configOptions: unknown;
  /** 角色关掉的引擎工具类别（`SessionConfig.engineTools`）：这些类别的审批请求直接拒绝。 */
  readonly deniedTools: ReadonlySet<EngineToolClass>;
  /**
   * 本回合引擎报过的工具调用，按 `toolCallId`。ACP 的审批请求可以只带 `toolCallId`：缺的 `kind`、`title`、`rawInput` 从这里补，
   * 不然角色的限制（只看 `kind`）会被绕过（T3 Code #26647）。回合开始与结束时清空。
   */
  readonly toolCalls: Map<string, TrackedToolCall>;
}

/** ACP 的工具种类（`ToolKind`）→ 引擎工具的类别；`think`、`switch_mode`、`other` 不归哪一类。 */
const TOOL_KIND_CLASSES: Readonly<Record<string, EngineToolClass>> = {
  read: 'read',
  search: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  execute: 'shell',
  fetch: 'web',
};

/** 一个挂起的审批：引擎在等 `reply` 的结果（所选的 `optionId`，undefined 表示取消）。 */
interface PendingPermission {
  readonly info: PendingApproval;
  /** 兑现交给引擎的那个回复（ACP SDK 随即把它写给引擎）。只调用一次。 */
  readonly reply: (optionId: string | undefined) => void;
}

/** 一个挂起的提问：引擎在等 `reply` 的回答（按问题 ID，undefined 表示取消）。 */
interface PendingQuestion {
  readonly requestId: string;
  readonly reply: (answers: Record<string, string[]> | undefined) => void;
}

/**
 * ACP 引擎的 `AgentRuntimeAdapter`（ADR-0005 决策 1.3）：一个 `AcpProcess` 承载全部会话，经 ACP 驱动；引擎之间的
 * 差异都在引擎描述里（engine.ts）。
 *
 * 事件路径（docs/architecture/acp-event-mapping.md 第一部分）：AcpProcess 按引擎写出的顺序交来原始的
 * `session/update`，按 `sessionId` 路由到各会话的 `SessionEventQueue`，在那里映射，再扇出给订阅者。
 * `session/prompt` 的结果在它之前的更新全部入队之后才兑现，所以回合终结事件总在该回合的其他事件之后。
 *
 * 审批（§1.3）：`session/request_permission` 变成 `approval.requested`（适配器分配 `requestId`，选项原样），
 * 挂起到 `respondToApproval` 回复 `selected`，或以 `cancelled` 回复并发 `approval.cancelled`：取消与关闭
 * （`turn_cancelled`，先写 `session/cancel` 再回复，T0.3 场景 D 的顺序）、回合在审批未决时结束（`turn_ended`）、
 * 引擎退出（`engine_exited`，已无从回复）、`dispose`（`disposed`）。不回复引擎就一直等。审批详情不在这里取：
 * 请求只带 `toolCallId`，Host 用同一 `toolCallId` 的 `tool.started`（`tool_call.rawInput`）生成。顺序：引擎
 * 先把积压的 `session/update` 写完再发审批请求（dsh 的 `drainUpdates`），而更新在 SDK 之前就已入队，所以该工具的
 * `tool.started` 总在 `approval.requested` 之前。
 *
 * 路由：每个会话在 `session/new` / `session/resume` 之后用 `session/set_config_option` 选定 Provider 与模型
 * （编码由引擎描述的 `route` 给出）。
 *
 * 恢复（§1.4）：`resumeSession` 对不在本进程上的会话发 ACP `session/resume`（创建时的 cwd），再像建会话一样选定
 * 路由；Host 重启后适配器是新的，不认识的 ID 也照样问引擎。引擎不回放历史，界面历史由 Host 的事件库负责。失败按
 * 引擎描述的 `classifyResumeError` 归类：恢复不了的报 `session_lost`，Host 据此标为只读。`cancel` 在时限内得不到
 * 确认时重启引擎进程：卡住的回合随旧进程结束，挂着的会话都以 `engine.exited`（`cancel_unconfirmed`）脱开，之后
 * resume 到新进程上（dsh 不允许 resume 同一进程里仍活跃的会话）。
 */
export class AcpAdapter<P extends AcpProcess = AcpProcess> implements AgentRuntimeAdapter {
  readonly process: P;
  readonly engine: AcpEngine;
  /** 图片（0.28.0）：引擎描述的 `images` 为 `true` 时才有。 */
  readonly acceptsImages?: AgentRuntimeAdapter['acceptsImages'];
  readonly #sessions = new Map<string, AcpSession>();
  readonly #logger: AdapterLogger;
  readonly #warnOnce: WarnOnce;
  readonly #cancelTimeoutMs: number;
  readonly #mcpServers: McpServer[];
  readonly #appToolsBridge: AppToolsBridge | undefined;
  #bridgeWritten = false;
  /** 应用级工具（0.30.0）：有桥时才有。 */
  readonly appTools?: boolean;
  #nextRequestId = 0;
  #nextQuestionId = 0;
  #disposed: Promise<void> | undefined;
  /** 进行中的有计划重启（合并并发的请求）。 */
  #restart: Promise<void> | undefined;
  /**
   * 进行中的 `createSession` / `resumeSession` 数：它们的会话还没登记，有计划的重启要等它们完成，否则会话会挂在
   * 被回收的进程上（`busy`）。
   */
  #activating = 0;

  constructor(options: AcpAdapterOptions<P>) {
    const { engine } = options;
    this.engine = engine;
    if (engine.images === true) this.acceptsImages = () => true;
    this.#logger = options.logger ?? stderrLogger(engine.name);
    this.#warnOnce = warnOnceVia(this.#logger);
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
    this.#mcpServers = [...(options.mcpServers ?? [])];
    this.#appToolsBridge = options.appToolsBridge;
    if (options.appToolsBridge !== undefined) this.appTools = true;
    this.process = options.createProcess({
      onSessionUpdate: (params) => this.#onSessionUpdate(params),
      onRequestPermission: (params, signal) => this.#onRequestPermission(params, signal),
      onElicitation: (params, signal) => this.#onElicitation(params, signal),
      onExtNotification: (method, params) => {
        try {
          this.extNotification(method, params);
        } catch (error) {
          this.#logger.warn(`${engine.name} 的扩展通知处理失败`, {
            method,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      onExtRequest: (method, params, signal) => this.extRequest(method, params, signal),
      logger: this.#logger,
    });
    this.process.on('exit', (exit) => this.#onExit(exit));
    this.process.on('restarting', ({ attempt, maxRestarts, delayMs }) =>
      this.#logger.warn(
        `${engine.name} 进程将在 ${delayMs} ms 后重启（第 ${attempt}/${maxRestarts} 次）`,
      ),
    );
    this.process.on('failed', ({ restarts }) =>
      this.#logger.warn(`${engine.name} 进程连续重启 ${restarts} 次仍失败，停止重启`),
    );
  }

  /** 适配器记得的会话数（含已关闭、已脱开的）；dispose 之后为 0。 */
  get sessionCount(): number {
    return this.#sessions.size;
  }

  /** 交给这个会话的 MCP 服务：固定的那些，加上它的应用级工具（0.30.0）。 */
  #sessionMcpServers(config: SessionConfig): McpServer[] {
    const bridge = this.#appToolsBridge;
    if (bridge === undefined || config.appTools === undefined) return this.#mcpServers;
    if (!this.#bridgeWritten) {
      writeAppToolsBridgeScript(bridge);
      this.#bridgeWritten = true;
    }
    return [...this.#mcpServers, acpAppToolsServer(bridge, config.appTools)];
  }

  async createSession(config: SessionConfig): Promise<EngineSession> {
    this.assertUsable();
    if (!config.cwd) throw new AdapterError('invalid_input', 'cwd 不能为空');
    const connection = await this.#readyConnection();
    this.#activating += 1;
    try {
      let response: {
        sessionId: string;
        configOptions?: unknown;
        modes?: unknown;
        models?: unknown;
      };
      try {
        response = await this.#withAuth(() =>
          connection.agent.request(methods.agent.session.new, {
            cwd: config.cwd,
            mcpServers: this.#sessionMcpServers(config),
          }),
        );
      } catch (error) {
        throw engineError(error, 'session/new');
      }
      const id = response.sessionId;
      let configOptions: unknown;
      try {
        configOptions = await this.#selectRoute(
          id,
          config,
          this.#withSessionModels(response.configOptions, response.models),
        );
        configOptions = await this.afterActivation(id, config, {
          configOptions,
          modes: response.modes,
        });
      } catch (error) {
        // 选不上路由的会话不交给 Host，引擎侧也关掉。
        await connection.agent
          .request(methods.agent.session.close, { sessionId: id })
          .catch(() => {});
        throw error;
      }
      this.#register(id, config.cwd, configOptions, config.engineTools?.denied);
      return {
        engineSessionId: id,
        engineVersion: this.engine.version,
        ...sessionConfigInfo(configOptions, this.engine.route),
      };
    } finally {
      this.#activating -= 1;
    }
  }

  /**
   * 已挂在本进程上的会话直接成功，不发 ACP（dsh 拒绝 resume 活跃的会话）。其余的（已关闭、引擎退出或重启后脱开、
   * 适配器根本不认识）发 `session/resume`，再按 `config` 选定路由：引擎恢复的可能是会话日志里最后的路由，Provider
   * 配置换过之后已经不是 Host 记录的那个。引擎说会话仍活跃（之前 `session/close` 失败、适配器按已关闭处理）
   * 时直接沿用。路由选不上时把刚恢复的会话关掉再报错。
   */
  async resumeSession(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    this.assertUsable();
    if (!config.cwd) throw new AdapterError('invalid_input', 'cwd 不能为空');
    if (this.#sessions.get(engineSessionId)?.status === 'open') {
      return { engineSessionId, engineVersion: this.engine.version };
    }
    const connection = await this.#readyConnection();
    this.#activating += 1;
    try {
      let configOptions: unknown;
      let modes: unknown;
      let models: unknown;
      try {
        ({ configOptions, modes, models } = await this.#withAuth<{
          configOptions?: unknown;
          modes?: unknown;
          models?: unknown;
        }>(() =>
          connection.agent.request(
            this.engine.resumeMethod === 'load'
              ? methods.agent.session.load
              : methods.agent.session.resume,
            {
              sessionId: engineSessionId,
              cwd: config.cwd,
              mcpServers: this.#sessionMcpServers(config),
            },
          ),
        ));
      } catch (error) {
        if (isAdapterError(error)) throw error;
        const classified = this.engine.classifyResumeError(error);
        const { failure } = classified;
        if (failure.kind !== 'already_active') {
          throw new AdapterError(
            failure.kind === 'lost'
              ? 'session_lost'
              : failure.kind === 'cwd_mismatch'
                ? 'session_unavailable'
                : 'engine_unavailable',
            `session/resume 失败：${classified.message}`,
            { cause: error, ...(failure.kind === 'lost' && { lostReason: failure.reason }) },
          );
        }
        this.#logger.warn(
          `${this.engine.name} 里这个会话仍挂着（之前的 session/close 失败过），直接沿用`,
          { engineSessionId },
        );
      }
      try {
        configOptions = await this.#selectRoute(
          engineSessionId,
          config,
          this.#withSessionModels(configOptions, models),
        );
        configOptions = await this.afterActivation(engineSessionId, config, {
          configOptions,
          modes,
        });
      } catch (error) {
        await connection.agent
          .request(methods.agent.session.close, { sessionId: engineSessionId })
          .catch(() => {});
        throw error;
      }
      this.#register(engineSessionId, config.cwd, configOptions, config.engineTools?.denied);
      return {
        engineSessionId,
        engineVersion: this.engine.version,
        ...sessionConfigInfo(configOptions, this.engine.route),
      };
    } finally {
      this.#activating -= 1;
    }
  }

  /** `session/prompt` 的内容块：文本，之后是图片（0.28.0，读文件发 base64）。 */
  #promptBlocks(input: AgentInput): ContentBlock[] | Promise<ContentBlock[]> {
    const texts: ContentBlock[] = [];
    const images: Promise<ContentBlock>[] = [];
    for (const part of input.content) {
      if (part.type === 'text') {
        texts.push({ type: 'text', text: part.text });
        continue;
      }
      if (this.acceptsImages === undefined) {
        throw new AdapterError('invalid_input', `${this.engine.name} 不收图片`);
      }
      images.push(
        readFile(part.path).then((bytes) => ({
          type: 'image',
          mimeType: part.mimeType,
          data: bytes.toString('base64'),
        })),
      );
    }
    // 只有文本时同步返回：`send` 在发出 `session/prompt` 之前不让出事件循环（取消与回合结束的先后靠它）。
    if (images.length === 0) return texts;
    return Promise.all(images).then((blocks) => [...texts, ...blocks]);
  }

  subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    this.assertUsable();
    return this.#openSession(engineSessionId).queue.subscribe();
  }

  async send(engineSessionId: string, input: AgentInput): Promise<void> {
    this.assertUsable();
    const session = this.#openSession(engineSessionId);
    if (session.turn !== undefined) throw new AdapterError('session_busy', '会话有进行中的回合');
    if (input.content.length === 0) throw new AdapterError('invalid_input', 'content 不能为空');
    const pending = this.#promptBlocks(input);
    const blocks = Array.isArray(pending) ? pending : await pending;
    if (session.turn !== undefined) throw new AdapterError('session_busy', '会话有进行中的回合');
    const connection = this.process.connection;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const turn: Turn = { cancelRequested: false, done, finish };
    session.turn = turn;
    session.toolCalls.clear();
    session.queue.beginTurn();
    const meta = this.promptMeta(engineSessionId);
    // ACP 的 session/prompt 到回合结束才返回（适配器接口注释第 7 条），这里发出请求就返回。
    const prompt: Promise<PromptResponse> = connection.agent.request(methods.agent.session.prompt, {
      sessionId: engineSessionId,
      prompt: blocks,
      ...(meta !== undefined && { _meta: meta }),
    });
    prompt.then(
      (response) => {
        this.#settle(session, turn, this.#promptOutcome(engineSessionId, turn, response));
        turn.finish();
      },
      (error: unknown) => {
        this.#settle(session, turn, this.#turnFailed(engineSessionId, error));
        turn.finish();
      },
    );
  }

  async respondToApproval(
    engineSessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    this.assertUsable();
    const session = this.#session(engineSessionId);
    const pending = session.approvals.get(requestId);
    if (pending === undefined) {
      throw new AdapterError(
        'approval_not_found',
        `引擎会话 ${engineSessionId} 没有未决审批 ${requestId}（不存在、已决定或已结束）`,
      );
    }
    if (!pending.info.options.some((option) => option.optionId === decision.optionId)) {
      throw new AdapterError(
        'invalid_option',
        `选项 ${decision.optionId} 不在审批 ${requestId} 的选项里`,
      );
    }
    // 先移出再回复：同一请求只回复引擎一次，之后的决定报 approval_not_found。
    session.approvals.delete(requestId);
    pending.reply(decision.optionId);
  }

  async listPendingApprovals(engineSessionId?: string): Promise<PendingApproval[]> {
    this.assertUsable();
    const sessions =
      engineSessionId === undefined
        ? [...this.#sessions.values()]
        : [this.#sessions.get(engineSessionId)].filter((s) => s !== undefined);
    return sessions.flatMap((session) =>
      [...session.approvals.values()].map(({ info }) => copyApproval(info)),
    );
  }

  async cancel(engineSessionId: string): Promise<void> {
    const session = this.#sessions.get(engineSessionId);
    const turn = session?.turn;
    if (session === undefined || turn === undefined) return;
    if (!turn.cancelRequested) {
      turn.cancelRequested = true;
      const notified = this.#notifyCancel(engineSessionId);
      // 挂起的审批与提问必须以 cancelled 回复，否则引擎一直等（ADR-0001 §6）。SDK 在 notify 调用时就把
      // session/cancel 排进写队列，这些回复排在它后面，与 T0.3 场景 D 的顺序相同。
      this.#cancelPending(session, 'turn_cancelled');
      await notified;
    }
    if (!(await settledWithin(turn.done, this.#cancelTimeoutMs))) {
      // 引擎可能卡住了：重启它，卡住的回合随旧进程结束，这个会话之后 resume 到新进程上。
      if (session.turn === turn) {
        this.restartEngine('cancel_unconfirmed').catch((error: unknown) =>
          this.#logger.warn(`取消得不到确认，重启 ${this.engine.name} 失败`, {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      throw new AdapterError(
        'cancel_unconfirmed',
        `发出 session/cancel 后 ${this.#cancelTimeoutMs} ms 内回合没有结算`,
      );
    }
  }

  async close(engineSessionId: string): Promise<void> {
    this.assertUsable();
    const session = this.#session(engineSessionId);
    if (session.status === 'closed') return;
    await this.cancel(engineSessionId);
    if (session.status === 'open' && this.process.state === 'ready') {
      try {
        await this.process.connection.agent.request(methods.agent.session.close, {
          sessionId: engineSessionId,
        });
      } catch (error) {
        if (isAdapterError(error, 'disposed')) throw error;
        // 引擎侧已经没有这个会话（-32602 unknown session）等：不阻止关闭（domain-model.md §4.1 #13）。
        this.#logger.warn('ACP session/close 失败，按已关闭处理', {
          engineSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    session.status = 'closed';
    session.queue.end();
  }

  dispose(): Promise<void> {
    this.#disposed ??= (async () => {
      let replied = false;
      for (const session of this.#sessions.values()) {
        replied = this.#cancelPending(session, 'disposed') || replied;
        session.turn?.finish();
        session.turn = undefined;
        session.queue.end();
      }
      this.#sessions.clear();
      // 回复经 SDK 的几个微任务才写进引擎的 stdin；先让它们写出去，再关连接、关 stdin。
      if (replied) await new Promise((resolve) => setImmediate(resolve));
      await this.process.dispose();
    })();
    return this.#disposed;
  }

  // ── 给引擎子类的扩展点 ───────────────────────────────────────────────────────────────

  /** 告警出口（构造时给的 `logger`，默认写 stderr）。 */
  protected get logger(): AdapterLogger {
    return this.#logger;
  }

  /** 有进行中的回合（含等审批），或有进行中的 `createSession` / `resumeSession`。 */
  protected get busy(): boolean {
    return (
      this.#activating > 0 ||
      [...this.#sessions.values()].some((session) => session.turn !== undefined)
    );
  }

  /** 进行中的有计划重启（`restartEngine`）；没有时为 undefined。 */
  protected get pendingRestart(): Promise<void> | undefined {
    return this.#restart;
  }

  /**
   * 有计划地重启引擎进程：先把挂着的会话全部脱开（同步；之后的 send 报 session_closed，不会在旧进程上开新回合），
   * 发 `engine.exited`（`reason`），再回收旧进程、启动新进程。进行中的重启不重复发起。
   */
  protected restartEngine(reason: NonNullable<EngineExitedEvent['reason']>): Promise<void> {
    if (this.#restart !== undefined) return this.#restart;
    this.#detachAll({ exitCode: null, signal: null, reason });
    this.#restart = this.process
      .restart()
      .then(() => {})
      .finally(() => {
        this.#restart = undefined;
      });
    return this.#restart;
  }

  /** 进程就绪之后、建会话或恢复会话之前调用（dsh：配置换过且空闲时先重启）。默认什么都不做。 */
  protected async beforeActivation(): Promise<void> {}

  /**
   * `session/new` / `session/resume` 失败之后调用：引擎要先认证时（Grok：`-32000 Authentication required`）用它自己存的
   * 凭据 `authenticate`，返回 true 则重试一次；不是这种错误返回 false。认证不了时可以抛 `missing_credentials`。默认 false。
   */
  protected async authenticateAfter(_error: unknown): Promise<boolean> {
    return false;
  }

  /** `session/prompt` 的 `_meta`（Grok：本回合的 `promptId`，用来认出它的结束通知）。默认没有。 */
  protected promptMeta(_engineSessionId: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /** `session/cancel` 的 `_meta`（Grok：`cancelTrigger: ctrl_c`）。默认没有。 */
  protected cancelMeta(_engineSessionId: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   * 引擎描述 `extensions.notifications` 里的扩展通知，按引擎写出的顺序同步调用（在同一条流里后到的 `session/prompt`
   * 结果之前）。默认什么都不做。抛错只告警。
   */
  protected extNotification(_method: string, _params: unknown): void {}

  /** 引擎描述 `extensions.requests` 里的扩展请求；返回值作为响应写给引擎。默认回 `Method not found`。 */
  protected extRequest(method: string, _params: unknown, _signal: AbortSignal): Promise<unknown> {
    return Promise.reject(
      Object.assign(new Error(`Method not found: ${method}`), { code: -32601 }),
    );
  }

  /**
   * 引擎报了这个会话的回合结束（不经 `session/prompt` 的结果，Grok 的 `prompt_complete`），按它结算进行中的回合；之后
   * 到的 `session/prompt` 结果不再上报。之前的 `session/update` 都已入队（扩展通知与它们在同一条流里按序截下）。
   * 没有进行中的回合时返回 false。
   */
  protected completeTurn(engineSessionId: string, completion: TurnCompletion): boolean {
    const session = this.#sessions.get(engineSessionId);
    const turn = session?.status === 'open' ? session.turn : undefined;
    if (session === undefined || turn === undefined) return false;
    this.#settle(
      session,
      turn,
      'stopReason' in completion
        ? this.#promptOutcome(engineSessionId, turn, completion)
        : this.#turnFailed(engineSessionId, completion.error),
    );
    return true;
  }

  /**
   * 引擎在扩展通知里报的用量（0.62.0，`usage.recorded`；Grok 的 `turn_completed`）：按到达顺序进会话的事件流，回合外也报。
   * 没有挂着的会话时返回 false。
   */
  protected recordUsage(
    engineSessionId: string,
    usage: Omit<UsageRecordedEvent, 'type' | 'engineSessionId'>,
  ): boolean {
    const session = this.#sessions.get(engineSessionId);
    if (session?.status !== 'open') return false;
    session.queue.usage({ type: 'usage.recorded', engineSessionId: session.id, ...usage });
    return true;
  }

  /** 会话有进行中的回合。 */
  protected inTurn(engineSessionId: string): boolean {
    const session = this.#sessions.get(engineSessionId);
    return session?.status === 'open' && session.turn !== undefined;
  }

  /**
   * 向用户请求审批（`session/request_permission`，或引擎的扩展请求，例如 Grok 的退出计划模式）：发 `approval.requested`，
   * 等 `respondToApproval` 给出的 `optionId`；审批被取消（取消、关闭、回合结束、引擎退出、`dispose`、`signal`）时得到
   * undefined。选项经引擎描述的 `approvalOptions` 过滤。没有挂着的会话或进行中的回合时直接得到 undefined 并告警；回合
   * 已在取消时照常上报，随即结束。
   */
  protected requestApproval(
    engineSessionId: string,
    toolCallId: string,
    options: ApprovalOption[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const session = this.#sessions.get(engineSessionId);
    const turn = session?.status === 'open' ? session.turn : undefined;
    if (session === undefined || turn === undefined) {
      this.#logger.warn('审批请求不属于进行中的回合，回复 cancelled', {
        engineSessionId,
        toolCallId,
      });
      return Promise.resolve(undefined);
    }
    const filtered = this.engine.approvalOptions?.(options.map((option) => ({ ...option })));
    const info: PendingApproval = {
      engineSessionId: session.id,
      requestId: `perm-${++this.#nextRequestId}`,
      toolCallId,
      options: filtered !== undefined && filtered.length > 0 ? filtered : options,
    };
    session.queue.approval({ type: 'approval.requested', ...copyApproval(info) });
    if (turn.cancelRequested) {
      session.queue.approval(cancelledEvent(info, 'turn_cancelled'));
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      session.approvals.set(info.requestId, { info, reply: resolve });
      // 引擎撤回请求（`$/cancel_request`；dsh 0.2.1-alpha.2 不发）。连接关闭也会触发，那时引擎退出或 dispose
      // 的路径已经同步结束了这个审批，所以晚一个微任务再看。
      signal?.addEventListener(
        'abort',
        () =>
          queueMicrotask(() => {
            if (!session.approvals.delete(info.requestId)) return;
            session.queue.approval(cancelledEvent(info, 'turn_ended'));
            resolve(undefined);
          }),
        { once: true },
      );
    });
  }

  /**
   * 报一份计划（0.36.0，引擎的扩展请求，例如 Grok 的退出计划模式）：`plan.proposed`。没有挂着的会话或进行中的回合时不报，
   * 返回 false。
   */
  protected proposePlan(engineSessionId: string, planId: string, text: string): boolean {
    const session = this.#sessions.get(engineSessionId);
    if (session?.status !== 'open' || session.turn === undefined) return false;
    session.queue.plan({ type: 'plan.proposed', engineSessionId: session.id, planId, text });
    return true;
  }

  /**
   * 向用户提问（引擎的扩展请求，例如 Grok 的 `ask_user_question`）：发 `question.requested`，等 `answerQuestion` 给的
   * 回答（按问题 ID，选中的选项 `label` 或用户填写的文本）；被取消时得到 undefined，规则同 `requestApproval`。
   */
  protected requestAnswers(
    engineSessionId: string,
    toolCallId: string | undefined,
    questions: UserQuestion[],
    signal?: AbortSignal,
  ): Promise<Record<string, string[]> | undefined> {
    const session = this.#sessions.get(engineSessionId);
    const turn = session?.status === 'open' ? session.turn : undefined;
    if (session === undefined || turn === undefined) {
      this.#logger.warn('提问不属于进行中的回合，回复 cancelled', { engineSessionId, toolCallId });
      return Promise.resolve(undefined);
    }
    const requestId = `q-${++this.#nextQuestionId}`;
    session.queue.approval({
      type: 'question.requested',
      engineSessionId: session.id,
      requestId,
      ...(toolCallId !== undefined && { toolCallId }),
      questions,
    });
    const cancelled = (reason: ApprovalCancelledEvent['reason']) =>
      session.queue.approval({
        type: 'question.cancelled',
        engineSessionId: session.id,
        requestId,
        reason,
      });
    if (turn.cancelRequested) {
      cancelled('turn_cancelled');
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      session.questions.set(requestId, { requestId, reply: resolve });
      signal?.addEventListener(
        'abort',
        () =>
          queueMicrotask(() => {
            if (!session.questions.delete(requestId)) return;
            cancelled('turn_ended');
            resolve(undefined);
          }),
        { once: true },
      );
    });
  }

  /**
   * 回答一个未决提问（子类的 `respondToQuestion` 用）：提问随即结束，`requestAnswers` 得到回答。
   * 错误：`session_not_found`、`question_not_found`。
   */
  protected answerQuestion(
    engineSessionId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): void {
    const session = this.#session(engineSessionId);
    const pending = session.questions.get(requestId);
    if (pending === undefined) {
      throw new AdapterError(
        'question_not_found',
        `引擎会话 ${engineSessionId} 没有未决提问 ${requestId}（不存在、已回答或已结束）`,
      );
    }
    session.questions.delete(requestId);
    pending.reply(answers);
  }

  /**
   * 给挂着、没有回合的会话重新选定模型与推理强度（子类在会话中换模型时用，规则同建会话）。选不上报 `invalid_input`。
   */
  protected async applyRoute(
    engineSessionId: string,
    config: Pick<SessionConfig, 'providerId' | 'modelId' | 'reasoningEffort'>,
  ): Promise<void> {
    const session = this.#openSession(engineSessionId);
    session.configOptions = await this.#selectRoute(engineSessionId, config, session.configOptions);
  }

  /** 会话最近的 `configOptions`（子类在 `applyRoute` 之后按新模型设别的选项时读，Antigravity：思考档位）。 */
  protected sessionConfigOptions(engineSessionId: string): unknown {
    return this.#openSession(engineSessionId).configOptions;
  }

  /**
   * 会话挂到引擎上（`session/new` / `session/resume` 成功、路由已选定）之后、交给 Host 之前调用：引擎在这里按 `config`
   * 设定会话的其他选项（Antigravity：权限模式）。返回最终的 `configOptions`；抛错时会话被关掉，错误交给调用方。
   * 默认原样返回。
   */
  protected async afterActivation(
    _engineSessionId: string,
    _config: SessionConfig,
    setup: AcpSessionSetup,
  ): Promise<unknown> {
    return setup.configOptions;
  }

  /**
   * `session/request_permission` 在当作审批之前先交给它（Antigravity：`interaction_*` 是提问，用 `requestAnswers` 问
   * 用户）。返回 Promise 时由它给出回复；返回 undefined 照常走 `requestApproval`。只在会话有进行中的回合时调用。
   */
  protected interceptPermission(
    _params: RequestPermissionRequest,
    _signal: AbortSignal,
  ): Promise<RequestPermissionResponse> | undefined {
    return undefined;
  }

  /** 会话挂在当前进程上时返回，否则抛 `session_not_found` / `session_closed`。 */
  protected assertOpenSession(engineSessionId: string): void {
    this.#openSession(engineSessionId);
  }

  /**
   * 停掉引擎进程、不再启动（Antigravity 登出：旧进程里缓存着凭据）：挂着的会话全部脱开并发 `engine.exited`
   * （`reason`），下一次建会话或恢复时再拉起新进程。
   */
  protected async stopEngine(reason: NonNullable<EngineExitedEvent['reason']>): Promise<void> {
    this.#detachAll({ exitCode: null, signal: null, reason });
    await this.process.stop();
  }

  /**
   * 一个回合结算（`turn.settled` / `turn.failed` 已发出）之后调用（dsh：等回合结束的配置重启；Antigravity：读会话库里这个回合
   * 的用量）。默认什么都不做。
   */
  protected afterTurn(_engineSessionId: string): void {}

  protected assertUsable(): void {
    if (this.#disposed !== undefined) {
      throw new AdapterError('disposed', `${this.engine.name} 适配器已释放`);
    }
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────────────────

  #onSessionUpdate(params: unknown): void {
    if (!isAcpSessionNotification(params)) {
      this.#warnOnce(
        'acp:malformed',
        'ACP session/update 缺少 sessionId 或 update.sessionUpdate，丢弃',
        {
          params: JSON.stringify(params)?.slice(0, 500),
        },
      );
      return;
    }
    const session = this.#sessions.get(params.sessionId);
    if (session?.status !== 'open') {
      this.#warnOnce(
        `acp:unknown_session:${params.sessionId}`,
        'ACP session/update 属于没有挂着的会话，丢弃',
        { engineSessionId: params.sessionId, sessionUpdate: params.update.sessionUpdate },
      );
      return;
    }
    if (
      params.update.sessionUpdate === 'config_option_update' &&
      Array.isArray(params.update.configOptions)
    ) {
      session.configOptions = params.update.configOptions;
    }
    let notification = params;
    if (this.engine.normalizeUpdate !== undefined) {
      try {
        notification = this.engine.normalizeUpdate(params);
      } catch {
        // 约定不抛错；万一抛了就用原文。
      }
    }
    if (session.turn !== undefined) trackToolCall(session.toolCalls, notification.update);
    session.queue.acpUpdate(notification);
  }

  /**
   * ACP `session/request_permission`（SDK 已校验参数）。返回的 Promise 兑现时 SDK 把它作为响应写给引擎。
   * 没有挂着的会话或进行中的回合时直接回复 cancelled；其余见 `requestApproval`。
   */
  #onRequestPermission(
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (!this.inTurn(request.sessionId)) {
      this.#logger.warn('ACP session/request_permission 不属于进行中的回合，回复 cancelled', {
        engineSessionId: request.sessionId,
        toolCallId: request.toolCall.toolCallId,
      });
      return Promise.resolve(PERMISSION_CANCELLED);
    }
    const params = withTrackedToolCall(
      request,
      this.#sessions.get(request.sessionId)?.toolCalls.get(request.toolCall.toolCallId),
    );
    // 角色关掉的引擎工具（acp-event-mapping.md §1.9）：ACP 没有按会话收工具的办法，只能拒掉引擎为它们请求的批准；引擎不问就做的
    // （完全访问、它自己放行的读）管不到。
    const kind = TOOL_KIND_CLASSES[params.toolCall.kind ?? ''];
    if (
      kind !== undefined &&
      this.#sessions.get(params.sessionId)?.deniedTools.has(kind) === true
    ) {
      const reject =
        params.options.find((option) => option.kind === 'reject_once') ??
        params.options.find((option) => option.kind === 'reject_always');
      this.#warnOnce(`role_denied:${kind}`, `角色不许 ${kind} 类的工具，拒绝审批`, {
        engineSessionId: params.sessionId,
      });
      return Promise.resolve(
        reject === undefined
          ? PERMISSION_CANCELLED
          : { outcome: { outcome: 'selected', optionId: reject.optionId } },
      );
    }
    const intercepted = this.interceptPermission(params, signal);
    if (intercepted !== undefined) return intercepted;
    const options: ApprovalOption[] = params.options.map((option) => ({
      optionId: option.optionId,
      label: option.name,
      kind: option.kind,
    }));
    return this.requestApproval(params.sessionId, params.toolCall.toolCallId, options, signal).then(
      (optionId) =>
        optionId === undefined
          ? PERMISSION_CANCELLED
          : { outcome: { outcome: 'selected', optionId } },
    );
  }

  /**
   * ACP `elicitation/create`（acp-event-mapping.md §1.8，`@wevir/runtime-adapter` 的 mcp-elicitation.ts）：引擎的 MCP 服务要用户
   * 输入。只认属于会话进行中回合的请求。表单换成提问（引擎实现了 `respondToQuestion` 的才问，否则 `decline`）；链接先当一个
   * `MCP_URL_ELICITATION_TOOL` 工具调用报出（同 `tool_call`），再请求“打开链接”的审批，决定之后报这个工具调用结束。被取消时回
   * `cancel`；认不出的表单、不是 http(s) 的地址与别的模式回 `decline`。
   */
  async #onElicitation(
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    const sessionId = 'sessionId' in params ? params.sessionId : undefined;
    if (typeof sessionId !== 'string' || !this.inTurn(sessionId)) return { action: 'decline' };
    const toolCallId =
      'toolCallId' in params && typeof params.toolCallId === 'string'
        ? params.toolCallId
        : undefined;
    if (params.mode === 'form' && 'requestedSchema' in params) {
      const questions = elicitationQuestions(params.message, params.requestedSchema);
      const answers =
        questions === undefined ||
        typeof (this as AgentRuntimeAdapter).respondToQuestion !== 'function'
          ? null
          : await this.requestAnswers(sessionId, toolCallId, questions, signal);
      if (answers === null) return { action: 'decline' };
      if (answers === undefined) return { action: 'cancel' };
      const result = elicitationResult(params.message, params.requestedSchema, answers);
      return result.action === 'accept'
        ? { action: 'accept', content: result.content ?? {} }
        : { action: result.action };
    }
    const url = params.mode === 'url' && 'url' in params ? elicitationUrl(params.url) : undefined;
    if (url === undefined) return { action: 'decline' };
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return { action: 'decline' };
    const elicitationToolCallId = `mcp-elicitation-${++this.#nextRequestId}`;
    session.queue.acpUpdate({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: elicitationToolCallId,
        title: MCP_URL_ELICITATION_TOOL,
        kind: 'fetch',
        status: 'pending',
        rawInput: { message: params.message, url },
      },
    });
    const optionId = await this.requestApproval(
      sessionId,
      elicitationToolCallId,
      URL_ELICITATION_OPTIONS.map((option) => ({ ...option })),
      signal,
    );
    session.queue.acpUpdate({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: elicitationToolCallId,
        status: optionId === 'accept' ? 'completed' : 'failed',
      },
    });
    return optionId === undefined
      ? { action: 'cancel' }
      : { action: optionId === 'accept' ? 'accept' : 'decline' };
  }

  /**
   * 结束会话的全部未决审批与提问：以 cancelled 回复引擎（引擎已退出时这个回复写不出去，无妨），发
   * `approval.cancelled` / `question.cancelled`。返回是否结束了至少一个。
   */
  #cancelPending(session: AcpSession, reason: ApprovalCancelledEvent['reason']): boolean {
    if (session.approvals.size === 0 && session.questions.size === 0) return false;
    const approvals = [...session.approvals.values()];
    const questions = [...session.questions.values()];
    session.approvals.clear();
    session.questions.clear();
    for (const { info, reply } of approvals) {
      session.queue.approval(cancelledEvent(info, reason));
      reply(undefined);
    }
    for (const { requestId, reply } of questions) {
      session.queue.approval({
        type: 'question.cancelled',
        engineSessionId: session.id,
        requestId,
        reason,
      });
      reply(undefined);
    }
    return true;
  }

  /** 发 `session/cancel`，不抛错：连接已断时回合由引擎退出的路径结算（engine.exited）。 */
  #notifyCancel(engineSessionId: string): Promise<void> {
    try {
      const meta = this.cancelMeta(engineSessionId);
      return this.process.connection.agent
        .notify(methods.agent.session.cancel, {
          sessionId: engineSessionId,
          ...(meta !== undefined && { _meta: meta }),
        })
        .catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  #settle(session: AcpSession, turn: Turn, event: TurnSettledEvent | TurnFailedEvent): void {
    // 引擎退出、dispose 或引擎报的结束（completeTurn）已经结束了这个回合。
    if (session.turn !== turn) return;
    // 回合在审批未决时自己结束了（dsh 不会这样，防御）：审批与提问随回合结束。
    this.#cancelPending(session, 'turn_ended');
    session.turn = undefined;
    session.toolCalls.clear();
    session.queue.endTurn(event);
    turn.finish();
    this.afterTurn(session.id);
  }

  /**
   * `session/prompt` 的结果（或引擎自己报的回合结束）→ 回合的结算。`stopReason: error`（ACP v2 把回合失败报成带 `error` 的结果，
   * 而不是 JSON-RPC 错误；SDK 不校验结果，这个值照样到这里）算失败，`error` 的 `code`、`message`、`data` 像 JSON-RPC 错误那样交给
   * 引擎归类（T3 Code #24615），已经请求取消的回合仍算取消；其余的除 `cancelled` 外都算完成。
   */
  #promptOutcome(
    engineSessionId: string,
    turn: Turn,
    response: { stopReason: string; error?: unknown },
  ): TurnSettledEvent | TurnFailedEvent {
    if (response.stopReason !== 'error') return settledEvent(engineSessionId, response.stopReason);
    if (turn.cancelRequested) {
      return { type: 'turn.settled', engineSessionId, outcome: 'cancelled', stopReason: 'error' };
    }
    const error = isRecord(response.error) ? response.error : {};
    const message =
      typeof error.message === 'string' && error.message !== ''
        ? error.message
        : `${this.engine.name} 报回合失败（stopReason: error）`;
    return this.#turnFailed(
      engineSessionId,
      Object.assign(new Error(message), {
        code: typeof error.code === 'number' ? error.code : -32603,
        ...(error.data !== undefined && { data: error.data }),
      }),
    );
  }

  /** 回合失败：按引擎归类；原文进事件库之前遮盖像密钥的片段（`redactDiagnostics`）。 */
  #turnFailed(engineSessionId: string, error: unknown): TurnFailedEvent {
    const classified = this.engine.classifyTurnError(error);
    return {
      type: 'turn.failed',
      engineSessionId,
      ...classified,
      message: redactDiagnostics(classified.message),
    };
  }

  /** 引擎描述了 `sessionModels` 时把结果里的 ACP `models` 并进 `configOptions`。 */
  #withSessionModels(configOptions: unknown, models: unknown): unknown {
    return this.engine.sessionModels === undefined || models === undefined
      ? configOptions
      : this.engine.sessionModels(configOptions, models);
  }

  /**
   * 选定会话的路由：模型选项的值按引擎描述的 `route` 编码（dsh 是 `JSON.stringify([provider, model])`），与
   * `session/new` 给的当前值不同就 `set_config_option`；给了推理强度、且引擎有这个选项时也一样。返回最终的
   * `configOptions`。选不上（引擎没有这个 Provider 或模型，dsh 是 `-32602 unknown model option`）报 `invalid_input`。
   */
  async #selectRoute(
    engineSessionId: string,
    config: Pick<SessionConfig, 'providerId' | 'modelId' | 'reasoningEffort'>,
    initial: unknown,
  ): Promise<unknown> {
    const connection = this.process.connection;
    const { name, route } = this.engine;
    let configOptions = initial;
    const set = async (configId: string, value: string, what: string) => {
      try {
        const result = await connection.agent.request(methods.agent.session.setConfigOption, {
          sessionId: engineSessionId,
          configId,
          value,
        });
        configOptions = result.configOptions;
      } catch (error) {
        const failed = engineError(error, 'session/set_config_option');
        throw new AdapterError(
          failed.code,
          `${name} 选不上${what}（Provider 配置里有没有它？配置改过但还没生效？）：${failed.message}`,
          { cause: error },
        );
      }
    };
    const value = route.encode(config.providerId, config.modelId);
    const modelOption = routeModelOption(configOptions, route);
    const effort = config.reasoningEffort;
    const effortOption = route.reasoningEffortOption;
    if (route.modelMethod === 'set_model') {
      // ACP 的 session/set_model（Grok）：推理强度跟着模型走，在同一请求的 _meta 里；没给推理强度时不带，不当作清掉
      // 引擎的默认档位（T3 的 applyGrokAcpModelSelection）。
      const effortChanged =
        effort !== undefined &&
        effortOption !== undefined &&
        currentOption(configOptions, effortOption) !== effort;
      const current = currentOption(configOptions, modelOption);
      const target = value ?? current;
      if ((value === undefined || value === current) && !effortChanged) return configOptions;
      // 只换推理强度又不知道当前模型：没法发 set_model，用引擎的默认档位。
      if (target === undefined) return configOptions;
      let result: { _meta?: unknown } | undefined;
      try {
        result = await connection.agent.request<{ _meta?: unknown } | undefined>(
          'session/set_model',
          {
            sessionId: engineSessionId,
            modelId: target,
            ...(effort !== undefined && { _meta: { reasoningEffort: effort } }),
          },
        );
      } catch (error) {
        const failed = engineError(error, 'session/set_model');
        throw new AdapterError(
          failed.code,
          `${name} 选不上模型 ${config.modelId}：${failed.message}`,
          { cause: error },
        );
      }
      const rejected = (result?._meta as { model?: { Err?: unknown } } | undefined)?.model?.Err;
      if (rejected !== undefined) {
        throw new AdapterError(
          'invalid_input',
          `${name} 选不上模型 ${config.modelId}：${typeof rejected === 'string' ? rejected : JSON.stringify(rejected)}`,
        );
      }
      configOptions = withCurrentOption(configOptions, modelOption, target);
      if (effort !== undefined && effortOption !== undefined) {
        configOptions = withCurrentOption(configOptions, effortOption, effort);
      }
      return configOptions;
    }
    if (value !== undefined && currentOption(configOptions, modelOption) !== value) {
      await set(modelOption, value, ` ${config.providerId} 的模型 ${config.modelId}`);
    }
    if (
      effort !== undefined &&
      effortOption !== undefined &&
      currentOption(configOptions, effortOption) !== effort
    ) {
      await set(effortOption, effort, `推理强度 ${effort}`);
    }
    return configOptions;
  }

  /** 引擎要求先认证时（`authenticateAfter`）认证后重试一次。 */
  async #withAuth<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (isAdapterError(error) || !(await this.authenticateAfter(error))) throw error;
      return request();
    }
  }

  /** 启动或等进行中的重启完成，返回就绪的连接。 */
  async #readyConnection() {
    await this.process.start();
    await this.beforeActivation();
    this.assertUsable();
    return this.process.connection;
  }

  #onExit(exit: AcpExit): void {
    this.#detachAll({
      exitCode: exit.exitCode,
      signal: exit.signal,
      ...(exit.stderrTail !== '' && { stderrTail: exit.stderrTail }),
    });
  }

  /**
   * 挂着的会话全部脱开：结束未决审批（`engine_exited`，引擎已退出或即将被回收，回复写不出去也无妨）、丢下进行中的
   * 回合（它的 `session/prompt` 随旧连接失败，`#settle` 发现回合已换掉就不再上报），发 `engine.exited`。
   */
  #detachAll(exit: Omit<EngineExitedEvent, 'type' | 'engineSessionId'>): void {
    for (const session of this.#sessions.values()) {
      if (session.status !== 'open') continue;
      session.status = 'detached';
      this.#cancelPending(session, 'engine_exited');
      session.turn?.finish();
      session.turn = undefined;
      session.queue.exited({ type: 'engine.exited', engineSessionId: session.id, ...exit });
    }
  }

  /** 登记一个刚挂到本进程上的会话；之前的记录（已关闭或已脱开，事件队列已结束）被替换。 */
  #register(
    id: string,
    cwd: string,
    configOptions: unknown,
    deniedTools: readonly EngineToolClass[] = [],
  ): void {
    this.#sessions.set(id, {
      id,
      cwd,
      status: 'open',
      queue: new SessionEventQueue(id, this.#warnOnce, this.engine),
      approvals: new Map(),
      questions: new Map(),
      configOptions,
      deniedTools: new Set(deniedTools),
      toolCalls: new Map(),
    });
  }

  #session(engineSessionId: string): AcpSession {
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `不认识的引擎会话 ${engineSessionId}`);
    }
    return session;
  }

  #openSession(engineSessionId: string): AcpSession {
    const session = this.#session(engineSessionId);
    if (session.status !== 'open') {
      throw new AdapterError(
        'session_closed',
        `引擎会话 ${engineSessionId} 没有挂着（${session.status}）`,
      );
    }
    return session;
  }
}

/** 默认的告警出口：写 stderr，前缀 `[adapter-<引擎名>]`。 */
function stderrLogger(name: string): AdapterLogger {
  return {
    warn: (message, fields) =>
      process.stderr.write(
        `[adapter-${name}] ${message}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}\n`,
      ),
  };
}

function copyApproval(info: PendingApproval): PendingApproval {
  return { ...info, options: info.options.map((option) => ({ ...option })) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 记下 `tool_call` / `tool_call_update` 带来的 `kind`、`title`、`rawInput`（后到的盖掉先到的；没给或是 null 的不动）。 */
function trackToolCall(calls: Map<string, TrackedToolCall>, update: AcpSessionUpdate): void {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
  if (typeof update.toolCallId !== 'string') return;
  const tracked = calls.get(update.toolCallId) ?? {};
  if (typeof update.kind === 'string') tracked.kind = update.kind;
  if (typeof update.title === 'string') tracked.title = update.title;
  if (update.rawInput !== undefined && update.rawInput !== null) tracked.rawInput = update.rawInput;
  calls.set(update.toolCallId, tracked);
}

/** 审批请求里没给（或给了 null）的 `kind`、`title`、`rawInput` 用记下的补上；给了的照用。 */
function withTrackedToolCall(
  params: RequestPermissionRequest,
  tracked: TrackedToolCall | undefined,
): RequestPermissionRequest {
  if (tracked === undefined) return params;
  const { kind, title, rawInput } = params.toolCall;
  return {
    ...params,
    toolCall: {
      ...params.toolCall,
      ...(kind == null &&
        tracked.kind !== undefined && {
          kind: tracked.kind as NonNullable<RequestPermissionRequest['toolCall']['kind']>,
        }),
      ...(title == null && tracked.title !== undefined && { title: tracked.title }),
      ...(rawInput == null && tracked.rawInput !== undefined && { rawInput: tracked.rawInput }),
    },
  };
}

function settledEvent(engineSessionId: string, stopReason: string): TurnSettledEvent {
  return {
    type: 'turn.settled',
    engineSessionId,
    outcome: stopReason === 'cancelled' ? 'cancelled' : 'completed',
    stopReason,
  };
}

function cancelledEvent(
  info: PendingApproval,
  reason: ApprovalCancelledEvent['reason'],
): ApprovalCancelledEvent {
  return {
    type: 'approval.cancelled',
    engineSessionId: info.engineSessionId,
    requestId: info.requestId,
    reason,
  };
}

/** ACP `configOptions` 里某个选项的 `currentValue`。 */
function currentOption(configOptions: unknown, id: string): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const option: unknown = configOptions.find(
    (o) => typeof o === 'object' && o !== null && (o as { id?: unknown }).id === id,
  );
  const value = (option as { currentValue?: unknown } | undefined)?.currentValue;
  return typeof value === 'string' ? value : undefined;
}

/** 改掉 `configOptions` 里某个选项的 `currentValue`（`session/set_model` 不回 `configOptions`）。 */
function withCurrentOption(configOptions: unknown, id: string, value: string): unknown {
  if (!Array.isArray(configOptions)) return [{ id, currentValue: value }];
  let found = false;
  const next = configOptions.map((option: unknown) => {
    if (typeof option !== 'object' || option === null || (option as { id?: unknown }).id !== id) {
      return option;
    }
    found = true;
    return { ...option, currentValue: value };
  });
  return found ? next : [...next, { id, currentValue: value }];
}

/** ACP 调用失败 → AdapterError：参数错误是 `invalid_input`，其余是 `engine_unavailable`。 */
function engineError(error: unknown, method: string): AdapterError {
  if (isAdapterError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return new AdapterError(
    code === INVALID_PARAMS ? 'invalid_input' : 'engine_unavailable',
    `${method} 失败：${message}`,
    { cause: error },
  );
}
