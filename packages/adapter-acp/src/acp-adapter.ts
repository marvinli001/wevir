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
  type EngineExitedEvent,
  type EngineSession,
  isAdapterError,
  type PendingApproval,
  type SessionConfig,
  type TurnFailedEvent,
  type TurnSettledEvent,
} from '@wevir/runtime-adapter';
import { isAcpSessionNotification, sessionConfigInfo } from './acp-mapping.js';
import { type AcpExit, type AcpProcess, settledWithin } from './acp-process.js';
import type { AcpEngine, IncrementalEvent } from './engine.js';
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
   * 建引擎进程（构造时调用一次）。`hooks` 里的回调要接到进程上：`onSessionUpdate` 与 `onRequestPermission`
   * 原样作 `AcpProcessOptions` 的同名项，`onIncrementalEvent` 作增量旁路的 `onEvent`。`logger` 是适配器
   * 最终用的告警出口（旁路的告警写这里）。
   */
  createProcess(hooks: AcpProcessHooks): P;
  /** 告警日志（Host 的 Logger 满足这个接口），默认写 stderr。 */
  logger?: AdapterLogger;
  cancelTimeoutMs?: number;
}

export interface AcpProcessHooks {
  onSessionUpdate: (params: unknown) => void;
  onRequestPermission: (
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
  onIncrementalEvent: (event: IncrementalEvent) => void;
  logger: AdapterLogger;
}

interface Turn {
  cancelRequested: boolean;
  /** `session/prompt` 结算（成功、失败或被引擎退出打断）后兑现，永不 reject。 */
  done: Promise<void>;
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
}

/** 一个挂起的 `session/request_permission`：引擎在等 `reply` 的结果。 */
interface PendingPermission {
  readonly info: PendingApproval;
  /** 兑现 ACP SDK 交给处理器的那个 Promise，SDK 随即把它作为响应写给引擎。只调用一次。 */
  readonly reply: (response: RequestPermissionResponse) => void;
}

/**
 * ACP 引擎的 `AgentRuntimeAdapter`（ADR-0005 决策 1.3）：一个 `AcpProcess` 承载全部会话，经 ACP 驱动；引擎之间的
 * 差异都在引擎描述里（engine.ts）。dsh 的 `DshAdapter` 是它的子类，另加 Provider 桥接与配置变更时的重启。
 *
 * 事件路径（docs/architecture/acp-event-mapping.md 第一部分）：AcpProcess 按引擎写出的顺序交来原始的
 * `session/update`，增量旁路（有的话）交来增量；两者按 `sessionId` 路由到各会话的 `SessionEventQueue`，在那里
 * 映射、对齐，再扇出给订阅者。`session/prompt` 的结果在它之前的更新全部入队之后才兑现，所以回合终结事件总在
 * 该回合的其他事件之后。旁路里不属于任何 ACP 会话的帧（dsh 子 agent 的会话）丢弃。
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
  readonly #sessions = new Map<string, AcpSession>();
  readonly #logger: AdapterLogger;
  readonly #warnOnce: WarnOnce;
  readonly #cancelTimeoutMs: number;
  #nextRequestId = 0;
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
    this.#logger = options.logger ?? stderrLogger(engine.name);
    this.#warnOnce = warnOnceVia(this.#logger);
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
    this.process = options.createProcess({
      onSessionUpdate: (params) => this.#onSessionUpdate(params),
      onRequestPermission: (params, signal) => this.#onRequestPermission(params, signal),
      onIncrementalEvent: (event) => this.#onIncremental(event),
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

  async createSession(config: SessionConfig): Promise<EngineSession> {
    this.assertUsable();
    if (!config.cwd) throw new AdapterError('invalid_input', 'cwd 不能为空');
    const connection = await this.#readyConnection();
    this.#activating += 1;
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
      this.#register(id, config.cwd);
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
      try {
        ({ configOptions } = await connection.agent.request(methods.agent.session.resume, {
          sessionId: engineSessionId,
          cwd: config.cwd,
          mcpServers: [],
        }));
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
        configOptions = await this.#selectRoute(engineSessionId, config, configOptions);
      } catch (error) {
        await connection.agent
          .request(methods.agent.session.close, { sessionId: engineSessionId })
          .catch(() => {});
        throw error;
      }
      this.#register(engineSessionId, config.cwd);
      return {
        engineSessionId,
        engineVersion: this.engine.version,
        ...sessionConfigInfo(configOptions, this.engine.route),
      };
    } finally {
      this.#activating -= 1;
    }
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
          ...this.engine.classifyTurnError(error),
        }),
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
    pending.reply({ outcome: { outcome: 'selected', optionId: decision.optionId } });
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
      // 挂起的审批必须以 cancelled 回复，否则引擎一直等（ADR-0001 §6）。SDK 在 notify 调用时就把
      // session/cancel 排进写队列，这些回复排在它后面，与 T0.3 场景 D 的顺序相同。
      this.#cancelApprovals(session, 'turn_cancelled');
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
        replied = this.#cancelApprovals(session, 'disposed') || replied;
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

  /** 一个回合结算（`turn.settled` / `turn.failed` 已发出）之后调用（dsh：等回合结束的配置重启）。默认什么都不做。 */
  protected afterTurn(): void {}

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
    session.queue.acpUpdate(params);
  }

  /**
   * ACP `session/request_permission`（SDK 已校验参数）。返回的 Promise 兑现时 SDK 把它作为响应写给引擎。
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
      // 引擎撤回请求（`$/cancel_request`；dsh 0.2.1-alpha.2 不发）。连接关闭也会触发，那时引擎退出或 dispose
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
   * 结束会话的全部未决审批：以 cancelled 回复引擎（引擎已退出时这个回复写不出去，无妨），发 `approval.cancelled`。
   * 返回是否结束了至少一个。
   */
  #cancelApprovals(session: AcpSession, reason: ApprovalCancelledEvent['reason']): boolean {
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

  #onIncremental(event: IncrementalEvent): void {
    const session = this.#sessions.get(event.engineSessionId);
    if (session?.status === 'open') session.queue.incremental(event);
  }

  #settle(session: AcpSession, turn: Turn, event: TurnSettledEvent | TurnFailedEvent): void {
    // 引擎退出或 dispose 已经结束了这个回合。
    if (session.turn !== turn) return;
    // 回合在审批未决时自己结束了（dsh 不会这样，防御）：审批随回合结束。
    this.#cancelApprovals(session, 'turn_ended');
    session.turn = undefined;
    session.queue.endTurn(event);
    this.afterTurn();
  }

  /**
   * 选定会话的路由：模型选项的值按引擎描述的 `route` 编码（dsh 是 `JSON.stringify([provider, model])`），与
   * `session/new` 给的当前值不同就 `set_config_option`；给了推理强度、且引擎有这个选项时也一样。返回最终的
   * `configOptions`。选不上（引擎没有这个 Provider 或模型，dsh 是 `-32602 unknown model option`）报 `invalid_input`。
   */
  async #selectRoute(
    engineSessionId: string,
    config: SessionConfig,
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
    if (currentOption(configOptions, route.modelOption) !== value) {
      await set(route.modelOption, value, ` ${config.providerId} 的模型 ${config.modelId}`);
    }
    const effort = config.reasoningEffort;
    const effortOption = route.reasoningEffortOption;
    if (
      effort !== undefined &&
      effortOption !== undefined &&
      currentOption(configOptions, effortOption) !== effort
    ) {
      await set(effortOption, effort, `推理强度 ${effort}`);
    }
    return configOptions;
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
      this.#cancelApprovals(session, 'engine_exited');
      session.turn = undefined;
      session.queue.exited({ type: 'engine.exited', engineSessionId: session.id, ...exit });
    }
  }

  /** 登记一个刚挂到本进程上的会话；之前的记录（已关闭或已脱开，事件队列已结束）被替换。 */
  #register(id: string, cwd: string): void {
    this.#sessions.set(id, {
      id,
      cwd,
      status: 'open',
      queue: new SessionEventQueue(id, this.#warnOnce, this.engine),
      approvals: new Map(),
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
