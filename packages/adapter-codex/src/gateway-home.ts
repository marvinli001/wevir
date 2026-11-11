import {
  GatewayPrivacyMasker,
  type ModelGateway,
  type RequestObservation,
  startModelGateway,
  testProvider,
  VertexTokenCache,
  validateProvider,
} from '@wevir/model-gateway';
import {
  AdapterError,
  type EnginePluginSource,
  type GatewayPrivacySource,
  type ProviderConfig,
} from '@wevir/runtime-adapter';
import { writeHistoryToolScript } from '@wevir/runtime-adapter/history-tool';
import { WEB_TOOL_TOKEN_ENV, writeWebToolScript } from '@wevir/runtime-adapter/web-tool';
import type { CodexAdapterLogger, CodexAdapterOptions } from './codex-adapter.js';
import type { CodexProcess, CodexSpawnSpec } from './codex-process.js';
import { renderConfigToml, renderModelCatalog, writeCodexConfig } from './config.js';
import { buildCodexEnv } from './env.js';
import {
  type CodexPaths,
  checkCodexVersion,
  codexPathDir,
  codexPaths,
  prepareCodexHome,
  resolveCodexBinary,
} from './paths.js';
import { CodexPluginFileState, effectivePlugins, pluginsToml } from './plugins.js';
import { BasePrompt, defaultPromptsDir } from './prompts.js';
import { writeSuggestTasksServer } from './suggest-tasks.js';

