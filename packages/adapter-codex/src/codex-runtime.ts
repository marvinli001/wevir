import type {
  AgentEvent,
  AgentInput,
  AgentRuntimeAdapter,
  ApprovalDecision,
  CancelOptions,
  EngineAccounts,
  EngineSession,
  PendingApproval,
  PermissionMode,
  ProviderConfig,
  ProviderIssue,
  ProviderTestResult,
  ReviewRequest,
  SessionConfig,
  TitleRequest,
} from '@wevir/runtime-adapter';
import { CodexAdapter, type CodexAdapterOptions, PERMISSION_MODES } from './codex-adapter.js';

export type CodexRuntimeOptions = Omit<CodexAdapterOptions, 'mode'>;

/**
 * Host 用的 Codex 引擎（ADR-0005 补记 10，codex-event-mapping.md §8）：两个 codex-app-server 进程，各是一个
 * `CodexAdapter`。
 *
 * - **网关进程**（`engines/codex`）：经网关的 Provider，带 Wevir 生成的模型目录（apply_patch、上下文、base.md）。
 * - **ChatGPT 进程**（`engines/codex-chatgpt`）：`chatgpt` 类 Provider，Codex 内置的 openai Provider 与它自己的模型目录，
 *   登录凭据只在这里；`accounts` 就是它的账号。第一次用到账号或 ChatGPT 会话时才启动。
 *
 * 分成两个进程是因为 `model_catalog_json` 一设就整体替换 Codex 的模型目录（`model/list` 只剩 Wevir 的模型，OpenAI 模型
 * 拿不到为它们调好的元数据），而目录只在进程启动时读一次（R6 实测）。会话按 Provider 的种类交给其中一个，之后的调用按
 * 引擎会话 ID 找回它（子会话由派出它的那个进程认出）。
 */
export class CodexRuntime implements AgentRuntimeAdapter {
  /** 两个进程都是 CodexAdapter，权限模式相同（0.11.0）。 */
  readonly permissionModes: readonly PermissionMode[] = PERMISSION_MODES;
  /** 环境会话的额外目录（0.15.0）。 */
  readonly additionalRoots = true;
  readonly suggestedTasks = true;
  readonly googleVertex = true;
  /** 读历史的工具（0.25.0）：给了 `historyTool` 时两个进程都登记。 */
  readonly historyTool: boolean;
  readonly gateway: CodexAdapter;
  readonly chatgpt: CodexAdapter;
  readonly accounts: EngineAccounts;
  /** Provider ID → 种类（`configureProviders` 时记下）。 */
  #kinds = new Map<string, ProviderConfig['kind']>();
  /** 引擎会话 ID → 承载它的进程。 */
  readonly #owners = new Map<string, CodexAdapter>();

  constructor(options: CodexRuntimeOptions) {
    const providers = options.providers ?? [];
    this.gateway = new CodexAdapter({
      ...options,
      mode: 'gateway',
      providers: providers.filter((provider) => provider.kind !== 'chatgpt'),
    });
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
    const session = await adapter.createSession(config);
    this.#owners.set(session.engineSessionId, adapter);
    return session;
  }

  async resumeSession(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    const adapter = this.#forProvider(config.providerId);
    const session = await adapter.resumeSession(engineSessionId, config);
    this.#owners.set(engineSessionId, adapter);
    return session;
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

  respondToQuestion(
    engineSessionId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    return this.#forSession(engineSessionId).respondToQuestion(engineSessionId, requestId, answers);
  }

  configureSession(
    engineSessionId: string,
    config: { modelId: string; reasoningEffort?: string; permissionMode?: PermissionMode },
  ): Promise<void> {
    return this.#forSession(engineSessionId).configureSession(engineSessionId, config);
  }

  async fork(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    const adapter = this.#forSession(engineSessionId);
    const session = await adapter.fork(engineSessionId, config);
    this.#owners.set(session.engineSessionId, adapter);
    return session;
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
    const [gateway, chatgpt] = await Promise.all([
      this.gateway.listPendingApprovals(),
      this.chatgpt.listPendingApprovals(),
    ]);
    return [...gateway, ...chatgpt];
  }

  cancel(engineSessionId: string, options?: CancelOptions): Promise<void> {
    return this.#forSession(engineSessionId).cancel(engineSessionId, options);
  }

  close(engineSessionId: string): Promise<void> {
    return this.#forSession(engineSessionId).close(engineSessionId);
  }

  generateTitle(engineSessionId: string, request: TitleRequest): Promise<string> {
    return this.#forSession(engineSessionId).generateTitle(engineSessionId, request);
  }

  validateProvider(provider: ProviderConfig): ProviderIssue[] {
    return (provider.kind === 'chatgpt' ? this.chatgpt : this.gateway).validateProvider(provider);
  }

  async configureProviders(providers: readonly ProviderConfig[]): Promise<void> {
    this.#rememberKinds(providers);
    await Promise.all([
      this.gateway.configureProviders(providers.filter((provider) => provider.kind !== 'chatgpt')),
      this.chatgpt.configureProviders(providers.filter((provider) => provider.kind === 'chatgpt')),
    ]);
  }

  testProvider(provider: ProviderConfig, modelId: string): Promise<ProviderTestResult> {
    return (provider.kind === 'chatgpt' ? this.chatgpt : this.gateway).testProvider(
      provider,
      modelId,
    );
  }

  async dispose(): Promise<void> {
    await Promise.all([this.gateway.dispose(), this.chatgpt.dispose()]);
  }

  #rememberKinds(providers: readonly ProviderConfig[]): void {
    this.#kinds = new Map(providers.map((provider) => [provider.id, provider.kind]));
  }

  /** 不认识的 Provider 交给网关进程，由它报 `invalid_input`。 */
  #forProvider(providerId: string): CodexAdapter {
    return this.#kinds.get(providerId) === 'chatgpt' ? this.chatgpt : this.gateway;
  }

  /** 不认识的会话交给网关进程，由它报 `session_not_found`（`cancel` 等幂等的方法直接成功）。 */
  #forSession(engineSessionId: string): CodexAdapter {
    const owner = this.#owners.get(engineSessionId);
    if (owner !== undefined) return owner;
    // 子会话由派出它的进程认出，不经这里登记。
    return this.chatgpt.hasSession(engineSessionId) ? this.chatgpt : this.gateway;
  }
}
