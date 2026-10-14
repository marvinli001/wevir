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
  type ApprovalCancelledEvent,
  type ApprovalDecision,
  type ApprovalOption,
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
  type TitleRequest,
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
  NO_REPLY,
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
  type ApprovalDecisionValue,
  type ApprovalRequestMethod,
  type ApprovalResponse,
  type CommandExecutionRequestApprovalParams,
  type FileChangeRequestApprovalParams,
  type RequestId,
  type ThreadResumeParams,
  type ThreadResumeResponse,
  type ThreadStartParams,
  type ThreadStartResponse,
  type ThreadUnsubscribeResponse,
  type TurnInterruptParams,
  type TurnStartParams,
  type TurnStartResponse,
} from './protocol.js';
import { classifyResumeError } from './resume-error.js';
import { lowestEffort, TITLE_THREAD_CONFIG, TitleCollector, titleViaGateway } from './title.js';

/**
 * `cancel` 等回合结算的时限。Spike 实测 `turn/interrupt` 之后 4–7 ms 结算（codex-notes §7.1）；Host 自己的取消时限是
 * 5 s，适配器先于它报 `cancel_unconfirmed`，并重启进程（与 adapter-acp 相同）。
 */
export const CANCEL_TIMEOUT_MS = 4000;

/**
 * `thread/resume` 遇到 thread 正在卸载（关闭后没有订阅者、空闲满 60 s，`thread … is closing`）时的重试：每次间隔
 * `RESUME_RETRY_DELAY_MS`，最多 `RESUME_RETRIES` 次。
 */
export const RESUME_RETRIES = 10;
export const RESUME_RETRY_DELAY_MS = 200;

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
  /**
   * 放在 app-server 自己的参数之前的参数。测试用：`binary` 是 node，这里是假的 app-server 脚本
   * （test-fixtures/fake-app-server.mjs）。
   */
  binaryArgs?: readonly string[];
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
  /** 旁听 app-server 的每一个服务端请求（到达时、处理之前同步调用）；录制测试样本用。 */
  onRawServerRequest?: (request: CodexServerRequest) => void;
  /**
   * `generateTitle` 走哪条路（codex-event-mapping.md §4.4）：`gateway` 经网关直接请求（经网关的会话），`thread` 用
   * Codex 的临时 thread（不经网关的会话，ChatGPT 登录在 R6）。R6 之前所有会话都经网关，默认 `gateway`；测试用
   * `thread` 覆盖另一条路。
   */
  titleVia?: 'gateway' | 'thread';
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

/** 一个未决审批：上报给 Host 的信息，与回复 app-server 的那个服务端请求。 */
interface PendingCodexApproval {
  readonly info: PendingApproval;
  /** app-server 的请求 id（`serverRequest/resolved` 带它）。 */
  readonly rpcId: RequestId;
  /** 兑现服务端请求的处理结果：`{decision}` 写回 app-server，`NO_REPLY` 不回。 */
  readonly reply: (result: unknown) => void;
}

interface CodexSession {
  readonly id: string;
  readonly cwd: string;
  readonly providerId: string;
  readonly model: ProviderModelConfig;
  /** open：挂在当前进程上；closed：已 close；detached：进程退出或重启后脱开（`resumeSession` 接回）。 */
  status: 'open' | 'closed' | 'detached';
  readonly hub: EventHub<AgentEvent>;
  readonly mapper: CodexEventMapper;
  turn?: Turn;
  /** Wevir 的 requestId → 未决审批。 */
  readonly approvals: Map<string, PendingCodexApproval>;
}

/**
 * 审批选项（codex-event-mapping.md §6.6）。`availableDecisions` 是实验字段拿不到，按 Codex 终端界面
 * （tui/src/bottom_pane/approval_overlay.rs 的 `exec_options` / `patch_options`）固定：`optionId` 就是回给 app-server 的
 * 决定；`kind` 以 `allow_` / `reject_` 开头决定批准与否，客户端不认识这些 kind，显示这里的中文 `label`。
 */
