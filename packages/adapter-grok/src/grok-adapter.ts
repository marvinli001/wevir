// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-grok/src/server/adapter.ts（`registerGrokAskUserQuestionExtensions`、`registerGrokExitPlanModeExtensions`、`grokLaunchRuntimeMode`、`GrokProviderCapabilitiesV2` 的会话能力）、packages/provider-grok/src/server/xaiAcpExtension.ts（`makeXAiPromptCompletionRuntime`：`session/prompt` 带 `promptId`，与 `prompt_complete` 竞速）、packages/provider-grok/src/server/acpSupport.ts（`resolveGrokAuthMethodId`）、packages/provider-acp/src/server/AcpSessionRuntime.ts（`authenticateAfterRequired`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS，建在 `@wevir/adapter-acp` 的 `AcpAdapter` 上；T3 每个会话一个 `grok` 进程，Wevir 每种
// 权限模式一个、承载这种模式的全部会话；会话中途换权限模式时在下一次发消息前关掉旧进程里的会话、在新模式的进程里
// `session/resume`（T3 不允许中途换）；不做 T3 的后台任务、子 agent、计划卡片、斜杠命令与对话压缩。
//
// Grok Build 的适配器（grok-event-mapping.md）。Grok 的权限模式只能在启动时用参数给（xai.ts 的 `grokSpawnArgs`），所以这里
// 按权限模式各开一个 `GrokModeAdapter`（一个 `grok agent stdio` 进程，`AcpAdapter` 的子类），会话交给它所在模式的那个。
// Host 订阅的是这里的每会话事件流：换模式时会话从一个进程挪到另一个，Host 的订阅不断。

import { randomUUID } from 'node:crypto';
import {
  AcpAdapter,
  AcpProcess,
  type AcpProcessOptions,
  type AdapterLogger,
} from '@wevir/adapter-acp';
import type { McpServer } from '@wevir/adapter-acp/sdk';
import {
  AdapterError,
  type AgentEvent,
  type AgentInput,
  type AgentRuntimeAdapter,
  type ApprovalDecision,
  type EngineSession,
  EventHub,
  type PendingApproval,
  type PermissionMode,
  type SessionConfig,
} from '@wevir/runtime-adapter';
import type { AppToolsBridge } from '@wevir/runtime-adapter/app-tools-bridge';
import {
  HISTORY_TOOL_SERVER,
  type HistoryToolServer,
  historyToolCommand,
  writeHistoryToolScript,
} from '@wevir/runtime-adapter/history-tool';
import { GrokAccounts, type GrokAccountsOptions } from './accounts.js';
import { agentVersionOf, GROK_ENGINE, isAuthRequired } from './engine.js';
import { GROK_LOGIN_COMMAND, GrokLauncher, XAI_API_KEY_ENV } from './launch.js';
import {
  ASK_USER_QUESTION_CANCELLED,
  askUserQuestionResponse,
  completionOf,
  EXIT_PLAN_CAPTURED,
  GROK_CANCEL_META,
  GROK_PERMISSION_MODES,
  parseAskUserQuestion,
  parseExitPlanMode,
  promptCompleteOf,
  toUserQuestions,
  turnUsageOf,
  XAI_ASK_USER_QUESTION_METHODS,
  XAI_EXIT_PLAN_MODE_METHODS,
} from './xai.js';

/** ACP 认证方式（T3 的 `resolveGrokAuthMethodId`）：有 `XAI_API_KEY` 用它，否则用 Grok 缓存的登录令牌。 */
export const GROK_AUTH_METHOD_API_KEY = 'xai.api_key';
export const GROK_AUTH_METHOD_CACHED_TOKEN = 'cached_token';

/** 进程的可调参数（测试用）。 */
export type GrokProcessOptions = Partial<
  Pick<AcpProcessOptions, 'initializeTimeoutMs' | 'restart' | 'disposeTimeouts'>
>;

