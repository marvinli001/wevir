import { chmodSync, writeFileSync } from 'node:fs';
import {
  APP_TOOLS_SERVER,
  type AppToolsEndpoint,
  type ProviderConfig,
  type ProviderModelConfig,
} from '@wevir/runtime-adapter';
import {
  HISTORY_TOOL_NAME,
  HISTORY_TOOL_SERVER,
  type HistoryToolServer,
  historyToolCommand,
} from '@wevir/runtime-adapter/history-tool';
import { GATEWAY_TOKEN_ENV } from './env.js';
import type { CodexPaths } from './paths.js';
import type { BasePromptVars } from './prompts.js';
import { type SuggestTasksServer, suggestTasksToml } from './suggest-tasks.js';

// 生成 CODEX_HOME/config.toml 与模型目录（ADR-0005 决策 5，docs/architecture/codex-event-mapping.md §3）。
// 每次启动 codex-app-server 之前重写；配置键以 rust-v0.162.1 为准，进程带 --strict-config 启动，写错就启动失败。

/**
 * 加固项（ADR-0005 决策 5 与补记 1，codex-notes §6）。顶层键必须写在任何表之前，所以分成两段。
 * - `features.plugins = false`：唯一产生外连的开关（启动时同步插件市场：github.com、api.github.com、chatgpt.com）；
 * - `features.apps = false`：ChatGPT 登录时 Codex 会连 ChatGPT 的应用（connectors）MCP（`<chatgpt_base_url>/ps/mcp`），
 *   把连接器的工具给模型；Wevir 不支持（R6 实测，codex-event-mapping.md §8.2）。没有 ChatGPT 登录时它本来就不起；
 * - `web_search = "disabled"`：否则把托管搜索工具发给模型服务；`analytics.enabled = false`；
 *   `check_for_update_on_startup = false`（只影响 TUI，设上无害）；
 * - `features.instant_interrupt = false`：插话（`turn/steer`，R11）等模型这一段输出结束再进回合，而不是立刻掐断正在
 *   流式输出的这一步（这个开关默认开，codex-event-mapping.md §4.5；维护者定的插话是“这一步结束后插进本回合”）；
 * - `features.default_mode_request_user_input = true`：模型在普通回合也能用 `request_user_input` 向用户提问（默认只在
 *   计划模式提供；Stage::UnderDevelopment，U11，codex-event-mapping.md §6.6）；`suppress_unstable_features_warning = true`
 *   免得每个 thread 开头一条“开了开发中的功能”的 warning 通知；
 * - `features.goals = false`：Wevir 暂不支持目标（补记 1）；`features.memories = false`、`approvals_reviewer = "user"`：
 *   两者默认就是这样，写出来防默认值变化（它们会用写死的 OpenAI 模型名）；
 * - `tools.update_plan.enabled = true`：计划默认关；
 * - `skills.include_instructions = false`、`skills.bundled.enabled = false`：不把 skills 列表放进上下文，也不往
 *   CODEX_HOME 装内置 skills。Codex 读用户的 `~/.agents/skills`（HOME 是用户真实的家目录），不关就会把用户给别的
 *   工具装的 skills 列给模型（R2 实测，codex-event-mapping.md §1.3）；
 * - `shell_environment_policy`：套用内置的 *KEY* / *SECRET* / *TOKEN* 排除并排除 `WEVIR_*`，模型跑的命令看不到
 *   网关令牌（默认 `ignore_default_excludes = true`，codex-notes §6.3）。
 */
export const HARDENING_TOP: readonly string[] = [
  'approval_policy = "on-request"',
  'sandbox_mode = "workspace-write"',
  'approvals_reviewer = "user"',
  'check_for_update_on_startup = false',
  'web_search = "disabled"',
  'suppress_unstable_features_warning = true',
];

