// Host 与引擎适配器之间的类型（domain-model.md 里标 `→ adapter 接口` 的部分）。只在 Host 进程内
// 传递，不上线缆；线缆类型在 @wevir/protocol。
//
// 与 protocol 同形的类型（ToolDisplay、TodoItem）在这里单独声明，不 import 协议包：适配器不需要
// zod，也不必等 protocol 构建出 dist 才能做类型检查。Host 在两者之间直接赋值，形状一旦分叉，
// Host 的类型检查会报错。

/**
 * 会话的权限模式（0.11.0，protocol 的 `PermissionMode`，domain-model §3.9）：`on_request` 越界的操作问用户；`auto_review`
 * 先由会话的模型审查；`full_access` 不用沙箱、不问。
 */
export type PermissionMode = 'on_request' | 'auto_review' | 'full_access';

/**
 * 回合的协作模式（0.36.0，protocol 的 `CollaborationMode`，domain-model §3.17）：`plan` 只做不改动工作区的事、可以提问，最后给出
 * 计划（`plan.proposed`），不实施。
 */
export type CollaborationMode = 'default' | 'plan';

/** 建会话与恢复会话的参数。 */
export interface SessionConfig {
  /**
   * 工作区根目录的 realpath，即 ACP `session/new` 的 `cwd`。`resumeSession` 必须传创建时的同一个值
   * （dsh 按 realpath 比较，T0.3 §3.2）。
   */
  cwd: string;
  /** Provider ID，也是 dsh 的 provider 路由名。 */
  providerId: string;
  modelId: string;
  /** 引擎原值，如 dsh 的 off / low / high / max。 */
  reasoningEffort?: string;
  /**
   * 权限模式（0.11.0）；省略表示 `on_request`。只有声明了 `permissionModes` 的适配器会收到别的值，从这个会话的下一个回合
   * 起生效。
   */
  permissionMode?: PermissionMode;
  /**
   * 环境会话（0.15.0，U22.1）：除 `cwd` 外这个会话还能读写的目录（其他文件夹或它们的 worktree）。只有声明了
   * `additionalRoots` 的适配器会收到。
   */
  additionalRoots?: string[];
  /**
   * 应用级工具（0.30.0，domain-model §3.15）：Host 里 `wevir` MCP 服务的地址与这个会话的令牌。只有声明了 `appTools` 的适配器
   * 会收到；适配器按引擎的方式把它挂到这个引擎会话上（Streamable HTTP，带 `Authorization: Bearer <token>`）。令牌只认这一个
   * Wevir 会话，Host 重启后作废，恢复会话时给新的。
   */
  appTools?: AppToolsEndpoint;
}

/** Host 里的 `wevir` MCP 服务（0.30.0）。 */
export interface AppToolsEndpoint {
  /** `http://127.0.0.1:<端口>/mcp`。 */
  url: string;
  /** 这个会话的令牌；不写进日志。 */
  token: string;
}

/**
 * 引擎级的应用级工具入口（`AgentRuntimeAdapter.bindEngineAppTools`）：`grant(kinds)` 返回同一个 `/mcp` 端点与一个引擎令牌；
 * Host 还没监听时返回 `undefined`。
 */
export type EngineAppToolsGrant = (
  kinds: readonly ProviderConfig['kind'][],
) => AppToolsEndpoint | undefined;

/** 带引擎令牌的请求里写调用工具的引擎会话 ID 的请求头（OpenCode 的 `ses_…`）。 */
export const APP_TOOLS_ENGINE_SESSION_HEADER = 'x-wevir-engine-session';

/** 应用级工具的 MCP 服务名：模型看到的工具是 `mcp__wevir__wevir_session_list` 这样（Codex、Claude）。 */
export const APP_TOOLS_SERVER = 'wevir';

