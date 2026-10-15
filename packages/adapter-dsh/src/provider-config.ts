import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ProviderCompatConfig,
  ProviderConfig,
  ProviderIssue,
  ProviderModelConfig,
} from '@wevir/runtime-adapter';
import type { DshPaths } from './paths.js';

// ProviderConfig → dsh 的 `--patch` overlay 与子进程环境（T3.4，docs/architecture/providers.md）。
// overlay 只写 `apiKeyEnv` 变量名，Key 只进子进程环境（ADR-0001 §4，AGENTS.md 规则 5）。
// 字段依据 dsh 0.2.1-alpha.2 的 docs/config-catalog.zh.md（dsh-llm-pi-ai、dsh-llm-deepseek-api-key）。

/** DeepSeek 官方路由：`llm-deepseek` 注册的固定路由名（kind `deepseek-official` 的 Profile 只能用它作 ID）。 */
export const DEEPSEEK_OFFICIAL = 'deepseek-official';

/**
 * dsh 里已被别的适配器占用的路由名，`openai-compatible` 不能用：pi-ai 再注册同名路由会以
 * `DUPLICATE_ADAPTER` 让 dsh 启动失败（llm-deepseek README）。
 */
export const RESERVED_PROVIDER_IDS: readonly string[] = [DEEPSEEK_OFFICIAL, 'deepseek-account'];

/**
 * `deepseek-official` 不列模型时 dsh 自带的目录（llm-deepseek 0.2.1-alpha.2 的默认 `models`）。ACP 的模型选项
 * 只认目录里的模型，所以这时 `defaultModelId` 必须是其中之一。
 */
export const DSH_DEEPSEEK_MODELS: readonly string[] = ['deepseek-flash', 'deepseek-v4-pro'];

/** pi-ai 的推理档位（`ModelThinkingLevel`）。 */
export const REASONING_LEVELS: readonly string[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** Wevir 支持的 OpenAI 兼容协议。`anthropic-messages` 只预留类型，暂不生成配置。 */
export const SUPPORTED_APIS: readonly string[] = ['openai-completions', 'openai-responses'];

/**
 * 只有 Codex 引擎的模型网关用的 compat 开关（protocol 0.4.0、0.12.0，ADR-0005 补记 7、12）。dsh 不认识它们，写进 overlay 会让
 * dsh 拒绝整份配置，所以既不报错也不写进 overlay：同一个 Provider 在两个引擎之间可以共用。
 */
export const GATEWAY_ONLY_COMPAT = Object.freeze([
  'supportsCustomTools',
  'supportsNamespaceTools',
  'toolChoice',
  'systemMessageMode',
] as const);
type GatewayOnlyCompat = (typeof GATEWAY_ONLY_COMPAT)[number];

/**
 * 每个 compat 开关能用在哪些协议上（`PiAiCompatProfile` 的注释）。路由上写了一个所有模型都读不了的开关，
 * dsh 会拒绝整份配置、启动失败，所以这里先挡住。只有网关用的开关不在表里（`GATEWAY_ONLY_COMPAT`）。
 */
export const COMPAT_APIS: Readonly<
  Record<Exclude<keyof ProviderCompatConfig, GatewayOnlyCompat>, readonly string[]>
> = {
  supportsDeveloperRole: ['openai-completions', 'openai-responses'],
  maxTokensField: ['openai-completions'],
  thinkingFormat: ['openai-completions'],
  requiresReasoningContentOnAssistantMessages: ['openai-completions'],
};

/** 给 dsh 的 Key 环境变量名：`WEVIR_PROVIDER_<ID>_KEY`，ID 转大写、`-` 换成 `_`（domain-model.md §3.2）。 */
export function providerKeyEnv(providerId: string): string {
  return `WEVIR_PROVIDER_${providerId.toUpperCase().replaceAll('-', '_')}_KEY`;
}

/** 是不是 OpenAI 官方地址：pi-ai 按 OpenAI 自己的规则拼请求，只有官方地址不需要默认的 compat 修正。 */
export function isOpenAIOfficial(baseURL: string): boolean {
  return hostnameOf(baseURL) === 'api.openai.com';
}

/** 是不是 DeepSeek 的地址（`api.deepseek.com` 及其子域）。 */
export function isDeepSeekHost(baseURL: string): boolean {
  return /(^|\.)deepseek\.com$/.test(hostnameOf(baseURL));
}

/**
 * `openai-compatible` 实际写进 overlay 的 compat：用户给的值优先，其余按地址补默认值，只补该协议认的开关。
 * - 不是 OpenAI 官方地址：`supportsDeveloperRole: false`、`maxTokensField: max_tokens`（多数网关不认
 *   `developer` 角色与 `max_completion_tokens`，dsh providers.md「Request compatibility」）。
 * - DeepSeek 的 OpenAI 兼容端点：另加 `thinkingFormat: deepseek` 与
 *   `requiresReasoningContentOnAssistantMessages: true`（T0.3 §6.2，取自 pi-ai 自带的 deepseek 目录）。
 */
export function effectiveCompat(provider: ProviderConfig): ProviderCompatConfig {
  const api = provider.api ?? '';
  const baseURL = provider.baseURL ?? '';
  const defaults: ProviderCompatConfig = {};
  if (!isOpenAIOfficial(baseURL)) {
    defaults.supportsDeveloperRole = false;
    defaults.maxTokensField = 'max_tokens';
  }
  if (isDeepSeekHost(baseURL)) {
    defaults.thinkingFormat = 'deepseek';
    defaults.requiresReasoningContentOnAssistantMessages = true;
  }
  const merged: ProviderCompatConfig = { ...defaults, ...definedOnly(provider.compat ?? {}) };
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (COMPAT_APIS[key as keyof typeof COMPAT_APIS]?.includes(api)) result[key] = value;
  }
  return result as ProviderCompatConfig;
}