export const HARDENING_TABLES: readonly string[] = [
  '[analytics]',
  'enabled = false',
  '',
  '[features]',
  'plugins = false',
  'apps = false',
  'goals = false',
  'memories = false',
  'instant_interrupt = false',
  'default_mode_request_user_input = true',
  '',
  '[tools.update_plan]',
  'enabled = true',
  '',
  '[skills]',
  'include_instructions = false',
  '',
  '[skills.bundled]',
  'enabled = false',
  '',
  '[shell_environment_policy]',
  'ignore_default_excludes = false',
  `exclude = ["WEVIR_*"]`,
];

/** 一个 Wevir Provider 在 Codex 里的 Provider ID：`wevir_<id>`。 */
export function codexProviderId(providerId: string): string {
  return `wevir_${providerId}`;
}

/**
 * `[model_providers.wevir_<id>]` 的内容（决策 2.2）：`base_url` 是网关给这个 Provider 的地址，令牌在
 * `WEVIR_GATEWAY_TOKEN`，上游 Key 不出 Host。`name` 带上 `Wevir/` 前缀：Codex 把名字恰好是 `OpenAI` 的 Provider
 * 当作 OpenAI 自己的（`is_openai()`，codex-notes §6.4），Provider 的显示名可能就叫这个。
 */
export function modelProviderEntry(
  provider: Pick<ProviderConfig, 'displayName'>,
  baseURL: string,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    name: `Wevir/${provider.displayName}`,
    base_url: baseURL,
    wire_api: 'responses',
    env_key: GATEWAY_TOKEN_ENV,
    ...extra,
  };
}

/** Wevir 的推理档位（protocol `ProviderReasoningLevel`）→ Codex 的 `ReasoningEffort`：只有 off 改名为 none。 */
export function toCodexEffort(level: string): string {
  return level === 'off' ? 'none' : level;
}

/** Codex 的 `ReasoningEffort` → Wevir 的推理档位。 */
export function fromCodexEffort(effort: string): string {
  return effort === 'none' ? 'off' : effort;
}

const EFFORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  none: '不推理',
  minimal: '最少推理',
  low: '轻度推理',
  medium: '中等推理',
  high: '深度推理',
  xhigh: '更深推理',
  max: '最深推理',
};

/**
 * Provider 模型没填 `contextWindow` 时按这个大小告诉 Codex（codex-event-mapping.md §3“上下文大小”）。模型目录里的模型没有
 * `context_window` 时 Codex 既不自动压缩、也不报上下文大小（`auto_compact_token_limit()` 与 `usable_context_window()`
 * 都是 None，upstream/codex/codex-rs/protocol/src/openai_models.rs 516-540），只能等上游报超长；给一个偏小的值，宁可早压缩。
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 会话模型交给 Codex 的上下文大小：填了用填的，否则 `DEFAULT_CONTEXT_WINDOW`。 */
export function contextWindowOf(model: ProviderModelConfig): number {
  return model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Codex 自动压缩的阈值：上下文大小的 90%（`ModelInfo::auto_compact_token_limit`，Wevir 不写
 * `model_auto_compact_token_limit`）。已用量到了它，Codex 在下一次请求模型之前先压缩。
 */
export function autoCompactLimit(model: ProviderModelConfig): number {
  return Math.floor((contextWindowOf(model) * 9) / 10);
}

/**
 * 模型目录里的一个模型（`model_catalog_json` 的 `models[]`，字段见
 * upstream/codex/codex-rs/protocol/src/openai_models.rs 的 `ModelInfo`，codex-notes §3.3）。没写的字段与 Codex 给
 * 未知模型的默认元数据一致（models-manager/src/model_info.rs `model_info_from_slug`），区别是：声明
 * `apply_patch_tool_type: "freeform"`（否则没有 apply_patch 工具）、总是带上下文大小（没填用 `DEFAULT_CONTEXT_WINDOW`）
 * 与推理档位、`base_instructions` 用 Wevir 的 base.md、列出（`visibility: "list"`）。
 */
export function catalogEntry(
  model: ProviderModelConfig,
  baseInstructions: string,
  priority: number,
): Record<string, unknown> {
  const efforts = (model.reasoningEfforts ?? []).map(toCodexEffort);
  return {
    slug: model.id,
    display_name: model.displayName ?? model.id,
    description: null,
    base_instructions: baseInstructions,
    supported_reasoning_levels: efforts.map((effort) => ({
      effort,
      description: EFFORT_DESCRIPTIONS[effort] ?? effort,
    })),
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'bytes', limit: 10_000 },
    experimental_supported_tools: [],
    include_apps_usage_instructions: false,
    input_modalities: model.supportsImages === true ? ['text', 'image'] : ['text'],
    context_window: contextWindowOf(model),
  };
}

