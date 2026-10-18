import { z } from 'zod';
import {
  ApprovalIdSchema,
  ClientIdentitySchema,
  EnvironmentIdSchema,
  ImageIdSchema,
  IsoTimeSchema,
  PendingMessageIdSchema,
  ProviderIdSchema,
  QuestionIdSchema,
  SeqCursorSchema,
  SeqSchema,
  SessionIdSchema,
  StreamIdSchema,
  TaskIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from './common.js';

// 领域实体的线缆形状，字段含义见 docs/architecture/domain-model.md §3。

// ── Workspace ──────────────────────────────────────────────────────────

/**
 * 工作区的种类（0.39.0，domain-model §3.1）：`chats` 是 Host 自己的“对话”工作区，放不在项目里的会话，每个会话在它下面有自己的
 * 文件夹（`<数据目录>/chats/<会话 ID>`）。省略表示用户添加的项目。
 */
export const WorkspaceKindSchema = z.enum(['chats']);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

export const WorkspaceSchema = z.object({
  id: WorkspaceIdSchema,
  /** 目录的 realpath；Host 按它去重。 */
  rootPath: z.string().min(1),
  displayName: z.string(),
  /** 0.39.0；省略表示项目。 */
  kind: WorkspaceKindSchema.optional(),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

// ── ProviderProfile ────────────────────────────────────────────────────

/**
 * `chatgpt`（0.7.0，R6）：用 ChatGPT 订阅登录的 Codex，没有 Key、没有地址，模型列表来自引擎（Codex 的 `model/list`）。
 * 给已有枚举加的值，按能力位 `provider_kind_chatgpt` 门控：没有声明它的连接在 `provider.list` 里看不到这类 Provider
 * （host-api.md §10）。
 * 订阅来源（0.19.0）：`claude`（Claude Agent，用用户本机 `claude auth login` 的登录）、`cursor`、`opencode`、`grok`、
 * `antigravity`，各自由对应的引擎运行（ADR-0005 补记 14），同样没有 Key 与地址，模型来自引擎，ID 固定等于种类。按能力位
 * `subscription_kinds` 门控，规则同 `chatgpt`。
 */
export const SUBSCRIPTION_KINDS = ['claude', 'cursor', 'opencode', 'grok', 'antigravity'] as const;
export const SubscriptionKindSchema = z.enum(SUBSCRIPTION_KINDS);
export type SubscriptionKind = z.infer<typeof SubscriptionKindSchema>;

export const ProviderKindSchema = z.enum([
  'deepseek-official',
  'openai-compatible',
  'google-vertex',
  'chatgpt',
  ...SUBSCRIPTION_KINDS,
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderApiSchema = z.enum([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]);
export type ProviderApi = z.infer<typeof ProviderApiSchema>;

/**
 * 推理档位（pi-ai 的 `ModelThinkingLevel`）。`off` 表示不带推理参数，其余原样作为 `reasoning_effort`
 * 发给服务端（docs/architecture/providers.md §2）。
 */
export const ProviderReasoningLevelSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ProviderReasoningLevel = z.infer<typeof ProviderReasoningLevelSchema>;

export const ProviderModelSchema = z.object({
  /** 发给服务端的模型 ID。 */
  id: z.string().min(1),
  displayName: z.string().optional(),
  contextWindow: z.int().min(1).optional(),
  /** 最大输出 token（0.2.0）。省略时用 dsh 目录或路由的默认值。 */
  maxTokens: z.int().min(1).optional(),
  /** 是否接受图片输入（0.2.0）。省略时沿用 dsh 目录，目录里没有的模型只收文本。 */
  supportsImages: z.boolean().optional(),
  /**
   * 可选的推理档位（0.2.0），对 `openai-compatible` 与 `google-vertex` 有意义。省略：沿用 dsh 目录（手填的模型不推理）；
   * 空数组：明确不推理。
   */
  reasoningEfforts: z.array(ProviderReasoningLevelSchema).optional(),
});
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

/**
 * 请求格式的修正，用于 `openai-compatible` 与 `google-vertex`。前四个原样写进 dsh overlay 的 `compat`，Codex 引擎的模型网关
 * 也读它们（`thinkingFormat` 用于 `anthropic-messages`）；其余只有模型网关用（0.4.0、0.12.0、0.26.0，
 * model-gateway.md §4.4），dsh 忽略。
 */
export const ProviderCompatSchema = z.object({
  supportsDeveloperRole: z.boolean().optional(),
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  thinkingFormat: z.string().optional(),
  requiresReasoningContentOnAssistantMessages: z.boolean().optional(),
  /**
   * `openai-responses` 上游不支持自定义工具（Codex 的 `apply_patch`）时设 false（0.4.0）：网关把它们摊平成只有一个
   * 字符串参数的函数，响应里再还原。省略时 xAI 地址默认不支持，其余支持。
   */
  supportsCustomTools: z.boolean().optional(),
  /** Responses 的 namespace 工具支持（0.12.0）：false 时摊平；省略时 xAI 地址为 false，其余为 true。 */
  supportsNamespaceTools: z.boolean().optional(),
  /** 网关三条路的工具选择（0.12.0）：auto_only 改 required / 具名为 auto，none 只去掉 tool_choice。 */
  toolChoice: z.enum(['any', 'auto_only']).optional(),
  /** Chat 工具 Schema 的 Gemini 清洗（0.26.0），默认关闭，详见 model-gateway.md §4.5；dsh 忽略。 */
  geminiToolSchema: z.boolean().optional(),
  /**
   * `openai-completions` 上游怎样收对话中间的 developer / system 消息（0.4.0）：`inline`（默认）原位转 system；
   * `merge` 全部并进开头的一条 system；`user` 开头连续的并成一条 system，之后的转成注明来源的 user 消息。
   * `anthropic-messages` 的当前 Claude 支持 inline（user 之后追加 system），旧模型按 user；merge 并进顶层 system。
   */
  systemMessageMode: z.enum(['inline', 'merge', 'user']).optional(),
});
export type ProviderCompat = z.infer<typeof ProviderCompatSchema>;

/** http / https 地址；允许 localhost 与 IP（本机模型服务）。 */
export const HttpUrlSchema = z.url({ protocol: /^https?$/ });

/** Vertex 的非密钥配置（0.21.0），省略 location 时用 global。 */
export const VertexConfigSchema = z.object({
  project: z.string().min(1),
  location: z.string().min(1).optional(),
});
export type VertexConfig = z.infer<typeof VertexConfigSchema>;

/** Key 不在 Profile 里，线缆上只暴露 `hasSecret`。 */
export const ProviderProfileSchema = z.object({
  id: ProviderIdSchema,
  kind: ProviderKindSchema,
  displayName: z.string(),
  /** `openai-compatible` 与 `google-vertex` 必有。 */
  api: ProviderApiSchema.optional(),
  /** `openai-compatible` 必有；`deepseek-official` 可选（覆盖官方地址）。 */
  baseURL: HttpUrlSchema.optional(),
  compat: ProviderCompatSchema.optional(),
  vertex: VertexConfigSchema.optional(),
  /**
   * `deepseek-official` 可为空，用 dsh 自带目录。`chatgpt`（0.7.0）由 Host 按账号从引擎取（登录成功时与读账号时刷新），
   * 客户端不写。
   */
  models: z.array(ProviderModelSchema),
  defaultModelId: z.string().min(1),
  hasSecret: z.boolean(),
  /**
   * 是否启用（0.19.0，Host 功能 `provider_enabled`，`provider.setEnabled`）：停用的 Provider 不出现在模型选择里，已有会话照常
   * 能用。省略表示启用。
   */
  enabled: z.boolean().optional(),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

// ── 账号（0.7.0，R6） ──────────────────────────────────────────────────

/**
 * 引擎自己的订阅登录（ADR-0005 决策 4）：`chatgpt` 是 Codex 的 `account/*`（0.7.0），凭据由 Codex 存在 Wevir 专属的
 * 目录里。订阅来源（0.19.0，ADR-0005 补记 14）是 `SUBSCRIPTION_KINDS`，每种由对应的引擎读状态、登录：有的在应用里登录
 * （`signIn: in_app`），有的用用户自己在终端里的登录（`signIn: command`）。Host 与客户端都拿不到令牌（domain-model §3.6）。
 * 订阅来源按能力位 `subscription_kinds` 门控。
 */
export const AccountKindSchema = z.enum(['chatgpt', ...SUBSCRIPTION_KINDS]);
export type AccountKind = z.infer<typeof AccountKindSchema>;

/** `browser`：在浏览器里打开 `authUrl`，回调落在本机；`device_code`：在任意设备上打开 `verificationUrl` 输入 `userCode`。 */
export const AccountLoginMethodSchema = z.enum(['browser', 'device_code']);
export type AccountLoginMethod = z.infer<typeof AccountLoginMethodSchema>;

/** 进行中的一次登录。同一时刻最多一个，新的登录替换旧的。 */
export const AccountLoginSchema = z.object({
  /** 引擎给的登录 ID，`account.cancelLogin` 用它。 */
  loginId: z.string().min(1),
  method: AccountLoginMethodSchema,
  /** `browser`：要在浏览器里打开的地址（回调是本机 `127.0.0.1` 上引擎临时监听的端口，浏览器要在这台机器上）。 */
  authUrl: HttpUrlSchema.optional(),
  /** `device_code`：去这个网址登录并输入 `userCode`。 */
  verificationUrl: HttpUrlSchema.optional(),
  /** `device_code`：一次性的码，15 分钟内有效。 */
  userCode: z.string().min(1).optional(),
  startedAt: IsoTimeSchema,
});
export type AccountLogin = z.infer<typeof AccountLoginSchema>;

/** 一个用量窗口（Codex 的 `RateLimitWindow`）。 */
export const AccountRateLimitWindowSchema = z.object({
  /** 已用的百分比，0–100。 */
  usedPercent: z.number().min(0),
  /** 窗口长度（分钟），例如 300（5 小时）、10080（一周）。 */
  windowMinutes: z.int().min(1).optional(),
  /** 窗口重置的时间。 */
  resetsAt: IsoTimeSchema.optional(),
  /** 0.45.0：长度不固定的周期，`monthly` 是按月（计费周期）；有 `windowMinutes` 时以它为准。 */
  period: z.enum(['monthly']).optional(),
  /** 0.45.0：账号有几份额度时这个窗口算的是哪一份（如 `Gemini`、`Auto + Composer`），产品名，界面原样显示。 */
  scope: z.string().min(1).optional(),
});
export type AccountRateLimitWindow = z.infer<typeof AccountRateLimitWindowSchema>;

/**
 * 账号的状态。`signed_out`：没有登录（`lastError` 是最近一次登录失败的原因，取消的不算）；`signing_in`：有一次进行中的
 * 登录（`login`）；`signed_in`：已登录（`email`、`plan`，用量尽力而为，读不到时省略）。
 */
export const AccountStateSchema = z.object({
  kind: AccountKindSchema,
  status: z.enum(['signed_out', 'signing_in', 'signed_in']),
  /** 已登录的账号邮箱；登录中时是之前登录的账号（换号登录）。 */
  email: z.string().optional(),
  /** 套餐，Codex 的 `PlanType` 原值（`free`、`plus`、`pro`、`team`、`business`…），界面认不出就原样显示。 */
  plan: z.string().optional(),
  login: AccountLoginSchema.optional(),
  /** 引擎原文。 */
  lastError: z.string().optional(),
  /**
   * 主窗口（ChatGPT：5 小时）与次窗口（每周）的用量。0.45.0 起 `windows` 是全部窗口（按显示的先后），有它时客户端显示它；
   * 引擎同时把前两个放进 `primary` / `secondary`，给旧客户端。
   */
  rateLimits: z
    .object({
      primary: AccountRateLimitWindowSchema.optional(),
      secondary: AccountRateLimitWindowSchema.optional(),
      windows: z.array(AccountRateLimitWindowSchema).optional(),
    })
    .optional(),
  // 以下是订阅来源（0.19.0）的字段，`chatgpt` 只用到 `planLabel`、`signIn`、`loginMethods`。
  /** 套餐给人看的说法（如 `Max 20x`），引擎认得时给；没有时界面按 `plan` 显示。 */
  planLabel: z.string().min(1).optional(),
  /**
   * 怎样登录：`in_app` 用 `account.login`（方式见 `loginMethods`）；`command` 由用户在终端里运行 `loginCommand`，之后
   * `account.get` 带 `refresh` 重新检测。
   */
  signIn: z.enum(['in_app', 'command']).optional(),
  /** `in_app` 支持的登录方式。 */
  loginMethods: z.array(AccountLoginMethodSchema).optional(),
  /** `command`：要在终端里运行的登录命令，如 `claude auth login`。 */
  loginCommand: z.string().min(1).optional(),
  /** 引擎的运行体（CLI 或下载的程序）找不找得到；false 时登录字段没有意义，界面给安装方法。省略：随包，总是在。 */
  installed: z.boolean().optional(),
  /** 运行体的版本。 */
  version: z.string().min(1).optional(),
  /** 实际用的可执行文件。 */
  executablePath: z.string().min(1).optional(),
  /** 用户用 `account.setPath` 指定的可执行文件，没指定时省略。 */
  customPath: z.string().min(1).optional(),
  /** 用户自己安装的命令（如 `npm install -g @anthropic-ai/claude-code`）。 */
  installCommand: z.string().min(1).optional(),
  /** 安装说明的网页。 */
  installUrl: HttpUrlSchema.optional(),
  /** Wevir 能替用户下载安装（`account.install`），如 Antigravity。 */
  canInstall: z.boolean().optional(),
  /** 正在下载安装；`totalBytes` 不知道时省略。失败时这一项去掉，原因在 `lastError`。 */
  installing: z
    .object({
      completedBytes: z.int().min(0),
      totalBytes: z.int().min(0).optional(),
    })
    .optional(),
});
export type AccountState = z.infer<typeof AccountStateSchema>;

// ── 错误分类 ───────────────────────────────────────────────────────────

export const EngineErrorCategorySchema = z.enum([
  'missing_credentials',
  'provider',
  'engine_exited',
  'cancel_unconfirmed',
  'session_unavailable',
  'unknown',
]);
export type EngineErrorCategory = z.infer<typeof EngineErrorCategorySchema>;

export const EngineErrorInfoSchema = z.object({
  category: EngineErrorCategorySchema,
  /** 引擎原文，始终保留。 */
  message: z.string(),
});
export type EngineErrorInfo = z.infer<typeof EngineErrorInfoSchema>;

// ── 工具展示、输出、待办 ────────────────────────────────────────────────

export const ToolDisplayKindSchema = z.enum([
  'shell',
  'read',
  'edit',
  'write',
  'search',
  'fetch',
  'plan',
  'sub_agent',
  'unknown',
]);
export type ToolDisplayKind = z.infer<typeof ToolDisplayKindSchema>;

export const ToolDisplaySchema = z.object({
  kind: ToolDisplayKindSchema,
  /** 一行摘要：路径、命令、查询词或 URL。 */
  summary: z.string().optional(),
  /** `rawInput` 原值，可能是相对路径。 */
  paths: z.array(z.string()).optional(),
  command: z.string().optional(),
  query: z.string().optional(),
  url: z.string().optional(),
  /** `mcp__<server>__<tool>` 的 server 部分。 */
  mcpServer: z.string().optional(),
});
export type ToolDisplay = z.infer<typeof ToolDisplaySchema>;

/** 截断规则见 host-api.md「工具输出截断上限」。 */
export const ToolOutputSchema = z.object({
  text: z.string(),
  truncated: z.boolean(),
  /** 截断前的长度（UTF-16 code unit），只在 `truncated` 时出现。 */
  originalLength: z.int().min(0).optional(),
});
export type ToolOutput = z.infer<typeof ToolOutputSchema>;

/**
 * 整个 JSON 值超过上限时的替身（host-api.md「工具输出截断上限」）。出现在 `input`、
 * `engine.raw.params` 这类 `unknown` 字段里；客户端看到 `$truncated: true` 就按它显示。
 */
export const TruncatedJsonSchema = z.object({
  $truncated: z.literal(true),
  /** 原值 `JSON.stringify` 后的长度（UTF-16 code unit）。 */
  originalLength: z.int().min(0),
  /** 原值 JSON 文本的开头。 */
  preview: z.string(),
});
export type TruncatedJson = z.infer<typeof TruncatedJsonSchema>;

export const TodoItemSchema = z.object({
  content: z.string(),
  /** dsh `todo_write` 原值（已见 pending / in_progress / completed），其他值原样保留。 */
  status: z.string(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

/**
 * 上下文分布里的一行（0.50.0）。`name` 是引擎给的类别名，原样传；桌面端认得的名字（Messages、System prompt、Free space……）按
 * 界面语言显示，其余照写。
 */
export const UsageCategorySchema = z.object({
  name: z.string().min(1).max(100),
  tokens: z.int().min(0),
  /**
   * 这一行是什么：`used` 占着上下文，`free` 是剩下的，`buffer` 是给压缩留的，`deferred` 是按需才载入的工具定义（不算在窗口里，
   * 只列出来）。其他值按 `used` 看。
   */
  kind: z.string().min(1).max(20),
});
export type UsageCategory = z.infer<typeof UsageCategorySchema>;

/** 一组细项里的一项（0.50.0）：一个 MCP 工具、一个记忆文件、一个自定义 agent、一个技能。 */
export const UsageItemSchema = z.object({
  name: z.string().min(1).max(300),
  /** 它的来源：MCP 工具的服务名、记忆文件的种类、agent 与技能的来源。 */
  source: z.string().max(100).optional(),
  tokens: z.int().min(0),
});
export type UsageItem = z.infer<typeof UsageItemSchema>;

/**
 * 一组细项（0.50.0）：`group` 已见 `mcp_tools`、`memory_files`、`agents`、`skills`，其他值照 `group` 本身显示。`items` 只带
 * 占用最多的前若干项（至多 100），`count` 是这一组一共有多少项。
 */
export const UsageGroupSchema = z.object({
  group: z.string().min(1).max(40),
  count: z.int().min(0),
  items: z.array(UsageItemSchema).max(100),
});
export type UsageGroup = z.infer<typeof UsageGroupSchema>;

/** 上下文是被什么占的（0.50.0）：Claude 报与 `/context` 同口径的分类，Codex 报最近一次请求的输入、缓存与输出。 */
export const UsageBreakdownSchema = z.object({
  categories: z.array(UsageCategorySchema).max(32),
  groups: z.array(UsageGroupSchema).max(16).optional(),
});
export type UsageBreakdown = z.infer<typeof UsageBreakdownSchema>;

export const UsageSchema = z.object({
  contextUsed: z.int().min(0),
  contextSize: z.int().min(0),
  /** 这个会话累计用掉的 token（0.14.0）；引擎不报时省略。 */
  totalTokens: z.int().min(0).optional(),
  /** 已用到这个数时引擎自己压缩上下文（0.29.0）；引擎不自动压缩或不说阈值时省略。 */
  autoCompactAt: z.int().min(0).optional(),
  /** 上下文的分布（0.50.0）；引擎不报时省略。回合中间的 `usage.updated` 不带它时，沿用上一次的。 */
  breakdown: UsageBreakdownSchema.optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const StreamBlockRefSchema = z.object({
  streamId: StreamIdSchema,
  blockIndex: z.int().min(0),
});
export type StreamBlockRef = z.infer<typeof StreamBlockRefSchema>;

// ── 用户消息内容 ────────────────────────────────────────────────────────

/** 能随消息发送的图片格式（0.28.0）。 */
export const UserImageMimeTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
export type UserImageMimeType = z.infer<typeof UserImageMimeTypeSchema>;

/**
 * 消息里的一张图片（0.28.0，Host 功能 `user_images`）：`image.upload` 存下的图片的引用，字节经 `image.read` 读。客户端把
 * `image.upload` 的结果原样放进 `content`；Host 以自己记下的为准。
 */
export const UserImagePartSchema = z.object({
  type: z.literal('image'),
  imageId: ImageIdSchema,
  mimeType: UserImageMimeTypeSchema,
  /** 字节数。 */
  size: z.int().min(1),
  /** 像素，从文件头读出；读不出时省略。 */
  width: z.int().min(1).optional(),
  height: z.int().min(1).optional(),
  /** 原来的文件名；粘贴的截图没有。 */
  name: z.string().min(1).max(255).optional(),
});
export type UserImagePart = z.infer<typeof UserImagePartSchema>;

/**
 * 文本，或图片（0.28.0）。图片按客户端能力 `user_images` 门控：没声明的连接收到的事件与结果里，图片换成文本 `[image]`。
 */
export const UserContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  UserImagePartSchema,
]);
export type UserContentPart = z.infer<typeof UserContentPartSchema>;

// ── ApprovalRequest ───────────────────────────────────────────────────

export const ApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'cancelled',
  'expired',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalOptionSchema = z.object({
  /** 引擎原样，`approval.respond` 回传它。 */
  optionId: z.string().min(1),
  /** 引擎原样；界面按 `kind` 本地化，未知 `kind` 才显示它。 */
  label: z.string(),
  /** 引擎原样（ACP：allow_once / allow_always / reject_once / reject_always）。 */
  kind: z.string(),
  /** 由 `kind` 推导：`allow_` 开头为 allow，其余一律 reject。 */
  category: z.enum(['allow', 'reject']),
});
export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>;

export const ApprovalDetailSchema = z.object({
  toolName: z.string(),
  display: ToolDisplaySchema,
  /** `rawInput` 原样（截断后）；引擎没给时省略。 */
  input: z.unknown().optional(),
  justification: z.string().optional(),
  sandboxPermissions: z.string().optional(),
});
export type ApprovalDetail = z.infer<typeof ApprovalDetailSchema>;

export const ApprovalResolutionReasonSchema = z.enum([
  'user',
  'turn_cancelled',
  'session_closed',
  'engine_exited',
  'host_shutdown',
  'host_restarted',
]);
export type ApprovalResolutionReason = z.infer<typeof ApprovalResolutionReasonSchema>;

export const ApprovalResolutionSchema = z.object({
  /** `reason` 为 `user` 时必有。 */
  optionId: z.string().min(1).optional(),
  /** `reason` 为 `user` 时必有。 */
  decidedBy: ClientIdentitySchema.optional(),
  reason: ApprovalResolutionReasonSchema,
});
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

export const ResolvedApprovalStatusSchema = ApprovalStatusSchema.exclude(['pending']);
export type ResolvedApprovalStatus = z.infer<typeof ResolvedApprovalStatusSchema>;

// ── 提问（0.10.0） ─────────────────────────────────────────────────────

/** 问题的一个选项。 */
export const UserQuestionOptionSchema = z.object({
  label: z.string().min(1),
  /** 选项的补充说明。 */
  description: z.string().optional(),
});
export type UserQuestionOption = z.infer<typeof UserQuestionOptionSchema>;

/** 引擎（Agent）向用户提的一个问题（Codex：`request_user_input`，domain-model §3.8）。 */
export const UserQuestionSchema = z.object({
  /** 这一组里的问题 ID（引擎给的），回答按它对应。 */
  id: z.string().min(1),
  /** 短标题（卡片上的小标签）。 */
  header: z.string().optional(),
  question: z.string().min(1),
  options: z.array(UserQuestionOptionSchema),
  /** 可以选多个（Codex 的问题都是单选）。 */
  multiSelect: z.boolean().optional(),
  /** 可以自己填写“其他”（Codex 恒为 true）。 */
  allowOther: z.boolean().optional(),
  /** 回答不回显（密码类）。 */
  secret: z.boolean().optional(),
});
export type UserQuestion = z.infer<typeof UserQuestionSchema>;

/** 一个问题的回答：选中的选项 `label`，或用户填写的文本；跳过时为空数组。 */
export const QuestionAnswerSchema = z.object({ answers: z.array(z.string()) });
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

export const QuestionStatusSchema = z.enum(['pending', 'answered', 'cancelled']);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

/** 结束一组问题的原因：用户回答了，或同审批一样随回合、会话、引擎、Host 一起取消。 */
export const QuestionResolutionReasonSchema = ApprovalResolutionReasonSchema;

export const QuestionResolutionSchema = z.object({
  reason: QuestionResolutionReasonSchema,
  /** `reason` 为 `user` 时必有：按问题 ID。 */
  answers: z.record(z.string(), QuestionAnswerSchema).optional(),
  /** `reason` 为 `user` 时必有。 */
  answeredBy: ClientIdentitySchema.optional(),
});
export type QuestionResolution = z.infer<typeof QuestionResolutionSchema>;

/** 一组问题（0.10.0）：回合进行中引擎要用户回答，回答后回合接着做。 */
export const QuestionRequestSchema = z.object({
  id: QuestionIdSchema,
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema,
  /** 提问的工具调用（Codex 的 item ID）；没有时省略。 */
  toolCallId: z.string().optional(),
  questions: z.array(UserQuestionSchema).min(1),
  status: QuestionStatusSchema,
  createdAt: IsoTimeSchema,
  resolvedAt: IsoTimeSchema.optional(),
  resolution: QuestionResolutionSchema.optional(),
});
export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;

export const ApprovalRequestSchema = z.object({
  id: ApprovalIdSchema,
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema,
  toolCallId: z.string(),
  options: z.array(ApprovalOptionSchema).min(1),
  /** 找不到对应 `tool.started` 时为 null。 */
  detail: ApprovalDetailSchema.nullable(),
  status: ApprovalStatusSchema,
  createdAt: IsoTimeSchema,
  resolvedAt: IsoTimeSchema.optional(),
  resolution: ApprovalResolutionSchema.optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// ── Session ───────────────────────────────────────────────────────────

export const SessionStateSchema = z.enum([
  'idle',
  'running',
  'awaiting_approval',
  'cancelling',
  'error',
  'closed',
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const ActiveTurnSchema = z.object({
  turnId: TurnIdSchema,
  startedAt: IsoTimeSchema,
  clientMessageId: z.string().optional(),
});
export type ActiveTurn = z.infer<typeof ActiveTurnSchema>;

/**
 * 标题从哪来：`first_prompt` 首条用户消息截断；`user` 用户改的；`generated` 用会话的模型生成（0.5.0，R3，
 * prompts/thread-title.md）。Host 只把 `generated` 发给声明了 `title_source_generated` 能力位的连接，其余连接
 * 看到的是 `first_prompt`（host-api.md §10）。
 */
export const TitleSourceSchema = z.enum(['first_prompt', 'user', 'generated']);
export type TitleSource = z.infer<typeof TitleSourceSchema>;

/**
 * 会话为什么只读（0.3.0，T3.5）：引擎会话恢复不了，历史仍在 Host 的事件库里，可以基于它新建会话。
 * - `engine_session_not_found`：引擎找不到这个会话（dsh 的会话日志被删除，例如引擎数据目录被清理）。
 * - `engine_session_incompatible`：当前引擎读不了它的格式（日志由更新、或没有升级路径的更旧版本写入）。
 * - `engine_session_corrupted`：引擎的会话日志损坏。
 */
export const SessionReadOnlyReasonSchema = z.enum([
  'engine_session_not_found',
  'engine_session_incompatible',
  'engine_session_corrupted',
]);
export type SessionReadOnlyReason = z.infer<typeof SessionReadOnlyReasonSchema>;

export const SessionReadOnlySchema = z.object({
  reason: SessionReadOnlyReasonSchema,
  /** 引擎原文。 */
  message: z.string(),
  /** 标为只读的时间（最近一条 `session.read_only` 的 `ts`）。 */
  since: IsoTimeSchema,
});
export type SessionReadOnly = z.infer<typeof SessionReadOnlySchema>;

// ── 子会话（0.6.0，R4） ─────────────────────────────────────────────────

/**
 * 子会话的状态（domain-model §3.3.1）：由子会话自己的事件推导。`running` 刚派出或回合进行中；回合结束后是
 * `completed` / `cancelled` / `failed`（回合失败或被中断）；父 agent 关掉它是 `closed`。
 */
export const SubagentStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'closed',
  'cancelled',
]);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

/** 子会话的 `Session.subagent`。 */
export const SubagentInfoSchema = z.object({
  /** 父会话里派出它的工具调用（Codex：`collabAgentToolCall` 的 item ID）。 */
  parentToolCallId: z.string().min(1),
  /** 认出它时父会话进行中的回合；在父会话的回合之外认出的没有。 */
  parentTurnId: TurnIdSchema.optional(),
  status: SubagentStatusSchema,
  /** 子会话 `session.created` 的时间。 */
  startedAt: IsoTimeSchema,
  /** 最近一次离开 `running` 的时间；`running` 时没有。 */
  endedAt: IsoTimeSchema.optional(),
});
export type SubagentInfo = z.infer<typeof SubagentInfoSchema>;

/** 父会话快照的 `subagents` 与 `subagent.*` 事件里的一项：一个子会话的摘要。 */
export const SubagentSummarySchema = z.object({
  /** 子会话。 */
  sessionId: SessionIdSchema,
  parentToolCallId: z.string().min(1),
  parentTurnId: TurnIdSchema.optional(),
  /** 子会话当前的标题。 */
  title: z.string(),
  modelId: z.string().min(1),
  reasoningEffort: z.string().optional(),
  /** 引擎给子 agent 起的名字（Codex 的 `agentNickname`）；晚到，可能没有。 */
  nickname: z.string().optional(),
  /** 引擎的子 agent 类型（Codex 的 `agentRole`）。 */
  role: z.string().optional(),
  status: SubagentStatusSchema,
  startedAt: IsoTimeSchema,
  endedAt: IsoTimeSchema.optional(),
  /** 子会话的未决审批的副本（审批属于子会话，`approval.respond` 照常用它的 `id`）。 */
  pendingApprovals: z.array(ApprovalRequestSchema),
});
export type SubagentSummary = z.infer<typeof SubagentSummarySchema>;

// ── 协作模式（0.36.0） ──────────────────────────────────────────────────

/**
 * 回合的协作模式（0.36.0，Host 功能 `plan_mode`，domain-model §3.17）：`default` 照常做事；`plan` 计划模式：Agent 只做不改动
 * 工作区的操作（读、搜索、试运行），可以向用户提问，最后给出一份计划（`plan.proposed`），不实施。按消息给（`session.send` 的
 * `collaborationMode`），不是会话的设置；会话的 `collaborationMode` 是最近一个由消息开始的回合用的模式。
 */
export const CollaborationModeSchema = z.enum(['default', 'plan']);
export type CollaborationMode = z.infer<typeof CollaborationModeSchema>;

/** 没有指定协作模式的消息（含 0.36.0 之前的）按它算。 */
export const DEFAULT_COLLABORATION_MODE: CollaborationMode = 'default';

// ── 待发消息（0.8.0，R11） ──────────────────────────────────────────────

/**
 * 回合进行中发的消息怎样送达（domain-model §3.3.2）：`steer` 插话，不打断回合，等当前这一步（模型这一段输出或这次
 * 工具调用）结束插进同一个回合；`queue` 排队，回合结束后作为下一个回合发出。
 */
export const PendingDeliverySchema = z.enum(['steer', 'queue']);
export type PendingDelivery = z.infer<typeof PendingDeliverySchema>;

/**
 * 待发消息的状态：`waiting` 等待（插话等这一步结束，排队等回合结束）；`held` 暂停（回合以失败或取消结束、会话出错或
 * 关闭、Host 重启，等用户继续发送、编辑或删除）；终态 `inserted` 已插入、`sent` 已发送、`cancelled` 已取消。
 */
export const PendingStatusSchema = z.enum(['waiting', 'held', 'inserted', 'sent', 'cancelled']);
export type PendingStatus = z.infer<typeof PendingStatusSchema>;

/**
 * 要插话却转为排队的原因：`unsupported` 引擎不支持插话；`rejected` 引擎拒绝（回合不能插话，或恰好结束）；
 * `turn_ended` 回合结束（取消、失败、Host 重启）时还没插进去，或回合正在取消。
 */
export const PendingFallbackReasonSchema = z.enum(['unsupported', 'rejected', 'turn_ended']);
export type PendingFallbackReason = z.infer<typeof PendingFallbackReasonSchema>;

/**
 * 会话之间的消息（0.30.0，应用级工具，domain-model §3.15）：这条消息不是用户写的，是另一个会话里的 agent 用 `wevir_session_send`
 * / `wevir_session_create` 发来的（`message`），或 Host 把一个会话回合的结果回报给请它做事的会话（`report`）。
 */
export const MessageFromSchema = z.object({
  sessionId: SessionIdSchema,
  kind: z.enum(['message', 'report']),
  /** `message` 的发送方要回报：这条消息开始的回合结束后，Host 把结果作为 `report` 发回 `sessionId`。 */
  reportBack: z.literal(true).optional(),
  /**
   * 后台进程的通知（0.47.0）：agent 用 `wevir_process_start` 起的进程退出或输出匹配时，Host 发回起它的会话的消息。`kind` 是
   * `report`、`sessionId` 是这个会话自己（旧客户端照回报显示）。
   */
  process: z
    .object({
      /** 会话里的进程 ID（`p1`）。 */
      id: z.string(),
      name: z.string(),
      /** `exit` 退出、`match` 输出的一行匹配了 agent 给的模式；开放字符串。 */
      event: z.string(),
      exitCode: z.number().int().optional(),
      signal: z.string().optional(),
    })
    .optional(),
});
export type MessageFrom = z.infer<typeof MessageFromSchema>;

export const PendingMessageSchema = z.object({
  id: PendingMessageIdSchema,
  content: z.array(UserContentPartSchema).min(1),
  /** 当前的方式。 */
  delivery: PendingDeliverySchema,
  status: PendingStatusSchema,
  /** “已转为排队”：要插话、没插成，`delivery` 已是 `queue`。 */
  fallback: z
    .object({
      reason: PendingFallbackReasonSchema,
      /** 引擎原文。 */
      message: z.string().optional(),
    })
    .optional(),
  /** `session.send` 的幂等键，原样带到 `user.message` / `user.steered`。 */
  clientMessageId: z.string().optional(),
  /**
   * 计划模式（0.36.0）：排队的消息作为回合发出时用它；插进进行中的回合时不起作用（回合沿用自己的模式）。省略表示 `default`。
   */
  collaborationMode: CollaborationModeSchema.optional(),
  sentBy: ClientIdentitySchema,
  /** 别的会话发来的（0.30.0）：原样带到 `user.message` / `user.steered`。 */
  from: MessageFromSchema.optional(),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
  /** `inserted`：插进的回合；`sent`：它开始的回合。 */
  turnId: TurnIdSchema.optional(),
});
export type PendingMessage = z.infer<typeof PendingMessageSchema>;

// ── Host 设置（0.8.0，R11） ──────────────────────────────────────────────

/** 整个 Host 共用、CLI 与桌面一致的偏好（domain-model §3.7）。字段都有默认值。 */
export const HostSettingsSchema = z.object({
  /** 回合进行中按发送（回车、发送按钮）的默认方式；另一种用 Tab（桌面端输入框里的切换改的就是它）。 */
  sendWhileBusy: PendingDeliverySchema,
  /**
   * 输入建议（0.53.0）：回合正常结束后，Host 用会话的模型预测用户接着会发的一句话（`suggestion.updated`）。关掉就不再生成，
   * 也不再有额外的请求；旧 Host 的设置里没有这一项，当作开着。
   */
  promptSuggestions: z.boolean().optional(),
  /**
   * 离开后摘要（0.54.0，`session.recap`，domain-model §3.24）：关掉后 Host 不再生成，也不请求模型。省略按开着（默认）。
   * 新字段，旧客户端的更新与旧 Host 的结果里都可能没有它。
   */
  sessionRecap: z.boolean().optional(),
});
export type HostSettings = z.infer<typeof HostSettingsSchema>;

export const DEFAULT_HOST_SETTINGS: HostSettings = Object.freeze({
  sendWhileBusy: 'steer',
  promptSuggestions: true,
  sessionRecap: true,
});

// ── 联网工具（0.34.0） ──────────────────────────────────────────────────

/**
 * 搜索服务的 ID（0.34.0，`web.*`）：`bocha` 博查、`tavily` Tavily。开放的字符串：以后的 Host 多一家时旧客户端照常解析，按 ID
 * 显示；Host 支持哪些看 `WebSettings.services`。
 */
export const WebSearchServiceIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
export type WebSearchServiceId = z.infer<typeof WebSearchServiceIdSchema>;

/** 现在的 Host 支持的搜索服务。 */
export const WEB_SEARCH_SERVICES = ['bocha', 'tavily'] as const;

/**
 * Agent 的联网工具的设置（0.34.0，Host 功能 `web_tools`，docs/architecture/web-tools.md）：`web_search` 经所选的搜索服务，
 * `web_fetch` 由 Host 自己抓网页、不需要 Key。Key 存在 Host 的密钥存储里，只说配没配。
 */
export const WebSettingsSchema = z.object({
  /** 联网工具开着没有；关着时引擎不登记这两个工具，调用也被拒绝。 */
  enabled: z.boolean(),
  /** `web_search` 用哪个服务。 */
  searchService: WebSearchServiceIdSchema,
  /** Host 支持的搜索服务，按显示顺序；`hasKey` 说存没存 Key。 */
  services: z.array(z.object({ id: WebSearchServiceIdSchema, hasKey: z.boolean() })),
});
export type WebSettings = z.infer<typeof WebSettingsSchema>;

// ── 权限模式（0.11.0，U15） ──────────────────────────────────────────────

/**
 * 会话的权限模式（0.11.0，Host 功能 `permission_modes`，domain-model §3.9）：Agent 要越过工作区的限制（写工作区外的文件、
 * 联网、在沙箱外运行命令）时怎么批准。从下一个回合起生效。
 * - `on_request`（请求批准，默认）：沙箱限在工作区，越界的操作逐个问用户；
 * - `auto_review`（自动批准）：同样的沙箱，越界的操作先由会话所用的模型按审查规则判断，判断为低风险的直接允许，有风险的
 *   拒绝并把理由告诉 Agent（Codex 的 auto review）；
 * - `full_access`（完全访问）：不用沙箱、也不问，可以访问互联网与电脑上的任何文件。
 */
export const PermissionModeSchema = z.enum(['on_request', 'auto_review', 'full_access']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/** 没有指定权限模式的会话（含 0.11.0 之前建的）按它算。 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'on_request';

// ── 接力（0.25.0） ──────────────────────────────────────────────────────

/** 由命令开始的回合的命令（0.27.0，`EngineFeatures.commands`）：`compact` 压缩上下文，`review` 代码审查（domain-model §4.7）。 */
export const SessionCommandSchema = z.enum(['compact', 'review']);
export type SessionCommand = z.infer<typeof SessionCommandSchema>;

/**
 * 一种 Provider 的会话由哪个引擎跑、那个引擎能做什么（0.25.0，`host.hello` 的 `engineFeatures`，按 Provider 种类）。会话接力到
 * 别的来源之后，能用的功能跟着当前的引擎变（domain-model §3.14）。省略的项表示不支持。
 */
export const EngineFeaturesSchema = z.object({
  mcpServers: z.boolean().optional(),
  skills: z.boolean().optional(),
  /** 引擎的名字（`codex`、`claude`、`echo` 等），只作诊断。 */
  engine: z.string().min(1),
  /** 回合进行中插话；没有时插话一律排队。 */
  steer: z.boolean().optional(),
  /** 同一 Provider 里换模型与推理档位（`session.configure`）。 */
  configure: z.boolean().optional(),
  /** 支线会话（`session.fork`）。 */
  fork: z.boolean().optional(),
  /** 向用户提问（`question.*`）。 */
  questions: z.boolean().optional(),
  /** 支持的权限模式；省略表示只有 `on_request`。 */
  permissionModes: z.array(PermissionModeSchema).optional(),
  /** 额外的可写目录：多文件夹的环境会话只能接力给有它的引擎。 */
  additionalRoots: z.boolean().optional(),
  /** 接力过来的引擎会话能用 `read_session_history` 读之前的完整历史。 */
  historyTool: z.boolean().optional(),
  /** 计划模式（0.36.0）：`session.send` 能带 `collaborationMode: 'plan'`，回合里的计划以 `plan.proposed` 报出。 */
  planMode: z.boolean().optional(),
  /**
   * 会话能用的命令（0.27.0）：`compact` 是 `session.compact`，`review` 是 `session.review`，都还要 Host 声明对应的功能。0.27.0
   * 起的 Host 总是给，引擎一个都不会时是空数组；更早的 Host 没有这一项，客户端只能看 Host 的功能。
   */
  commands: z.array(SessionCommandSchema).optional(),
  /** 会话的引擎挂上了 Wevir 的应用级工具（0.30.0，`app_tools`）。 */
  appTools: z.boolean().optional(),
  /** 会话目标（0.35.0，`session.setGoal` 等，还要 Host 声明 `session_goals`）。 */
  goals: z.boolean().optional(),
  /** 分支到新会话（0.38.0，`session.fork` 不带 `side`，还要 Host 声明 `session_branches`），能从任一完成的回合分。 */
  branch: z.boolean().optional(),
  /** 撤回最后一个回合（0.38.0，`session.rewind`，还要 Host 声明 `session_rewind`）。 */
  rewind: z.boolean().optional(),
  /** 撤销 / 重做回合（0.51.0，`session.undo` / `session.redo`，还要 Host 声明 `session_undo`）：引擎能收到补进上下文的说明（`injectNote`）。 */
  undo: z.boolean().optional(),
});
export type EngineFeatures = z.infer<typeof EngineFeaturesSchema>;

/**
 * 撤销 / 重做时会话目录里的文件怎么样了（0.51.0，domain-model §3.22）：`restored` 还原了 `fileCount` 个文件，`unchanged` 目录本来就是
 * 那个样子，`unavailable` 没动文件，`reason`（开放字符串）说为什么：`not_git`（目录不在 git 仓库里）、`no_checkpoint`（这个回合没有快照）、
 * `head_moved`（回合之后 HEAD 动过，还原文件会和提交打架）、`failed`（还原失败，目录已按原样放回）。
 */
export const FilesRestoreSchema = z.object({
  status: z.enum(['restored', 'unchanged', 'unavailable']),
  reason: z.string().min(1).optional(),
  fileCount: z.int().min(0).optional(),
});
export type FilesRestore = z.infer<typeof FilesRestoreSchema>;

/**
 * 离开后摘要（0.54.0，`session.recap`，domain-model §3.24）：一到三句话，说会话在做什么、接下来该做什么。纯文本，用户的语言。
 * `throughSeq` 是生成时会话最后一个回合结束事件的 `seq`：摘要对应的就是这个位置之前的内容，之后会话有新回合，摘要就旧了。
 */
export const SessionRecapSchema = z.object({
  text: z.string().min(1).max(1000),
  generatedAt: IsoTimeSchema,
  throughSeq: SeqSchema,
});
export type SessionRecap = z.infer<typeof SessionRecapSchema>;

/**
 * 接力的方式（0.25.0，开放字符串）：`full_thread_summary`：第一次用这个来源，交给它整段对话的摘要；
 * `delta_since_target_last_seen`：换回用过的来源，只补它错过的那段。
 */
export const HandoffStrategySchema = z.string().min(1);
export type HandoffStrategy = z.infer<typeof HandoffStrategySchema>;

// ── 环境（0.15.0，U22.1） ──────────────────────────────────────────────

/**
 * 会话用文件夹本身还是新开一个 git worktree：`new`：每个会话在这个文件夹的仓库里新开一个；`none`：用工作区目录本身。环境的
 * 文件夹（0.15.0）与 `session.create` 的 `worktree`（0.18.0）共用。
 */
export const WorktreeModeSchema = z.enum(['none', 'new']);
export type WorktreeMode = z.infer<typeof WorktreeModeSchema>;

/** 环境里的一个文件夹（domain-model §3.10）。 */
export const EnvironmentFolderSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  worktree: WorktreeModeSchema,
});
export type EnvironmentFolder = z.infer<typeof EnvironmentFolderSchema>;

/** 保存的一组会话设置：在哪儿跑、用哪几个文件夹（第一个是主文件夹）、每个文件夹要不要新开 worktree。 */
export const EnvironmentSchema = z.object({
  id: EnvironmentIdSchema,
  name: z.string().min(1).max(60),
  /** 现在只有本机；SSH 与云端以后加。 */
  location: z.object({ kind: z.literal('local') }),
  folders: z.array(EnvironmentFolderSchema).min(1).max(8),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type Environment = z.infer<typeof EnvironmentSchema>;

/** Host 为会话新开的 worktree（`Session.worktrees` 的一项；环境会话 0.15.0，单独新开 0.18.0）。 */
export const SessionWorktreeSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  /** worktree 里对应这个文件夹的目录。 */
  path: z.string().min(1),
  branch: z.string().min(1),
});
export type SessionWorktree = z.infer<typeof SessionWorktreeSchema>;

/** 环境会话的目录（0.15.0）：`session.created` 与 `Session` 共用的三个字段，建会话后不变。 */
export const SessionEnvironmentFields = {
  /** 用哪个环境建的。 */
  environmentId: EnvironmentIdSchema.optional(),
  /** 除主文件夹外的文件夹（或它们的 worktree），作为额外的可写目录交给引擎。 */
  extraRoots: z.array(z.string().min(1)).optional(),
  /** Host 为这个会话新开的 worktree（按环境，或 0.18.0 起 `session.create` 的 `worktree: 'new'`）。 */
  worktrees: z.array(SessionWorktreeSchema).optional(),
};

export const TurnOutcomeSchema = z.enum(['completed', 'cancelled', 'failed', 'interrupted']);
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

/**
 * 代码审查看哪些改动（0.24.0，`session.review`）：`uncommitted` 工作树（暂存、未暂存与未跟踪的文件）；`branch` 当前分支对基础分支
 * （Host 找的默认分支，同 `workspace.diff` 的 `branch`）的改动。
 */
export const ReviewTargetSchema = z.enum(['uncommitted', 'branch']);
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;

/**
 * 回合由命令开始、没有用户消息（0.24.0，domain-model §4.7）：`compact` 压缩上下文（`session.compact`），`review` 代码审查
 * （`session.review`；`branch` 时 `baseBranch` 是比较的分支）。
 */
export const TurnCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('compact') }),
  z.object({
    kind: z.literal('review'),
    target: ReviewTargetSchema,
    baseBranch: z.string().min(1).optional(),
  }),
]);
export type TurnCommand = z.infer<typeof TurnCommandSchema>;

/**
 * 会话目标的状态（0.35.0，domain-model §3.16，Codex 的 `ThreadGoalStatus`）：`active` 进行中，引擎在会话空闲时自己开回合接着做；
 * `paused` 用户暂停（停止回合时也会暂停）；`blocked` 模型判定同一阻碍连续出现、需要用户；`usage_limited` 账号用量到了上限；
 * `budget_limited` 用完了 token 预算；`complete` 模型判定已达成。后四种由引擎或模型设置，用户只能在 `active` 与 `paused` 之间切换。
 */
export const GoalStatusSchema = z.enum([
  'active',
  'paused',
  'blocked',
  'usage_limited',
  'budget_limited',
  'complete',
]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

/** 目标的最长字数（0.35.0），同 Codex 的 `MAX_THREAD_GOAL_OBJECTIVE_CHARS`（按 Unicode 码点）。 */
export const GOAL_OBJECTIVE_MAX_CHARS = 4000;

/** 会话的目标（0.35.0，`session.setGoal`）：引擎持久化，Host 从引擎的通知记下（`session.goal_changed`）。 */
export const SessionGoalSchema = z.object({
  objective: z.string().min(1),
  status: GoalStatusSchema,
  /** 用户给的 token 预算；没有时省略。 */
  tokenBudget: z.int().positive().optional(),
  /** 为这个目标用掉的 token。 */
  tokensUsed: z.int().min(0),
  /** 为这个目标工作的时长（秒），只算回合进行的时间。 */
  timeUsedSeconds: z.int().min(0),
  /** 引擎最近一次改动目标的时刻。 */
  updatedAt: IsoTimeSchema,
});
export type SessionGoal = z.infer<typeof SessionGoalSchema>;

/**
 * 回合怎么开始的（0.35.0）：`goal` 为会话目标工作的回合，`session.setGoal` 开的第一个回合（带 `user.message`，即目标本身），或
 * 目标进行中、会话空闲时引擎自己开的回合（没有 `user.message`）。
 */
export const TurnTriggerSchema = z.enum(['goal']);
export type TurnTrigger = z.infer<typeof TurnTriggerSchema>;

/** 上下文压缩怎么来的（0.24.0）：`manual` 用户的 `session.compact`；`auto` 引擎在上下文快满时自己压缩。 */
export const CompactionTriggerSchema = z.enum(['manual', 'auto']);
export type CompactionTrigger = z.infer<typeof CompactionTriggerSchema>;

/** 会话从哪儿分出来（支线 0.17.0，domain-model §3.12；分支 0.38.0，§3.18）。 */
export const SessionForkedFromSchema = z.object({
  sessionId: SessionIdSchema,
  /** 带到哪个完成的回合为止：支线是被分的会话当时最近一个完成的回合，分支是 `session.fork` 的 `turnId`。 */
  turnId: TurnIdSchema.optional(),
});
export type SessionForkedFrom = z.infer<typeof SessionForkedFromSchema>;

/** 支线会话的字段（0.17.0）：`Session` 与 `session.created` 共用。 */
export const SessionSideFields = {
  forkedFrom: SessionForkedFromSchema.optional(),
  /** 支线会话；不进 `session.list`。 */
  side: z.literal(true).optional(),
};

// ── 建议的后续任务（0.16.0，U23） ─────────────────────────────────────

/** Agent 建议的一项后续任务（domain-model §3.11）。 */
export const SuggestedTaskSchema = z.object({
  id: TaskIdSchema,
  title: z.string().min(1).max(200),
  /** 开新会话时的第一条消息。 */
  prompt: z.string().min(1).max(8000),
  reason: z.string().optional(),
  /** 提出建议的工具调用。 */
  toolCallId: z.string().min(1),
  turnId: TurnIdSchema.optional(),
  status: z.enum(['suggested', 'started', 'reported']),
  /** 开出来的会话（started 起有）。 */
  sessionId: SessionIdSchema.optional(),
  /** 那个会话第一个回合的结局（reported 时有）。 */
  outcome: TurnOutcomeSchema.optional(),
});
export type SuggestedTask = z.infer<typeof SuggestedTaskSchema>;

/** 由另一个会话里的 agent 用 `wevir_session_create` 开出来的会话（0.30.0）。 */
export const SessionOpenedBySchema = z.object({
  /** 开出它的会话。 */
  sessionId: SessionIdSchema,
  /** 开它时用的预设角色名（0.52.0，`wevir_session_create` 的 `role`，domain-model §3.15）；没用角色时省略。 */
  role: z.string().min(1).optional(),
});
export type SessionOpenedBy = z.infer<typeof SessionOpenedBySchema>;

// ── 共享任务清单（0.52.0，domain-model §3.15） ───────────────────────────

/** 任务清单里一项的状态。 */
export const BoardTaskStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);
export type BoardTaskStatus = z.infer<typeof BoardTaskStatusSchema>;

/** 一项任务上的备注（谁在什么时候写的）。 */
export const BoardTaskNoteSchema = z.object({
  sessionId: SessionIdSchema,
  text: z.string(),
  at: IsoTimeSchema,
});
export type BoardTaskNote = z.infer<typeof BoardTaskNoteSchema>;

/**
 * 共享任务清单里的一项：一个会话和它开出来的所有会话（再加引擎派出的子 agent）共用一张清单，agent 用 `wevir_tasks`、
 * `wevir_task_create`、`wevir_task_update` 分工。`id` 在清单里唯一（`t1`、`t2`……，不重用）；`owner` 是认领的会话（同一棵会话树里
 * 的），没人认领时省略；`blockedBy` 是要先做完（完成或取消）的几项的 `id`。
 */
export const BoardTaskSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  description: z.string().optional(),
  status: BoardTaskStatusSchema,
  owner: SessionIdSchema.optional(),
  blockedBy: z.array(z.string().min(1)),
  /** 最近的备注，旧的在前；Host 在事件与快照里最多带最近 5 条。 */
  notes: z.array(BoardTaskNoteSchema),
  createdBy: SessionIdSchema,
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type BoardTask = z.infer<typeof BoardTaskSchema>;

/**
 * 请界面显示的东西（0.30.0，`ui.show`）：会话目录里的文件（`path` 相对会话目录，`line` 从 1 开始）、“变更”窗格、“文件”窗格、
 * 另一个会话。
 */
export const UiShowTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file'),
    path: z.string().min(1),
    line: z.int().min(1).optional(),
  }),
  z.object({ kind: z.literal('changes') }),
  z.object({ kind: z.literal('files') }),
  z.object({ kind: z.literal('session'), sessionId: SessionIdSchema }),
]);
export type UiShowTarget = z.infer<typeof UiShowTargetSchema>;

/** `file.shared` 一次最多交几个文件（0.40.0）。 */
export const SHARED_FILES_MAX = 20;

/**
 * Agent 交给用户的一个文件（0.40.0，`wevir_share_file`，domain-model §3.15.2）：会话文件夹里的文件，`path` 相对会话的 `cwd`、
 * `/` 分隔；`name` 是显示的文件名，`size` 是交出时的字节数，`mimeType` 由扩展名推断（认不出时省略）。
 */
export const SharedFileSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  size: z.int().min(0),
  mimeType: z.string().min(1).optional(),
});
export type SharedFile = z.infer<typeof SharedFileSchema>;

/** 会话是怎么来的（0.16.0）：现在只有“从一项建议开出来”。 */
export const SessionOriginSchema = z.object({
  kind: z.literal('suggested_task'),
  /** 提出建议的会话。 */
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema,
});
export type SessionOrigin = z.infer<typeof SessionOriginSchema>;

/**
 * 会话挂过的一个引擎会话（0.25.0，接力，domain-model §3.14）。一个 Wevir 会话可以先后用几个来源，每个来源一个引擎会话；
 * 换回用过的来源时接着用它的引擎会话，只补它错过的那段。
 */
export const SessionEngineSchema = z.object({
  providerId: ProviderIdSchema,
  /** 这个引擎会话最近用的模型。 */
  modelId: z.string().min(1),
  /** 引擎会话 ID，只作诊断。 */
  sessionId: z.string().min(1),
  /**
   * 这个引擎会话的上下文里有会话到这个 `seq` 为止的内容：它自己跑完的回合，或已经随一条消息交给它的接力摘要。
   */
  seenSeq: SeqCursorSchema,
});
export type SessionEngine = z.infer<typeof SessionEngineSchema>;

export const SessionSchema = z.object({
  id: SessionIdSchema,
  workspaceId: WorkspaceIdSchema,
  /** 创建时工作区 `rootPath` 的 realpath，不可变。 */
  cwd: z.string().min(1),
  /** 仅诊断用，客户端不得据此做任何操作。`kind` 是 Host 的引擎（`codex`、`dsh`、`echo`）。 */
  engine: z.object({ kind: z.string(), sessionId: z.string() }),
  providerId: ProviderIdSchema,
  modelId: z.string().min(1),
  /** dsh 的 reasoning_effort 选项值，原样。 */
  reasoningEffort: z.string().optional(),
  /** 权限模式（0.11.0）；省略表示 `on_request`。 */
  permissionMode: PermissionModeSchema.optional(),
  /**
   * 最近一个由消息开始的回合用的协作模式（0.36.0，`user.message` 的 `collaborationMode`）；省略表示 `default`。客户端拿它作输入框
   * 计划开关的初值。
   */
  collaborationMode: CollaborationModeSchema.optional(),
  title: z.string(),
  titleSource: TitleSourceSchema,
  state: SessionStateSchema,
  activeTurn: ActiveTurnSchema.optional(),
  lastError: EngineErrorInfoSchema.optional(),
  /**
   * 引擎会话恢复不了时有（0.3.0）：会话不能再发送，`session.resume` 会重试一次引擎，成功即清除。
   * 状态是 `error` 或 `closed`。
   */
  readOnly: SessionReadOnlySchema.optional(),
  /** 子会话的父会话（0.6.0）：引擎派出的子 agent，只读，由父 agent 驱动（domain-model §3.3.1）。 */
  parentSessionId: SessionIdSchema.optional(),
  /** 只有子会话有（0.6.0）。 */
  subagent: SubagentInfoSchema.optional(),
  /** 有问题等用户回答（0.10.0）：回合仍是 `running`，只是在等用户。 */
  awaitingInput: z.boolean().optional(),
  ...SessionEnvironmentFields,
  /** 从一项建议开出来的会话（0.16.0）。 */
  origin: SessionOriginSchema.optional(),
  /** 由另一个会话里的 agent 开出来的会话（0.30.0）。 */
  openedBy: SessionOpenedBySchema.optional(),
  /** 支线会话（0.17.0，domain-model §3.12）。 */
  ...SessionSideFields,
  createdAt: IsoTimeSchema,
  /** 最后一个事件的 `ts`。 */
  updatedAt: IsoTimeSchema,
  /** 会话里最后一个事件的 `seq`；新建会话为 1（`session.created`）。 */
  lastSeq: SeqCursorSchema,
  /**
   * 接力过的会话（0.25.0，`session.handoff`）：挂过的引擎会话，按第一次用的先后；当前的是 `engine.sessionId` 那个，`providerId`、
   * `modelId` 也跟着它。没接力过时省略。
   */
  engines: z.array(SessionEngineSchema).optional(),
  /**
   * 归档的时刻（0.23.0）：归档的会话已关闭，`session.list` 默认不列。不是事件推导的，只出现在 `session.list`、`session.get`
   * 与 `session.*` 方法的结果里；订阅的事件不带它。
   */
  archivedAt: IsoTimeSchema.optional(),
  /** 会话的目标（0.35.0，`session.goal_changed`）；没有或已清除时省略。 */
  goal: SessionGoalSchema.optional(),
});
export type Session = z.infer<typeof SessionSchema>;

/** 输入建议的长度上限（按 UTF-16 code unit）：一句话，Host 整理后不会超过它。 */
export const PROMPT_SUGGESTION_MAX_LENGTH = 200;

/**
 * 输入建议（0.53.0，domain-model §3.23）：`turnId` 是它所预测的那个回合（刚正常结束的回合），`text` 是一句话，用用户的口气与语言，
 * 不为空。客户端把它灰着放在空的输入框里，接受就是把 `text` 当作用户消息发出。
 */
export const PromptSuggestionSchema = z.object({
  turnId: TurnIdSchema,
  text: z.string().min(1).max(PROMPT_SUGGESTION_MAX_LENGTH),
});
export type PromptSuggestion = z.infer<typeof PromptSuggestionSchema>;

/** `session.get` 的结果：由事件推导的快照（ADR-0002 §3）。 */
export const SessionSnapshotSchema = z.object({
  session: SessionSchema,
  pendingApprovals: z.array(ApprovalRequestSchema),
  /** 最近一次 `todo.updated`。 */
  todos: z.array(TodoItemSchema).optional(),
  /** 最近一次 `usage.updated`。 */
  usage: UsageSchema.optional(),
  /** 这个会话派出的子会话（0.6.0），按 `startedAt`；没有时省略。 */
  subagents: z.array(SubagentSummarySchema).optional(),
  /** 等待中与暂停的待发消息（0.8.0），按加入的先后；没有时省略。 */
  pendingMessages: z.array(PendingMessageSchema).optional(),
  /** 等用户回答的问题（0.10.0），按提出的先后；没有时省略。 */
  pendingQuestions: z.array(QuestionRequestSchema).optional(),
  /** 这个会话里 Agent 建议的后续任务（0.16.0），按提出的先后；没有时省略。 */
  suggestedTasks: z.array(SuggestedTaskSchema).optional(),
  /**
   * 共享任务清单（0.52.0）：最近一次 `tasks.board_updated`，只有会话树的根会话有；清单从没改过时省略，任务都删光后是空数组。
   */
  taskBoard: z.array(BoardTaskSchema).optional(),
  /**
   * 输入建议（0.53.0）：最近一次 `suggestion.updated`，用户有了新消息、回合重新开始或回合被撤回 / 撤销 / 重做后就没有了；没有时省略。
   */
  promptSuggestion: PromptSuggestionSchema.optional(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
