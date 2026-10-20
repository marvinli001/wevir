// 多引擎路由（0.19.0，ADR-0005 补记 14）：Host 只认一个 `AgentRuntimeAdapter`，订阅来源各有自己的引擎（Claude Agent、Cursor、
// OpenCode、Grok、Antigravity），所以 Host 拿到的是把几个引擎拼在一起的路由。会话按 Provider 的种类交给一个引擎，之后的调用按
// 引擎会话 ID 找回它（子会话与支线跟着派出它的引擎）；账号按种类合并。照 adapter-codex 的 CodexRuntime（两个进程按种类分会话）
// 推广到任意个引擎。
//
// 订阅多账号（0.63.0）：同一来源添加的账号各是同类引擎的一个新实例，作为一条只认自己 Provider ID 的路由在运行时加进来
// （`accountPool`）；按 Provider 找引擎时认领了这个 ID 的路由优先，其余仍按种类。

import type { EngineFeatures, SessionCommand } from '@wevir/protocol';
import type {
  AccountKind,
  AccountLoginOptions,
  AccountState,
  AccountUpstream,
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
  /**
   * 0.63.0：只认这些 Provider（添加的账号，ID 就是账号 ID），不按种类接别的 Provider；`kinds` 是这个账号的种类。省略时按
   * `kinds` 接没被认领的 Provider。
   */
  providerIds?: readonly string[];
}

/**
 * 给添加的账号建引擎（0.63.0）：`kinds` 是能添加账号的种类；`create` 建一个只有这一个账号的同类引擎，凭据与会话放在 `root`
 * （`<数据目录>/accounts/<id>/`）下。引擎应当懒启动，同 engines.ts 的约定。
 */
export interface AccountEngineFactory {
  readonly kinds: readonly AccountKind[];
  create(kind: AccountKind, account: { id: string; root: string }): AgentRuntimeAdapter;
}

/** Host 的账号登记用它给添加的账号开、关引擎（accounts.ts）。 */
export interface AccountPool {
  readonly kinds: readonly AccountKind[];
  /** 建这个账号的引擎并挂上路由，返回它的账号接口（只有 `kind` 这一种）。 */
  open(kind: AccountKind, account: { id: string; root: string }): EngineAccounts;
  /** 停掉这个账号的引擎、去掉路由；没有时什么都不做。 */
  close(id: string): Promise<void>;
}

/** 权限模式的固定顺序，合并各引擎的模式时用。 */
const PERMISSION_ORDER: readonly PermissionMode[] = ['on_request', 'auto_review', 'full_access'];

export class EngineRouter implements AgentRuntimeAdapter {
  readonly mcpServers: boolean;
  readonly skills: boolean;
  readonly permissionModes?: readonly PermissionMode[];
  readonly additionalRoots?: boolean;
  readonly googleVertex?: boolean;
  readonly suggestedTasks?: boolean;
  readonly historyTool?: boolean;
  readonly appTools?: boolean;
  readonly planMode?: boolean;
  readonly branches?: boolean;
  readonly accounts?: EngineAccounts;
  /** 0.63.0：能给添加的账号开引擎时有（构造时给了 `accountEngines`）。 */
  readonly accountPool?: AccountPool;

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
  readonly ruleFiles?: AgentRuntimeAdapter['ruleFiles'];
  readonly bindEngineAppTools?: AgentRuntimeAdapter['bindEngineAppTools'];
  readonly deleteSession?: AgentRuntimeAdapter['deleteSession'];