/** 一个会话的模型对应的 base.md 变量。 */
export function basePromptVars(
  provider: ProviderConfig,
  model: ProviderModelConfig,
): BasePromptVars {
  return {
    model_display_name: model.displayName ?? model.id,
    provider_display_name: provider.displayName,
  };
}

/**
 * 由全部 Provider 生成模型目录：每个模型一条，按 slug 去重（Codex 按 slug 精确查找，同名模型以先出现的 Provider 为准；
 * 会话自己的上下文大小与基础提示词由 `thread/start` 覆盖，见 `threadConfig`）。没有模型时返回 undefined：Codex 拒绝
 * 空目录（`model_catalog_json path … must contain at least one model`）。
 */
export function renderModelCatalog(
  providers: readonly ProviderConfig[],
  render: (vars: BasePromptVars) => string,
): string | undefined {
  const seen = new Set<string>();
  const models: Record<string, unknown>[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(catalogEntry(model, render(basePromptVars(provider, model)), models.length + 1));
    }
  }
  return models.length === 0 ? undefined : `${JSON.stringify({ models }, null, 2)}\n`;
}

/** TOML 基本字符串：JSON 的字符串转义是它的子集（`\"`、`\\`、`\n`、`\uXXXX`）。 */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlValue(value: unknown): string {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`config.toml 里不支持这种值：${JSON.stringify(value)}`);
}

export interface RenderConfigInput {
  providers: readonly ProviderConfig[];
  /** 网关给某个 Provider 的 `base_url`（`ModelGateway.baseURL`）。 */
  gatewayBaseURL: (providerId: string) => string;
  /** 模型目录文件；没有模型时省略（不写 `model_catalog_json`）。 */
  catalogFile?: string;
  /** 每个 `[model_providers.*]` 额外的键（测试把重试次数设成 0）。 */
  providerExtra?: Readonly<Record<string, unknown>>;
  /** 建议后续任务的本机 MCP 服务（U23，suggest-tasks.ts）；省略时不登记。 */
  suggestTasks?: SuggestTasksServer;
  /** 读历史的本机 MCP 服务（0.25.0，接力，`@wevir/runtime-adapter/history-tool`）；省略时不登记。 */
  historyTool?: HistoryToolServer;
}

/**
 * config.toml 的全文。默认的 `model` / `model_provider` 取第一个 Provider 的默认模型（会话总在 `thread/start`
 * 里指定自己的，这只是让进程不落到 OpenAI 的默认 Provider 上）。不含任何 Key 与令牌，只有令牌的变量名。
 */
export function renderConfigToml(input: RenderConfigInput): string {
  const first = input.providers[0];
  const top = [
    '# 由 Wevir 生成（packages/adapter-codex/src/config.ts），每次启动 codex-app-server 之前重写，不要手改。',
    ...HARDENING_TOP,
    ...(first === undefined
      ? []
      : [
          `model = ${tomlString(first.defaultModelId)}`,
          `model_provider = ${tomlString(codexProviderId(first.id))}`,
        ]),
    ...(input.catalogFile === undefined
      ? []
      : [`model_catalog_json = ${tomlString(input.catalogFile)}`]),
    '',
  ];
  const providers = input.providers.flatMap((provider) => [
    '',
    `[model_providers.${tomlString(codexProviderId(provider.id))}]`,
    ...Object.entries(
      modelProviderEntry(provider, input.gatewayBaseURL(provider.id), input.providerExtra),
    ).map(([key, value]) => `${key} = ${tomlValue(value)}`),
  ]);
  const mcp = [
    ...(input.suggestTasks === undefined ? [] : suggestTasksToml(input.suggestTasks)),
    ...(input.historyTool === undefined ? [] : historyToolToml(input.historyTool)),
  ];
  return `${[...top, ...HARDENING_TABLES, ...providers, ...mcp].join('\n')}\n`;
}