/**
 * 不用批准的应用级工具（0.30.0）：只读的，加上只请界面显示的 `wevir_show` 与（0.40.0）交文件卡片的 `wevir_share_file`；0.33.0 起还有只读的浏览器工具（列标签页、快照、
 * 截图、等待、日志，0.48.0 起还有查元素与网络记录，Host 的 `BROWSER_READ_ONLY_TOOLS`）。其余（新开会话、给别的会话发消息、停别的会话、在网页上点击填写与跳转）
 * 按会话的权限模式走引擎自己的审批。P3 的 wevir_plugins_list 也只读；三个插件写工具由 Host 核对用户批准，不在这张表里。0.47.0 起
 * 还有后台进程的列出、读输出与等待（起进程、写 stdin、发信号按权限模式）；代码智能的 `lsp_*` 只读（Host 的 `LSP_TOOLS`，会按需启动项目的语言服务器）。
 * 引擎要按名字放行时用它（Claude 的 `allowedTools`）；Codex 看工具的 annotations。
 */
export const APP_TOOLS_NO_APPROVAL: readonly string[] = Object.freeze([
  'wevir_session_list',
  'wevir_session_read',
  'wevir_session_wait',
  'wevir_models',
  'wevir_show',
  'wevir_share_file',
  'wevir_plugins_list',
  'wevir_process_list',
  'wevir_process_output',
  'wevir_process_wait',
  'browser_list_tabs',
  'browser_snapshot',
  'browser_screenshot',
  'browser_wait',
  'browser_logs',
  'browser_query',
  'browser_network',
  'lsp_definition',
  'lsp_references',
  'lsp_hover',
  'lsp_document_symbols',
  'lsp_workspace_symbols',
  'lsp_call_hierarchy',
  'lsp_diagnostics',
]);

/** `createSession` / `resumeSession` 的结果。 */
export interface EngineSession {
  /** 引擎会话 ID（dsh：ACP `sessionId`）。Host 只用它路由，不解析。 */
  engineSessionId: string;
  /** 引擎实际采用的模型（ACP `session/new` 结果的 `configOptions`）；引擎不报时省略，Host 用请求值。 */
  modelId?: string;
  reasoningEffort?: string;
  /**
   * 建立或恢复这个会话的引擎版本（dsh：`@deepseek-ai/dsh` 的包版本；ACP 的 `agentInfo.version` 恒为 0.0.1，
   * 不能用）。Host 记进 `session.created` / `session.resumed`，排查跨版本问题用（T3.5）。不知道时省略。
   */
  engineVersion?: string;
}

/**
 * `fork` 分出什么（0.38.0）：`side` 是支线（0.17.0，引擎不持久化，带一条边界说明，到最近一个完成的回合为止）；`branch` 是分支到
 * 新会话（持久化的普通会话，没有边界说明），去掉最后 `dropTurns` 个完成的回合，带到它们之前为止（0 表示到最近一个完成的回合）。
 * 回合按引擎自己的回合数，从后往前数，Host 数的是它的回合里没被撤回的（domain-model §3.18）。
 */
export type ForkOptions = { kind: 'side' } | { kind: 'branch'; dropTurns: number };

/** 用户输入的一段文本。 */
export interface AgentTextInput {
  type: 'text';
  text: string;
}

/** 与 @wevir/protocol 的 `UserImageMimeType` 同形。 */
export type AgentImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/**
 * 用户输入的一张图片（0.28.0）：Host 存在数据目录里的文件，不超过 10 MiB，格式已按文件头核对。只有 `acceptsImages` 对这个
 * 会话回答 `true` 的适配器会收到。引擎能读文件的直接给路径（Codex 的 `localImage`），否则读出来按引擎的格式发（base64）。
 */
export interface AgentImageInput {
  type: 'image';
  /** 绝对路径。 */
  path: string;
  mimeType: AgentImageMimeType;
  /** 原来的文件名；粘贴的截图没有。 */
  name?: string;
}

