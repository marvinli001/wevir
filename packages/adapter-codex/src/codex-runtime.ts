import {
  AdapterError,
  type AgentEvent,
  type AgentInput,
  type AgentRuntimeAdapter,
  type ApprovalDecision,
  type CancelOptions,
  type EngineAccounts,
  type EngineGoal,
  type EnginePluginSource,
  type EngineRuleFiles,
  type EngineSession,
  type EngineToolEnforcement,
  type ForkOptions,
  type GatewayPrivacySource,
  type GoalStartRequest,
  type PendingApproval,
  type PermissionMode,
  type ProviderConfig,
  type ProviderIssue,
  type ProviderTestResult,
  type ReviewRequest,
  type SessionConfig,
  type TitleRequest,
  type UserQuestion,
} from '@wevir/runtime-adapter';
import {
  CODEX_RULE_FILES,
  CODEX_TOOL_ENFORCEMENT,
  CodexAdapter,
  type CodexAdapterOptions,
  PERMISSION_MODES,
} from './codex-adapter.js';
import { GatewayHome } from './gateway-home.js';

export type CodexRuntimeOptions = Omit<
  CodexAdapterOptions,
  'mode' | 'gatewayHome' | 'providerId'
> & {
  /** 测试用：生产固定为 30 分钟。 */
  idleTimeoutMs?: number;
};

export const GATEWAY_IDLE_TIMEOUT_MS = 30 * 60_000;

/**
 * 网关服务商各用一个懒启动的 CodexAdapter，共用 GatewayHome 的家目录、模型目录和网关。
 * ChatGPT 账号保留独立进程与家目录，使用 Codex 自己的模型目录和登录凭据（codex-event-mapping.md §8）。
 * 会话按服务商路由，子会话由派出它的进程认出；网关进程无会话和请求持续 30 分钟后回收。
 */
export class CodexRuntime implements AgentRuntimeAdapter {
  readonly mcpServers = true;
  readonly skills = true;
  /** 各进程都是 CodexAdapter，权限模式相同（0.11.0）。 */
  readonly permissionModes: readonly PermissionMode[] = PERMISSION_MODES;
  /** 环境会话的额外目录（0.15.0）。 */
  readonly additionalRoots = true;
  readonly suggestedTasks = true;
  /** 应用级工具（0.30.0）：各进程都按 thread 挂上。 */
  readonly appTools = true;
  /** 角色关掉的引擎工具：各进程都是 CodexAdapter。 */
  readonly engineToolEnforcement: EngineToolEnforcement = CODEX_TOOL_ENFORCEMENT;
  /** 计划模式（0.36.0）：各进程都是 Codex 的协作模式。 */
  readonly planMode = true;
  /** 分支到新会话（0.38.0）：各进程都是 `thread/fork`。 */
  readonly branches = true;
  /** 换目录（0.81.0）：各进程都是 `thread/resume` 带新的 `cwd`。 */
  readonly relocatable = true;
  readonly googleVertex = true;
  /** 读历史的工具（0.25.0）：给了 `historyTool` 时各进程都登记。 */
  readonly historyTool: boolean;
  readonly gatewayHome: GatewayHome;
  readonly #pool = new Map<string, CodexAdapter>();
  readonly #options: CodexRuntimeOptions;
  readonly #idleTimers = new Map<string, NodeJS.Timeout>();
  readonly #operations = new Map<CodexAdapter, number>();
  readonly #retiring = new Set<Promise<void>>();
  #stopping = false;
  #plugins: EnginePluginSource | undefined;
  #disposed: Promise<void> | undefined;
  #gatewayProviders: readonly ProviderConfig[] = [];
  readonly chatgpt: CodexAdapter;
  readonly accounts: EngineAccounts;
  /** Provider ID → 种类（`configureProviders` 时记下）。 */
  #kinds = new Map<string, ProviderConfig['kind']>();
  /** 引擎会话 ID → 承载它的进程。 */
  readonly #owners = new Map<string, CodexAdapter>();

  constructor(options: CodexRuntimeOptions) {
    const providers = options.providers ?? [];
    this.#options = options;
    this.#gatewayProviders = providers.filter((provider) => provider.kind !== 'chatgpt');
    this.gatewayHome = new GatewayHome({ ...options, providers: this.#gatewayProviders });
    this.chatgpt = new CodexAdapter({
      ...options,
      mode: 'chatgpt',
      providers: providers.filter((provider) => provider.kind === 'chatgpt'),
    });
    if (this.chatgpt.accounts === undefined) throw new Error('ChatGPT 进程没有账号');
    this.historyTool = options.historyTool !== undefined;
    this.accounts = this.chatgpt.accounts;
    this.#rememberKinds(providers);
  }

  async createSession(config: SessionConfig): Promise<EngineSession> {
    const adapter = this.#forProvider(config.providerId);
    return this.#using(adapter, async () => {
      const session = await adapter.createSession(config);
      this.#owners.set(session.engineSessionId, adapter);
      return session;
    });
  }

