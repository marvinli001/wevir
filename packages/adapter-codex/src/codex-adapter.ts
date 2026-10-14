import {
  type ModelGateway,
  type ModelGatewayOptions,
  startModelGateway,
  testProvider,
  validateProvider,
} from '@wevir/model-gateway';
import {
  AdapterError,
  type AgentEvent,
  type AgentInput,
  type AgentRuntimeAdapter,
  type ApprovalDecision,
  type EngineExitedEvent,
  type EngineSession,
  EventHub,
  isAdapterError,
  type PendingApproval,
  type ProviderConfig,
  type ProviderIssue,
  type ProviderModelConfig,
  type ProviderTestResult,
  type SessionConfig,
} from '@wevir/runtime-adapter';
import {
  type CodexExit,
  type CodexLauncher,
  CodexProcess,
  CodexRpcError,
  type CodexServerRequest,
  type CodexSpawnSpec,
  type DisposeTimeouts,
  METHOD_NOT_FOUND,
  type RestartPolicy,
  settledWithin,
} from './codex-process.js';
import {
  basePromptVars,
  codexProviderId,
  fromCodexEffort,
  renderConfigToml,
  renderModelCatalog,
  threadConfig,
  writeCodexConfig,
} from './config.js';
import { buildCodexEnv } from './env.js';
import { CodexEventMapper, isRecord } from './mapping.js';
import {
  CODEX_VERSION,
  type CodexPaths,
  checkCodexVersion,
  codexPaths,
  prepareCodexHome,
  resolveCodexBinary,
} from './paths.js';
import { BasePrompt, defaultPromptsDir } from './prompts.js';
import {
  APPROVAL_REQUESTS,
  type ApprovalResponse,
  type ThreadStartParams,
  type ThreadStartResponse,
  type ThreadUnsubscribeResponse,
  type TurnInterruptParams,
  type TurnStartParams,
  type TurnStartResponse,
} from './protocol.js';

/**
 * `cancel` 等回合结算的时限。Spike 实测 `turn/interrupt` 之后 4–7 ms 结算（codex-notes §7.1）；Host 自己的取消时限是
 * 5 s，适配器先于它报 `cancel_unconfirmed`（与 adapter-acp 相同）。
 */
export const CANCEL_TIMEOUT_MS = 4000;

/** 告警与日志出口；Host 的 Logger 满足这个接口（`info` 给网关的请求日志，`addSecret` 登记网关令牌）。 */
export interface CodexAdapterLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
  /** 登记要从日志里抹掉的值（网关令牌，每次启动进程换一个）。 */
  addSecret?(value: string): void;
}

export interface CodexAdapterOptions {
  /** Wevir 数据目录（绝对路径）；Codex 用其中的 `engines/codex`（`CODEX_HOME`）。 */
  home: string;
  /** codex-app-server 可执行文件，默认 `resolveCodexBinary()`（`WEVIR_CODEX_BIN` → 开发缓存）。 */
  binary?: string;
  /** `initialize` 的 `clientInfo`：`name` 默认 `wevir`，`version` 写 Host 版本。 */
  clientInfo?: { name: string; version: string };
  logger?: CodexAdapterLogger;
  /** 启动前就已知的 Provider，等同构造后立即 `configureProviders`。 */
  providers?: readonly ProviderConfig[];
  /** Wevir 提示词目录，默认仓库的 `prompts/`（`defaultPromptsDir()`）。 */
  promptsDir?: string;
  /** 环境变量的继承来源，默认 `process.env`。 */
  parentEnv?: NodeJS.ProcessEnv;
  /** 网关的选项（测试把 DeepSeek 的地址指向 mock）；日志用 `logger`。 */
  gateway?: Omit<ModelGatewayOptions, 'logger'>;
  /** `testProvider` 的选项（测试注入 fetch、缩短时限）。 */
  providerTest?: Parameters<typeof testProvider>[2];
  /** 每个 `[model_providers.*]` 额外的键（测试把 `request_max_retries` 等设成 0，不让重试拖慢失败用例）。 */
  providerExtra?: Readonly<Record<string, unknown>>;
  /** 子进程的 `RUST_LOG`，默认 `warn`。 */
  rustLog?: string;
  /** 旁听 app-server 的每一条原始通知（在映射之前，按到达顺序同步调用）；录制测试样本用。 */
  onRawNotification?: (method: string, params: unknown) => void;
  cancelTimeoutMs?: number;
  initializeTimeoutMs?: number;
  restart?: Partial<RestartPolicy>;
  disposeTimeouts?: Partial<DisposeTimeouts>;
}