/**
 * dsh 会拒绝、或会让 Wevir 用不了的配置。dsh 在启动时校验 overlay，任何一处不合法都会让整个进程起不来
 * （所有会话都受影响），所以 Host 在写库之前调用它（`AgentRuntimeAdapter.validateProvider`）。
 */
export function validateProviderConfig(provider: ProviderConfig): ProviderIssue[] {
  if (provider.kind === 'chatgpt') {
    return [{ path: ['kind'], message: 'dsh 引擎没有 ChatGPT 账号，要用 Codex 引擎' }];
  }
  const issues: ProviderIssue[] = [];
  const issue = (path: Array<string | number>, message: string) => issues.push({ path, message });

  if (provider.baseURL !== undefined) {
    const problem = baseURLProblem(provider.baseURL);
    if (problem !== undefined) issue(['baseURL'], problem);
  }
  const ids = new Set<string>();
  provider.models.forEach((model, index) => {
    if (ids.has(model.id)) issue(['models', index, 'id'], `模型 ${model.id} 重复`);
    ids.add(model.id);
  });

  if (provider.kind === 'deepseek-official') {
    if (provider.id !== DEEPSEEK_OFFICIAL) {
      issue(['id'], `DeepSeek 官方 Provider 的 ID 只能是 ${DEEPSEEK_OFFICIAL}`);
    }
    if (provider.api !== undefined) issue(['api'], 'DeepSeek 官方 Provider 不选协议');
    if (provider.compat !== undefined) issue(['compat'], 'compat 只对 openai-compatible 有意义');
    provider.models.forEach((model, index) => {
      if (model.reasoningEfforts !== undefined) {
        issue(
          ['models', index, 'reasoningEfforts'],
          'DeepSeek 官方路由的推理档位由 dsh 固定（off / low / high / max），不能配置',
        );
      }
    });
    const known = provider.models.length > 0 ? [...ids] : DSH_DEEPSEEK_MODELS;
    if (!known.includes(provider.defaultModelId)) {
      issue(
        ['defaultModelId'],
        provider.models.length > 0
          ? 'defaultModelId 必须是 models 之一'
          : `不列模型时用 dsh 自带的目录，defaultModelId 必须是 ${DSH_DEEPSEEK_MODELS.join(' / ')} 之一`,
      );
    }
    return issues;
  }

  if (RESERVED_PROVIDER_IDS.includes(provider.id)) {
    issue(['id'], `${provider.id} 是 dsh 内置路由的名字，OpenAI 兼容 Provider 不能用`);
  }
  if (provider.api === undefined) {
    issue(['api'], 'OpenAI 兼容 Provider 必须选协议');
  } else if (!SUPPORTED_APIS.includes(provider.api)) {
    issue(
      ['api'],
      provider.api === 'anthropic-messages'
        ? 'anthropic-messages 协议只预留了类型，暂不支持'
        : `不认识的协议 ${provider.api}`,
    );
  }
  if (provider.baseURL === undefined) issue(['baseURL'], 'OpenAI 兼容 Provider 必须有 baseURL');
  if (provider.models.length === 0) issue(['models'], '至少要有一个模型');
  if (!ids.has(provider.defaultModelId))
    issue(['defaultModelId'], 'defaultModelId 必须是 models 之一');
  for (const [key, value] of Object.entries(provider.compat ?? {})) {
    if (value === undefined) continue;
    if ((GATEWAY_ONLY_COMPAT as readonly string[]).includes(key)) continue;
    const apis = COMPAT_APIS[key as keyof typeof COMPAT_APIS];
    if (apis === undefined) {
      issue(['compat', key], `不认识的 compat 开关 ${key}`);
    } else if (provider.api !== undefined && !apis.includes(provider.api)) {
      issue(['compat', key], `${key} 只用于 ${apis.join(' / ')} 协议`);
    }
  }
  provider.models.forEach((model, index) => {
    for (const level of model.reasoningEfforts ?? []) {
      if (!REASONING_LEVELS.includes(level)) {
        issue(['models', index, 'reasoningEfforts'], `不认识的推理档位 ${level}`);
      }
    }
  });
  return issues;
}

