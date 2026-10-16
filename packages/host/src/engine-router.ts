// 多引擎路由（0.19.0，ADR-0005 补记 14）：Host 只认一个 `AgentRuntimeAdapter`，订阅来源各有自己的引擎（Claude Agent、Cursor、
// OpenCode、Grok、Antigravity），所以 Host 拿到的是把几个引擎拼在一起的路由。会话按 Provider 的种类交给一个引擎，之后的调用按
// 引擎会话 ID 找回它（子会话与支线跟着派出它的引擎）；账号按种类合并。照 adapter-codex 的 CodexRuntime（两个进程按种类分会话）
// 推广到任意个引擎。

import type { EngineFeatures, SessionCommand } from '@wevir/protocol';
import type {
  AccountKind,
  AccountState,
  AgentEvent,
  AgentInput,
  AgentRuntimeAdapter,
  ApprovalDecision,
  CancelOptions,
  EngineAccounts,
  EngineSession,
  GoalStartRequest,
  PendingApproval,
  PermissionMode,
  ProviderConfig,
  ProviderIssue,
  ProviderTestResult,
  ReviewRequest,
  SessionCapability,
  SessionConfig,
  TitleRequest,
} from '@wevir/runtime-adapter';
import { AdapterError } from '@wevir/runtime-adapter';

type ProviderKind = ProviderConfig['kind'];

/** 一个引擎与交给它的 Provider 种类。 */
export interface EngineRoute {
  /** 日志与报错里的名字，如 `codex`、`claude`。 */
  name: string;
  adapter: AgentRuntimeAdapter;
  kinds: readonly ProviderKind[];
}

/** 权限模式的固定顺序，合并各引擎的模式时用。 */
const PERMISSION_ORDER: readonly PermissionMode[] = ['on_request', 'auto_review', 'full_access'];

export class EngineRouter implements AgentRuntimeAdapter {
  readonly routes: readonly EngineRoute[];
  readonly permissionModes?: readonly PermissionMode[];
  readonly additionalRoots?: boolean;
  readonly googleVertex?: boolean;
  readonly suggestedTasks?: boolean;
  readonly historyTool?: boolean;
  readonly appTools?: boolean;
  readonly planMode?: boolean;
  readonly branches?: boolean;
  readonly accounts?: EngineAccounts;

  // 可选方法：至少一个引擎有时才有，Host 据此声明功能；会话所在的引擎没有时报 `invalid_input`。
  readonly steer?: AgentRuntimeAdapter['steer'];
  readonly configureSession?: AgentRuntimeAdapter['configureSession'];
  readonly fork?: AgentRuntimeAdapter['fork'];
  readonly rewind?: AgentRuntimeAdapter['rewind'];
  readonly injectNote?: AgentRuntimeAdapter['injectNote'];
  readonly respondToQuestion?: AgentRuntimeAdapter['respondToQuestion'];
  readonly generateTitle?: AgentRuntimeAdapter['generateTitle'];
  readonly compact?: AgentRuntimeAdapter['compact'];
  readonly review?: AgentRuntimeAdapter['review'];
  readonly startGoal?: AgentRuntimeAdapter['startGoal'];
  readonly updateGoal?: AgentRuntimeAdapter['updateGoal'];
  readonly clearGoal?: AgentRuntimeAdapter['clearGoal'];
  readonly acceptsImages?: AgentRuntimeAdapter['acceptsImages'];
  readonly bindEngineAppTools?: AgentRuntimeAdapter['bindEngineAppTools'];

  /** Provider 种类 → 引擎。 */
  readonly #byKind = new Map<ProviderKind, EngineRoute>();
  /** Provider ID → 种类（`configureProviders` 时记下）。 */
  #kinds = new Map<string, ProviderKind>();
  /** 引擎会话 ID → 承载它的引擎。 */
  readonly #owners = new Map<string, EngineRoute>();