export const COMMAND_APPROVAL_OPTIONS: readonly ApprovalOption[] = Object.freeze([
  { optionId: 'accept', label: '是，继续', kind: 'allow_accept' },
  {
    optionId: 'acceptForSession',
    label: '是，本会话内这个命令不再问',
    kind: 'allow_accept_for_session',
  },
  { optionId: 'decline', label: '否，不运行并继续', kind: 'reject_decline' },
  // 中断回合：用户接着说该怎么做。
  { optionId: 'cancel', label: '否，告诉它换个做法', kind: 'reject_cancel' },
]);

export const FILE_CHANGE_APPROVAL_OPTIONS: readonly ApprovalOption[] = Object.freeze([
  { optionId: 'accept', label: '是', kind: 'allow_accept' },
  {
    optionId: 'acceptForSession',
    label: '是，这些文件本会话不再问',
    kind: 'allow_accept_for_session',
  },
  { optionId: 'cancel', label: '否，告诉它换个做法', kind: 'reject_cancel' },
]);

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
    const binaryArgs = this.#options.binaryArgs ?? [];
    const baseEnv = { codexHome: this.paths.codexHome, parent, rustLog: this.#options.rustLog };
    if (!this.#versionChecked) {
      await checkCodexVersion(binary, buildCodexEnv(baseEnv), binaryArgs);
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
      args: [...binaryArgs, '--strict-config'],
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
 * - **审批**（§6.6）：命令与补丁的审批请求 → `approval.requested`（选项固定，详情取同一 item 的工具），回复
 *   `{decision}`；app-server 自己结束的请求（`serverRequest/resolved`）、回合结束时仍未决的、取消与引擎退出时的
 *   都以 `approval.cancelled` 结束，不再回复。子 thread 的审批 R4 之前一律拒绝。
 * - **取消**（§4.1）：`turn/interrupt`，时限内回合没有结算就重启进程，挂着的会话以 `engine.exited`
 *   （`cancel_unconfirmed`）脱开，之后 `thread/resume` 到新进程上。
 * - **恢复**（§4.2）：`thread/resume`，失败按 `resume-error.ts` 归类（`session_lost` / `session_unavailable`）。
 * - **标题**（§4.4）：`generateTitle` 经网关（或临时 thread）用会话的模型发一次不带工具的请求。
 * - 子 thread 的事件按 engine.raw 挂在父会话上，R4 再做子会话。
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
  /** app-server 的请求 id → 未决审批所在的会话与 Wevir 的 requestId（当前进程的；进程退出时清空）。 */
  readonly #approvalsByRpc = new Map<RequestId, { session: CodexSession; requestId: string }>();
  /** 生成标题的临时 thread → 收它的通知。 */
  readonly #titleThreads = new Map<string, TitleCollector>();
  #providers = new Map<string, ProviderConfig>();
  #nextApproval = 0;
  #disposed: Promise<void> | undefined;
  #restart: Promise<void> | undefined;
  /** 进行中的 `createSession` / `resumeSession` / 临时 thread 数：有计划的重启要等它们完成。 */
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
      const params: ThreadStartParams = {
        cwd: config.cwd,
        ...this.#threadSettings(provider, model, config.reasoningEffort),
      };
      let response: ThreadStartResponse;
      try {
        response = await this.process.request<ThreadStartResponse>('thread/start', params);
      } catch (error) {
        throw engineError(error, 'thread/start');
      }
      const id = response.thread.id;
      this.#register(id, config.cwd, provider, model);
      return engineSession(id, response);
    } finally {
      this.#activating -= 1;
    }
  }

  /**
   * 把已关闭、或进程退出 / 重启后脱开的会话重新挂上：`thread/resume`（codex-event-mapping.md §4.2）。适配器不认识的
   * ID 也照样问 Codex（Host 重启后就是这样，会话只在 CODEX_HOME 的 rollout 里）。Provider、模型与推理强度按 `config`
   * 重新带上，与建会话相同；Codex 不回放历史给 Wevir（`excludeTurns`），模型的上下文由 rollout 恢复。已挂上时直接成功。
   * thread 正在卸载时稍后重试；其余失败按 `classifyResumeError` 归类。
   */
  async resumeSession(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    this.#assertUsable();
    if (!config.cwd) throw new AdapterError('invalid_input', 'cwd 不能为空');
    if (this.#sessions.get(engineSessionId)?.status === 'open') {
      return { engineSessionId, engineVersion: CODEX_VERSION };
    }
    const { provider, model } = this.#route(config);
    await this.process.start();
    await this.#applyConfigIfIdle();
    this.#assertUsable();
    this.#activating += 1;
    try {
      const params: ThreadResumeParams = {
        threadId: engineSessionId,
        cwd: config.cwd,
        ...this.#threadSettings(provider, model, config.reasoningEffort),
        excludeTurns: true,
      };
      const response = await this.#resumeThread(params);
      this.#register(engineSessionId, config.cwd, provider, model);
      return engineSession(engineSessionId, response);
    } finally {
      this.#activating -= 1;
    }
  }

  async #resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.process.request<ThreadResumeResponse>('thread/resume', params);
      } catch (error) {
        if (isAdapterError(error)) throw error;
        const classified = classifyResumeError(error);
        const { failure } = classified;
        if (failure.kind === 'closing' && attempt < RESUME_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, RESUME_RETRY_DELAY_MS));
          continue;
        }
        const message = `thread/resume 失败：${classified.message}`;
        switch (failure.kind) {
          case 'lost':
            throw new AdapterError('session_lost', `${message}（${failure.explanation}）`, {
              cause: error,
              lostReason: failure.reason,
            });
          case 'closing':
          case 'rejected':
            throw new AdapterError('session_unavailable', message, { cause: error });
          case 'unknown':
            throw new AdapterError('engine_unavailable', message, { cause: error });
        }
      }
    }
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

  /**
   * 回复一个未决审批：`{decision}`，决定就是所选选项的 `optionId`。先移出未决表再回复，同一请求只回复一次。
   * app-server 随后发 `serverRequest/resolved`（已经不在未决表里，忽略）。
   */
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
        `引擎会话 ${engineSessionId} 没有未决审批 ${requestId}`,
      );
    }
    const option = pending.info.options.find(
      (candidate) => candidate.optionId === decision.optionId,
    );
    if (option === undefined) {
      throw new AdapterError(
        'invalid_option',
        `审批 ${requestId} 没有选项 ${decision.optionId}（可选：${pending.info.options
          .map((candidate) => candidate.optionId)
          .join('、')}）`,
      );
    }
    session.approvals.delete(requestId);
    this.#approvalsByRpc.delete(pending.rpcId);
    pending.reply({
      decision: option.optionId as ApprovalDecisionValue,
    } satisfies ApprovalResponse);
  }

  async listPendingApprovals(engineSessionId?: string): Promise<PendingApproval[]> {
    this.#assertUsable();
    const sessions =
      engineSessionId === undefined
        ? [...this.#sessions.values()]
        : [this.#sessions.get(engineSessionId)].filter((session) => session !== undefined);
    return sessions.flatMap((session) =>
      [...session.approvals.values()].map(({ info }) => copyApproval(info)),
    );
  }

  /**
   * 发 `turn/interrupt`，等回合结算（Spike 实测 4–7 ms）。未决审批先以 `approval.cancelled`（`turn_cancelled`）结束、
   * 不再回复：app-server 中断回合时自己收回它们（`serverRequest/resolved`，在 `turn/completed` 之后才到）。幂等：
   * 没有回合、会话已关闭或不认识都直接成功。时限内等不到结算时重启进程（卡住的回合随旧进程结束，挂着的会话都以
   * `engine.exited`（`cancel_unconfirmed`）脱开，之后 resume 到新进程上），并报 `cancel_unconfirmed`。
   */
  async cancel(engineSessionId: string): Promise<void> {
    const session = this.#sessions.get(engineSessionId);
    const turn = session?.turn;
    if (session === undefined || turn === undefined) return;
    if (!turn.cancelRequested) {
      turn.cancelRequested = true;
      this.#endApprovals(session, 'turn_cancelled');
      // turn/start 的结果还没到时，等它到了再发（send 里）。
      if (turn.turnId !== undefined) this.#interrupt(session, turn);
    }
    if (!(await settledWithin(turn.done, this.#cancelTimeoutMs))) {
      if (session.turn === turn && this.#disposed === undefined) {
        this.#restartEngine('cancel_unconfirmed').catch((error: unknown) =>
          this.#logger.warn('取消得不到确认，重启 codex-app-server 失败', {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      throw new AdapterError(
        'cancel_unconfirmed',
        `发出 turn/interrupt 后 ${this.#cancelTimeoutMs} ms 内回合没有结算`,
      );
    }
  }

  /**
   * 关闭会话：有回合时先取消，再 `thread/unsubscribe`。app-server 的语义（thread_processor.rs
   * `thread_unsubscribe_response_inner`）：本连接不再收这个 thread 的通知；thread 没有订阅者且空闲满
   * `thread_unload_delay_secs`（默认 60 s）后才卸载，磁盘上的 rollout 保留，之后可以 `thread/resume`。
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
    this.#endApprovals(session, 'turn_cancelled');
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
        if (session.status === 'open') this.#endApprovals(session, 'disposed');
        session.turn?.settle();
        session.turn = undefined;
        session.hub.end();
      }
      this.#sessions.clear();
      this.#children.clear();
      this.#approvalsByRpc.clear();
      for (const collector of this.#titleThreads.values()) {
        collector.fail(new AdapterError('disposed', 'Codex 适配器已释放'));
      }
      this.#titleThreads.clear();
      await this.process.dispose();
      await this.#launcher.closeGateway();
    })();
    return this.#disposed;
  }

  // ── 会话标题 ───────────────────────────────────────────────────────────────────────────

  /**
   * 用会话的 Provider 与模型生成标题（codex-event-mapping.md §4.4），推理档位取最低。经网关的会话直接经网关请求；
   * `titleVia: 'thread'` 时用 Codex 的临时 thread（不经网关的会话用，R6）。
   */
  async generateTitle(engineSessionId: string, request: TitleRequest): Promise<string> {
    this.#assertUsable();
    const session = this.#openSession(engineSessionId);
    if (this.#options.titleVia === 'thread') return this.#titleViaThread(session, request);
    const gateway = this.#launcher.gateway;
    if (gateway === undefined) throw new AdapterError('engine_unavailable', '网关没有启动');
    return titleViaGateway(gateway, session.providerId, session.model, request);
  }

  /** 临时 thread：只读沙箱、审批 `never`、工具关掉，`turn/start` 带 `outputSchema`，取最终的助手消息。 */
  async #titleViaThread(session: CodexSession, request: TitleRequest): Promise<string> {
    const provider = this.#providers.get(session.providerId);
    const gateway = this.#launcher.gateway;
    if (provider === undefined || gateway === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        `生成标题：Provider ${session.providerId} 不可用`,
      );
    }
    this.#activating += 1;
    try {
      let started: ThreadStartResponse;
      try {
        started = await this.process.request<ThreadStartResponse>('thread/start', {
          cwd: session.cwd,
          model: session.model.id,
          modelProvider: codexProviderId(provider.id),
          approvalPolicy: 'never',
          sandbox: 'read-only',
          baseInstructions: request.instructions,
          ephemeral: true,
          config: {
            ...threadConfig(
              provider,
              session.model,
              gateway.baseURL(provider.id),
              undefined,
              this.#options.providerExtra,
            ),
            ...TITLE_THREAD_CONFIG,
          },
        } satisfies ThreadStartParams);
      } catch (error) {
        throw engineError(error, 'thread/start（生成标题）');
      }
      const threadId = started.thread.id;
      const collector = new TitleCollector();
      this.#titleThreads.set(threadId, collector);
      const abort = () => collector.fail(new AdapterError('engine_unavailable', '生成标题已取消'));
      request.signal?.addEventListener('abort', abort, { once: true });
      try {
        const effort = lowestEffort(session.model);
        await this.process.request<TurnStartResponse>('turn/start', {
          threadId,
          input: [{ type: 'text', text: request.input, text_elements: [] }],
          outputSchema: request.outputSchema,
          ...(effort !== undefined && { effort }),
        } satisfies TurnStartParams);
        return await collector.done;
      } catch (error) {
        throw engineError(error, 'turn/start（生成标题）');
      } finally {
        request.signal?.removeEventListener('abort', abort);
        this.#titleThreads.delete(threadId);
        await this.process
          .request<ThreadUnsubscribeResponse>('thread/unsubscribe', { threadId })
          .catch(() => {});
      }
    } finally {
      this.#activating -= 1;
    }
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
    if (method === 'serverRequest/resolved') {
      this.#onRequestResolved((params as Record<string, unknown>).requestId);
      return;
    }
    const title = this.#titleThreads.get(threadId);
    if (title !== undefined) {
      title.onNotification(method, params);
      return;
    }
    const session = this.#sessions.get(threadId);
    if (session?.status === 'open') {
      this.#deliver(session, method, params);
      return;
    }
    const parent = this.#parentOf(threadId);
    if (parent !== undefined) {
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

  /**
   * 一个服务端请求结束了。Wevir 回复过的（以及回合结束、取消时已经结掉的）不在表里，忽略；仍未决的是 app-server
   * 自己收回的，以 `approval.cancelled`（`turn_ended`）结束、不再回复。
   */
  #onRequestResolved(rpcId: unknown): void {
    if (typeof rpcId !== 'string' && typeof rpcId !== 'number') return;
    const entry = this.#approvalsByRpc.get(rpcId);
    if (entry === undefined) return;
    this.#endApproval(entry.session, entry.requestId, 'turn_ended');
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
      if (event.type === 'turn.settled' || event.type === 'turn.failed') {
        // 回合结束时仍未决的审批：app-server 之后才发 serverRequest/resolved，先在终结事件之前结掉。
        this.#endApprovals(session, 'turn_ended');
        session.hub.emit(event);
        session.turn = undefined;
        turn.settle();
        this.#afterTurn();
      } else {
        session.hub.emit(event);
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

  #parentOf(threadId: string): CodexSession | undefined {
    const parentId = this.#children.get(threadId);
    const parent = parentId === undefined ? undefined : this.#sessions.get(parentId);
    return parent?.status === 'open' ? parent : undefined;
  }

  /**
   * 服务端请求（codex-event-mapping.md §6.6）。命令与补丁的审批属于进行中的回合时上报为 `approval.requested`，
   * 等 `respondToApproval`；回合已开始取消时随即结掉。子 thread 的审批（R4 之前）、不属于进行中回合的审批回复
   * `decline`；其余请求（`request_user_input`、MCP 等）回复“不支持”。
   */
  #onServerRequest(request: CodexServerRequest): Promise<unknown> {
    this.#options.onRawServerRequest?.(request);
    if (!(APPROVAL_REQUESTS as readonly string[]).includes(request.method)) {
      return Promise.reject(
        Object.assign(new Error(`Wevir 不支持 ${request.method}`), { code: METHOD_NOT_FOUND }),
      );
    }
    const method = request.method as ApprovalRequestMethod;
    const params = request.params as
      | CommandExecutionRequestApprovalParams
      | FileChangeRequestApprovalParams;
    const decline = Promise.resolve({ decision: 'decline' } satisfies ApprovalResponse);
    if (
      !isRecord(params) ||
      typeof params.threadId !== 'string' ||
      typeof params.itemId !== 'string'
    ) {
      this.#warnOnce(`approval_shape:${method}`, 'Codex 的审批请求缺少字段，拒绝', { method });
      return decline;
    }
    const session = this.#sessions.get(params.threadId);
    if (session?.status !== 'open') {
      const parent = this.#parentOf(params.threadId);
      if (parent !== undefined) {
        parent.hub.emit(parent.mapper.raw(method, params, 'server_request'));
        this.#warnOnce(
          `child_approval:${method}`,
          '子 agent 请求审批：子会话在 R4 实现，在那之前一律拒绝',
          { method },
        );
      } else {
        this.#warnOnce(`unknown_approval:${method}`, '审批请求属于没有挂着的 thread，拒绝', {
          method,
          threadId: params.threadId,
        });
      }
      return decline;
    }
    const turn = session.turn;
    if (turn === undefined || (turn.turnId !== undefined && params.turnId !== turn.turnId)) {
      this.#logger.warn('审批请求不属于进行中的回合，拒绝', {
        engineSessionId: session.id,
        turnId: params.turnId,
      });
      return decline;
    }
    for (const event of session.mapper.approvalPrelude(method, params)) session.hub.emit(event);
    this.#nextApproval += 1;
    const info: PendingApproval = {
      engineSessionId: session.id,
      requestId: `codex-${this.#nextApproval}`,
      toolCallId: params.itemId,
      options: (method === 'item/commandExecution/requestApproval'
        ? COMMAND_APPROVAL_OPTIONS
        : FILE_CHANGE_APPROVAL_OPTIONS
      ).map((option) => ({ ...option })),
    };
    return new Promise<unknown>((reply) => {
      session.approvals.set(info.requestId, { info, rpcId: request.id, reply });
      this.#approvalsByRpc.set(request.id, { session, requestId: info.requestId });
      session.hub.emit({ type: 'approval.requested', ...copyApproval(info) });
      // 取消开始之后才到的请求：照常上报，随即结掉；app-server 中断回合时自己收回它。
      if (turn.cancelRequested) this.#endApproval(session, info.requestId, 'turn_cancelled');
    });
  }

  /** 结掉一个未决审批：不再回复 app-server（它已收回，或回合已中断、进程已退出），发 `approval.cancelled`。 */
  #endApproval(
    session: CodexSession,
    requestId: string,
    reason: ApprovalCancelledEvent['reason'],
  ): void {
    const pending = session.approvals.get(requestId);
    if (pending === undefined) return;
    session.approvals.delete(requestId);
    this.#approvalsByRpc.delete(pending.rpcId);
    pending.reply(NO_REPLY);
    session.hub.emit({
      type: 'approval.cancelled',
      engineSessionId: session.id,
      requestId,
      reason,
    });
  }

  #endApprovals(session: CodexSession, reason: ApprovalCancelledEvent['reason']): void {
    for (const requestId of [...session.approvals.keys()]) {
      this.#endApproval(session, requestId, reason);
    }
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

  /**
   * 挂着的会话全部脱开：未决审批以 `approval.cancelled`（`engine_exited`）结束，丢下进行中的回合，发
   * `engine.exited`（该会话订阅的最后一个事件）。生成标题的临时 thread 随进程一起没了。
   */
  #detachAll(exit: Omit<EngineExitedEvent, 'type' | 'engineSessionId'>): void {
    for (const session of this.#sessions.values()) {
      if (session.status !== 'open') continue;
      this.#endApprovals(session, 'engine_exited');
      session.status = 'detached';
      session.turn?.settle();
      session.turn = undefined;
      session.hub.emit({ type: 'engine.exited', engineSessionId: session.id, ...exit });
      session.hub.end();
    }
    this.#children.clear();
    this.#approvalsByRpc.clear();
    for (const collector of this.#titleThreads.values()) {
      collector.fail(new AdapterError('engine_unavailable', 'codex-app-server 已退出或正在重启'));
    }
    this.#titleThreads.clear();
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

  /** `thread/start` 与 `thread/resume` 共用的设置：模型、Provider、审批与沙箱、基础提示词、配置覆盖。 */
  #threadSettings(
    provider: ProviderConfig,
    model: ProviderModelConfig,
    reasoningEffort: string | undefined,
  ): Omit<ThreadStartParams, 'cwd'> {
    const gateway = this.#launcher.gateway;
    if (gateway === undefined) throw new AdapterError('engine_unavailable', '网关没有启动');
    return {
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
        reasoningEffort,
        this.#options.providerExtra,
      ),
    };
  }

  #register(id: string, cwd: string, provider: ProviderConfig, model: ProviderModelConfig): void {
    this.#sessions.set(id, {
      id,
      cwd,
      providerId: provider.id,
      model,
      status: 'open',
      hub: new EventHub<AgentEvent>(),
      mapper: new CodexEventMapper(id, { contextSize: () => model.contextWindow }),
      approvals: new Map(),
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

/** `thread/start` / `thread/resume` 的结果 → EngineSession。 */
function engineSession(id: string, response: ThreadStartResponse): EngineSession {
  return {
    engineSessionId: id,
    modelId: response.model,
    ...(response.reasoningEffort !== null &&
      response.reasoningEffort !== undefined && {
        reasoningEffort: fromCodexEffort(response.reasoningEffort),
      }),
    engineVersion: CODEX_VERSION,
  };
}

function copyApproval(info: PendingApproval): PendingApproval {
  return { ...info, options: info.options.map((option) => ({ ...option })) };
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