/** 网关进程共享的家目录、监听、令牌与配置写入。 */
export class GatewayHome {
  readonly paths: CodexPaths;
  readonly pluginsState = new CodexPluginFileState();
  readonly vertexAuth: VertexTokenCache;
  plugins: EnginePluginSource | undefined;
  privacySource: GatewayPrivacySource | undefined;
  gateway: ModelGateway | undefined;
  readonly #options: CodexAdapterOptions;
  readonly #logger: CodexAdapterLogger;
  readonly #prompt: BasePrompt;
  readonly #privacy = new GatewayPrivacyMasker({
    settings: () => this.privacySource?.settings(),
    secrets: () => this.privacySource?.secrets() ?? [],
  });
  readonly #observers = new Map<string | undefined, (observation: RequestObservation) => void>();
  #providers: readonly ProviderConfig[] = [];
  #binary: string | undefined;
  #versionChecked = false;
  #launching: Promise<unknown> = Promise.resolve();
  #baseToml: string | undefined;
  #catalog: string | undefined;

  constructor(
    options: CodexAdapterOptions,
    logger: CodexAdapterLogger = options.logger ?? {
      warn: (message, fields) => console.warn('[adapter-codex]', message, fields ?? ''),
    },
  ) {
    this.#options = options;
    this.#logger = logger;
    this.paths = codexPaths(options.home);
    this.#prompt = new BasePrompt(options.promptsDir ?? defaultPromptsDir());
    this.vertexAuth = new VertexTokenCache({
      fetch: options.gateway?.fetch ?? options.providerTest?.fetch,
    });
    this.#setProviders(options.providers ?? []);
  }

  observe(providerId: string | undefined, listener: (value: RequestObservation) => void) {
    this.#observers.set(providerId, listener);
    return () => {
      if (this.#observers.get(providerId) === listener) this.#observers.delete(providerId);
    };
  }

  catalog(): string | undefined {
    return renderModelCatalog(this.#providers, (vars) => this.#prompt.render(vars));
  }

  startProcess(process: CodexProcess): ReturnType<CodexProcess['start']> {
    // 首次建库的迁移不能重叠；握手后各进程的会话与回合仍可并发。
    const started = this.#launching.then(() => process.start());
    this.#launching = started.catch(() => {});
    return started;
  }

  validateProvider(provider: ProviderConfig) {
    const issues = validateProvider(provider);
    if (provider.models.length === 0)
      issues.push({ path: ['models'], message: '至少要有一个模型' });
    return issues;
  }

  testProvider(provider: ProviderConfig, modelId: string) {
    return testProvider(provider, modelId, {
      ...(this.#options.gateway?.deepseekBaseURL !== undefined && {
        deepseekBaseURL: this.#options.gateway.deepseekBaseURL,
      }),
      ...this.#options.providerTest,
      vertexAuth: this.vertexAuth,
    });
  }

  configureProviders(providers: readonly ProviderConfig[]): Promise<void> {
    return this.pluginsState.run(async () => {
      this.#setProviders(providers);
      if (this.gateway !== undefined) await this.#writeFiles();
    });
  }

  #setProviders(providers: readonly ProviderConfig[]): void {
    for (const provider of providers) {
      const issues = this.validateProvider(provider);
      if (issues.length > 0)
        throw new AdapterError(
          'invalid_input',
          `Provider ${provider.id}：${issues.map((i) => `${i.path.join('.')}：${i.message}`).join('；')}`,
        );
    }
    renderModelCatalog(providers, (vars) => this.#prompt.render(vars));
    this.#providers = [...providers];
    this.vertexAuth.retain(providers);
    this.gateway?.setProviders(providers);
  }

  prepare(): Promise<{
    spec: CodexSpawnSpec;
    catalog: string | undefined;
    webRegistered: boolean;
  }> {
    return this.pluginsState.run(async () => {
      prepareCodexHome(this.paths);
      this.#binary ??= this.#options.binary ?? resolveCodexBinary({ env: this.#options.parentEnv });
      const binary = this.#binary;
      const binaryArgs = this.#options.binaryArgs ?? [];
      const baseEnv = {
        codexHome: this.paths.codexHome,
        packagePathDir: codexPathDir(binary),
        parent: this.#options.parentEnv,
        rustLog: this.#options.rustLog,
      };
      if (!this.#versionChecked) {
        await checkCodexVersion(binary, buildCodexEnv(baseEnv), binaryArgs);
        this.#versionChecked = true;
      }
      if (this.gateway === undefined) {
        this.gateway = await startModelGateway({
          ...this.#options.gateway,
          privacy: this.#options.gateway?.privacy ?? this.#privacy,
          vertexAuth: this.vertexAuth,
          logger: {
            info: (message, fields) => this.#logger.info?.(message, fields),
            warn: (message, fields) => this.#logger.warn(message, fields),
          },
          onRequest: (observation) => {
            const observer =
              this.#observers.get(observation.providerId) ?? this.#observers.get(undefined);
            observer?.(observation);
            this.#options.gateway?.onRequest?.(observation);
          },
        });
        this.#logger.addSecret?.(this.gateway.token);
        this.gateway.setProviders(this.#providers);
      }
      const { catalog, webEndpoint } = await this.#writeFiles();
      return {
        catalog,
        webRegistered: webEndpoint !== undefined,
        spec: {
          command: binary,
          args: [...binaryArgs, '--strict-config'],
          options: {
            cwd: this.paths.codexHome,
            env: buildCodexEnv({
              ...baseEnv,
              gatewayToken: this.gateway.token,
              ...(webEndpoint !== undefined && {
                extra: { [WEB_TOOL_TOKEN_ENV]: webEndpoint.token },
              }),
            }),
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            windowsHide: true,
          },
        },
      };
    });
  }

  async #writeFiles() {
    const plugins = await this.plugins?.read();
    for (const secret of plugins?.secrets ?? []) this.#logger.addSecret?.(secret);
    for (const item of plugins?.connectors ?? [])
      for (const value of Object.values(
        item.config.transport === 'stdio' ? (item.config.env ?? {}) : (item.config.headers ?? {}),
      ))
        this.#logger.addSecret?.(value);
    const suggestTasks = writeSuggestTasksServer(this.paths.codexHome, this.#options.mcpNode);
    if (this.#options.historyTool !== undefined) writeHistoryToolScript(this.#options.historyTool);
    const webServer = this.#options.webTool;
    const webEndpoint = webServer?.endpoint();
    const webTool =
      webServer === undefined || webEndpoint === undefined
        ? undefined
        : { server: webServer, endpoint: webEndpoint };
    if (webTool !== undefined) writeWebToolScript(webTool.server);
    const catalog = this.catalog();
    const gateway = this.gateway;
    if (gateway === undefined) throw new Error('网关尚未启动');
    const baseToml = renderConfigToml({
      providers: this.#providers,
      gatewayBaseURL: (id) => gateway.baseURL(id),
      ...(catalog !== undefined && { catalogFile: this.paths.catalogFile }),
      providerExtra: this.#options.providerExtra,
      suggestTasks,
      historyTool: this.#options.historyTool,
      webTool,
    });
    const fingerprint =
      plugins === undefined
        ? ''
        : JSON.stringify(effectivePlugins(plugins, this.pluginsState.discoveredSkills));
    if (
      baseToml !== this.#baseToml ||
      catalog !== this.#catalog ||
      fingerprint !== this.pluginsState.fingerprint
    ) {
      const changed = writeCodexConfig(
        this.paths,
        pluginsToml(baseToml, plugins, this.pluginsState.discoveredSkills),
        catalog,
      );
      this.#baseToml = baseToml;
      this.#catalog = catalog;
      this.pluginsState.fingerprint = fingerprint;
      this.pluginsState.names = new Set(plugins?.connectors.map((item) => item.name) ?? []);
      if (changed) this.pluginsState.revision += 1;
    }
    return { catalog, webEndpoint };
  }

  dispose(): Promise<void> {
    return this.pluginsState.run(async () => {
      const gateway = this.gateway;
      this.gateway = undefined;
      await gateway?.close();
      this.vertexAuth.close();
      this.#observers.clear();
    });
  }
}