/** 一次 `send` 的用户输入。 */
export interface AgentInput {
  /** 至少一段；图片（0.28.0）在 `acceptsImages` 之后才会有。 */
  content: Array<AgentTextInput | AgentImageInput>;
  /**
   * 这个回合的协作模式（0.36.0）；省略表示 `default`。只有声明了 `planMode` 的适配器会收到 `plan`，而且只在 `send` 里（插话
   * 沿用回合的模式）。模式按回合给：上一个回合是 `plan`、这次省略，就回到默认模式。
   */
  collaborationMode?: CollaborationMode;
}

/**
 * `review` 的请求（0.24.0）：`uncommitted` 看工作树（暂存、未暂存与未跟踪的文件），`branch` 看当前分支对 `baseBranch` 的改动
 * （Host 找的默认分支）。
 */
export type ReviewRequest = { target: 'uncommitted' } | { target: 'branch'; baseBranch: string };

/** Host 在开始回合之前问引擎会不会的可选方法（`supports`）；`startGoal` 代表会话目标的几个方法（0.35.0）。 */
export type SessionCommandMethod = 'compact' | 'review' | 'startGoal';

/** 会话目标的状态（0.35.0，同协议的 `GoalStatus`；Codex 的 `ThreadGoalStatus`）。 */
export type EngineGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usage_limited'
  | 'budget_limited'
  | 'complete';

/** 引擎持久化的会话目标（0.35.0）。 */
export interface EngineGoal {
  objective: string;
  status: EngineGoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  /** 引擎最近一次改动目标的时刻（ISO 8601，毫秒精度）。 */
  updatedAt: string;
}

/** `startGoal` 的请求（0.35.0）：新的目标与第一个回合的输入（Host 写下的 `user.message`，即目标本身）。 */
export interface GoalStartRequest {
  objective: string;
  tokenBudget?: number;
  input: AgentInput;
}

/** `supports` 能问的：可选方法，计划模式（0.36.0，`planMode`），分支与撤回（0.38.0，`branch` 是 `fork` 的 `{ kind: 'branch' }`）。 */
export type SessionCapability = SessionCommandMethod | 'planMode' | 'branch' | 'rewind';

/** `generateTitle` 的请求（prompts/README.md「会话标题」）。 */
export interface TitleRequest {
  /** 说明：prompts/thread-title.md 去掉注释后的全文。 */
  instructions: string;
  /** 用户消息：`<user_prompt>…</user_prompt>` 或 `<conversation>…</conversation>`，已转义、已限长。 */
  input: string;
  /** 输出的 JSON Schema（`{title, description}`）；引擎支持结构化输出时用它约束。 */
  outputSchema: Record<string, unknown>;
  /** Host 不再需要结果时（超时、会话被改名）中止。 */
  signal?: AbortSignal;
}

/** 引擎给的一个审批选项，全部字段原样。 */
export interface ApprovalOption {
  /** `respondToApproval` 回传它，如 dsh 的 `allow-once`。 */
  optionId: string;
  /** 如 dsh 的 "Allow once"；界面按 `kind` 本地化。 */
  label: string;
  /** ACP：allow_once / allow_always / reject_once / reject_always。以 `allow` 开头才算批准。 */
  kind: string;
}

/** 审批决定：所选选项的 ID，必须是该请求 `options` 中的一个。 */
export interface ApprovalDecision {
  optionId: string;
}

/** 一个尚未决定的审批请求。`listPendingApprovals` 返回它，`approval.requested` 事件也是这个形状。 */
export interface PendingApproval {
  engineSessionId: string;
  /** 适配器分配，在适配器实例内唯一；`respondToApproval` 用它定位请求。 */
  requestId: string;
  /** 引擎要执行的工具调用。审批详情由 Host 从同一 `toolCallId` 的 `tool.started` 取（ADR-0001 §5）。 */
  toolCallId: string;
  options: ApprovalOption[];
}