interface Turn {
  /** `turn/start` 的结果到了才有。 */
  turnId?: string;
  cancelRequested: boolean;
  /** 回合结算（终结事件已发出，或会话脱开）时兑现，永不 reject。 */
  done: Promise<void>;
  settle: () => void;
}

interface CodexSession {
  readonly id: string;
  readonly cwd: string;
  /** open：挂在当前进程上；closed：已 close；detached：进程退出或重启后脱开（R3 的 resume 才能接回）。 */
  status: 'open' | 'closed' | 'detached';
  readonly hub: EventHub<AgentEvent>;
  readonly mapper: CodexEventMapper;
  turn?: Turn;
}

/**
 * 启动器：每次启动 codex-app-server 之前建好 `CODEX_HOME`、解析并核对二进制、新建网关实例（令牌随之换新，
 * ADR-0005 决策 2.2 与补记 3）、按当前的 Provider 写 config.toml 与模型目录，再给出 spawn 参数。
 */
class Launcher implements CodexLauncher {
  readonly paths: CodexPaths;
  readonly #options: CodexAdapterOptions;
  readonly #logger: CodexAdapterLogger;
  readonly #prompt: BasePrompt;
  providers: readonly ProviderConfig[] = [];
  gateway: ModelGateway | undefined;
  /** 当前进程启动时用的模型目录（判断目录是否过期）。 */
  launchedCatalog: string | undefined;
  #binary: string | undefined;
  #versionChecked = false;

  constructor(options: CodexAdapterOptions, logger: CodexAdapterLogger, prompt: BasePrompt) {
    this.paths = codexPaths(options.home);
    this.#options = options;
    this.#logger = logger;
    this.#prompt = prompt;
  }