  constructor(routes: readonly EngineRoute[]) {
    if (routes.length === 0) throw new Error('EngineRouter needs at least one engine');
    this.routes = routes;
    for (const route of routes) {
      for (const kind of route.kinds) {
        if (this.#byKind.has(kind)) throw new Error(`provider kind ${kind} has two engines`);
        this.#byKind.set(kind, route);
      }
    }
    const adapters = routes.map((route) => route.adapter);

    const modes = new Set(adapters.flatMap((adapter) => adapter.permissionModes ?? []));
    if (modes.size > 0) this.permissionModes = PERMISSION_ORDER.filter((mode) => modes.has(mode));
    if (adapters.some((adapter) => adapter.additionalRoots === true)) this.additionalRoots = true;
    if (
      routes.some(
        (route) => route.kinds.includes('google-vertex') && route.adapter.googleVertex === true,
      )
    )
      this.googleVertex = true;
    if (adapters.some((adapter) => adapter.suggestedTasks === true)) this.suggestedTasks = true;
    if (adapters.some((adapter) => adapter.historyTool === true)) this.historyTool = true;
    if (adapters.some((adapter) => adapter.appTools === true)) this.appTools = true;
    if (adapters.some((adapter) => adapter.planMode === true)) this.planMode = true;
    if (adapters.some((adapter) => adapter.branches === true)) this.branches = true;
    const accounts = routes.flatMap((route) =>
      route.adapter.accounts === undefined ? [] : [route.adapter.accounts],
    );
    if (accounts.length > 0) this.accounts = new MergedAccounts(accounts);

    if (adapters.some((adapter) => adapter.steer !== undefined)) {
      this.steer = async (id, steerId, input) =>
        this.#method(id, 'steer').steer(id, steerId, input);
    }
    if (adapters.some((adapter) => adapter.configureSession !== undefined)) {
      this.configureSession = async (id, config) =>
        this.#method(id, 'configureSession').configureSession(id, config);
    }
    if (adapters.some((adapter) => adapter.fork !== undefined)) {
      this.fork = async (id, config, options) => {
        const route = this.#forSession(id);
        if (route.adapter.fork === undefined) throw unsupported(route, 'fork');
        if (options?.kind === 'branch' && route.adapter.branches !== true) {
          throw unsupported(route, 'branching');
        }
        const session = await route.adapter.fork(id, config, options);
        this.#owners.set(session.engineSessionId, route);
        return session;
      };
    }
    if (adapters.some((adapter) => adapter.rewind !== undefined)) {
      this.rewind = async (id) => this.#method(id, 'rewind').rewind(id);
    }
    if (adapters.some((adapter) => adapter.injectNote !== undefined)) {
      this.injectNote = async (id, text) => this.#method(id, 'injectNote').injectNote(id, text);
    }
    if (adapters.some((adapter) => adapter.respondToQuestion !== undefined)) {
      this.respondToQuestion = async (id, requestId, answers) =>
        this.#method(id, 'respondToQuestion').respondToQuestion(id, requestId, answers);
    }
    if (adapters.some((adapter) => adapter.acceptsImages !== undefined)) {
      // 按 Provider 的种类问承载它的引擎；不认识的 Provider 当作不收。
      this.acceptsImages = (config) => {
        const kind = this.#kinds.get(config.providerId);
        const route = kind === undefined ? undefined : this.#byKind.get(kind);
        return route?.adapter.acceptsImages?.(config) === true;
      };
    }
    if (adapters.some((adapter) => adapter.bindEngineAppTools !== undefined)) {
      // 引擎令牌只认交给这个引擎的 Provider 种类：别的引擎的会话冒充不了。
      this.bindEngineAppTools = (grant) => {
        for (const route of routes) {
          route.adapter.bindEngineAppTools?.((kinds) =>
            grant(kinds.filter((kind) => route.kinds.includes(kind))),
          );
        }
      };
    }
    if (adapters.some((adapter) => adapter.generateTitle !== undefined)) {
      this.generateTitle = async (id: string, request: TitleRequest) =>
        this.#method(id, 'generateTitle').generateTitle(id, request);
    }
    if (adapters.some((adapter) => adapter.compact !== undefined)) {
      this.compact = async (id) => this.#method(id, 'compact').compact(id);
    }
    if (adapters.some((adapter) => adapter.review !== undefined)) {
      this.review = async (id, request: ReviewRequest) =>
        this.#method(id, 'review').review(id, request);
    }
    if (adapters.some((adapter) => adapter.startGoal !== undefined)) {
      this.startGoal = async (id, request: GoalStartRequest) =>
        this.#method(id, 'startGoal').startGoal(id, request);
      this.updateGoal = async (id, status) => this.#method(id, 'updateGoal').updateGoal(id, status);
      this.clearGoal = async (id) => this.#method(id, 'clearGoal').clearGoal(id);
    }
  }

  /** 会话所在的引擎有没有这个方法（0.24.0）、计划模式（0.36.0）或分支（0.38.0）：Host 在开始命令回合、分支与撤回之前问。 */
  supports(engineSessionId: string, method: SessionCapability): boolean {
    const adapter = this.#forSession(engineSessionId).adapter;
    return (
      adapter.supports?.(engineSessionId, method) ??
      (method === 'planMode'
        ? adapter.planMode === true
        : method === 'branch'
          ? adapter.branches === true && adapter.fork !== undefined
          : adapter[method] !== undefined)
    );
  }

  async createSession(config: SessionConfig): Promise<EngineSession> {
    const route = this.#forProvider(config.providerId);
    const session = await route.adapter.createSession(this.#configFor(route, config));
    this.#owners.set(session.engineSessionId, route);
    return session;
  }

  async resumeSession(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    const route = this.#forProvider(config.providerId);
    const session = await route.adapter.resumeSession(
      engineSessionId,
      this.#configFor(route, config),
    );
    this.#owners.set(engineSessionId, route);
    return session;
  }

  subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    const route = this.#forSession(engineSessionId);
    const events = route.adapter.subscribe(engineSessionId);
    const owners = this.#owners;
    // 子会话由派出它的引擎认出：看到 `subagent.started` 时记下归属，之后对子会话的调用才找得到它。
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of events) {
          if (event.type === 'subagent.started') owners.set(event.childEngineSessionId, route);
          yield event;
        }
      },
    };
  }

  send(engineSessionId: string, input: AgentInput): Promise<void> {
    return this.#forSession(engineSessionId).adapter.send(engineSessionId, input);
  }

  respondToApproval(
    engineSessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    return this.#forSession(engineSessionId).adapter.respondToApproval(
      engineSessionId,
      requestId,
      decision,
    );
  }

  async listPendingApprovals(engineSessionId?: string): Promise<PendingApproval[]> {
    if (engineSessionId !== undefined) {
      return this.#forSession(engineSessionId).adapter.listPendingApprovals(engineSessionId);
    }
    const all = await Promise.all(this.routes.map((route) => route.adapter.listPendingApprovals()));
    return all.flat();
  }

  cancel(engineSessionId: string, options?: CancelOptions): Promise<void> {
    return this.#forSession(engineSessionId).adapter.cancel(engineSessionId, options);
  }

  close(engineSessionId: string): Promise<void> {
    return this.#forSession(engineSessionId).adapter.close(engineSessionId);
  }

  validateProvider(provider: ProviderConfig): ProviderIssue[] {
    const route = this.#byKind.get(provider.kind);
    if (route === undefined) {
      return [{ path: ['kind'], message: `no engine for ${provider.kind} providers in this host` }];
    }
    return route.adapter.validateProvider?.(provider) ?? [];
  }

  async configureProviders(providers: readonly ProviderConfig[]): Promise<void> {
    this.#kinds = new Map(providers.map((provider) => [provider.id, provider.kind]));
    await Promise.all(
      this.routes.map((route) =>
        route.adapter.configureProviders?.(
          providers.filter((provider) => route.kinds.includes(provider.kind)),
        ),
      ),
    );
  }

  async testProvider(provider: ProviderConfig, modelId: string): Promise<ProviderTestResult> {
    const test = this.#byKind.get(provider.kind)?.adapter.testProvider;
    if (test === undefined) {
      return {
        ok: false,
        error: { category: 'unknown', message: 'provider test is not available for this provider' },
        reason: 'unknown',
      };
    }
    return test.call(this.#byKind.get(provider.kind)?.adapter, provider, modelId);
  }

  async dispose(): Promise<void> {
    await Promise.all(this.routes.map((route) => route.adapter.dispose()));
  }

  /** 每种 Provider 的会话由哪个引擎跑、能做什么（0.25.0，`host.hello` 的 `engineFeatures`）。 */
  engineFeatures(): Record<string, EngineFeatures> {
    const features: Record<string, EngineFeatures> = {};
    for (const route of this.routes) {
      const value = engineFeaturesOf(route.name, route.adapter);
      for (const kind of route.kinds) features[kind] = value;
    }
    return features;
  }

  /** 交给引擎的配置：引擎不支持额外目录时，有额外目录的会话建不了。 */
  #configFor(route: EngineRoute, config: SessionConfig): SessionConfig {
    if (config.additionalRoots === undefined || route.adapter.additionalRoots === true)
      return config;
    if (config.additionalRoots.length > 0) {
      throw new AdapterError('invalid_input', `the ${route.name} engine has no additional folders`);
    }
    const { additionalRoots: _none, ...rest } = config;
    return rest;
  }

  #forProvider(providerId: string): EngineRoute {
    const kind = this.#kinds.get(providerId);
    const route = kind === undefined ? undefined : this.#byKind.get(kind);
    if (route !== undefined) return route;
    // 不认识的 Provider：只有一个引擎时交给它，由它报错（与单引擎的 Host 相同）。
    if (this.routes.length === 1 && this.routes[0] !== undefined) return this.routes[0];
    throw new AdapterError(
      'invalid_input',
      kind === undefined
        ? `unknown provider ${providerId}`
        : `no engine for ${kind} providers in this host`,
    );
  }

  /** 不认识的会话交给第一个引擎，由它报 `session_not_found`（`cancel` 等幂等的方法直接成功）。 */
  #forSession(engineSessionId: string): EngineRoute {
    return this.#owners.get(engineSessionId) ?? (this.routes[0] as EngineRoute);
  }

  #method<M extends OptionalMethod>(
    engineSessionId: string,
    method: M,
  ): Required<Pick<AgentRuntimeAdapter, M>> {
    const route = this.#forSession(engineSessionId);
    if (route.adapter[method] === undefined) throw unsupported(route, method);
    return route.adapter as unknown as Required<Pick<AgentRuntimeAdapter, M>>;
  }
}