/** 工具调用的展示类型，与 @wevir/protocol 的 `ToolDisplayKind` 同形（domain-model.md §7）。 */
export type ToolDisplayKind =
  | 'shell'
  | 'read'
  | 'edit'
  | 'write'
  | 'search'
  | 'fetch'
  | 'plan'
  | 'sub_agent'
  | 'unknown';

/**
 * 与 @wevir/protocol 的 `ToolDisplay` 同形。按工具名映射展示类型依赖引擎的工具名，所以由适配器
 * 产出（domain-model.md §6.2「放在哪一侧」）。
 */
export interface ToolDisplay {
  kind: ToolDisplayKind;
  /** 一行摘要：路径、命令、查询词或 URL。 */
  summary?: string;
  /** 引擎输入里的原值，可能是相对路径。 */
  paths?: string[];
  command?: string;
  query?: string;
  url?: string;
  /** `mcp__<server>__<tool>` 的 server 部分。 */
  mcpServer?: string;
}

/** 与 @wevir/protocol 的 `UserQuestion` 同形（0.10.0）：引擎向用户提的一个问题。 */
export interface UserQuestion {
  id: string;
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  allowOther?: boolean;
  secret?: boolean;
}

/** 与 @wevir/protocol 的 `TodoItem` 同形。 */
export interface TodoItem {
  content: string;
  /** 引擎原值（dsh 已见 pending / in_progress / completed），其他值原样保留。 */
  status: string;
}

/** 与 @wevir/protocol 的 `UsageBreakdown` 同形（0.50.0）：上下文是被什么占的。 */
export interface UsageBreakdown {
  /** `name` 是引擎给的类别名；`kind`：`used` / `free` / `buffer` / `deferred`，其他值按 `used` 看。 */
  categories: Array<{ name: string; tokens: number; kind: string }>;
  /** 细项分组（`mcp_tools`、`memory_files`、`agents`、`skills`）：`count` 是总数，`items` 只带占用最多的前若干项（至多 100）。 */
  groups?: Array<{
    group: string;
    count: number;
    items: Array<{ name: string; source?: string; tokens: number }>;
  }>;
}

// ── Provider（T3.4）──────────────────────────────────────────────────────

/**
 * 与 @wevir/protocol 的 `ProviderCompat` 同形：OpenAI 兼容服务的请求格式修正（domain-model.md §3.2）。前四个以外只有
 * Codex 引擎的模型网关用（model-gateway.md §4.4），dsh 适配器忽略它们。
 */
export interface ProviderCompatConfig {
  supportsDeveloperRole?: boolean;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  thinkingFormat?: string;
  requiresReasoningContentOnAssistantMessages?: boolean;
  supportsCustomTools?: boolean;
  supportsNamespaceTools?: boolean;
  toolChoice?: 'any' | 'auto_only';
  geminiToolSchema?: boolean;
  systemMessageMode?: 'inline' | 'merge' | 'user';
}

/** 与 @wevir/protocol 的 `ProviderModel` 同形。 */
export interface ProviderModelConfig {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
  /** 推理档位（off / minimal / low / medium / high / xhigh / max）；空数组表示不推理。 */
  reasoningEfforts?: string[];
}

/**
 * 交给引擎的一个 Provider：`ProviderProfile` 的非密钥字段加上 SecretStore 里的 Key，由 Host 组装，
 * 只在内存里传递。适配器只能经子进程环境变量把 Key 交给引擎，不得写进文件或日志（AGENTS.md 规则 5）。
 */