export interface GrokModeAdapterOptions {
  mode: PermissionMode;
  workDir: string;
  accounts: GrokAccounts;
  env: NodeJS.ProcessEnv;
  logger?: AdapterLogger;
  cancelTimeoutMs?: number;
  process?: GrokProcessOptions;
  mcpServers?: readonly McpServer[];
  appToolsBridge?: AppToolsBridge;
}

/**
 * 一种权限模式的 `grok agent stdio`：通用 ACP 适配器加上 Grok 的扩展——`session/prompt` 带 `promptId`，引擎报的回合结束
 * （`prompt_complete` / `turn_completed`）先到就按它结算；向用户提问与退出计划模式；要认证时用 Grok 自己存的凭据认证。
 */
export class GrokModeAdapter extends AcpAdapter<AcpProcess> {
  readonly mode: PermissionMode;
  readonly #env: NodeJS.ProcessEnv;
  readonly #accounts: GrokAccounts;
  /** 每个会话进行中的回合的 `promptId`。 */
  readonly #prompts = new Map<string, string>();
  #nextPrompt = 0;
  /** `usage.recorded.requestId` 的前缀：`promptId` 只在这个实例里唯一。 */
  readonly #instance = randomUUID().slice(0, 8);

  constructor(options: GrokModeAdapterOptions) {
    const { mode, workDir, accounts } = options;
    super({
      engine: GROK_ENGINE,
      ...(options.logger !== undefined && { logger: options.logger }),
      ...(options.cancelTimeoutMs !== undefined && { cancelTimeoutMs: options.cancelTimeoutMs }),
      ...(options.mcpServers !== undefined && { mcpServers: options.mcpServers }),
      ...(options.appToolsBridge !== undefined && { appToolsBridge: options.appToolsBridge }),
      createProcess: (hooks) =>
        new AcpProcess({
          ...options.process,
          engine: GROK_ENGINE,
          launcher: new GrokLauncher(mode, workDir, () => accounts.executable()),
          onSessionUpdate: hooks.onSessionUpdate,
          onRequestPermission: hooks.onRequestPermission,
          onExtNotification: hooks.onExtNotification,
          onExtRequest: hooks.onExtRequest,
        }),
    });
    this.mode = mode;
    this.#env = options.env;
    this.#accounts = accounts;
  }

  /** 当前进程里 Grok 自报的版本。 */
  get agentVersion(): string | undefined {
    return agentVersionOf(this.process.initializeResponse);
  }

  /** 会话有进行中的回合。 */
  hasTurn(engineSessionId: string): boolean {
    return this.inTurn(engineSessionId);
  }

  /** 会话中换模型或推理档位：在没有回合时重新选定（下一个回合起生效）。 */
  configureRoute(
    engineSessionId: string,
    config: Pick<SessionConfig, 'providerId' | 'modelId' | 'reasoningEffort'>,
  ): Promise<void> {
    this.assertUsable();
    return this.applyRoute(engineSessionId, config);
  }

  async respondToQuestion(
    engineSessionId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    this.assertUsable();
    this.answerQuestion(engineSessionId, requestId, answers);
  }

  protected override promptMeta(engineSessionId: string): Record<string, unknown> {
    const promptId = `wevir-${this.mode}-${++this.#nextPrompt}`;
    this.#prompts.set(engineSessionId, promptId);
    return { promptId, requestId: promptId };
  }

  protected override cancelMeta(): Record<string, unknown> {
    return { ...GROK_CANCEL_META };
  }