  get gatewayAdapters(): ReadonlyMap<string, CodexAdapter> {
    return this.#pool;
  }

  /**
   * 规则文件（0.68.0）与用户的说明（0.78.0）：各进程读的一样（`CODEX_RULE_FILES`），补给的经 `SessionConfig.ruleInstructions`
   * 进 thread 的 `developerInstructions`。
   */
  ruleFiles(): EngineRuleFiles {
    return CODEX_RULE_FILES;
  }

  /** 护栏（0.86.0）：各进程都把会话的 hooks 挂在 thread 上。 */
  hookDialect(): 'codex' {
    return 'codex';
  }

  bindGatewayPrivacy(source: GatewayPrivacySource): void {
    this.gatewayHome.privacySource = source;
  }

  bindPlugins(source: EnginePluginSource): void {
    this.#plugins = source;
    this.gatewayHome.plugins = source;
    for (const adapter of this.#pool.values()) adapter.bindPlugins(source);
    this.chatgpt.bindPlugins(source);
  }

  async reloadPlugins(): Promise<void> {
    await Promise.all(
      [...this.#pool.values(), this.chatgpt]
        .filter((adapter) => adapter.process.state === 'ready')
        .map((adapter) => this.#using(adapter, () => adapter.reloadPlugins())),
    );
  }

  async listConnectorStatus() {
    const gateways = [...this.#pool.values()].filter(
      (adapter) => adapter.process.state === 'ready',
    );
    const statuses = (
      await Promise.all([
        ...gateways.map((adapter, index) =>
          this.#using(adapter, () => adapter.listConnectorStatus(index === 0)),
        ),
        this.chatgpt.listConnectorStatus(),
      ])
    ).flat();
    const unique = new Map<string, (typeof statuses)[number]>();
    for (const status of statuses) {
      if (!unique.has(status.name) || status.status === 'connected')
        unique.set(status.name, status);
    }
    return [...unique.values()];
  }

  async resumeSession(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    const adapter = this.#forProvider(config.providerId);
    return this.#using(adapter, async () => {
      const session = await adapter.resumeSession(engineSessionId, config);
      this.#owners.set(engineSessionId, adapter);
      return session;
    });
  }

  canResumeExternalSession(
    origin: { app: 'claude' | 'codex'; externalId: string; path: string },
    config: SessionConfig,
  ): Promise<boolean> {
    return this.#forProvider(config.providerId).canResumeExternalSession(origin, config);
  }

  subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    return this.#forSession(engineSessionId).subscribe(engineSessionId);
  }

  /** 图片（0.28.0）：问承载这类 Provider 的进程。 */
  acceptsImages(config: { providerId: string; modelId: string }): boolean {
    return this.#forProvider(config.providerId).acceptsImages(config);
  }

  send(engineSessionId: string, input: AgentInput): Promise<void> {
    return this.#forSession(engineSessionId).send(engineSessionId, input);
  }

  compact(engineSessionId: string): Promise<void> {
    return this.#forSession(engineSessionId).compact(engineSessionId);
  }

  review(engineSessionId: string, request: ReviewRequest): Promise<void> {
    return this.#forSession(engineSessionId).review(engineSessionId, request);
  }

  startGoal(engineSessionId: string, request: GoalStartRequest): Promise<void> {
    return this.#forSession(engineSessionId).startGoal(engineSessionId, request);
  }

  updateGoal(engineSessionId: string, status: 'active' | 'paused'): Promise<EngineGoal> {
    return this.#forSession(engineSessionId).updateGoal(engineSessionId, status);
  }

  clearGoal(engineSessionId: string): Promise<boolean> {
    return this.#forSession(engineSessionId).clearGoal(engineSessionId);
  }

  respondToQuestion(
    engineSessionId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    return this.#forSession(engineSessionId).respondToQuestion(engineSessionId, requestId, answers);
  }