export interface ProviderConfig {
  /** Provider ID，也是引擎的路由名（dsh：provider 路由，写进会话日志，创建后不可改名）。 */
  id: string;
  /**
   * `chatgpt`（R6）：用 ChatGPT 订阅登录的 Codex，没有 Key 与地址，模型来自 `EngineAccounts.models`。不支持账号的引擎
   * 在 `validateProvider` 里拒绝它、在 `configureProviders` 里跳过它（Host 可能带着库里已有的这类 Provider 换引擎启动）。
   * 订阅来源（0.19.0）同理：模型来自对应引擎的 `EngineAccounts.models`，Host 的引擎路由只把它交给那个引擎。
   */
  kind: 'deepseek-official' | 'openai-compatible' | 'google-vertex' | 'chatgpt' | SubscriptionKind;
  displayName: string;
  /** `openai-compatible` 必有；google-vertex 只用 openai-completions / anthropic-messages。 */
  api?: string;
  baseURL?: string;
  compat?: ProviderCompatConfig;
  vertex?: { project: string; location?: string };
  /** 整份服务账号 JSON，只供 Host 进程里的网关使用。 */
  serviceAccountJson?: string;
  models: ProviderModelConfig[];
  defaultModelId: string;
  /** 没有存 Key 时省略。 */
  apiKey?: string;
}

/** `validateProvider` 发现的一个问题：字段路径（相对 ProviderConfig）与给人看的说明。 */
export interface ProviderIssue {
  path: Array<string | number>;
  message: string;
}

/** 与 @wevir/protocol 的 `ProviderTestFailure` 同形。 */
export type ProviderTestFailure =
  | 'missing_key'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'model_not_found'
  | 'protocol'
  | 'rate_limited'
  | 'server'
  | 'unknown';

/** 与 @wevir/protocol 的 `provider.test` 结果同形。 */
export interface ProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  /** `ok` 为 false 时必有；`message` 给人看，不含 Key。 */
  error?: {
    category: 'missing_credentials' | 'provider' | 'unknown';
    message: string;
    /** Diagnostic code, matching protocol EngineErrorInfo; UI localizes known codes. */
    code?: string | number;
  };
  reason?: ProviderTestFailure;
  httpStatus?: number;
}

// ── 账号（R6）──────────────────────────────────────────────────────────────

/** 与 @wevir/protocol 的 `SubscriptionKind` 同形（0.19.0，订阅来源，ADR-0005 补记 14）。 */
export type SubscriptionKind = 'claude' | 'cursor' | 'opencode' | 'grok' | 'antigravity';

/** 与 @wevir/protocol 的 `AccountKind` 同形。 */
export type AccountKind = 'chatgpt' | SubscriptionKind;

/** 与 @wevir/protocol 的 `AccountLoginMethod` 同形。 */
export type AccountLoginMethod = 'browser' | 'device_code';

/** 与 @wevir/protocol 的 `AccountState` 同形（domain-model §3.6）。 */
export interface AccountState {
  kind: AccountKind;
  status: 'signed_out' | 'signing_in' | 'signed_in';
  email?: string;
  plan?: string;
  login?: {
    loginId: string;
    method: AccountLoginMethod;
    authUrl?: string;
    verificationUrl?: string;
    userCode?: string;
    startedAt: string;
  };
  lastError?: string;
  rateLimits?: {
    primary?: AccountRateLimitWindow;
    secondary?: AccountRateLimitWindow;
    /** 0.45.0：全部窗口；用 `accountRateLimits` 生成，前两个同时放进 primary / secondary。 */
    windows?: AccountRateLimitWindow[];
  };
  // 订阅来源（0.19.0）的字段，含义见 @wevir/protocol 的 `AccountState`。
  planLabel?: string;
  signIn?: 'in_app' | 'command';
  loginMethods?: AccountLoginMethod[];
  loginCommand?: string;
  installed?: boolean;
  version?: string;
  executablePath?: string;
  customPath?: string;
  installCommand?: string;
  installUrl?: string;
  canInstall?: boolean;
  installing?: { completedBytes: number; totalBytes?: number };
}

export interface AccountRateLimitWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
  period?: 'monthly';
  scope?: string;
}

/** 账号能用的模型（ChatGPT：Codex 的 `model/list`）。 */
export interface AccountModels {
  models: ProviderModelConfig[];
  /** 引擎标为默认的模型；没有时取第一个。列表为空时省略。 */
  defaultModelId?: string;
}
