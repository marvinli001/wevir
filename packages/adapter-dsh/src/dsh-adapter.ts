import {
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
  type EngineSession,
  isAdapterError,
  type PendingApproval,
  type ProviderConfig,
  type ProviderIssue,
  type ProviderTestResult,
  type SessionConfig,
  type TurnFailedEvent,
  type TurnSettledEvent,
} from '@wevir/runtime-adapter';
import { isAcpSessionNotification, sessionConfigInfo } from './acp-mapping.js';
import {
  type DshExit,
  DshProcess,
  type DshProcessOptions,
  type DshStreamTapOptions,
} from './dsh-process.js';
import {
  providerEnv,
  providerOverlayPath,
  renderProviderOverlay,
  validateProviderConfig,
  writeProviderOverlay,
} from './provider-config.js';
import { type ProviderTestOptions, testProvider } from './provider-test.js';
import {
  type AdapterLogger,
  SessionEventQueue,
  type WarnOnce,
  warnOnceVia,
} from './session-events.js';
import type { StreamTapEvent } from './stream-tap.js';
import { classifyTurnError } from './turn-error.js';

/**
 * `cancel` 等回合结算的时限。T0.3 实测 3–64 ms 结算；Host 自己的取消时限是 5 s（domain-model.md §4.1 #9），
 * 适配器先于它报 `cancel_unconfirmed`。
 */
export const CANCEL_TIMEOUT_MS = 4000;

const INVALID_PARAMS = -32602;

/** 审批的“取消”回复（ACP `RequestPermissionOutcome`）：dsh 把它记为 `approval … was cancelled`，工具失败。 */
const PERMISSION_CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

export interface DshAdapterOptions
  extends Omit<DshProcessOptions, 'onSessionUpdate' | 'onRequestPermission' | 'streamTap'> {
  /**
   * 增量流式旁路（T3.2a）。默认开启，用本包的 stream-tap 插件；`false` 关闭，只有 ACP 的已提交消息。
   * 旁路的告警写 `logger`。
   */
  streamTap?: false | Omit<DshStreamTapOptions, 'onEvent' | 'onWarning'>;
  /** 告警日志（Host 的 Logger 满足这个接口），默认写 stderr。 */
  logger?: AdapterLogger;
  cancelTimeoutMs?: number;
  /**
   * 启动前就已知的 Provider（T3.4），等同构造后立即 `configureProviders`。Provider overlay 排在 `patches`
   * 之前，`patches` 里同 `id` 的条目会整体覆盖它（测试用）。
   */
  providers?: readonly ProviderConfig[];
  /** `testProvider` 的选项（测试注入 fetch、缩短时限）。 */
  providerTest?: ProviderTestOptions;
}

interface Turn {
  cancelRequested: boolean;
  /** `session/prompt` 结算（成功、失败或被引擎退出打断）后兑现，永不 reject。 */
  done: Promise<void>;
}

interface DshSession {
  readonly id: string;
  readonly cwd: string;
  /** open：挂在当前 dsh 进程上；closed：已 close；detached：进程退出后脱开，要 resume（T3.5）。 */
  status: 'open' | 'closed' | 'detached';
  queue: SessionEventQueue;
  turn?: Turn;
  /** 未决审批，按 requestId。只在回合中有；回合结束、取消、引擎退出、dispose 时清空。 */
  readonly approvals: Map<string, PendingPermission>;
}

/** 一个挂起的 `session/request_permission`：dsh 在等 `reply` 的结果。 */
interface PendingPermission {
  readonly info: PendingApproval;
  /** 兑现 ACP SDK 交给处理器的那个 Promise，SDK 随即把它作为响应写给 dsh。只调用一次。 */
  readonly reply: (response: RequestPermissionResponse) => void;
}

