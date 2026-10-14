import { AcpAdapter, type AdapterLogger } from '@wevir/adapter-acp';
import {
  AdapterError,
  type ProviderConfig,
  type ProviderIssue,
  type ProviderTestResult,
} from '@wevir/runtime-adapter';
import { DshProcess, type DshProcessOptions, type DshStreamTapOptions } from './dsh-process.js';
import { DSH_ENGINE } from './engine.js';
import {
  providerEnv,
  providerOverlayPath,
  renderProviderOverlay,
  validateProviderConfig,
  writeProviderOverlay,
} from './provider-config.js';
import { type ProviderTestOptions, testProvider } from './provider-test.js';

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

/**
 * dsh 的 `AgentRuntimeAdapter`（ADR-0001）：通用 ACP 适配器（`AcpAdapter`，会话、审批、事件映射与恢复，见
 * docs/architecture/acp-event-mapping.md 第一部分）按 `DSH_ENGINE` 驱动一个 `DshProcess`，这里只多出 Provider
 * 桥接与配置变更时的重启（第二部分）。
 *
 * Provider（T3.4，docs/architecture/providers.md）：`configureProviders` 把整套 Provider 写成
 * `<DSH_HOME>/wevir/providers.yml`（只含 Key 的变量名），Key 放进下一次 spawn 的环境。dsh 不热加载配置
 * （ADR-0001 补记 5），所以运行中的进程要重启才用上新配置：没有进行中的回合时立即重启，否则等最后一个回合
 * 结束再重启；挂着的会话先以 `engine.exited`（`config_changed`）脱开，之后 resume（T3.5）即用新配置。
 * 每个会话的路由（Provider 与模型）由 `AcpAdapter` 在 `session/new` 之后用 `session/set_config_option` 选定，
 * 编码见 `DSH_ROUTE`。
 */
export class DshAdapter extends AcpAdapter<DshProcess> {
  readonly #basePatches: readonly string[];
  readonly #baseEnv: Readonly<Record<string, string>>;
  readonly #providerTest: ProviderTestOptions | undefined;

  constructor(options: DshAdapterOptions) {
    const { streamTap, logger, cancelTimeoutMs, providers, providerTest, ...processOptions } =
      options;
    super({
      engine: DSH_ENGINE,
      logger,
      cancelTimeoutMs,
      createProcess: (hooks) =>
        new DshProcess({
          ...processOptions,
          onSessionUpdate: hooks.onSessionUpdate,
          onRequestPermission: hooks.onRequestPermission,
          ...(streamTap !== false && {
            streamTap: {
              ...streamTap,
              onEvent: hooks.onIncrementalEvent,
              onWarning: (warning) =>
                hooks.logger.warn(warning.message, {
                  kind: `stream_tap_${warning.kind}`,
                  ...(warning.line !== undefined && { line: warning.line }),
                }),
            },
          }),
        }),
    });
    this.#basePatches = processOptions.patches ?? [];
    this.#baseEnv = processOptions.env ?? {};
    this.#providerTest = providerTest;
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
    this.assertUsable();
    this.#writeProviders(providers);
    await this.#applyConfigIfIdle();
  }

  testProvider(provider: ProviderConfig, modelId: string): Promise<ProviderTestResult> {
    return testProvider(provider, modelId, this.#providerTest);
  }

  /** 配置换过、没有回合时先重启，新会话直接用新配置；有进行中的重启时等它完成。 */
  protected override async beforeActivation(): Promise<void> {
    await this.#applyConfigIfIdle();
  }

  /** 等这个回合结束的配置重启（configureProviders 时有回合在跑）。 */
  protected override afterTurn(): void {
    if (this.process.launchConfigStale) {
      this.#applyConfigIfIdle().catch((error: unknown) =>
        this.logger.warn('为应用新的 Provider 配置重启 dsh 失败', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  #writeProviders(all: readonly ProviderConfig[]): void {
    // ChatGPT 账号（R6）只有 Codex 引擎有：Host 换成 dsh 启动时库里可能还有这类 Provider，跳过。
    const providers = all.filter((provider) => provider.kind !== 'chatgpt');
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
   * 进程用的是旧配置且空闲（没有进行中的回合、没有进行中的 `createSession` / `resumeSession`）时重启它；
   * 否则什么都不做，等下一个回合结束或下一次 `createSession` / `resumeSession` 再看。
   */
  async #applyConfigIfIdle(): Promise<void> {
    const pending = this.pendingRestart;
    if (pending !== undefined) return pending;
    if (this.process.state !== 'ready' || !this.process.launchConfigStale) return;
    if (this.busy) return;
    return this.restartEngine('config_changed');
  }
}