  /** 不挂起回合的提问的回答（0.156.0）：只按参数拼，交给哪个进程都一样。 */
  formatAsyncAnswer(
    engineSessionId: string,
    questions: UserQuestion[],
    answers: Record<string, string[]>,
  ): string {
    return this.#forSession(engineSessionId).formatAsyncAnswer(engineSessionId, questions, answers);
  }

  configureSession(
    engineSessionId: string,
    config: { modelId: string; reasoningEffort?: string; permissionMode?: PermissionMode },
  ): Promise<void> {
    return this.#forSession(engineSessionId).configureSession(engineSessionId, config);
  }

  async fork(
    engineSessionId: string,
    config: SessionConfig,
    options?: ForkOptions,
  ): Promise<EngineSession> {
    const adapter = this.#forSession(engineSessionId);
    const session = await adapter.fork(engineSessionId, config, options);
    this.#owners.set(session.engineSessionId, adapter);
    return session;
  }

  rewind(engineSessionId: string): Promise<void> {
    return this.#forSession(engineSessionId).rewind(engineSessionId);
  }

  injectNote(engineSessionId: string, text: string): Promise<void> {
    return this.#forSession(engineSessionId).injectNote(engineSessionId, text);
  }

  steer(engineSessionId: string, steerId: string, input: AgentInput): Promise<void> {
    return this.#forSession(engineSessionId).steer(engineSessionId, steerId, input);
  }