/**
 * dsh 的 `AgentRuntimeAdapter`（ADR-0001）：一个 `DshProcess` 承载全部会话，经 ACP 驱动。
 *
 * 事件路径（T3.2，docs/architecture/acp-event-mapping.md）：DshProcess 按 dsh 写出的顺序交来原始的
 * `session/update`，stream-tap 交来增量；两者按 `sessionId` 路由到各会话的 `SessionEventQueue`，在那里映射、
 * 对齐，再扇出给订阅者。`session/prompt` 的结果在它之前的更新全部入队之后才兑现，所以回合终结事件总在
 * 该回合的其他事件之后。stream-tap 里不属于任何 ACP 会话的帧（子 agent 的会话）丢弃。
 *
 * 审批（T3.3，acp-event-mapping.md §5）：`session/request_permission` 变成 `approval.requested`（适配器分配
 * `requestId`，选项原样），挂起到 `respondToApproval` 回复 `selected`，或以 `cancelled` 回复并发
 * `approval.cancelled`：取消与关闭（`turn_cancelled`，先写 `session/cancel` 再回复，T0.3 场景 D 的顺序）、
 * 回合在审批未决时结束（`turn_ended`）、引擎退出（`engine_exited`，已无从回复）、`dispose`（`disposed`）。
 * 不回复 dsh 就一直等。审批详情不在这里取：请求只带 `toolCallId`，Host 用同一 `toolCallId` 的
 * `tool.started`（dsh 的 `tool_call.rawInput`）生成（ADR-0001 §5 第 6 条）。顺序：dsh 先把积压的
 * `session/update` 写完再发审批请求（上游 `dsh-acp/src/index.ts` 的 `drainUpdates`），而更新在 SDK 之前就已入队，
 * 所以该工具的 `tool.started` 总在 `approval.requested` 之前；dsh 收到回复之前不会写出这个工具的结果。
 *
 * Provider（T3.4，docs/architecture/providers.md）：`configureProviders` 把整套 Provider 写成
 * `<DSH_HOME>/wevir/providers.yml`（只含 Key 的变量名），Key 放进下一次 spawn 的环境。dsh 不热加载配置
 * （ADR-0001 补记 5），所以运行中的进程要重启才用上新配置：没有进行中的回合时立即重启，否则等最后一个回合
 * 结束再重启；挂着的会话先以 `engine.exited`（`config_changed`）脱开，之后 resume（T3.5）即用新配置。
 * 每个会话的路由（Provider 与模型）在 `session/new` 之后用 `session/set_config_option` 选定。
 *
 * 尚未实现的部分：脱开或关闭之后的 `resumeSession`（T3.5）、`cancel` 无法确认时重启 dsh（T3.5）。
 */
export class DshAdapter implements AgentRuntimeAdapter {
  readonly process: DshProcess;
  readonly #sessions = new Map<string, DshSession>();
  readonly #logger: AdapterLogger;
  readonly #warnOnce: WarnOnce;
  readonly #cancelTimeoutMs: number;
  readonly #basePatches: readonly string[];
  readonly #baseEnv: Readonly<Record<string, string>>;
  readonly #providerTest: ProviderTestOptions | undefined;
  #nextRequestId = 0;
  #disposed: Promise<void> | undefined;
  /** 为应用新配置的重启（合并并发的请求）。 */
  #configRestart: Promise<void> | undefined;
  /** 进行中的 `createSession` 数：它们的会话还没登记，重启要等它们完成，否则会话会挂在被回收的进程上。 */
  #creating = 0;