/** dsh `--patch` overlay 的一条：按 `id` 整体替换该条目的 `config`（Cordis loader 的语义）。 */
export interface OverlayEntry {
  id: string;
  config: Record<string, unknown>;
}

/**
 * Provider 列表 → overlay 条目。不合法的 Provider 抛错（调用方先 `validateProviderConfig`）。
 *
 * - `llm-deepseek` 与 `web-search-deepseek` 的 `apiKeyEnv` 总是改成 Wevir 的变量（默认是 `DEEPSEEK_API_KEY`），
 *   没有 DeepSeek 官方 Provider 时也改：dsh 不会再去找 `DEEPSEEK_API_KEY`。
 * - `session-log-deepseek` 与 `plugin-package-inventory-deepseek` 总是关掉：dsh 默认给经 `llm-deepseek` 的每个请求
 *   附带会话日志 `dsh_session_log` 与插件清单 `dsh_plugin_packages`，两者都不是模型输入（docs/security.md §4）。
 * - `openai-compatible` 都进 `llm-pi-ai` 的 `providers`；一个都没有时不写这一条（保持 dsh 的默认）。
 * - 不写 `acp` 条目：每个会话的路由由适配器在 `session/new` 之后用 `session/set_config_option` 选定。
 */
export function providerOverlayEntries(providers: readonly ProviderConfig[]): OverlayEntry[] {
  for (const provider of providers) {
    const issues = validateProviderConfig(provider);
    if (issues.length > 0) {
      throw new TypeError(
        `Provider ${provider.id} 的配置 dsh 不接受：${issues.map((i) => `${i.path.join('.')}：${i.message}`).join('；')}`,
      );
    }
  }
  const keyEnv = providerKeyEnv(DEEPSEEK_OFFICIAL);
  const deepseek = providers.find((provider) => provider.kind === 'deepseek-official');
  const deepseekConfig: Record<string, unknown> = { apiKeyEnv: keyEnv };
  if (deepseek?.baseURL !== undefined) deepseekConfig.baseURL = deepseek.baseURL;
  if (deepseek !== undefined && deepseek.models.length > 0) {
    deepseekConfig.models = deepseek.models.map(deepseekModel);
  }
  const entries: OverlayEntry[] = [
    { id: 'llm-deepseek', config: deepseekConfig },
    { id: 'web-search-deepseek', config: { apiKeyEnv: keyEnv } },
    { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'plugin-package-inventory-deepseek', config: { enabled: false } },
  ];

  const routes: Record<string, unknown> = {};
  for (const provider of providers) {
    if (provider.kind !== 'openai-compatible') continue;
    const route: Record<string, unknown> = {
      displayName: provider.displayName,
      apiKeyEnv: providerKeyEnv(provider.id),
      api: provider.api,
      baseURL: provider.baseURL,
    };
    const compat = effectiveCompat(provider);
    if (Object.keys(compat).length > 0) route.compat = compat;
    route.models = provider.models.map(piAiModel);
    routes[provider.id] = route;
  }
  if (Object.keys(routes).length > 0)
    entries.push({ id: 'llm-pi-ai', config: { providers: routes } });
  return entries;
}