  respondToApproval(
    engineSessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    return this.#forSession(engineSessionId).respondToApproval(
      engineSessionId,
      requestId,
      decision,
    );
  }

  async listPendingApprovals(engineSessionId?: string): Promise<PendingApproval[]> {
    if (engineSessionId !== undefined) {
      return this.#forSession(engineSessionId).listPendingApprovals(engineSessionId);
    }
    return (
      await Promise.all(
        [...this.#pool.values(), this.chatgpt].map((adapter) => adapter.listPendingApprovals()),
      )
    ).flat();
  }

  cancel(engineSessionId: string, options?: CancelOptions): Promise<void> {
    return (
      this.#findSession(engineSessionId)?.cancel(engineSessionId, options) ?? Promise.resolve()
    );
  }

  async close(engineSessionId: string): Promise<void> {
    const adapter = this.#forSession(engineSessionId);
    await adapter.close(engineSessionId);
    this.#scheduleIdle(adapter);
  }

  holdsIdleWork(engineSessionId: string): Promise<boolean> {
    return this.#forSession(engineSessionId).holdsIdleWork(engineSessionId);
  }

  generateTitle(engineSessionId: string, request: TitleRequest): Promise<string> {
    return this.#forSession(engineSessionId).generateTitle(engineSessionId, request);
  }

  validateProvider(provider: ProviderConfig): ProviderIssue[] {
    return provider.kind === 'chatgpt'
      ? this.chatgpt.validateProvider(provider)
      : this.gatewayHome.validateProvider(provider);
  }

  async configureProviders(providers: readonly ProviderConfig[]): Promise<void> {
    this.#assertUsable();
    for (const provider of providers) {
      const issues = this.validateProvider(provider);
      if (issues.length > 0)
        throw new AdapterError(
          'invalid_input',
          `Provider ${provider.id}：${issues.map((i) => i.message).join('；')}`,
        );
    }
    const gatewayProviders = providers.filter((provider) => provider.kind !== 'chatgpt');
    await this.gatewayHome.configureProviders(gatewayProviders);
    this.#gatewayProviders = gatewayProviders;
    this.#rememberKinds(providers);
    await this.chatgpt.configureProviders(
      providers.filter((provider) => provider.kind === 'chatgpt'),
    );
    await Promise.all(
      [...this.#pool].map(async ([id, adapter]) => {
        if (this.#kinds.has(id)) await adapter.configureProviders(gatewayProviders);
        this.#scheduleIdle(adapter);
      }),
    );
  }

  testProvider(provider: ProviderConfig, modelId: string): Promise<ProviderTestResult> {
    return provider.kind === 'chatgpt'
      ? this.chatgpt.testProvider(provider, modelId)
      : this.gatewayHome.testProvider(provider, modelId);
  }

  dispose(): Promise<void> {
    this.#stopping = true;
    this.#disposed ??= (async () => {
      for (const timer of this.#idleTimers.values()) clearTimeout(timer);
      this.#idleTimers.clear();
      const adapters = new Set([...this.#pool.values(), this.chatgpt, ...this.#operations.keys()]);
      await Promise.all([...adapters].map((adapter) => adapter.dispose()));
      await Promise.all(this.#retiring);
      this.#pool.clear();
      this.#owners.clear();
      await this.gatewayHome.dispose();
    })();
    return this.#disposed;
  }

  #rememberKinds(providers: readonly ProviderConfig[]): void {
    this.#kinds = new Map(providers.map((provider) => [provider.id, provider.kind]));
  }

  async deleteSession(engineSessionId: string, options: { providerId: string }): Promise<void> {
    this.#assertUsable();
    const owner = this.#findSession(engineSessionId);
    const providerId = this.#kinds.has(options.providerId)
      ? options.providerId
      : this.#gatewayProviders[0]?.id;
    const adapter =
      owner ??
      (providerId !== undefined
        ? this.#forProvider(providerId)
        : new CodexAdapter({ ...this.#options, providers: [], gatewayHome: this.gatewayHome }));
    try {
      await this.#using(adapter, () => adapter.deleteSession(engineSessionId));
      this.#owners.delete(engineSessionId);
    } finally {
      if (owner === undefined && providerId === undefined) await adapter.dispose();
    }
  }

  #forProvider(providerId: string): CodexAdapter {
    this.#assertUsable();
    const kind = this.#kinds.get(providerId);
    if (kind === undefined)
      throw new AdapterError('invalid_input', `Codex 没有 Provider ${providerId}`);
    if (kind === 'chatgpt') return this.chatgpt;
    let adapter = this.#pool.get(providerId);
    if (adapter === undefined) {
      adapter = new CodexAdapter({
        ...this.#options,
        mode: 'gateway',
        providers: this.#gatewayProviders,
        gatewayHome: this.gatewayHome,
        providerId,
      });
      if (this.#plugins !== undefined) adapter.bindPlugins(this.#plugins);
      this.#pool.set(providerId, adapter);
      const current = adapter;
      adapter.process.on('activity', () => this.#scheduleIdle(current));
      adapter.process.on('ready', () => this.#scheduleIdle(current));
      adapter.process.on('exit', () => this.#scheduleIdle(current));
    }
    return adapter;
  }

  #findSession(engineSessionId: string): CodexAdapter | undefined {
    return (
      this.#owners.get(engineSessionId) ??
      [...this.#pool.values(), this.chatgpt].find((adapter) => adapter.hasSession(engineSessionId))
    );
  }

  #forSession(engineSessionId: string): CodexAdapter {
    this.#assertUsable();
    const adapter = this.#findSession(engineSessionId);
    if (adapter === undefined)
      throw new AdapterError('session_not_found', `Codex 没有会话 ${engineSessionId}`);
    return adapter;
  }

  #scheduleIdle(adapter: CodexAdapter): void {
    const entry = [...this.#pool].find(([, candidate]) => candidate === adapter);
    if (entry === undefined || this.#stopping) return;
    const [providerId] = entry;
    clearTimeout(this.#idleTimers.get(providerId));
    this.#idleTimers.delete(providerId);
    if (!adapter.idle || (this.#operations.get(adapter) ?? 0) > 0) return;
    const timer = setTimeout(
      () => {
        this.#idleTimers.delete(providerId);
        if (!adapter.idle) {
          this.#scheduleIdle(adapter);
          return;
        }
        this.#pool.delete(providerId);
        for (const [id, owner] of this.#owners) if (owner === adapter) this.#owners.delete(id);
        const retiring = adapter.dispose();
        this.#retiring.add(retiring);
        void retiring
          .finally(() => this.#retiring.delete(retiring))
          .catch((error: unknown) =>
            this.#options.logger?.warn('回收空闲 Codex 进程失败', {
              providerId,
              error: String(error),
            }),
          );
      },
      this.#kinds.has(providerId) ? (this.#options.idleTimeoutMs ?? GATEWAY_IDLE_TIMEOUT_MS) : 0,
    );
    timer.unref();
    this.#idleTimers.set(providerId, timer);
  }

  async #using<T>(adapter: CodexAdapter, action: () => Promise<T>): Promise<T> {
    this.#operations.set(adapter, (this.#operations.get(adapter) ?? 0) + 1);
    this.#scheduleIdle(adapter);
    try {
      return await action();
    } finally {
      const remaining = (this.#operations.get(adapter) ?? 1) - 1;
      if (remaining === 0) this.#operations.delete(adapter);
      else this.#operations.set(adapter, remaining);
      this.#scheduleIdle(adapter);
    }
  }

  #assertUsable(): void {
    if (this.#stopping) throw new AdapterError('disposed', 'Codex 运行时已释放');
  }
}