  /** 全部引擎：构造时的，加上之后添加的账号的。 */
  readonly #routes: EngineRoute[];
  /** Provider 种类 → 引擎（不含只认 Provider ID 的路由）。 */
  readonly #byKind = new Map<ProviderKind, EngineRoute>();
  /** Provider ID → 认领它的路由（添加的账号）。 */
  readonly #claimed = new Map<string, EngineRoute>();
  /** Provider ID → 种类（`configureProviders` 时记下）。 */
  #kinds = new Map<string, ProviderKind>();
  /** 最近一次 `configureProviders` 的全部 Provider：后加的路由要分到它的那份。 */
  #providers: readonly ProviderConfig[] = [];
  #pluginSource: import('@wevir/runtime-adapter').EnginePluginSource | undefined;
  #appToolsGrant: Parameters<NonNullable<AgentRuntimeAdapter['bindEngineAppTools']>>[0] | undefined;
  /** 引擎会话 ID → 承载它的引擎。 */
  readonly #owners = new Map<string, EngineRoute>();

  constructor(
    routes: readonly EngineRoute[],
    options: { accountEngines?: AccountEngineFactory } = {},
  ) {
    if (routes.length === 0) throw new Error('EngineRouter needs at least one engine');
    this.#routes = [...routes];
    for (const route of routes) {
      if (route.providerIds !== undefined) {
        for (const id of route.providerIds) this.#claimed.set(id, route);
        continue;
      }
      for (const kind of route.kinds) {
        if (this.#byKind.has(kind)) throw new Error(`provider kind ${kind} has two engines`);
        this.#byKind.set(kind, route);
      }
    }
    const adapters = routes.map((route) => route.adapter);
    this.mcpServers = adapters.some((adapter) => adapter.mcpServers === true);
    this.skills = adapters.some((adapter) => adapter.skills === true);

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
      route.adapter.accounts === undefined || route.providerIds !== undefined
        ? []
        : [route.adapter.accounts],
    );
    if (accounts.length > 0) this.accounts = new MergedAccounts(accounts);
    const factory = options.accountEngines;
    if (factory !== undefined && factory.kinds.length > 0) {
      this.accountPool = {
        kinds: factory.kinds,
        open: (kind, account) => this.#openAccount(factory, kind, account),
        close: (id) => this.#closeAccount(id),
      };
    }

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
      // 问承载这个 Provider 的引擎；不认识的 Provider 当作不收。
      this.acceptsImages = (config) =>
        this.#routeOf(config.providerId)?.adapter.acceptsImages?.(config) === true;
    }
    if (adapters.some((adapter) => adapter.ruleFiles !== undefined)) {
      // 0.68.0：问承载这个 Provider 的引擎读哪些规则文件；不认识的 Provider 没有。
      this.ruleFiles = (providerId) => this.#routeOf(providerId)?.adapter.ruleFiles?.(providerId);
    }
    if (adapters.some((adapter) => adapter.bindEngineAppTools !== undefined)) {
      // 引擎令牌只认交给这个引擎的 Provider 种类：别的引擎的会话冒充不了。
      this.bindEngineAppTools = (grant) => {
        this.#appToolsGrant = grant;
        for (const route of this.#routes) bindAppTools(route, grant);
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
    if (adapters.some((adapter) => adapter.deleteSession !== undefined)) {
      // 0.43.0：删的多是 Host 重启后没挂过的会话，按挂着时的归属、否则按它最后用的 Provider 找引擎；引擎没有这个方法时报
      // `invalid_input`，Host 记为引擎数据留着。
      this.deleteSession = async (id, options) => {
        const route = this.#owners.get(id) ?? this.#forProvider(options.providerId);
        if (route.adapter.deleteSession === undefined) throw unsupported(route, 'deleteSession');
        await route.adapter.deleteSession(id, options);
        this.#owners.delete(id);
      };
    }
    if (adapters.some((adapter) => adapter.startGoal !== undefined)) {
      this.startGoal = async (id, request: GoalStartRequest) =>
        this.#method(id, 'startGoal').startGoal(id, request);
      this.updateGoal = async (id, status) => this.#method(id, 'updateGoal').updateGoal(id, status);
      this.clearGoal = async (id) => this.#method(id, 'clearGoal').clearGoal(id);
    }
  }

  /** 全部引擎（构造时的与添加的账号的）。 */
  get routes(): readonly EngineRoute[] {
    return this.#routes;
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
    const all = await Promise.all(
      this.#routes.map((route) => route.adapter.listPendingApprovals()),
    );
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
    this.#providers = providers;
    this.#kinds = new Map(providers.map((provider) => [provider.id, provider.kind]));
    await Promise.all(
      this.#routes.map((route) =>
        route.adapter.configureProviders?.(this.#providersFor(route, providers)),
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
    await Promise.all(this.#routes.map((route) => route.adapter.dispose()));
  }

  bindPlugins(source: import('@wevir/runtime-adapter').EnginePluginSource): void {
    this.#pluginSource = source;
    for (const route of this.#routes) route.adapter.bindPlugins?.(source);
  }
  async reloadPlugins(): Promise<void> {
    await Promise.all(this.#routes.map((route) => route.adapter.reloadPlugins?.()));
  }
  async listConnectorStatus() {
    return (
      await Promise.all(
        this.#routes.map(async (route) => (await route.adapter.listConnectorStatus?.()) ?? []),
      )
    ).flat();
  }

  /** 每种 Provider 的会话由哪个引擎跑、能做什么（0.25.0，`host.hello` 的 `engineFeatures`）。 */
  engineFeatures(): Record<string, EngineFeatures> {
    const features: Record<string, EngineFeatures> = {};
    for (const route of this.#routes) {
      if (route.providerIds !== undefined) continue;
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

  /** 承载这个 Provider 的引擎：认领了它的路由，否则按它的种类。 */
  #routeOf(providerId: string): EngineRoute | undefined {
    const claimed = this.#claimed.get(providerId);
    if (claimed !== undefined) return claimed;
    const kind = this.#kinds.get(providerId);
    return kind === undefined ? undefined : this.#byKind.get(kind);
  }

  /** 交给这个引擎的 Provider：认领的只有它们自己，按种类的是这些种类里没被别的路由认领的。 */
  #providersFor(route: EngineRoute, providers: readonly ProviderConfig[]): ProviderConfig[] {
    if (route.providerIds !== undefined) {
      const ids = route.providerIds;
      return providers.filter((provider) => ids.includes(provider.id));
    }
    return providers.filter(
      (provider) => route.kinds.includes(provider.kind) && !this.#claimed.has(provider.id),
    );
  }

  /**
   * 添加的账号的引擎（0.63.0）：同类引擎的新实例，只认这个账号的 Provider。之前给过的插件来源、应用级工具与 Provider
   * 都补给它；按种类的路由重新分一次 Provider，交出被认领的那个。
   */
  #openAccount(
    factory: AccountEngineFactory,
    kind: AccountKind,
    account: { id: string; root: string },
  ): EngineAccounts {
    if (this.#claimed.has(account.id)) throw new Error(`account ${account.id} is already open`);
    const adapter = factory.create(kind, account);
    if (adapter.accounts === undefined || !adapter.accounts.kinds.includes(kind)) {
      void adapter.dispose();
      throw new Error(`the ${kind} engine for account ${account.id} has no ${kind} account`);
    }
    const route: EngineRoute = {
      name: `${kind}:${account.id}`,
      adapter,
      kinds: [kind],
      providerIds: [account.id],
    };
    this.#routes.push(route);
    this.#claimed.set(account.id, route);
    if (this.#pluginSource !== undefined) adapter.bindPlugins?.(this.#pluginSource);
    if (this.#appToolsGrant !== undefined) bindAppTools(route, this.#appToolsGrant);
    if (this.#providers.length > 0) {
      void this.configureProviders(this.#providers).catch(() => {});
    }
    return adapter.accounts;
  }

  async #closeAccount(id: string): Promise<void> {
    const route = this.#claimed.get(id);
    if (route === undefined) return;
    this.#claimed.delete(id);
    this.#routes.splice(this.#routes.indexOf(route), 1);
    for (const [session, owner] of this.#owners) if (owner === route) this.#owners.delete(session);
    await route.adapter.dispose();
  }

  #forProvider(providerId: string): EngineRoute {
    const route = this.#routeOf(providerId);
    if (route !== undefined) return route;
    const kind = this.#kinds.get(providerId);
    // 不认识的 Provider：只有一个引擎时交给它，由它报错（与单引擎的 Host 相同）。
    if (this.#routes.length === 1 && this.#routes[0] !== undefined) return this.#routes[0];
    throw new AdapterError(
      'invalid_input',
      kind === undefined
        ? `unknown provider ${providerId}`
        : `no engine for ${kind} providers in this host`,
    );
  }

  /** 不认识的会话交给第一个引擎，由它报 `session_not_found`（`cancel` 等幂等的方法直接成功）。 */
  #forSession(engineSessionId: string): EngineRoute {
    return this.#owners.get(engineSessionId) ?? (this.#routes[0] as EngineRoute);
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

/** 引擎令牌只认交给这个引擎的 Provider 种类：别的引擎的会话冒充不了。 */
function bindAppTools(
  route: EngineRoute,
  grant: Parameters<NonNullable<AgentRuntimeAdapter['bindEngineAppTools']>>[0],
): void {
  route.adapter.bindEngineAppTools?.((kinds) =>
    grant(kinds.filter((kind) => route.kinds.includes(kind))),
  );
}

/** `EngineFeatures.commands` 的顺序（0.27.0），对应适配器的 `compact` / `review`。 */
const SESSION_COMMANDS = ['compact', 'review'] as const satisfies readonly SessionCommand[];

/** 一个引擎能做什么（0.25.0）：按适配器实现了哪些可选方法、声明了哪些能力；0.27.0 起总是带 `commands`。 */
export function engineFeaturesOf(name: string, adapter: AgentRuntimeAdapter): EngineFeatures {
  const commands = SESSION_COMMANDS.filter((command) => adapter[command] !== undefined);
  return {
    engine: name,
    mcpServers: adapter.mcpServers === true,
    skills: adapter.skills === true,
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
    ...(adapter.injectNote !== undefined && { undo: true }),
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
    if (parts.some((part) => part.upstreams !== undefined)) {
      this.upstreams = async (kind) => {
        const part = this.#part(kind);
        if (part.upstreams === undefined) {
          throw new AdapterError('invalid_input', `the ${kind} account has no upstreams`);
        }
        return part.upstreams(kind);
      };
    }
  }

  async read(kind: AccountKind, options?: { refresh?: boolean }): Promise<AccountState> {
    return this.#part(kind).read(kind, options);
  }

  async login(
    kind: AccountKind,
    method: 'browser' | 'device_code',
    options?: AccountLoginOptions,
  ): Promise<AccountState> {
    const part = this.#part(kind);
    // 只有实现了上游的引擎认 `upstream` 与 `apiKey`；别的引擎收到会悄悄忽略（用户以为 Key 存下了），所以在这里拒绝。
    // `option` 单独给时是 `loginOptions` 里的一项（WorkBuddy），由引擎自己核对。
    if (
      (options?.upstream !== undefined || options?.apiKey !== undefined) &&
      part.upstreams === undefined
    ) {
      throw new AdapterError('invalid_input', `the ${kind} account has no upstreams`);
    }
    return part.login(kind, method, options);
  }

  /** 有一个引擎的账号实现了上游，合并后的就实现（构造时定下）。 */
  upstreams?: (kind: AccountKind) => Promise<AccountUpstream[]>;

  async cancelLogin(kind: AccountKind, loginId?: string): Promise<AccountState> {
    return this.#part(kind).cancelLogin(kind, loginId);
  }

  async logout(kind: AccountKind, options?: { upstream?: string }): Promise<AccountState> {
    const part = this.#part(kind);
    if (options?.upstream !== undefined && part.upstreams === undefined) {
      throw new AdapterError('invalid_input', `the ${kind} account has no upstreams`);
    }
    return part.logout(kind, options);
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

  async refreshUsage(kind: AccountKind): Promise<void> {
    const part = this.#part(kind);
    if (part.refreshUsage !== undefined) await part.refreshUsage(kind);
    else await part.read(kind);
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