  constructor(options: DshAdapterOptions) {
    const { streamTap, logger, cancelTimeoutMs, providers, providerTest, ...processOptions } =
      options;
    this.#logger = logger ?? STDERR_LOGGER;
    this.#warnOnce = warnOnceVia(this.#logger);
    this.#cancelTimeoutMs = cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
    this.#basePatches = processOptions.patches ?? [];
    this.#baseEnv = processOptions.env ?? {};
    this.#providerTest = providerTest;
    this.process = new DshProcess({
      ...processOptions,
      onSessionUpdate: (params) => this.#onSessionUpdate(params),
      onRequestPermission: (params, signal) => this.#onRequestPermission(params, signal),
      ...(streamTap !== false && {
        streamTap: {
          ...streamTap,
          onEvent: (event: StreamTapEvent) => this.#onStreamTap(event),
          onWarning: (warning) =>
            this.#logger.warn(warning.message, {
              kind: `stream_tap_${warning.kind}`,
              ...(warning.line !== undefined && { line: warning.line }),
            }),
        },
      }),
    });
    this.process.on('exit', (exit) => this.#onExit(exit));
    this.process.on('restarting', ({ attempt, maxRestarts, delayMs }) =>
      this.#logger.warn(`dsh 进程将在 ${delayMs} ms 后重启（第 ${attempt}/${maxRestarts} 次）`),
    );
    this.process.on('failed', ({ restarts }) =>
      this.#logger.warn(`dsh 进程连续重启 ${restarts} 次仍失败，停止重启`),
    );
    if (providers !== undefined) this.#writeProviders(providers);
  }

  validateProvider(provider: ProviderConfig): ProviderIssue[] {
    return validateProviderConfig(provider);
  }

  /**
   * 换上整套 Provider：重写 overlay、换掉下一次 spawn 的 Key。dsh 进程没在运行时到此为止，下次启动生效；
   * 在运行且没有进行中的回合时立即重启（返回时新进程已就绪），有回合时等最后一个回合结束再重启。
   * 不合法的 Provider 抛 `invalid_input`（Host 应先 `validateProvider`），此时什么都不改。
   */
  async configureProviders(providers: readonly ProviderConfig[]): Promise<void> {
    this.#assertUsable();
    this.#writeProviders(providers);
    await this.#applyConfigIfIdle();
  }

  testProvider(provider: ProviderConfig, modelId: string): Promise<ProviderTestResult> {
    return testProvider(provider, modelId, this.#providerTest);
  }

  /** 适配器记得的会话数（含已关闭、已脱开的）；dispose 之后为 0。 */
  get sessionCount(): number {
    return this.#sessions.size;
  }

  async createSession(config: SessionConfig): Promise<EngineSession> {
    this.#assertUsable();
    if (!config.cwd) throw new AdapterError('invalid_input', 'cwd 不能为空');
    await this.process.start();
    // 配置换过、还在等回合结束的重启：没有回合了就先重启，新会话直接用新配置。
    await this.#applyConfigIfIdle();
    this.#assertUsable();
    const connection = this.process.connection;
    this.#creating += 1;
    try {
      let response: { sessionId: string; configOptions?: unknown };
      try {
        response = await connection.agent.request(methods.agent.session.new, {
          cwd: config.cwd,
          mcpServers: [],
        });
      } catch (error) {
        throw engineError(error, 'session/new');
      }
      const id = response.sessionId;
      let configOptions: unknown;
      try {
        configOptions = await this.#selectRoute(id, config, response.configOptions);
      } catch (error) {
        // 选不上路由的会话不交给 Host，引擎侧也关掉。
        await connection.agent
          .request(methods.agent.session.close, { sessionId: id })
          .catch(() => {});
        throw error;
      }
      this.#sessions.set(id, {
        id,
        cwd: config.cwd,
        status: 'open',
        queue: new SessionEventQueue(id, this.#warnOnce),
        approvals: new Map(),
      });
      return { engineSessionId: id, ...sessionConfigInfo(configOptions) };
    } finally {
      this.#creating -= 1;
    }
  }

  async resumeSession(engineSessionId: string, _config: SessionConfig): Promise<EngineSession> {
    this.#assertUsable();
    const session = this.#session(engineSessionId);
    if (session.status === 'open') return { engineSessionId };
    throw new AdapterError('session_unavailable', 'dsh 适配器的 resumeSession 尚未实现（T3.5）');
  }

  subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    this.#assertUsable();
    return this.#openSession(engineSessionId).queue.subscribe();
  }

  async send(engineSessionId: string, input: AgentInput): Promise<void> {
    this.#assertUsable();
    const session = this.#openSession(engineSessionId);
    if (session.turn !== undefined) throw new AdapterError('session_busy', '会话有进行中的回合');
    if (input.content.length === 0) throw new AdapterError('invalid_input', 'content 不能为空');
    const connection = this.process.connection;
    const turn: Turn = { cancelRequested: false, done: Promise.resolve() };
    session.turn = turn;
    session.queue.beginTurn();
    // ACP 的 session/prompt 到回合结束才返回（适配器接口注释第 7 条），这里发出请求就返回。
    const prompt: Promise<PromptResponse> = connection.agent.request(methods.agent.session.prompt, {
      sessionId: engineSessionId,
      prompt: input.content.map((part) => ({ type: 'text' as const, text: part.text })),
    });
    turn.done = prompt.then(
      ({ stopReason }) =>
        this.#settle(session, turn, {
          type: 'turn.settled',
          engineSessionId,
          outcome: stopReason === 'cancelled' ? 'cancelled' : 'completed',
          stopReason,
        }),
      (error: unknown) =>
        this.#settle(session, turn, {
          type: 'turn.failed',
          engineSessionId,
          ...classifyTurnError(error),
        }),
    );
  }

  async respondToApproval(
    engineSessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    this.#assertUsable();
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
    // 先移出再回复：同一请求只回复 dsh 一次，之后的决定报 approval_not_found。
    session.approvals.delete(requestId);
    pending.reply({ outcome: { outcome: 'selected', optionId: decision.optionId } });
  }

  async listPendingApprovals(engineSessionId?: string): Promise<PendingApproval[]> {
    this.#assertUsable();
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
      // 挂起的审批必须以 cancelled 回复，否则 dsh 一直等（ADR-0001 §6）。SDK 在 notify 调用时就把
      // session/cancel 排进写队列，这些回复排在它后面，与 T0.3 场景 D 的顺序相同。
      this.#cancelApprovals(session, 'turn_cancelled');
      await notified;
    }
    if (!(await settledWithin(turn.done, this.#cancelTimeoutMs))) {
      throw new AdapterError(
        'cancel_unconfirmed',
        `发出 session/cancel 后 ${this.#cancelTimeoutMs} ms 内回合没有结算`,
      );
    }
  }

  async close(engineSessionId: string): Promise<void> {
    this.#assertUsable();
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
        replied = this.#cancelApprovals(session, 'disposed') || replied;
        session.turn = undefined;
        session.queue.end();
      }
      this.#sessions.clear();
      // 回复经 SDK 的几个微任务才写进 dsh 的 stdin；先让它们写出去，再关连接、关 stdin。
      if (replied) await new Promise((resolve) => setImmediate(resolve));
      await this.process.dispose();
    })();
    return this.#disposed;
  }

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
    session.queue.acpUpdate(params);
  }

  /**
   * ACP `session/request_permission`（SDK 已校验参数）。返回的 Promise 兑现时 SDK 把它作为响应写给 dsh。
   * 没有挂着的会话或进行中的回合时直接回复 cancelled；回合已在取消时照常上报请求，随即以 cancelled 结束。
   */
  #onRequestPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const session = this.#sessions.get(params.sessionId);
    const turn = session?.status === 'open' ? session.turn : undefined;
    if (session === undefined || turn === undefined) {
      this.#logger.warn('ACP session/request_permission 不属于进行中的回合，回复 cancelled', {
        engineSessionId: params.sessionId,
        toolCallId: params.toolCall.toolCallId,
      });
      return Promise.resolve(PERMISSION_CANCELLED);
    }
    const info: PendingApproval = {
      engineSessionId: session.id,
      requestId: `perm-${++this.#nextRequestId}`,
      toolCallId: params.toolCall.toolCallId,
      options: params.options.map((option) => ({
        optionId: option.optionId,
        label: option.name,
        kind: option.kind,
      })),
    };
    session.queue.approval({ type: 'approval.requested', ...copyApproval(info) });
    if (turn.cancelRequested) {
      session.queue.approval(cancelledEvent(info, 'turn_cancelled'));
      return Promise.resolve(PERMISSION_CANCELLED);
    }
    return new Promise((resolve) => {
      session.approvals.set(info.requestId, { info, reply: resolve });
      // dsh 撤回请求（`$/cancel_request`；dsh 0.2.1-alpha.2 不发）。连接关闭也会触发，那时引擎退出或 dispose
      // 的路径已经同步结束了这个审批，所以晚一个微任务再看。
      signal.addEventListener(
        'abort',
        () =>
          queueMicrotask(() => {
            if (!session.approvals.delete(info.requestId)) return;
            session.queue.approval(cancelledEvent(info, 'turn_ended'));
            resolve(PERMISSION_CANCELLED);
          }),
        { once: true },
      );
    });
  }

  /**
   * 结束会话的全部未决审批：以 cancelled 回复 dsh（引擎已退出时这个回复写不出去，无妨），发 `approval.cancelled`。
   * 返回是否结束了至少一个。
   */
  #cancelApprovals(session: DshSession, reason: ApprovalCancelledEvent['reason']): boolean {
    if (session.approvals.size === 0) return false;
    const pending = [...session.approvals.values()];
    session.approvals.clear();
    for (const { info, reply } of pending) {
      session.queue.approval(cancelledEvent(info, reason));
      reply(PERMISSION_CANCELLED);
    }
    return true;
  }

  /** 发 `session/cancel`，不抛错：连接已断时回合由引擎退出的路径结算（engine.exited）。 */
  #notifyCancel(engineSessionId: string): Promise<void> {
    try {
      return this.process.connection.agent
        .notify(methods.agent.session.cancel, { sessionId: engineSessionId })
        .catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  #onStreamTap(event: StreamTapEvent): void {
    const session = this.#sessions.get(event.engineSessionId);
    if (session?.status === 'open') session.queue.streamTap(event);
  }

  #settle(session: DshSession, turn: Turn, event: TurnSettledEvent | TurnFailedEvent): void {
    // 引擎退出或 dispose 已经结束了这个回合。
    if (session.turn !== turn) return;
    // 回合在审批未决时自己结束了（dsh 不会这样，防御）：审批随回合结束。
    this.#cancelApprovals(session, 'turn_ended');
    session.turn = undefined;
    session.queue.endTurn(event);
    // 等这个回合结束的配置重启（configureProviders 时有回合在跑）。
    if (this.process.launchConfigStale) {
      this.#applyConfigIfIdle().catch((error: unknown) =>
        this.#logger.warn('为应用新的 Provider 配置重启 dsh 失败', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * 选定会话的路由：dsh 的模型选项值是 `JSON.stringify([provider, model])`（上游 `dsh-acp/src/model-control.ts`），
   * 与 `session/new` 给的当前值不同就 `set_config_option`；给了推理强度也一样。返回最终的 `configOptions`。
   * 选不上（dsh 没有这个 Provider 或模型，`-32602 unknown model option`）报 `invalid_input`。
   */
  async #selectRoute(
    engineSessionId: string,
    config: SessionConfig,
    initial: unknown,
  ): Promise<unknown> {
    const connection = this.process.connection;
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
          `dsh 选不上${what}（Provider 配置里有没有它？配置改过但还没生效？）：${failed.message}`,
          { cause: error },
        );
      }
    };
    const route = JSON.stringify([config.providerId, config.modelId]);
    if (currentOption(configOptions, 'model') !== route) {
      await set('model', route, ` ${config.providerId} 的模型 ${config.modelId}`);
    }
    const effort = config.reasoningEffort;
    if (effort !== undefined && currentOption(configOptions, 'reasoning_effort') !== effort) {
      await set('reasoning_effort', effort, `推理强度 ${effort}`);
    }
    return configOptions;
  }

  #writeProviders(providers: readonly ProviderConfig[]): void {
    let overlay: string;
    try {
      overlay = renderProviderOverlay(providers);
    } catch (error) {
      throw new AdapterError(
        'invalid_input',
        error instanceof Error ? error.message : String(error),
      );
    }
    writeProviderOverlay(this.process.paths, overlay);
    this.process.setLaunchConfig({
      patches: [providerOverlayPath(this.process.paths), ...this.#basePatches],
      env: { ...this.#baseEnv, ...providerEnv(providers) },
    });
  }

  /**
   * 进程用的是旧配置且空闲（没有进行中的回合、没有进行中的 `createSession`）时重启它；否则什么都不做，
   * 等下一个回合结束或下一次 `createSession` 再看。
   */
  async #applyConfigIfIdle(): Promise<void> {
    if (this.#configRestart !== undefined) return this.#configRestart;
    if (this.process.state !== 'ready' || !this.process.launchConfigStale) return;
    if (this.#creating > 0) return;
    if ([...this.#sessions.values()].some((session) => session.turn !== undefined)) return;
    this.#configRestart = (async () => {
      // 先脱开会话（同步），之后的 send 报 session_closed，不会在旧进程上开新回合。
      for (const session of this.#sessions.values()) {
        if (session.status !== 'open') continue;
        session.status = 'detached';
        session.queue.exited({
          type: 'engine.exited',
          engineSessionId: session.id,
          exitCode: null,
          signal: null,
          reason: 'config_changed',
        });
      }
      await this.process.restart();
    })().finally(() => {
      this.#configRestart = undefined;
    });
    return this.#configRestart;
  }

  #onExit(exit: DshExit): void {
    for (const session of this.#sessions.values()) {
      if (session.status !== 'open') continue;
      session.status = 'detached';
      this.#cancelApprovals(session, 'engine_exited');
      session.turn = undefined;
      session.queue.exited({
        type: 'engine.exited',
        engineSessionId: session.id,
        exitCode: exit.exitCode,
        signal: exit.signal,
        ...(exit.stderrTail !== '' && { stderrTail: exit.stderrTail }),
      });
    }
  }

  #assertUsable(): void {
    if (this.#disposed !== undefined) throw new AdapterError('disposed', 'dsh 适配器已释放');
  }

  #session(engineSessionId: string): DshSession {
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `不认识的引擎会话 ${engineSessionId}`);
    }
    return session;
  }

  #openSession(engineSessionId: string): DshSession {
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

const STDERR_LOGGER: AdapterLogger = {
  warn: (message, fields) =>
    process.stderr.write(
      `[adapter-dsh] ${message}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}\n`,
    ),
};

function copyApproval(info: PendingApproval): PendingApproval {
  return { ...info, options: info.options.map((option) => ({ ...option })) };
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

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