  /**
   * 回合结束的扩展通知（T3 的 `makeXAiPromptCompletionRuntime`）：`promptId` 与本会话进行中的回合相同才算；没带 `promptId`
   * 的按会话认。之前的 `session/update` 都已入队。
   */
  protected override extNotification(method: string, params: unknown): void {
    // 回合的用量（0.62.0）在结算之前报。Wevir 的 `promptId` 是进程里的序号，Host 重启后会重复，所以 `requestId` 前面加上
    // 这个适配器实例的随机前缀。
    const usage = turnUsageOf(method, params);
    if (usage !== undefined) {
      for (const entry of usage.models) {
        this.recordUsage(usage.sessionId, {
          requestId: `${this.#instance}:${usage.promptId}:${entry.model ?? ''}`,
          ...entry,
        });
      }
    }
    const complete = promptCompleteOf(method, params);
    if (complete === undefined) return;
    const current = this.#prompts.get(complete.sessionId);
    if (current === undefined) return;
    if (complete.promptId !== undefined && complete.promptId !== current) return;
    this.#prompts.delete(complete.sessionId);
    const completion = completionOf(complete);
    if ('error' in completion && isAuthRequired(completion.error)) {
      this.#accounts.markSignedOut(completion.error.message);
    }
    this.completeTurn(complete.sessionId, completion);
  }

  /** 向用户提问（`ask_user_question`）与退出计划模式（`exit_plan_mode`）。 */
  protected override async extRequest(
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (XAI_ASK_USER_QUESTION_METHODS.includes(method)) {
      const request = parseAskUserQuestion(params);
      if (request === undefined) throw invalidParams(method);
      const answers = await this.requestAnswers(
        request.sessionId,
        request.toolCallId,
        toUserQuestions(request.questions),
        signal,
      );
      return answers === undefined
        ? { ...ASK_USER_QUESTION_CANCELLED }
        : askUserQuestionResponse(request.questions, answers);
    }
    if (XAI_EXIT_PLAN_MODE_METHODS.includes(method)) {
      // 计划（0.36.0，照 T3 的 `registerGrokExitPlanModeExtensions`）：报成 `plan.proposed`，放弃这道关让 Grok 停下等用户；
      // 实施是用户另发的消息。不再当审批问。
      const request = parseExitPlanMode(params);
      if (request === undefined) throw invalidParams(method);
      if (request.planContent !== undefined) {
        this.proposePlan(request.sessionId, request.toolCallId, request.planContent.trim());
      }
      return { ...EXIT_PLAN_CAPTURED };
    }
    return super.extRequest(method, params, signal);
  }

  /**
   * `session/new` / `session/resume` 报要认证（T3 的 `authenticateAfterRequired`）：用 `XAI_API_KEY` 或 Grok 缓存的令牌认证
   * 一次再重试；`initialize` 没列出这种方式、或认证失败时报 `missing_credentials`。不用 `grok.com`（浏览器登录）。
   */
  protected override async authenticateAfter(error: unknown): Promise<boolean> {
    if (!isAuthRequired(error)) return false;
    const apiKey = this.#env[XAI_API_KEY_ENV]?.trim();
    const methodId =
      apiKey !== undefined && apiKey !== ''
        ? GROK_AUTH_METHOD_API_KEY
        : GROK_AUTH_METHOD_CACHED_TOKEN;
    const advertised = this.process.initializeResponse?.authMethods;
    const signInMessage = `Grok is not signed in: run \`${GROK_LOGIN_COMMAND}\` in a terminal, then check again`;
    if (advertised !== undefined && !advertised.some((method) => method.id === methodId)) {
      this.#accounts.markSignedOut(signInMessage);
      throw new AdapterError('missing_credentials', signInMessage, { cause: error });
    }
    try {
      await this.process.connection.agent.request('authenticate', { methodId });
    } catch (cause) {
      this.#accounts.markSignedOut(signInMessage);
      throw new AdapterError('missing_credentials', signInMessage, { cause });
    }
    return true;
  }
}

function invalidParams(method: string): Error {
  return Object.assign(new Error(`Invalid params for ${method}`), { code: -32602 });
}