/** `EngineFeatures.commands` 的顺序（0.27.0），对应适配器的 `compact` / `review`。 */
const SESSION_COMMANDS = ['compact', 'review'] as const satisfies readonly SessionCommand[];

/** 一个引擎能做什么（0.25.0）：按适配器实现了哪些可选方法、声明了哪些能力；0.27.0 起总是带 `commands`。 */
export function engineFeaturesOf(name: string, adapter: AgentRuntimeAdapter): EngineFeatures {
  const commands = SESSION_COMMANDS.filter((command) => adapter[command] !== undefined);
  return {
    engine: name,
    ...(adapter.steer !== undefined && { steer: true }),
    ...(adapter.configureSession !== undefined && { configure: true }),
    ...(adapter.fork !== undefined && { fork: true }),
    ...(adapter.respondToQuestion !== undefined && { questions: true }),
    ...(adapter.permissionModes !== undefined && { permissionModes: [...adapter.permissionModes] }),
    ...(adapter.additionalRoots === true && { additionalRoots: true }),
    ...(adapter.historyTool === true && { historyTool: true }),
    ...(adapter.appTools === true && { appTools: true }),
    ...(adapter.planMode === true && { planMode: true }),
    commands,
    ...(adapter.startGoal !== undefined && { goals: true }),
    ...(adapter.fork !== undefined && adapter.branches === true && { branch: true }),
    ...(adapter.rewind !== undefined && { rewind: true }),
  };
}