/**
 * ChatGPT 进程（R6，ADR-0005 补记 10）多出的顶层键：
 * - `model_provider = "openai"`：Codex 内置的 openai Provider，登录后流量直连 OpenAI（chatgpt.com），不经网关；
 * - `cli_auth_credentials_store = "file"`：登录凭据存在本进程 CODEX_HOME 的 `auth.json`（0600），与 Wevir 的
 *   `secrets.json` 同一个保护级别（docs/security.md §3），不碰系统钥匙串；
 * - `forced_login_method = "chatgpt"`：只允许 ChatGPT 登录（不接受 API Key 登录）；
 * - `mcp_oauth_credentials_store = "file"`：MCP 的 OAuth 凭据同样不进钥匙串（默认 `auto` 会先试钥匙串）。
 */
export const CHATGPT_TOP: readonly string[] = [
  'model_provider = "openai"',
  'cli_auth_credentials_store = "file"',
  'forced_login_method = "chatgpt"',
  'mcp_oauth_credentials_store = "file"',
];

/**
 * 测试用：把 ChatGPT 的登录服务与后端指向本机 mock。`issuer` 经 app-server 的环境变量
 * `CODEX_APP_SERVER_LOGIN_ISSUER`（account_processor.rs）与 `CODEX_REFRESH_TOKEN_URL_OVERRIDE`（刷新与吊销令牌，
 * login/src/auth/revoke.rs）生效；`backend` 是 ChatGPT 后端的根（`<backend>/backend-api/...`），写进
 * `chatgpt_base_url` 与 `openai_base_url`。注意工作区路由要求 https，账号读取时 mock 要报 `https://chatgpt.com`。
 */
export interface ChatgptEndpoints {
  issuer: string;
  backend: string;
}