export interface GrokAdapterOptions {
  /** Wevir 数据目录（绝对路径）；探测与 `grok` 进程的工作目录是其中的 engines/grok。 */
  home: string;
  logger?: AdapterLogger;
  /** 交给 `grok` 的环境的来源，默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  cancelTimeoutMs?: number;
  /** 测试用：账号检测的替身（可执行文件的查找、`initialize` 探测、时钟）。 */
  accounts?: Pick<GrokAccountsOptions, 'findExecutable' | 'probeInitialize' | 'now'>;
  /** 测试用：进程的时限与重启策略。 */
  process?: GrokProcessOptions;
  /** 读历史的本机 MCP 服务（0.25.0，接力）：经 ACP 的 `session/new` / `session/resume` 交给 `grok`。 */
  historyTool?: HistoryToolServer;
  /** 应用级工具的 stdio 桥（0.30.0）：会话带 `appTools` 时经 ACP 挂上。 */
  appToolsBridge?: AppToolsBridge;
}

/** 一个会话在路由里的记录。 */
interface GrokSession {
  readonly id: string;
  readonly cwd: string;
  /** Host 最近给的配置（建会话、恢复、`configureSession`）；`permissionMode` 是想要的模式。 */
  config: SessionConfig;
  /** 承载它的进程（权限模式）；关闭、脱开或挪动中途为 undefined。 */
  host: GrokModeAdapter | undefined;
  /** 模型或推理档位换过、还没交给引擎。 */
  routeStale: boolean;
  /** Host 订阅的事件流；每次挂上（建会话、恢复）一个新的。 */
  hub: EventHub<AgentEvent>;
  /** 正在挪到另一个进程：旧进程里的订阅结束不结束 `hub`。 */
  moving: boolean;
}

/**
 * Grok Build 的 `AgentRuntimeAdapter`（订阅来源 `grok`，ADR-0005 补记 14）：按权限模式分进程的路由。会话中途换权限模式时，
 * 下一次 `send` 之前把会话挪到新模式的进程（`session/close` 再 `session/resume`）。
 */
export class GrokAdapter implements AgentRuntimeAdapter {
  readonly permissionModes: readonly PermissionMode[] = GROK_PERMISSION_MODES;
  /** 读历史的工具（0.25.0）：给了 `historyTool` 时经 ACP 挂上。 */
  readonly historyTool: boolean;
  /** 应用级工具（0.30.0）：给了 `appToolsBridge` 时经 ACP 挂上。 */
  readonly appTools: boolean;
  readonly accounts: GrokAccounts;

  /** 图片（0.28.0）：各模式的进程照通用 ACP 适配器发图片内容块（`GROK_ENGINE.images`）。 */
  acceptsImages(): boolean {
    return true;
  }
  readonly #options: GrokAdapterOptions;
  readonly #workDir: string;
  readonly #modes = new Map<PermissionMode, GrokModeAdapter>();
  readonly #sessions = new Map<string, GrokSession>();
  #disposed: Promise<void> | undefined;

  constructor(options: GrokAdapterOptions) {
    this.#options = options;
    this.historyTool = options.historyTool !== undefined;
    this.appTools = options.appToolsBridge !== undefined;
    this.#workDir = `${options.home}/engines/grok`;
    this.accounts = new GrokAccounts({
      workDir: this.#workDir,
      ...(options.env !== undefined && { env: options.env }),
      ...options.accounts,
    });
  }

  /** 已起的各权限模式的引擎（诊断与测试用），按起的先后。 */
  get engines(): readonly GrokModeAdapter[] {
    return [...this.#modes.values()];
  }

  async createSession(config: SessionConfig): Promise<EngineSession> {
    this.#assertUsable();
    const host = this.#host(config.permissionMode);
    const engine = await host.createSession(config);
    const session = this.#attach(engine.engineSessionId, config, host);
    return this.#withVersion(engine, session);
  }

  async resumeSession(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    this.#assertUsable();
    const known = this.#sessions.get(engineSessionId);
    const mode = config.permissionMode ?? 'on_request';
    if (known?.host !== undefined && !known.hub.ended) {
      // 已挂着：同一模式直接成功；模式不同就挪过去。
      known.config = { ...config };
      if (known.host.mode !== mode) await this.#move(known);
      return this.#withVersion({ engineSessionId, engineVersion: GROK_ENGINE.version }, known);
    }
    const host = this.#host(mode);
    const engine = await host.resumeSession(engineSessionId, config);
    const session = this.#attach(engineSessionId, config, host);
    return this.#withVersion(engine, session);
  }

  subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    this.#assertUsable();
    const session = this.#session(engineSessionId);
    if (session.hub.ended) {
      throw new AdapterError('session_closed', `引擎会话 ${engineSessionId} 没有挂着`);
    }
    return session.hub.subscribe();
  }