  catalog(): string | undefined {
    return renderModelCatalog(this.providers, (vars) => this.#prompt.render(vars));
  }

  async prepare(): Promise<CodexSpawnSpec> {
    prepareCodexHome(this.paths);
    const parent = this.#options.parentEnv;
    this.#binary ??= this.#options.binary ?? resolveCodexBinary({ env: parent });
    const binary = this.#binary;
    const baseEnv = { codexHome: this.paths.codexHome, parent, rustLog: this.#options.rustLog };
    if (!this.#versionChecked) {
      await checkCodexVersion(binary, buildCodexEnv(baseEnv));
      this.#versionChecked = true;
    }
    // 旧进程此时已经停了（重启先回收再启动），它的网关一起关掉。
    await this.closeGateway();
    const gateway = await startModelGateway({
      ...this.#options.gateway,
      logger: gatewayLogger(this.#logger),
    });
    this.gateway = gateway;
    this.#logger.addSecret?.(gateway.token);
    gateway.setProviders(this.providers);
    const catalog = this.catalog();
    writeCodexConfig(
      this.paths,
      renderConfigToml({
        providers: this.providers,
        gatewayBaseURL: (id) => gateway.baseURL(id),
        ...(catalog !== undefined && { catalogFile: this.paths.catalogFile }),
        providerExtra: this.#options.providerExtra,
      }),
      catalog,
    );
    this.launchedCatalog = catalog;
    const windows = process.platform === 'win32';
    return {
      command: binary,
      // --strict-config：配置里有不认识的键就启动失败（codex-notes §2.1），加固项写错不会悄悄失效。
      args: ['--strict-config'],
      options: {
        // cwd 是 CODEX_HOME，不是用户工作区（决策 5）。
        cwd: this.paths.codexHome,
        env: buildCodexEnv({ ...baseEnv, gatewayToken: gateway.token }),
        stdio: ['pipe', 'pipe', 'pipe'],
        // POSIX 上自成进程组：终端的 Ctrl-C 只到 Host；回收时信号发给整个组。Windows 上不分离（会开新控制台）。
        detached: !windows,
        windowsHide: true,
      },
    };
  }

  async closeGateway(): Promise<void> {
    const gateway = this.gateway;
    this.gateway = undefined;
    await gateway?.close();
  }
}

/**
 * Codex 的 `AgentRuntimeAdapter`（ADR-0005 决策 1.1，docs/architecture/codex-event-mapping.md）：一个
 * codex-app-server 进程承载全部会话，一个 Wevir 会话对应一个 thread，`threadId` 即 `engineSessionId`。
 *
 * R2 的范围：进程、配置、会话、回合与流式事件。审批（R2 一律以 decline 回复并告警）、取消得不到确认时的重启、
 * 恢复（`resumeSession` 报 `session_unavailable`）留给 R3；子 thread 的事件按 engine.raw 挂在父会话上，R4 再做子会话。
 *
 * Provider（§5）：所有 Provider 都经网关（决策 2.2）。网关实例由本适配器在 Host 进程里创建并持有，每次启动
 * codex-app-server 新建一个（令牌随之换新）；`configureProviders` 立即交给运行中的网关（上游地址、Key、协议的变化
 * 不需要重启 Codex）。会话的 Provider 条目经 `thread/start` 的 `config` 覆盖带上，新增的 Provider 也不需要重启；
 * 只有模型目录变了（新增模型、上下文大小或推理档位变了）才要重启，因为 Codex 只在启动时读一次目录：空闲时立即重启，
 * 有回合时等最后一个回合结束，挂着的会话以 `engine.exited`（`config_changed`）脱开。
 */
export class CodexAdapter implements AgentRuntimeAdapter {
  readonly process: CodexProcess;
  readonly paths: CodexPaths;
  readonly #launcher: Launcher;
  readonly #prompt: BasePrompt;
  readonly #options: CodexAdapterOptions;
  readonly #logger: CodexAdapterLogger;
  readonly #warned = new Set<string>();
  readonly #cancelTimeoutMs: number;
  readonly #sessions = new Map<string, CodexSession>();
  /** 子 thread → 父会话（从 collabAgentToolCall 的 receiverThreadIds 得知）。 */
  readonly #children = new Map<string, string>();
  #providers = new Map<string, ProviderConfig>();
  #disposed: Promise<void> | undefined;
  #restart: Promise<void> | undefined;
  /** 进行中的 `createSession` 数：有计划的重启要等它们完成，否则会话会挂在被回收的进程上。 */
  #activating = 0;

  constructor(options: CodexAdapterOptions) {
    this.#options = options;
    this.#logger = options.logger ?? stderrLogger();
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
    this.#prompt = new BasePrompt(options.promptsDir ?? defaultPromptsDir());
    this.#launcher = new Launcher(options, this.#logger, this.#prompt);
    this.paths = this.#launcher.paths;
    this.process = new CodexProcess({
      launcher: this.#launcher,
      clientInfo: options.clientInfo ?? { name: 'wevir', version: '0.0.0' },
      onNotification: (method, params) => this.#onNotification(method, params),
      onServerRequest: (request) => this.#onServerRequest(request),
      initializeTimeoutMs: options.initializeTimeoutMs,
      restart: options.restart,
      disposeTimeouts: options.disposeTimeouts,
    });
    this.process.on('exit', (exit) => this.#onExit(exit));
    this.process.on('restarting', ({ attempt, maxRestarts, delayMs }) =>
      this.#logger.warn(
        `codex-app-server 将在 ${delayMs} ms 后重启（第 ${attempt}/${maxRestarts} 次）`,
      ),
    );
    this.process.on('failed', ({ restarts }) =>
      this.#logger.warn(`codex-app-server 连续重启 ${restarts} 次仍失败，停止重启`),
    );
    if (options.providers !== undefined) this.#setProviders(options.providers);
  }

  /** 当前网关（进程运行时才有）。 */
  get gateway(): ModelGateway | undefined {
    return this.#launcher.gateway;
  }

  /** 适配器记得的会话数（含已关闭、已脱开的）。 */
  get sessionCount(): number {
    return this.#sessions.size;
  }

  // ── 会话与回合 ─────────────────────────────────────────────────────────────────────────

  async createSession(config: SessionConfig): Promise<EngineSession> {
    this.#assertUsable();
    if (!config.cwd) throw new AdapterError('invalid_input', 'cwd 不能为空');
    const { provider, model } = this.#route(config);
    await this.process.start();
    await this.#applyConfigIfIdle();
    this.#assertUsable();
    this.#activating += 1;
    try {
      const gateway = this.#launcher.gateway;
      if (gateway === undefined) throw new AdapterError('engine_unavailable', '网关没有启动');
      const params: ThreadStartParams = {
        cwd: config.cwd,
        model: model.id,
        modelProvider: codexProviderId(provider.id),
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        // 经网关的第三方模型用 Wevir 的 base.md（补记 2），按会话的 Provider 与模型渲染；模型目录里同名模型只有一条，
        // 这里覆盖保证显示名是这个 Provider 的。ChatGPT 登录的 OpenAI 模型（R6）不覆盖。
        baseInstructions: this.#prompt.render(basePromptVars(provider, model)),
        config: threadConfig(
          provider,
          model,
          gateway.baseURL(provider.id),
          config.reasoningEffort,
          this.#options.providerExtra,
        ),
      };
      let response: ThreadStartResponse;
      try {
        response = await this.process.request<ThreadStartResponse>('thread/start', params);
      } catch (error) {
        throw engineError(error, 'thread/start');
      }
      const id = response.thread.id;
      this.#register(id, config.cwd, model);
      return {
        engineSessionId: id,
        modelId: response.model,
        ...(response.reasoningEffort !== null &&
          response.reasoningEffort !== undefined && {
            reasoningEffort: fromCodexEffort(response.reasoningEffort),
          }),
        engineVersion: CODEX_VERSION,
      };
    } finally {
      this.#activating -= 1;
    }
  }

  /** R3 实现（`thread/resume`）。在那之前报 `session_unavailable`：Host 记一条引擎错误，不把会话标成只读。 */
  async resumeSession(engineSessionId: string, _config: SessionConfig): Promise<EngineSession> {
    this.#assertUsable();
    if (this.#sessions.get(engineSessionId)?.status === 'open') {
      return { engineSessionId, engineVersion: CODEX_VERSION };
    }
    throw new AdapterError(
      'session_unavailable',
      'Codex 引擎暂不支持恢复会话（R3 实现 thread/resume）；请基于历史新建会话',
    );
  }

  subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    this.#assertUsable();
    return this.#openSession(engineSessionId).hub.subscribe();
  }

  async send(engineSessionId: string, input: AgentInput): Promise<void> {
    this.#assertUsable();
    const session = this.#openSession(engineSessionId);
    if (session.turn !== undefined) throw new AdapterError('session_busy', '会话有进行中的回合');
    if (input.content.length === 0) throw new AdapterError('invalid_input', 'content 不能为空');
    let settle!: () => void;
    const turn: Turn = {
      cancelRequested: false,
      done: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      settle: () => settle(),
    };
    session.turn = turn;
    session.mapper.reset();
    const params: TurnStartParams = {
      threadId: engineSessionId,
      input: input.content.map((part) => ({ type: 'text', text: part.text, text_elements: [] })),
    };
    let response: TurnStartResponse;
    try {
      // turn/start 立即返回（codex-notes §2.2），正好是 send 的语义：引擎接受输入就返回。
      response = await this.process.request<TurnStartResponse>('turn/start', params);
    } catch (error) {
      if (session.turn === turn) {
        session.turn = undefined;
        turn.settle();
      }
      throw engineError(error, 'turn/start');
    }
    turn.turnId = response.turn.id;
    if (turn.cancelRequested && session.turn === turn) this.#interrupt(session, turn);
  }

  async respondToApproval(
    engineSessionId: string,
    requestId: string,
    _decision: ApprovalDecision,
  ): Promise<void> {
    this.#assertUsable();
    this.#session(engineSessionId);
    // R2 不上报审批（一律 decline），所以没有未决审批。
    throw new AdapterError(
      'approval_not_found',
      `引擎会话 ${engineSessionId} 没有未决审批 ${requestId}（Codex 的审批在 R3 实现）`,
    );
  }

  async listPendingApprovals(_engineSessionId?: string): Promise<PendingApproval[]> {
    this.#assertUsable();
    return [];
  }

  /**
   * 发 `turn/interrupt`，等回合结算（Spike 实测 4–7 ms）。幂等：没有回合、会话已关闭或不认识都直接成功。
   * 时限内等不到时报 `cancel_unconfirmed`；那时重启进程让会话可以恢复是 R3 的事。
   */
  async cancel(engineSessionId: string): Promise<void> {
    const session = this.#sessions.get(engineSessionId);
    const turn = session?.turn;
    if (session === undefined || turn === undefined) return;
    if (!turn.cancelRequested) {
      turn.cancelRequested = true;
      // turn/start 的结果还没到时，等它到了再发（send 里）。
      if (turn.turnId !== undefined) this.#interrupt(session, turn);
    }
    if (!(await settledWithin(turn.done, this.#cancelTimeoutMs))) {
      throw new AdapterError(
        'cancel_unconfirmed',
        `发出 turn/interrupt 后 ${this.#cancelTimeoutMs} ms 内回合没有结算`,
      );
    }
  }

  /**
   * 关闭会话：有回合时先取消，再 `thread/unsubscribe`。app-server 的语义（thread_processor.rs
   * `thread_unsubscribe_response_inner`）：本连接不再收这个 thread 的通知；thread 没有订阅者且空闲满
   * `thread_unload_delay_secs`（默认 60 s）后才卸载，磁盘上的 rollout 保留，之后可以 `thread/resume`（R3）。
   */
  async close(engineSessionId: string): Promise<void> {
    this.#assertUsable();
    const session = this.#session(engineSessionId);
    if (session.status === 'closed') return;
    await this.cancel(engineSessionId);
    if (session.status === 'open' && this.process.state === 'ready') {
      try {
        await this.process.request<ThreadUnsubscribeResponse>('thread/unsubscribe', {
          threadId: engineSessionId,
        });
      } catch (error) {
        if (isAdapterError(error, 'disposed')) throw error;
        // 引擎侧已经没有这个 thread 等：不阻止关闭（domain-model.md §4.1 #13）。
        this.#logger.warn('thread/unsubscribe 失败，按已关闭处理', {
          engineSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    session.status = 'closed';
    session.turn?.settle();
    session.turn = undefined;
    session.hub.end();
    for (const [child, parent] of this.#children) {
      if (parent === engineSessionId) this.#children.delete(child);
    }
  }

  dispose(): Promise<void> {
    this.#disposed ??= (async () => {
      for (const session of this.#sessions.values()) {
        session.turn?.settle();
        session.turn = undefined;
        session.hub.end();
      }
      this.#sessions.clear();
      this.#children.clear();
      await this.process.dispose();
      await this.#launcher.closeGateway();
    })();
    return this.#disposed;
  }

  // ── Provider ──────────────────────────────────────────────────────────────────────────

  /** 网关处理不了的配置（协议、地址、compat 开关）；模型列表不能为空。 */
  validateProvider(provider: ProviderConfig): ProviderIssue[] {
    const issues = validateProvider(provider);
    if (provider.models.length === 0)
      issues.push({ path: ['models'], message: '至少要有一个模型' });
    return issues;
  }

  /**
   * 换上整套 Provider：交给运行中的网关（立即生效，进行中的请求用开始时的配置），记下来供之后的 `thread/start`
   * 与启动用。模型目录变了而进程在运行时，空闲就重启（返回时新进程已就绪），有回合就等最后一个回合结束。
   * 不合法的 Provider 抛 `invalid_input`（Host 应先 `validateProvider`），此时什么都不改。
   */
  async configureProviders(providers: readonly ProviderConfig[]): Promise<void> {
    this.#assertUsable();
    this.#setProviders(providers);
    await this.#applyConfigIfIdle();
  }

  /** provider.test：网关的 `testProvider`，与正式请求同样的处理方式（决策 2.5）。 */
  testProvider(provider: ProviderConfig, modelId: string): Promise<ProviderTestResult> {
    return testProvider(provider, modelId, {
      ...(this.#options.gateway?.deepseekBaseURL !== undefined && {
        deepseekBaseURL: this.#options.gateway.deepseekBaseURL,
      }),
      ...this.#options.providerTest,
    });
  }

  #setProviders(providers: readonly ProviderConfig[]): void {
    for (const provider of providers) {
      const issues = this.validateProvider(provider);
      if (issues.length > 0) {
        throw new AdapterError(
          'invalid_input',
          `Provider ${provider.id}：${issues.map((i) => `${i.path.join('.')}：${i.message}`).join('；')}`,
        );
      }
    }
    // 先渲染一次目录：base.md 渲染失败（变量缺失等）在这里就报出来。
    const next = [...providers];
    renderModelCatalog(next, (vars) => this.#prompt.render(vars));
    this.#providers = new Map(next.map((provider) => [provider.id, provider]));
    this.#launcher.providers = next;
    this.#launcher.gateway?.setProviders(next);
  }

  /** 运行中的进程用的模型目录过期了：启动之后 Provider 的模型变了。 */
  get #catalogStale(): boolean {
    return (
      this.process.state === 'ready' && this.#launcher.launchedCatalog !== this.#launcher.catalog()
    );
  }

  /** 模型目录过期且空闲（没有回合、没有进行中的 createSession）时重启；有进行中的重启时等它。 */
  async #applyConfigIfIdle(): Promise<void> {
    if (this.#restart !== undefined) return this.#restart;
    if (!this.#catalogStale) return;
    if (this.#busy) return;
    return this.#restartEngine('config_changed');
  }

  get #busy(): boolean {
    return (
      this.#activating > 0 ||
      [...this.#sessions.values()].some((session) => session.turn !== undefined)
    );
  }

  /** 有计划地重启：挂着的会话先全部脱开（发 `engine.exited`），再回收旧进程、启动新进程。 */
  #restartEngine(reason: NonNullable<EngineExitedEvent['reason']>): Promise<void> {
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

  // ── 通知与服务端请求 ───────────────────────────────────────────────────────────────────

  #onNotification(method: string, params: unknown): void {
    this.#options.onRawNotification?.(method, params);
    const threadId =
      isRecord(params) && typeof params.threadId === 'string' ? params.threadId : undefined;
    if (threadId === undefined) {
      this.#onGlobalNotification(method, params);
      return;
    }
    const session = this.#sessions.get(threadId);
    if (session?.status === 'open') {
      this.#deliver(session, method, params);
      return;
    }
    const parentId = this.#children.get(threadId);
    const parent = parentId === undefined ? undefined : this.#sessions.get(parentId);
    if (parent?.status === 'open') {
      // 子 thread（子 agent，codex-notes §2.4）：R4 之前按 engine.raw 挂在父会话上；增量太多，不保留。
      if (!/delta$/i.test(method)) {
        parent.hub.emit(parent.mapper.raw(method, params, 'child_thread'));
      }
      return;
    }
    if (method !== 'thread/started' && method !== 'thread/status/changed') {
      this.#warnOnce(
        `unknown_thread:${method}`,
        'codex-app-server 的通知属于没有挂着的 thread，丢弃',
        {
          method,
          threadId,
        },
      );
    }
  }

  /** 不属于任何 thread 的通知：告警类写日志，其余（账号、限额、远程控制等）忽略（codex-notes §6.4）。 */
  #onGlobalNotification(method: string, params: unknown): void {
    if (method === 'warning' || method === 'configWarning' || method === 'deprecationNotice') {
      const text = isRecord(params) && typeof params.message === 'string' ? params.message : '';
      this.#warnOnce(`${method}:${text}`, `codex-app-server ${method}`, {
        params: JSON.stringify(params)?.slice(0, 1000),
      });
    }
  }

  #deliver(session: CodexSession, method: string, params: unknown): void {
    this.#trackChildren(session, method, params);
    const turn = session.turn;
    // 不属于进行中回合的通知（上一个回合迟到的、或根本没有回合）：只保留 engine.raw 与用量（events.ts 的顺序约定）。
    const turnId = notificationTurnId(params);
    const stale =
      turn === undefined ||
      (turn.turnId !== undefined && turnId !== undefined && turnId !== turn.turnId);
    if (stale) {
      // 用量的映射不读回合状态；其余一律原样保留。
      const events =
        method === 'thread/tokenUsage/updated'
          ? session.mapper.map(method, params)
          : [session.mapper.raw(method, params)];
      for (const event of events) session.hub.emit(event);
      return;
    }
    for (const event of session.mapper.map(method, params)) {
      session.hub.emit(event);
      if (event.type === 'turn.settled' || event.type === 'turn.failed') {
        session.turn = undefined;
        turn.settle();
        this.#afterTurn();
      }
    }
  }

  /** 父会话里 collabAgentToolCall 的 receiverThreadIds 是子 thread（codex-notes §2.4）。 */
  #trackChildren(session: CodexSession, method: string, params: unknown): void {
    if (method !== 'item/started' && method !== 'item/completed') return;
    const item = isRecord(params) ? params.item : undefined;
    if (!isRecord(item) || item.type !== 'collabAgentToolCall') return;
    const receivers = item.receiverThreadIds;
    if (!Array.isArray(receivers)) return;
    for (const child of receivers) {
      if (typeof child === 'string' && !this.#sessions.has(child)) {
        this.#children.set(child, session.id);
      }
    }
  }

  /**
   * 服务端请求。审批（R3）在 R2 一律以 decline 回复，并在会话里留一条 engine.raw、在日志里告警一次：工作区内的补丁与
   * 沙箱内的命令不需要审批（codex-notes §2.3），只有越出沙箱的操作会被拒绝。其余请求（request_user_input、MCP 等）
   * 回复“不支持”。
   */
  async #onServerRequest(request: CodexServerRequest): Promise<unknown> {
    if ((APPROVAL_REQUESTS as readonly string[]).includes(request.method)) {
      const threadId = isRecord(request.params) ? request.params.threadId : undefined;
      const session = typeof threadId === 'string' ? this.#sessions.get(threadId) : undefined;
      session?.hub.emit(session.mapper.raw(request.method, request.params, 'server_request'));
      this.#warnOnce(
        `approval:${request.method}`,
        'Codex 请求审批：R2 还没有实现审批，一律拒绝（R3 实现）',
        { method: request.method },
      );
      return { decision: 'decline' } satisfies ApprovalResponse;
    }
    throw Object.assign(new Error(`Wevir 不支持 ${request.method}`), { code: METHOD_NOT_FOUND });
  }

  #interrupt(session: CodexSession, turn: Turn): void {
    if (turn.turnId === undefined) return;
    const params: TurnInterruptParams = { threadId: session.id, turnId: turn.turnId };
    this.process.request('turn/interrupt', params).catch((error: unknown) =>
      this.#logger.warn('turn/interrupt 失败', {
        engineSessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /** 回合结算之后：等回合结束的配置重启（configureProviders 时有回合在跑）。 */
  #afterTurn(): void {
    if (!this.#catalogStale || this.#busy) return;
    this.#applyConfigIfIdle().catch((error: unknown) =>
      this.#logger.warn('为应用新的 Provider 配置重启 codex-app-server 失败', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  #onExit(exit: CodexExit): void {
    this.#detachAll({
      exitCode: exit.exitCode,
      signal: exit.signal,
      ...(exit.stderrTail !== '' && { stderrTail: exit.stderrTail.slice(-4000) }),
    });
  }

  /** 挂着的会话全部脱开：丢下进行中的回合，发 `engine.exited`（该会话订阅的最后一个事件）。 */
  #detachAll(exit: Omit<EngineExitedEvent, 'type' | 'engineSessionId'>): void {
    for (const session of this.#sessions.values()) {
      if (session.status !== 'open') continue;
      session.status = 'detached';
      session.turn?.settle();
      session.turn = undefined;
      session.hub.emit({ type: 'engine.exited', engineSessionId: session.id, ...exit });
      session.hub.end();
    }
    this.#children.clear();
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────────────────

  /** 会话的 Provider 与模型；选不上报 `invalid_input`（与 dsh 选不上路由时相同）。 */
  #route(config: SessionConfig): { provider: ProviderConfig; model: ProviderModelConfig } {
    const provider = this.#providers.get(config.providerId);
    if (provider === undefined) {
      throw new AdapterError(
        'invalid_input',
        `Codex 没有 Provider ${config.providerId}（Provider 配置里有没有它？）`,
      );
    }
    const model = provider.models.find((candidate) => candidate.id === config.modelId);
    if (model === undefined) {
      throw new AdapterError(
        'invalid_input',
        `Provider ${config.providerId} 没有模型 ${config.modelId}`,
      );
    }
    return { provider, model };
  }

  #register(id: string, cwd: string, model: ProviderModelConfig): void {
    this.#sessions.set(id, {
      id,
      cwd,
      status: 'open',
      hub: new EventHub<AgentEvent>(),
      mapper: new CodexEventMapper(id, { contextSize: () => model.contextWindow }),
    });
  }

  #session(engineSessionId: string): CodexSession {
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `不认识的引擎会话 ${engineSessionId}`);
    }
    return session;
  }

  #openSession(engineSessionId: string): CodexSession {
    const session = this.#session(engineSessionId);
    if (session.status !== 'open') {
      throw new AdapterError(
        'session_closed',
        `引擎会话 ${engineSessionId} 没有挂着（${session.status}）`,
      );
    }
    return session;
  }

  #assertUsable(): void {
    if (this.#disposed !== undefined) throw new AdapterError('disposed', 'Codex 适配器已释放');
  }

  #warnOnce(key: string, message: string, fields?: Record<string, unknown>): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#logger.warn(message, fields);
  }
}

/** 通知所属的回合：多数通知带 `turnId`，`turn/*` 带 `turn.id`。 */
function notificationTurnId(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  if (typeof params.turnId === 'string') return params.turnId;
  const turn = params.turn;
  return isRecord(turn) && typeof turn.id === 'string' ? turn.id : undefined;
}

/** 请求失败 → AdapterError：参数错误（-32602、-32600）是 `invalid_input`，其余是 `engine_unavailable`。 */
function engineError(error: unknown, method: string): AdapterError {
  if (isAdapterError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof CodexRpcError ? error.code : undefined;
  return new AdapterError(
    code === -32602 || code === -32600 ? 'invalid_input' : 'engine_unavailable',
    `${method} 失败：${message}`,
    { cause: error },
  );
}

function gatewayLogger(logger: CodexAdapterLogger): NonNullable<ModelGatewayOptions['logger']> {
  return {
    info: (message, fields) => logger.info?.(message, fields),
    warn: (message, fields) => logger.warn(message, fields),
  };
}

/** 默认的告警出口：写 stderr。 */
function stderrLogger(): CodexAdapterLogger {
  return {
    warn: (message, fields) =>
      process.stderr.write(
        `[adapter-codex] ${message}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}\n`,
      ),
  };
}