/**
 * overlay 文件的内容。用 JSON 写（YAML 1.2 是 JSON 的超集，dsh 照样读）：显示名、地址等用户输入不用
 * 自己处理 YAML 转义。
 */
export function renderProviderOverlay(providers: readonly ProviderConfig[]): string {
  return [
    '# 由 Wevir 生成（packages/adapter-dsh/src/provider-config.ts），每次 Provider 变更时整体重写，不要手改。',
    '# 只含 Key 的环境变量名（apiKeyEnv），不含 Key；Key 只经 dsh 子进程的环境变量传入。',
    JSON.stringify(providerOverlayEntries(providers), null, 2),
    '',
  ].join('\n');
}

/** dsh 子进程要额外注入的 Key：只有存了 Key 的 Provider。 */
export function providerEnv(providers: readonly ProviderConfig[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const provider of providers) {
    if (provider.apiKey !== undefined && provider.apiKey !== '') {
      env[providerKeyEnv(provider.id)] = provider.apiKey;
    }
  }
  return env;
}

/** `DSH_HOME` 下 Wevir 专用的目录：`<DSH_HOME>/wevir`。dsh 自己不读写它。 */
export function wevirConfigDir(paths: DshPaths): string {
  return join(paths.dshHome, 'wevir');
}

/** Provider overlay 的路径：`<DSH_HOME>/wevir/providers.yml`。 */
export function providerOverlayPath(paths: DshPaths): string {
  return join(wevirConfigDir(paths), 'providers.yml');
}

/** 写 Provider overlay：目录 0700、文件 0600，先写临时文件再 rename，dsh 读不到写了一半的文件。 */
export function writeProviderOverlay(paths: DshPaths, content: string): string {
  const dir = wevirConfigDir(paths);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = providerOverlayPath(paths);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, file);
  return file;
}

function deepseekModel(model: ProviderModelConfig): Record<string, unknown> {
  const entry: Record<string, unknown> = { id: model.id };
  if (model.displayName !== undefined) entry.name = model.displayName;
  if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow;
  if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens;
  // llm-deepseek 省略 inputModalities 即只收文本，与 pi-ai 的“沿用目录”不同。
  if (model.supportsImages === true) entry.inputModalities = ['text', 'image'];
  return entry;
}

function piAiModel(model: ProviderModelConfig): Record<string, unknown> {
  const entry: Record<string, unknown> = { id: model.id };
  if (model.displayName !== undefined) entry.name = model.displayName;
  if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow;
  if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens;
  if (model.supportsImages !== undefined) {
    entry.input = model.supportsImages ? ['text', 'image'] : ['text'];
  }
  if (model.reasoningEfforts !== undefined) {
    // 键是界面上的档位，值是发给服务端的 reasoning_effort；只有 off 可以留空（不发推理参数）。
    entry.reasoningEfforts =
      model.reasoningEfforts.length === 0
        ? false
        : Object.fromEntries(
            model.reasoningEfforts.map((level) => [level, level === 'off' ? null : level]),
          );
  }
  return entry;
}

/** dsh 对 baseURL 的要求（llm-deepseek「端点与协议格式」）：http(s)，不含凭据、查询或片段。 */
function baseURLProblem(baseURL: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return `不是合法的地址：${baseURL}`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'baseURL 只能是 http 或 https';
  // 地址里的凭据会原样写进 overlay 文件，落进 DSH_HOME。
  if (url.username !== '' || url.password !== '') return 'baseURL 不能带用户名或密码，Key 单独填写';
  if (url.search !== '' || url.hash !== '') return 'baseURL 不能带查询参数或片段';
  return undefined;
}

function hostnameOf(baseURL: string): string {
  try {
    return new URL(baseURL).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