  async send(engineSessionId: string, input: AgentInput): Promise<void> {
    this.#assertUsable();
    const session = this.#session(engineSessionId);
    if (session.hub.ended) {
      throw new AdapterError('session_closed', `引擎会话 ${engineSessionId} 没有挂着`);
    }
    if (session.host?.hasTurn(engineSessionId) === true) {
      throw new AdapterError('session_busy', '会话有进行中的回合');
    }
    const mode = session.config.permissionMode ?? 'on_request';
    if (session.host === undefined || session.host.mode !== mode) await this.#move(session);
    const host = session.host as GrokModeAdapter;
    if (session.routeStale) {
      await host.configureRoute(engineSessionId, session.config);
      session.routeStale = false;
    }
    await host.send(engineSessionId, input);
  }

  /**
   * 会话中换模型、推理档位或权限模式：记下，下一次 `send` 之前交给引擎（模型与档位用 `session/set_model`；权限模式要换进程，
   * grok-event-mapping.md §6）。进行中的回合不受影响。
   */
  async configureSession(
    engineSessionId: string,
    config: { modelId: string; reasoningEffort?: string; permissionMode?: PermissionMode },
  ): Promise<void> {
    this.#assertUsable();
    const session = this.#session(engineSessionId);
    const { reasoningEffort: _effort, permissionMode: _mode, ...rest } = session.config;
    session.config = {
      ...rest,
      modelId: config.modelId,
      ...(config.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
      ...(config.permissionMode !== undefined && { permissionMode: config.permissionMode }),
    };
    session.routeStale = true;
  }

  async respondToApproval(
    engineSessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    this.#assertUsable();
    const host = this.#session(engineSessionId).host;
    if (host === undefined) {
      throw new AdapterError(
        'approval_not_found',
        `引擎会话 ${engineSessionId} 没有未决审批 ${requestId}`,
      );
    }
    await host.respondToApproval(engineSessionId, requestId, decision);
  }

  async respondToQuestion(
    engineSessionId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    this.#assertUsable();
    const host = this.#session(engineSessionId).host;
    if (host === undefined) {
      throw new AdapterError(
        'question_not_found',
        `引擎会话 ${engineSessionId} 没有未决提问 ${requestId}`,
      );
    }
    await host.respondToQuestion(engineSessionId, requestId, answers);
  }

  async listPendingApprovals(engineSessionId?: string): Promise<PendingApproval[]> {
    this.#assertUsable();
    if (engineSessionId !== undefined) {
      const host = this.#sessions.get(engineSessionId)?.host;
      return host === undefined ? [] : host.listPendingApprovals(engineSessionId);
    }
    const lists = await Promise.all(
      [...this.#modes.values()].map((host) => host.listPendingApprovals()),
    );
    return lists.flat();
  }

  async cancel(engineSessionId: string): Promise<void> {
    const host = this.#sessions.get(engineSessionId)?.host;
    if (host !== undefined) await host.cancel(engineSessionId);
  }

  async close(engineSessionId: string): Promise<void> {
    this.#assertUsable();
    const session = this.#session(engineSessionId);
    const host = session.host;
    if (host !== undefined) await host.close(engineSessionId);
    session.host = undefined;
    session.hub.end();
  }

  dispose(): Promise<void> {
    this.#disposed ??= (async () => {
      this.accounts.dispose();
      const hosts = [...this.#modes.values()];
      this.#modes.clear();
      await Promise.all(hosts.map((host) => host.dispose()));
      for (const session of this.#sessions.values()) session.hub.end();
      this.#sessions.clear();
    })();
    return this.#disposed;
  }

  /** 这种权限模式的进程（懒建：构造时不起进程）。 */
  #host(mode: PermissionMode = 'on_request'): GrokModeAdapter {
    let host = this.#modes.get(mode);
    if (host === undefined) {
      host = new GrokModeAdapter({
        mode,
        workDir: this.#workDir,
        accounts: this.accounts,
        env: this.#options.env ?? process.env,
        ...(this.#options.logger !== undefined && { logger: this.#options.logger }),
        ...(this.#options.cancelTimeoutMs !== undefined && {
          cancelTimeoutMs: this.#options.cancelTimeoutMs,
        }),
        ...(this.#options.process !== undefined && { process: this.#options.process }),
        ...(this.#options.historyTool !== undefined && {
          mcpServers: [acpHistoryServer(this.#options.historyTool)],
        }),
        ...(this.#options.appToolsBridge !== undefined && {
          appToolsBridge: this.#options.appToolsBridge,
        }),
      });
      this.#modes.set(mode, host);
    }
    return host;
  }

  /** 会话刚挂到 `host` 上：新的事件流（上一次的已结束）接上 `host` 的订阅。 */
  #attach(id: string, config: SessionConfig, host: GrokModeAdapter): GrokSession {
    const previous = this.#sessions.get(id);
    const hub =
      previous !== undefined && !previous.hub.ended ? previous.hub : new EventHub<AgentEvent>();
    const session: GrokSession = {
      id,
      cwd: config.cwd,
      config: { ...config },
      host,
      routeStale: false,
      hub,
      moving: false,
    };
    this.#sessions.set(id, session);
    this.#pipe(session, host);
    return session;
  }

  /** 把 `host` 里这个会话的事件转到它的事件流；`host` 里的订阅结束时（关闭、引擎退出）事件流跟着结束，挪动中途除外。 */
  #pipe(session: GrokSession, host: GrokModeAdapter): void {
    const events = host.subscribe(session.id);
    void (async () => {
      try {
        for await (const event of events) session.hub.emit(event);
      } finally {
        if (session.host === host && !session.moving) {
          session.host = undefined;
          session.hub.end();
        }
      }
    })();
  }