type OptionalMethod =
  | 'steer'
  | 'configureSession'
  | 'injectNote'
  | 'respondToQuestion'
  | 'generateTitle'
  | 'compact'
  | 'review'
  | 'startGoal'
  | 'updateGoal'
  | 'clearGoal'
  | 'rewind';

function unsupported(route: EngineRoute, method: string): AdapterError {
  return new AdapterError('invalid_input', `the ${route.name} engine does not support ${method}`);
}

/** 几个引擎的账号合成一个：种类不重复（先登记的优先），状态变化一起转出。 */
class MergedAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[];
  readonly #byKind = new Map<AccountKind, EngineAccounts>();
  readonly #parts: readonly EngineAccounts[];

  constructor(parts: readonly EngineAccounts[]) {
    this.#parts = parts;
    for (const part of parts) {
      for (const kind of part.kinds) if (!this.#byKind.has(kind)) this.#byKind.set(kind, part);
    }
    this.kinds = [...this.#byKind.keys()];
  }

  async read(kind: AccountKind, options?: { refresh?: boolean }): Promise<AccountState> {
    return this.#part(kind).read(kind, options);
  }

  async login(kind: AccountKind, method: 'browser' | 'device_code'): Promise<AccountState> {
    return this.#part(kind).login(kind, method);
  }

  async cancelLogin(kind: AccountKind, loginId?: string): Promise<AccountState> {
    return this.#part(kind).cancelLogin(kind, loginId);
  }

  async logout(kind: AccountKind): Promise<AccountState> {
    return this.#part(kind).logout(kind);
  }

  async models(kind: AccountKind) {
    return this.#part(kind).models(kind);
  }

  async setExecutablePath(kind: AccountKind, path: string | null): Promise<AccountState> {
    const part = this.#part(kind);
    if (part.setExecutablePath === undefined) {
      throw new AdapterError('invalid_input', `the ${kind} engine has no executable path setting`);
    }
    return part.setExecutablePath(kind, path);
  }

  async install(kind: AccountKind): Promise<AccountState> {
    const part = this.#part(kind);
    if (part.install === undefined) {
      throw new AdapterError('invalid_input', `the ${kind} engine cannot be installed by Wevir`);
    }
    return part.install(kind);
  }

  onChange(listener: (state: AccountState) => void): () => void {
    const offs = this.#parts.map((part) => part.onChange(listener));
    return () => {
      for (const off of offs) off();
    };
  }

  #part(kind: AccountKind): EngineAccounts {
    const part = this.#byKind.get(kind);
    if (part === undefined)
      throw new AdapterError('invalid_input', `no ${kind} account in this host`);
    return part;
  }
}