export function chatgptEndpointEnv(endpoints: ChatgptEndpoints): Record<string, string> {
  const issuer = endpoints.issuer.replace(/\/+$/, '');
  return {
    CODEX_APP_SERVER_LOGIN_ISSUER: issuer,
    CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${issuer}/oauth/token`,
  };
}

/** ChatGPT 进程的 config.toml：加固项 + `CHATGPT_TOP`，没有 Wevir 的 Provider，也没有模型目录（用 Codex 自己的）。 */
export function renderChatgptConfigToml(
  endpoints?: ChatgptEndpoints,
  suggestTasks?: SuggestTasksServer,
  historyTool?: HistoryToolServer,
): string {
  const backend = endpoints?.backend.replace(/\/+$/, '');
  const top = [
    '# 由 Wevir 生成（packages/adapter-codex/src/config.ts），每次启动 codex-app-server 之前重写，不要手改。',
    '# ChatGPT 进程：Codex 内置的 openai Provider，登录凭据在本目录的 auth.json。',
    ...HARDENING_TOP,
    ...CHATGPT_TOP,
    ...(backend === undefined
      ? []
      : [
          `chatgpt_base_url = ${tomlString(`${backend}/backend-api/`)}`,
          `openai_base_url = ${tomlString(`${backend}/backend-api/codex`)}`,
        ]),
    '',
  ];
  const mcp = [
    ...(suggestTasks === undefined ? [] : suggestTasksToml(suggestTasks)),
    ...(historyTool === undefined ? [] : historyToolToml(historyTool)),
  ];
  return `${[...top, ...HARDENING_TABLES, ...mcp].join('\n')}\n`;
}

/** ChatGPT 会话的 `thread/start` 的 `config` 覆盖：只有推理档位（模型的元数据来自 Codex 自己的目录）。 */
export function chatgptThreadConfig(reasoningEffort: string | undefined): Record<string, unknown> {
  return reasoningEffort === undefined
    ? {}
    : { model_reasoning_effort: toCodexEffort(reasoningEffort) };
}

/** 写配置文件（0600，覆盖）。 */
export function writeCodexConfig(
  paths: CodexPaths,
  toml: string,
  catalog: string | undefined,
): void {
  if (catalog !== undefined) writeSecretFile(paths.catalogFile, catalog);
  writeSecretFile(paths.configFile, toml);
}

function writeSecretFile(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600 });
  // writeFileSync 的 mode 只对新文件生效。
  chmodSync(file, 0o600);
}

/**
 * `thread/start` 的 `config` 覆盖（按点分路径，值是 JSON）：会话自己的 Provider 条目、上下文大小与推理档位。
 * Provider 条目总是带上：进程启动之后新增的 Provider 不在它的 config.toml 里，R2 实测这样就能用上，不必重启
 * （codex-event-mapping.md §5）。模型目录则只在进程启动时读一次（`model_catalog_json` 的覆盖实测无效），
 * 上下文大小因此另经 `model_context_window` 按会话给出。
 */
export function threadConfig(
  provider: ProviderConfig,
  model: ProviderModelConfig,
  gatewayBaseURL: string,
  reasoningEffort: string | undefined,
  providerExtra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    [`model_providers.${codexProviderId(provider.id)}`]: modelProviderEntry(
      provider,
      gatewayBaseURL,
      providerExtra,
    ),
    model_context_window: contextWindowOf(model),
    ...(reasoningEffort !== undefined && {
      model_reasoning_effort: toCodexEffort(reasoningEffort),
    }),
  };
}

/** 应用级工具一次调用的上限（秒）：`wevir_session_wait` 最长等 10 分钟，再留一点余量。 */
export const APP_TOOLS_TOOL_TIMEOUT_SEC = 660;

/**
 * 应用级工具（0.30.0，codex-event-mapping.md §6.11）：`thread/start` / `thread/resume` / `thread/fork` 的 `config` 覆盖里的
 * `mcp_servers.wevir`。Streamable HTTP，令牌放 `http_headers`（Codex 不接受行内的 `bearer_token`，环境变量又是整个进程共用）。
 * 批准方式 `auto`：只读的工具（`readOnlyHint`）直接调，其余按会话的审批策略问用户（完全访问时不问）。
 */
export function appToolsConfig(endpoint: AppToolsEndpoint): Record<string, unknown> {
  return {
    [`mcp_servers.${APP_TOOLS_SERVER}`]: {
      url: endpoint.url,
      http_headers: { Authorization: `Bearer ${endpoint.token}` },
      startup_timeout_sec: 10,
      tool_timeout_sec: APP_TOOLS_TOOL_TIMEOUT_SEC,
      default_tools_approval_mode: 'auto',
    },
  };
}

/**
 * config.toml 里的 `[mcp_servers.wevir_history]`（0.25.0，codex-event-mapping.md §6.10）：接力过来的会话读之前的历史，只开
 * `read_session_history` 一个只读工具，不需要批准。模型看到命名空间 `mcp__wevir_history` 里的它。
 */
export function historyToolToml(server: HistoryToolServer): string[] {
  const { command, args } = historyToolCommand(server);
  return [
    '',
    `[mcp_servers.${HISTORY_TOOL_SERVER}]`,
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(', ')}]`,
    'env = { ELECTRON_RUN_AS_NODE = "1" }',
    'default_tools_approval_mode = "approve"',
    `enabled_tools = [${tomlString(HISTORY_TOOL_NAME)}]`,
    'startup_timeout_sec = 10',
  ];
}