  /**
   * 把会话挪到它现在的权限模式的进程：旧进程里 `session/close`，新进程里 `session/resume`（创建时的 cwd），再按 Host 的配置
   * 选定模型。事件流不断。失败时会话留在没有进程的状态，下一次 `send` 再试。
   */
  async #move(session: GrokSession): Promise<void> {
    const target = this.#host(session.config.permissionMode);
    const from = session.host;
    session.moving = true;
    try {
      if (from !== undefined && from !== target) {
        session.host = undefined;
        await from.close(session.id);
      }
      await target.resumeSession(session.id, { ...session.config, cwd: session.cwd });
      session.host = target;
      session.routeStale = false;
      this.#pipe(session, target);
    } finally {
      session.moving = false;
    }
  }

  #withVersion(engine: EngineSession, session: GrokSession): EngineSession {
    return {
      ...engine,
      engineVersion: session.host?.agentVersion ?? this.accounts.version ?? engine.engineVersion,
    };
  }

  #session(engineSessionId: string): GrokSession {
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `不认识的引擎会话 ${engineSessionId}`);
    }
    return session;
  }

  #assertUsable(): void {
    if (this.#disposed !== undefined) throw new AdapterError('disposed', 'grok 适配器已释放');
  }
}

/** 读历史的 MCP 服务写成 ACP 的 stdio 形状（0.25.0）。 */
function acpHistoryServer(server: HistoryToolServer): McpServer {
  writeHistoryToolScript(server);
  const { command, args, env } = historyToolCommand(server);
  return {
    name: HISTORY_TOOL_SERVER,
    command,
    args,
    env: Object.entries(env).map(([name, value]) => ({ name, value })),
  };
}
