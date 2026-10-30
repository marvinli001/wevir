import { z } from 'zod';
import { ProposedApprovalRuleSchema } from './approval-rules.js';
import {
  ApprovalIdSchema,
  ApprovalRuleIdSchema,
  AutomationIdSchema,
  AutomationRunIdSchema,
  ChannelIdSchema,
  ClientIdentitySchema,
  EnvironmentIdSchema,
  ImageIdSchema,
  InsightIdSchema,
  IsoTimeSchema,
  OpinionIdSchema,
  PendingMessageIdSchema,
  ProviderIdSchema,
  QuestionIdSchema,
  SeqCursorSchema,
  SeqSchema,
  SessionIdSchema,
  StreamIdSchema,
  TaskIdSchema,
  TuningProposalIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from './common.js';
import { RemoteSettingsSchema } from './devices.js';
import { GitObjectIdSchema } from './git.js';
import { MarketMirrorPreferenceSchema } from './market.js';
import { NotificationKindSettingsSchema } from './notifications.js';
import { ImportedFromSchema } from './plugins.js';
import { ProfileVersionRefSchema } from './tuning.js';
import { RepairFromSchema, SessionVerificationSchema } from './verification.js';

// 领域实体的线缆形状，字段含义见 docs/architecture/domain-model.md §3。

// ── Workspace ──────────────────────────────────────────────────────────

/**
 * 工作区的种类（0.39.0，domain-model §3.1）：`chats` 是 Host 自己的“对话”工作区，放不在项目里的会话，每个会话在它下面有自己的
 * 文件夹（`<数据目录>/chats/<会话 ID>`）。`assistant`（0.120.0）是一个助理的隐藏工作区 `<数据目录>/assistants/<频道 ID>`，不出现在
 * `workspace.list` 里。省略表示用户添加的项目。
 */
export const WorkspaceKindSchema = z.enum(['chats', 'assistant']);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

/** 项目除 `rootPath` 外最多几个源文件夹（0.64.0）：加上主文件夹共 8 个，同环境的文件夹上限。 */
export const WORKSPACE_EXTRA_FOLDERS_MAX = 7;

export const WorkspaceSchema = z.object({
  id: WorkspaceIdSchema,
  /** 目录的 realpath；Host 按它去重。 */
  rootPath: z.string().min(1),
  displayName: z.string(),
  /** 0.39.0；省略表示项目。 */
  kind: WorkspaceKindSchema.optional(),
  /**
   * 项目的其他源文件夹（0.64.0，Host 功能 `workspace_folders`）：各自的 realpath，按添加顺序；省略表示只有 `rootPath`。项目里
   * 的会话把它们作为额外的可写目录交给引擎（`Session.extraRoots`），引擎不支持时不给。
   */
  extraFolders: z.array(z.string().min(1)).max(WORKSPACE_EXTRA_FOLDERS_MAX).optional(),
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
 * `antigravity`、`workbuddy`（0.55.0）、`devin`（0.88.0）、`copilot`（0.125.0，GitHub Copilot CLI）、`kiro`（0.141.0，Kiro CLI），各自由对应的引擎运行（ADR-0005 补记 14），同样没有 Key 与地址，模型来自引擎，ID 固定等于种类。按能力位
 * `subscription_kinds` 门控，规则同 `chatgpt`。
 */
export const SUBSCRIPTION_KINDS = [
  'claude',
  'cursor',
  'opencode',
  'grok',
  'antigravity',
  'workbuddy',
  'devin',
  'copilot',
  'kiro',
] as const;
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
 * 转写模型（0.92.0，听写，domain-model §3.2）：`openai-compatible` 的服务上走 `POST <baseURL>/audio/transcriptions` 的模型（如
 * `whisper-1`、`gpt-4o-transcribe`、Groq 的 `whisper-large-v3-turbo`）。与对话模型分开列，不出现在模型选择里。
 */
export const ProviderTranscriptionModelSchema = z.object({
  /** 发给服务端的模型 ID。 */
  id: z.string().min(1).max(200),
  displayName: z.string().max(200).optional(),
});
export type ProviderTranscriptionModel = z.infer<typeof ProviderTranscriptionModelSchema>;

/** 一个 Provider 最多几个转写模型。 */
export const PROVIDER_TRANSCRIPTION_MODELS_MAX = 20;

/**
 * 图片模型（0.139.0，生图，domain-model §3.2）：`openai-compatible` 的服务上走 `POST <baseURL>/images/generations` 与
 * `/images/edits` 的模型（OpenAI 的 `gpt-image-2` 系列与兼容服务的同类模型）。与对话模型分开列，不出现在模型选择里；会话的
 * Provider 有图片模型时，应用级工具多一个 `wevir_image_generate`。
 */
export const ProviderImageModelSchema = z.object({
  /** 发给服务端的模型 ID。 */
  id: z.string().min(1).max(200),
  displayName: z.string().max(200).optional(),
});
export type ProviderImageModel = z.infer<typeof ProviderImageModelSchema>;

/** 一个 Provider 最多几个图片模型。 */
export const PROVIDER_IMAGE_MODELS_MAX = 20;

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
  /**
   * Codex 的工具搜索（0.123.0，`supports_search_tool`）：打开时 Codex 首个请求只带常驻的工具与一个 `tool_search`，按需的工具
   * 搜到才加载。`native` 原样发给认它的上游（OpenAI 官方 Responses 地址默认）；`dispatch` 由网关把它翻译成普通函数，搜到的
   * 工具经一个分发函数调用（其余地址默认）；`off` 关掉，工具全部直接列出。dsh 忽略。
   */
  toolSearch: z.enum(['native', 'dispatch', 'off']).optional(),
  /**
   * 网关发给上游的请求体压缩（0.126.0）：`gzip` 时较大的请求体带 `Content-Encoding: gzip` 发出，上游以 400 / 413 / 415 拒绝时去掉
   * 压缩重发并记住这个 Provider 不收；省略时不压缩。没有哪家的文档说收压缩的请求体，所以默认不开。dsh 忽略。
   */
  requestCompression: z.enum(['gzip']).optional(),
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
  /** 转写模型（0.92.0），只有 `openai-compatible` 有；省略表示没有。 */
  transcriptionModels: z
    .array(ProviderTranscriptionModelSchema)
    .max(PROVIDER_TRANSCRIPTION_MODELS_MAX)
    .optional(),
  /** 图片模型（0.139.0），只有 `openai-compatible` 有；省略表示没有。第一个是生图工具的默认模型。 */
  imageModels: z.array(ProviderImageModelSchema).max(PROVIDER_IMAGE_MODELS_MAX).optional(),
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

/** 账号标签（0.63.0）最长多少字符。 */
export const ACCOUNT_LABEL_MAX_LENGTH = 16;

/** 账号标签（0.63.0）：一到十六个字符，不以空白开头或结尾。 */
export const AccountLabelSchema = z
  .string()
  .min(1)
  .max(ACCOUNT_LABEL_MAX_LENGTH)
  .regex(/^\S(?:.*\S)?$/s);

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

/**
 * 应用内登录可选的方式（0.56.0，WorkBuddy 的国内 / 国际站）：未登录且 `signIn` 是 `in_app` 时由引擎在 `AccountState.loginOptions`
 * 里列出，用户选了哪一项，`account.login` 的 `option` 就带回它的 `id`。
 */
export const AccountLoginOptionSchema = z.object({
  /** 引擎认的 ID，不透明字符串，`option` 原样带回。 */
  id: z.string().min(1).max(64),
  /** 引擎给的名称（如 `WeChat`、`Google / GitHub`），产品名，界面原样显示。 */
  label: z.string().min(1),
});
export type AccountLoginOption = z.infer<typeof AccountLoginOptionSchema>;

/** 订阅来源后面接着的一家上游的一种接入方式（0.56.0，OpenCode）。 */
export const AccountUpstreamMethodSchema = z.object({
  /**
   * `oauth`：浏览器授权或设备码，`account.login` 返回 `signing_in`，授权网址或设备码在 `login`；`api_key`：填 API Key，
   * `account.login` 带 `apiKey`，立即返回重新检测后的状态。
   */
  type: z.enum(['oauth', 'api_key']),
  /** 引擎给的方式名（如 “ChatGPT Pro/Plus (headless)”），产品名，界面原样显示。 */
  label: z.string().min(1),
  /** 这种方式在这家上游里的 ID，`account.login` 的 `option` 原样带回（OpenCode：方式的序号，默认的 API Key 方式是 `default`）。 */
  option: z.string().min(1).max(64),
});
export type AccountUpstreamMethod = z.infer<typeof AccountUpstreamMethodSchema>;

/**
 * 订阅来源后面接着的一家上游（0.56.0，OpenCode：OpenCode Zen / Go、OpenAI、GitHub Copilot…，一个 opencode 同时接着好几家）。
 * 只列在应用内能接的：要自己填实例地址、账号 ID 的方式引擎不提供，用户仍可在终端里登录。
 */
export const AccountUpstreamSchema = z.object({
  /** 引擎的上游 ID（`openai`、`github-copilot`…），`account.login` 的 `upstream`。 */
  id: z.string().min(1),
  name: z.string().min(1),
  /** 已接上：凭据在引擎里、环境变量里，或是引擎自带的免登录模型（OpenCode Zen）。 */
  connected: z.boolean(),
  /** 常用的（引擎自己列在最前面的几家，和有 OAuth 登录的）：界面可以先只列这些，其余放在“更多”里。 */
  featured: z.boolean(),
  /** 能用的接入方式，至少一种。 */
  methods: z.array(AccountUpstreamMethodSchema).min(1),
});
export type AccountUpstream = z.infer<typeof AccountUpstreamSchema>;

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
  /**
   * 0.63.0：账号 ID，也是这个账号的 Provider 的 ID。每种的首个账号等于种类（`claude`），之后添加的是 `<种类>-<4 位十六进制>`
   * （`account.add`）。新 Host 总是带；省略时是首个账号。
   */
  id: ProviderIdSchema.optional(),
  /** 0.63.0：用户给账号的标签（`account.setLabel`，如“主号”“工作”），界面显示它的首字角标。 */
  label: AccountLabelSchema.optional(),
  /** 0.63.0：用的是用户本机终端里的登录（Claude、Grok 的首个账号）：登出会让终端也登出。 */
  localLogin: z.literal(true).optional(),
  /** 0.63.0：这种来源能添加账号（`account.add`，Host 功能 `subscription_accounts`）；每个账号的状态都带。 */
  multiAccount: z.literal(true).optional(),
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
  /**
   * 0.56.0：`in_app` 且未登录时，引擎有几种登录方式可选（WorkBuddy：国内版微信、国际版 Google / GitHub）就列在这里，第一项是
   * 缺省；`account.login` 不带 `option` 时用缺省。只有一项或没有时客户端不必让用户选。
   */
  loginOptions: z.array(AccountLoginOptionSchema).min(1).optional(),
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

/**
 * 回合因订阅账号的用量上限失败（0.119.0，`engine.error` 的 `usageLimit`）。`resetsAt` 是额度恢复的时刻：引擎报的，或 Host 从账号的
 * 用量里取的（用完的窗口里最晚重置的那个）；`windowMinutes` 是用完的窗口的长度（300 是 5 小时，10080 是一周）。不知道时省略。
 */
export const UsageLimitSchema = z.object({
  resetsAt: IsoTimeSchema.optional(),
  windowMinutes: z.int().min(1).optional(),
});
export type UsageLimit = z.infer<typeof UsageLimitSchema>;

/**
 * 额度恢复后自动继续最多等多久（0.119.0，`session.setAutoContinue`）：额度在这之后才恢复（每周的额度等）时不能开。同 Claude Code
 * 不替用户等超过一天的重置。
 */
export const AUTO_CONTINUE_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * 会话的自动继续（0.119.0，Host 功能 `usage_auto_continue`）：`turnId` 是因用量上限失败的回合，Host 在 `resumeAt` 替用户发一条
 * 继续的消息（`from.usageLimit`）。会话开始任何新的回合时作废。
 */
export const SessionAutoContinueSchema = z.object({
  turnId: TurnIdSchema,
  resumeAt: IsoTimeSchema,
});
export type SessionAutoContinue = z.infer<typeof SessionAutoContinueSchema>;

/** 回合末的下一步卡片（0.128.0，`turn.wrap_up`）的上限，按码点；schema 按 UTF-16 计长，放宽到两倍。 */
export const WRAP_UP_RECAP_MAX_LENGTH = 400;
export const WRAP_UP_ASK_MAX_LENGTH = 120;
export const WRAP_UP_ACTIONS_MAX = 2;
export const WRAP_UP_LABEL_MAX_LENGTH = 24;
export const WRAP_UP_MESSAGE_MAX_LENGTH = 500;

/** 下一步卡片上的一个按钮（0.128.0）：`label` 是按钮字，点了以用户身份发出 `message`。第一个是 agent 的推荐。 */
export const WrapUpActionSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(WRAP_UP_LABEL_MAX_LENGTH * 2),
  message: z
    .string()
    .min(1)
    .max(WRAP_UP_MESSAGE_MAX_LENGTH * 2),
});
export type WrapUpAction = z.infer<typeof WrapUpActionSchema>;

/**
 * 会话最近一次回合收尾（0.128.0，Host 功能 `turn_wrap_up`，最近一次 `turn.wrap_up`）：`recap` 两三句说现在的情况，`ask` 是等用户
 * 做的一个决定，`blocked` 表示不等答复做不下去（侧栏放进“需要你”）。不带按钮，按钮只在事件里。会话开始新的回合、用户发了消息、
 * 这个回合被撤销或撤回时作废。
 */
export const SessionWrapUpSchema = z.object({
  turnId: TurnIdSchema,
  recap: z
    .string()
    .min(1)
    .max(WRAP_UP_RECAP_MAX_LENGTH * 2),
  ask: z
    .string()
    .min(1)
    .max(WRAP_UP_ASK_MAX_LENGTH * 2)
    .optional(),
  blocked: z.literal(true).optional(),
});
export type SessionWrapUp = z.infer<typeof SessionWrapUpSchema>;

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
  /** 生成或编辑图片（0.118.0，Codex 的 `imageGeneration`）。客户端没有 `tool_display_image` 时 Host 降级成 `unknown`。 */
  'image',
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

/** 一次工具调用最多带几张图片（0.118.0，`tool.finished` 的 `images`）。 */
export const TOOL_IMAGES_MAX = 16;

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
 * 0.90.0 起文本可以标 `pasted`：用户从别处粘贴进来的一大段（客户端把它单独放一段），Host 交给引擎时包进
 * `<pasted_content>`，让模型分清哪些是用户自己写的（prompts/base.md「不可信内容」）。旧 Host 丢掉这个字段，照普通文本发。
 */
export const UserTextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  pasted: z.literal(true).optional(),
});
export type UserTextPart = z.infer<typeof UserTextPartSchema>;

export const UserContentPartSchema = z.discriminatedUnion('type', [
  UserTextPartSchema,
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

/**
 * 用户接入的 MCP 服务要用户打开一个链接（URL 模式的 elicitation）时，审批详情的 `toolName`：`input.url` 是要打开的地址（只会是 http 或
 * https），`input.message` 是服务的说明。允许表示用户同意打开，客户端在浏览器里打开它；同 `@wevir/runtime-adapter` 的同名常量。
 */
export const MCP_URL_ELICITATION_TOOL = 'mcp/elicitation/url';

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
  /** Host 按审批规则替用户允许（0.80.0）：带 `optionId` 与 `ruleIds`，没有 `decidedBy`。 */
  'rule',
  /**
   * 到了 `expiresAt` 没人回（0.105.0，Host 功能 `approval_timeout`）：状态是 `expired`，带 Host 替用户选的拒绝类 `optionId`；
   * 没有拒绝类选项时没有 `optionId`，回合随之取消。
   */
  'timeout',
  /**
   * 生命周期钩子（0.137.0，`PermissionRequest`）替用户答的：带 `optionId`，没有 `decidedBy`；同时有一条 `hook.outcome`。客户端没有
   * 能力位 `hook_decisions` 时 Host 把它降级成 `rule`。
   */
  'hook',
]);
export type ApprovalResolutionReason = z.infer<typeof ApprovalResolutionReasonSchema>;

/** 拒绝附言的长度上限（0.144.0），按 UTF-16 code unit。 */
export const APPROVAL_MESSAGE_MAX_LENGTH = 20_000;

export const ApprovalResolutionSchema = z.object({
  /** `reason` 为 `user` 时必有。 */
  optionId: z.string().min(1).optional(),
  /** `reason` 为 `user` 时必有。 */
  decidedBy: ClientIdentitySchema.optional(),
  reason: ApprovalResolutionReasonSchema,
  /**
   * 审批规则（0.80.0）：`reason` 为 `rule` 时是匹配上的规则；为 `user` 时是这次选“总是允许”加的规则（`approval.respond` 的
   * `remember`）。规则之后可能被删掉，这里只是当时的 ID。
   */
  ruleIds: z.array(ApprovalRuleIdSchema).optional(),
  /**
   * 拒绝附言（0.144.0）：随拒绝交给了引擎的用户的话（`approval.respond` 的 `message`、`session.send` 的 `declineApproval`）。引擎收不了
   * 附言时没有，那句话作为插话或待发消息出现在消息记录里。
   */
  message: z.string().min(1).max(APPROVAL_MESSAGE_MAX_LENGTH).optional(),
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
  /**
   * 推荐的选项（0.72.0）：某个选项的 `label`。引擎给了用引擎的；没给时 Host 取标签以“(Recommended)”或“（推荐）”结尾的那个，
   * 都没有就取第一个。没有选项时省略。超时自动回答时按它回答。
   */
  defaultOption: z.string().min(1).optional(),
});
export type UserQuestion = z.infer<typeof UserQuestionSchema>;

/** 一个问题的回答：选中的选项 `label`，或用户填写的文本；跳过时为空数组。 */
export const QuestionAnswerSchema = z.object({ answers: z.array(z.string()) });
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

export const QuestionStatusSchema = z.enum(['pending', 'answered', 'cancelled']);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

/**
 * 结束一组问题的原因：用户回答了，或同审批一样随回合、会话、引擎、Host 一起取消。`timeout`（0.72.0）：到了 `autoAnswerAt` 没人
 * 回答，Host 按每题的 `defaultOption` 回答（状态 `answered`，没有选项的题跳过）。
 */
export const QuestionResolutionReasonSchema = z.enum([
  ...ApprovalResolutionReasonSchema.exclude(['rule', 'timeout']).options,
  'timeout',
]);
export type QuestionResolutionReason = z.infer<typeof QuestionResolutionReasonSchema>;

export const QuestionResolutionSchema = z.object({
  reason: QuestionResolutionReasonSchema,
  /** `reason` 为 `user` 或 `timeout` 时必有：按问题 ID。 */
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
  /**
   * 到这个时间还没人回答，Host 按推荐的选项回答（0.72.0，Host 功能 `question_timeout`）。无人值守的会话（自动化开的、子会话、
   * 另一个会话里的 agent 开的）才有；省略表示一直等。
   */
  autoAnswerAt: IsoTimeSchema.optional(),
  resolvedAt: IsoTimeSchema.optional(),
  resolution: QuestionResolutionSchema.optional(),
});
export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;

/**
 * 高风险审批的原因（0.131.0，Host 功能 `approval_risk`），开放字符串，客户端不认识的照样当高风险：
 * - `destructive_command`：命令里有删改文件、进程或发往别处的程序（`rm`、`mv`、`kill`、`curl`、`ssh`…）或改写历史、推送的 git 子命令；
 * - `privileged_command`：`sudo`、`su`、`doas`；
 * - `unparsed_command`：命令里有展开、重定向、子 shell 之类 Host 拆不开的写法，看不出它会做什么；
 * - `outside_sandbox`：要求在沙箱外执行（Codex 的 `sandbox_permissions: require_escalated`）。
 */
export const ApprovalRiskReasonSchema = z.string().min(1);
export type ApprovalRiskReason = z.infer<typeof ApprovalRiskReasonSchema>;

/** Host 判定的风险（0.131.0）：有它就是高风险，手机要先验证本人（Face ID / 指纹）再作答。省略表示普通。 */
export const ApprovalRiskSchema = z.object({
  level: z.literal('high'),
  reasons: z.array(ApprovalRiskReasonSchema).min(1),
});
export type ApprovalRisk = z.infer<typeof ApprovalRiskSchema>;

export const ApprovalRequestSchema = z.object({
  id: ApprovalIdSchema,
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema,
  toolCallId: z.string(),
  options: z.array(ApprovalOptionSchema).min(1),
  /** 找不到对应 `tool.started` 时为 null。 */
  detail: ApprovalDetailSchema.nullable(),
  /** Host 提议的“总是允许”的前缀（0.80.0，Host 功能 `approval_rules`）；没有时卡片不给这个选项。 */
  proposedRule: ProposedApprovalRuleSchema.optional(),
  status: ApprovalStatusSchema,
  createdAt: IsoTimeSchema,
  /**
   * 到这个时间还没人回，Host 按拒绝结掉（0.105.0，Host 功能 `approval_timeout`，`timeout`）。无人值守的会话、并且设置了
   * `unattendedApprovalTimeoutMinutes` 时才有；省略表示一直等。
   */
  expiresAt: IsoTimeSchema.optional(),
  /** Host 判定的风险（0.131.0，Host 功能 `approval_risk`）；省略表示普通。 */
  risk: ApprovalRiskSchema.optional(),
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
 * 关闭、Host 重启，等用户继续发送、编辑或删除；带 `from` 的（引用第二意见除外）在之后的回合完成时转回等待）；终态 `inserted` 已插入、
 * `sent` 已发送、`cancelled` 已取消。
 */
export const PendingStatusSchema = z.enum(['waiting', 'held', 'inserted', 'sent', 'cancelled']);
export type PendingStatus = z.infer<typeof PendingStatusSchema>;

/**
 * 要插话却转为排队的原因：`unsupported` 引擎不支持插话；`rejected` 引擎拒绝（回合不能插话，或恰好结束）；
 * `turn_ended` 回合结束（取消、失败、Host 重启）时还没插进去，或回合正在取消。
 */
export const PendingFallbackReasonSchema = z.enum(['unsupported', 'rejected', 'turn_ended']);
export type PendingFallbackReason = z.infer<typeof PendingFallbackReasonSchema>;

/** 第二意见（0.75.0）的长度上限（按 UTF-16 code unit）：发起时的侧重点、意见正文（超出的截断）与引用时的附言。 */
export const SECOND_OPINION_FOCUS_MAX_LENGTH = 2000;
export const SECOND_OPINION_TEXT_MAX_LENGTH = 20_000;
export const SECOND_OPINION_NOTE_MAX_LENGTH = 8000;

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
  /**
   * 自动修复（0.65.0，ADR-0008）：Host 为修复链交给 Agent 的检查失败材料。`kind` 是 `report`、`sessionId` 是这个会话自己（旧客户端照
   * 回报显示）。
   */
  repair: RepairFromSchema.optional(),
  /**
   * 生命周期钩子（0.137.0）：引擎没有原生的结束接点时，`Stop` 钩子要求 Agent 接着做，Host 以这条消息开一个后续回合。`kind` 是
   * `report`、`sessionId` 是这个会话自己（旧客户端照回报显示）。
   */
  hook: z.object({ event: z.string().min(1), hookId: z.string().optional() }).optional(),
  /**
   * 引用的第二意见（0.75.0）：Host 把意见拼成消息交给原会话。`kind` 是 `report`、`sessionId` 是给意见的会话（旧客户端照回报显示）；
   * `note` 是用户引用时附的话，原样也在消息正文里。
   */
  opinion: z
    .object({
      opinionId: OpinionIdSchema,
      note: z.string().min(1).max(SECOND_OPINION_NOTE_MAX_LENGTH).optional(),
    })
    .optional(),
  /**
   * 额度恢复后自动继续（0.119.0）：Host 替用户发的继续消息，`turnId` 是因用量上限失败的回合。`kind` 是 `report`、`sessionId` 是这个
   * 会话自己（旧客户端照回报显示）；新客户端不显示这条消息。
   */
  usageLimit: z.object({ turnId: TurnIdSchema }).optional(),
  /**
   * 频道（0.120.0，ADR-0020）：`wake` 是 Host 交给协调者的唤醒信封（`kind` 是 `report`、`sessionId` 是协调者自己）；`relay` 是协调者
   * 转给线程的用户帖子（`kind` 是 `message`、`sessionId` 是协调者）。旧客户端照会话间消息显示。
   */
  channel: z.object({ channelId: ChannelIdSchema, kind: z.enum(['wake', 'relay']) }).optional(),
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

// ── 用户的说明与输出风格（0.78.0） ──────────────────────────────────────

/** “给 Agent 的说明”最长多少个字符。 */
export const AGENT_INSTRUCTIONS_MAX_LENGTH = 16_000;
export const AgentInstructionsSchema = z.string().max(AGENT_INSTRUCTIONS_MAX_LENGTH);

/**
 * 输出风格（0.78.0，domain-model §3.34），开放字符串：`default`（不加风格）与 `OUTPUT_STYLES` 里的几种，正文是 prompts/output-styles/
 * 下的同名文件（`pragmatic`、`friendly` 是 Codex 的两种性格）。Host 只接受它认识的值；客户端遇到不认识的按 `default` 显示。
 */
export const OUTPUT_STYLES = [
  'concise',
  'explanatory',
  'learning',
  'proactive',
  'pragmatic',
  'friendly',
] as const;
export const OutputStyleSchema = z.string().min(1);
export type OutputStyle = 'default' | (typeof OUTPUT_STYLES)[number];

export function isOutputStyle(value: string): value is OutputStyle {
  return value === 'default' || (OUTPUT_STYLES as readonly string[]).includes(value);
}

// ── 听写的转写方（0.92.0） ─────────────────────────────────────────────

/**
 * 听写用谁转写（0.92.0，domain-model §3.7）：`local` 是本机模型（Host 下载的 SenseVoice，`speech.install`），`provider` 是某个
 * Provider 的转写模型（`ProviderProfile.transcriptionModels`）。
 */
export const SpeechTranscriberSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }),
  z.object({
    kind: z.literal('provider'),
    providerId: ProviderIdSchema,
    modelId: z.string().min(1).max(200),
  }),
]);
export type SpeechTranscriber = z.infer<typeof SpeechTranscriberSchema>;

// ── Host 设置（0.8.0，R11） ──────────────────────────────────────────────

/** `autoTuningMonthlyTokens` 的范围与省略时的值（0.108.0）。 */
export const AUTO_TUNING_MONTHLY_TOKENS_MIN = 10_000;
export const AUTO_TUNING_MONTHLY_TOKENS_MAX = 10_000_000;
export const AUTO_TUNING_MONTHLY_TOKENS_DEFAULT = 200_000;

/** `unattendedApprovalTimeoutMinutes` 的上限（一天）。 */
export const UNATTENDED_APPROVAL_TIMEOUT_MAX_MINUTES = 1440;

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
  /**
   * 自动记忆（0.57.0，Host 功能 `memory`，domain-model §3.21）：Agent 读写跨会话记忆。关掉后 Host 不再把记忆清单放进新会话的
   * 说明，`wevir_memory_*` 工具不再列出，调用也被拒绝；用户照样能用 `memory.*` 管理已有笔记。省略按开着（默认）。
   */
  autoMemory: z.boolean().optional(),
  /**
   * 跨引擎的规则文件（0.68.0，Host 功能 `rule_files`）：会话的引擎自己不读的 AGENTS.md / CLAUDE.md / GEMINI.md / Cursor 规则由 Host
   * 补给它。关掉后不再补，从下一次建会话、恢复或接力起生效；`session.rules` 照样记下引擎自己读的。省略按开着（默认）。
   */
  ruleFiles: z.boolean().optional(),
  /**
   * 给 Agent 的说明（0.78.0，Host 功能 `agent_instructions`，domain-model §3.34）：用户写给所有会话的长期说明，空串表示没有。与
   * 输出风格一起由 Host 交给引擎，从下一次建会话、恢复或接力起生效。省略按空串。
   */
  agentInstructions: AgentInstructionsSchema.optional(),
  /** 输出风格（0.78.0）：`default` 或 `OUTPUT_STYLES` 之一。省略按 `default`。 */
  outputStyle: OutputStyleSchema.optional(),
  /**
   * 你应该知道（0.79.0，Host 功能 `session_insights`，domain-model §3.33）：回合结束后，Host 用会话的模型在后台看一遍会话，偶尔提出
   * 一件用户大概没注意到、但有后果的事（`insight.updated`）。每次检查都是一次额外的模型请求，所以默认关；省略按关着。
   */
  sessionInsights: z.boolean().optional(),
  /**
   * 官方插件市场的镜像（0.91.0，Host 功能 `plugin_market`）：`auto` 首次使用时测速，记住最快的一家，之后一直用它；选了某一家就用那一家。
   * 省略按 `auto`。
   */
  marketMirror: MarketMirrorPreferenceSchema.optional(),
  /**
   * 听写的转写方（0.92.0，Host 功能 `speech`）。省略按 `local`。指向的 Provider 或模型不在了时 `speech.finish` 回 `SPEECH_FAILED`
   * （`provider_missing`），不自动换成别的。
   */
  speechTranscriber: SpeechTranscriberSchema.optional(),
  /**
   * 听写后润色（0.92.0）：转写出的文字再交给会话当前的模型改同音字、术语与标点（只发文字）。每次是一次额外的模型请求，所以默认关；
   * 省略按关着。
   */
  speechPolish: z.boolean().optional(),
  /**
   * 参考我的写作风格（0.95.0，Host 功能 `writing_style`，domain-model §3.43）：打开后 Host 把写作风格档案（有的话）与用法交给会话，
   * `wevir_writing_style_*` 工具列出；Agent 经用户同意读用户自己写过的东西建档，起草以用户名义发出的文字时按档案写。关掉后工具不再
   * 列出，从下一次建会话、恢复或接力起不再交档案；档案留着，用户照样能用 `writingStyle.*` 看、改、删。省略按关着。
   */
  writingStyle: z.boolean().optional(),
  /**
   * 电脑操作（0.114.0，Host 功能 `computer_use`，domain-model §3.15.8）：打开后应用级工具里列出 `computer_*`，agent 经用户逐个应用
   * 批准后读屏并操作桌面应用。省略按关着。
   */
  computerUse: z.boolean().optional(),
  /**
   * iOS 模拟器（0.122.0，Host 功能 `ios_simulator`）：关掉后应用级工具里不再列出 `simulator_control` 与 `simulator_build`，调用回
   * `sim_disabled`。窗格的 `simulator.*` 不受影响。省略按开着。
   */
  iosSimulator: z.boolean().optional(),
  /**
   * 运行时防止系统休眠（0.102.0，Host 功能 `prevent_sleep`，domain-model §3.45）：开着时，有回合在跑就让桌面主进程挡住系统的空闲睡眠
   * （`power.get` / `power.changed`）。合上笔记本盖子时系统照样睡眠。省略按关着。
   */
  preventSleep: z.boolean().optional(),
  /**
   * 无人值守的会话里审批等多久就过期（0.105.0，Host 功能 `approval_timeout`，domain-model §5 第 10 条），分钟：自动化开的、引擎派出的
   * 子会话、另一个会话里的 Agent 开的会话里新的审批带 `expiresAt`，到时 Host 按拒绝回复引擎。交互会话不受影响。省略或 0 是不过期。
   */
  unattendedApprovalTimeoutMinutes: z
    .int()
    .min(0)
    .max(UNATTENDED_APPROVAL_TIMEOUT_MAX_MINUTES)
    .optional(),
  /**
   * 哪几类事产生通知意图（0.106.0，Host 功能 `notification_intents`，domain-model §3.48）：关掉的一类不发给任何订阅的连接。省略或缺某一项
   * 按开。
   */
  notifications: NotificationKindSettingsSchema.optional(),
  /**
   * 远程访问（0.107.0，Host 功能 `remote_devices`，domain-model §3.49）：总开关、直连的网卡、中继与推送，全部默认关；省略按全关。
   * `settings.update` 整个替换这一项。
   */
  remote: RemoteSettingsSchema.optional(),
  /**
   * 自动调优（0.108.0，Host 功能 `tuning_auto`，domain-model §3.50，ADR-0018）：开着时，项目里的顶层会话空闲或关闭后，Host 用会话的
   * 模型在后台提出配置改动并直接进入试用。每次是一次额外的模型请求。省略表示用户还没在调优页的引导里选过（桌面端显示引导），按关着；
   * 不进 `DEFAULT_HOST_SETTINGS`。只管后台生成，试用的评估与回退始终运行。
   */
  autoTuning: z.boolean().optional(),
  /** 后台生成每个自然月（Host 本地时区）的 token 上限（输入加输出）。省略按 `AUTO_TUNING_MONTHLY_TOKENS_DEFAULT`。 */
  autoTuningMonthlyTokens: z
    .int()
    .min(AUTO_TUNING_MONTHLY_TOKENS_MIN)
    .max(AUTO_TUNING_MONTHLY_TOKENS_MAX)
    .optional(),
});
export type HostSettings = z.infer<typeof HostSettingsSchema>;

export const DEFAULT_HOST_SETTINGS: HostSettings = Object.freeze({
  sendWhileBusy: 'steer',
  promptSuggestions: true,
  sessionRecap: true,
  autoMemory: true,
  ruleFiles: true,
  sessionInsights: false,
});

// ── 跨会话记忆（0.57.0） ────────────────────────────────────────────────

/**
 * 笔记的种类（domain-model §3.21，同 Claude Code 的 auto memory）：`user` 用户是谁、偏好；`feedback` 怎么做事（纠正、确认过的
 * 做法、坑）；`project` 目标、决定、约束；`reference` 东西在哪。
 */
export const MemoryTypeSchema = z.enum(['user', 'feedback', 'project', 'reference']);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

/** `global`：所有项目的会话都看得到；`project`：只有这个项目（工作区）的会话看得到。 */
export const MemoryScopeSchema = z.enum(['global', 'project']);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

/** 名字：小写字母、数字、连字符，1–64 个字符，以字母或数字开头。同一个范围里唯一。 */
export const MemoryNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/** 说明的上限（字符，一行）。 */
export const MEMORY_DESCRIPTION_MAX = 200;
/** 正文的上限（UTF-8 字节）。 */
export const MEMORY_CONTENT_MAX_BYTES = 4096;
/** 每个范围最多几条：`memory.list` 不分页，一个范围的笔记一次给全。 */
export const MEMORY_MAX_PER_SCOPE = 100;

/** 谁写的（0.58.0）：`agent` 是会话里的 Agent 用 `wevir_memory_save` 存的，`user` 是用户在设置里改的（`memory.update`）。 */
export const MemoryAuthorSchema = z.enum(['agent', 'user']);
export type MemoryAuthor = z.infer<typeof MemoryAuthorSchema>;

/**
 * 来源会话现在怎样（0.58.0，只在 `memory.read` 里有）：`available` 会话还在；`withdrawn` 会话还在，但写下笔记的那个回合已被撤回
 * （`session.rewind`）或撤销（`session.undo`，重做后又是 `available`）；`deleted` 会话已删除。
 */
export const MemorySourceStatusSchema = z.enum(['available', 'withdrawn', 'deleted']);
export type MemorySourceStatus = z.infer<typeof MemorySourceStatusSchema>;

/**
 * 一次写入的来源（0.58.0）：由 Host 按调用方填写，客户端与 Agent 都不能指定。Agent 保存时带上调工具的会话、当时进行中的回合与
 * 会话最后一个事件的 `seq`；用户在设置里改时只有 `by: 'user'` 与时刻。来源只说明笔记在哪里写下，不说明内容属实。
 */
export const MemorySourceSchema = z.object({
  by: MemoryAuthorSchema,
  /** 写入的时刻；手改过的文件里可能不是合法时刻，客户端照原样当作不明。 */
  at: z.string(),
  sessionId: SessionIdSchema.optional(),
  turnId: TurnIdSchema.optional(),
  seq: SeqSchema.optional(),
  /** 只在 `memory.read` 里有，且只对带 `sessionId` 的来源。 */
  status: MemorySourceStatusSchema.optional(),
  /** 用户从别的应用导入的（0.74.0，`import.apply`）：这时 `by` 是 `user`，没有会话。 */
  importedFrom: ImportedFromSchema.optional(),
  /** 用户采纳调优的建议写下的（0.87.0，`tuning.proposal.decide`）：这时 `by` 是 `user`，`sessionId` 是提出建议的会话。 */
  proposalId: TuningProposalIdSchema.optional(),
});
export type MemorySource = z.infer<typeof MemorySourceSchema>;

/** 一条笔记，不含正文（`memory.list`）。 */
export const MemorySummarySchema = z.object({
  scope: MemoryScopeSchema,
  name: MemoryNameSchema,
  type: MemoryTypeSchema,
  description: z.string(),
  /** 最近一次改正文、说明或种类的时刻；手写的旧文件没有时是空字符串。启用、停用不改它。 */
  updatedAt: z.string(),
  /** 停用的笔记还在，但 Agent 看不到、读不到，也不能用同名保存把它换掉；只有用户能重新启用。 */
  enabled: z.boolean(),
  /** 这一版的标识（不透明）：文件每次改动都会变。`memory.update` / `memory.delete` 带着它检查有没有被别人改过。 */
  revision: z.string().min(1),
  /**
   * 第一次写下这条笔记的来源（0.58.0）。0.58.0 之前存的笔记没有记录，省略；Host 不会补造。之后被改写也不变（删掉再存是新的一条）。
   */
  origin: MemorySourceSchema.optional(),
  /** 最近一次改正文、说明或种类的来源（0.58.0）；没有记录时省略。启用、停用不改它。 */
  lastEdit: MemorySourceSchema.optional(),
});
export type MemorySummary = z.infer<typeof MemorySummarySchema>;

export const MemoryNoteSchema = MemorySummarySchema.extend({
  content: z.string(),
});
export type MemoryNote = z.infer<typeof MemoryNoteSchema>;

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
  /** 换目录（0.81.0，`session.move`）时接着用原来的引擎会话；没有时新开一个、交摘要（同接力）。 */
  relocate: z.boolean().optional(),
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

/** 一次接力里用户标为必须携带的约束最多几条、每条最多多少个字符（0.59.0）。 */
export const HANDOFF_MAX_CONSTRAINTS = 10;
export const HANDOFF_CONSTRAINT_MAX_CHARS = 2000;
/** 一次接力里用户选入的记忆笔记最多几条（0.59.0）。 */
export const HANDOFF_MAX_NOTES = 5;

/**
 * 这次接力额外交给新来源的材料（0.59.0，Host 功能 `handoff_material`，domain-model §3.14）：用户标为必须携带的约束原样整条放进
 * 材料，不截短；用户选入的记忆笔记（启用的，`project` 是会话所在项目的）整条放进材料。两者与历史摘要共用同一个材料预算，连同开头
 * 说明放不下时 Host 拒绝（`INVALID_PARAMS`），不截短、不省掉。Host 设置的 `autoMemory` 关着时不能选笔记。
 */
export const HandoffMaterialRequestSchema = z.object({
  constraints: z
    .array(z.string().trim().min(1).max(HANDOFF_CONSTRAINT_MAX_CHARS))
    .max(HANDOFF_MAX_CONSTRAINTS)
    .optional(),
  notes: z
    .array(z.object({ scope: MemoryScopeSchema, name: MemoryNameSchema }))
    .max(HANDOFF_MAX_NOTES)
    .optional(),
});
export type HandoffMaterialRequest = z.infer<typeof HandoffMaterialRequestSchema>;

/** 交出去的一条笔记（0.59.0）：哪一条、哪一版。 */
export const HandoffNoteRefSchema = z.object({
  scope: MemoryScopeSchema,
  name: MemoryNameSchema,
  revision: z.string().min(1),
});
export type HandoffNoteRef = z.infer<typeof HandoffNoteRefSchema>;

/** 因预算省掉的一段连续的历史条目（0.59.0）：第一条与最后一条的 `itemId`（同读历史工具）与条数。 */
export const HandoffOmittedRangeSchema = z.object({
  first: z.string().min(1),
  last: z.string().min(1),
  count: z.int().min(1),
});
export type HandoffOmittedRange = z.infer<typeof HandoffOmittedRangeSchema>;

/** 材料的散列（0.59.0）：`context` 的 UTF-8 字节的 SHA-256，小写十六进制。 */
export const HandoffHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * 预览绑定的版本（0.60.0，`session.handoffPreview` 给出，`session.configure` 的 `handoff.binding` 带回）：材料算到的事件、目标
 * 来源、方式、选入的笔记各是哪一版、材料的散列（没有材料时省略）。正式切换时 Host 按当时的情况重算，任何一项不同都回
 * `HANDOFF_STALE`，不递交用户没看过的版本。
 */
export const HandoffBindingSchema = z.object({
  providerId: ProviderIdSchema,
  /** 会话在预览时的 `lastSeq`。 */
  throughSeq: z.int().min(0),
  strategy: HandoffStrategySchema,
  notes: z.array(HandoffNoteRefSchema),
  hash: HandoffHashSchema.optional(),
});
export type HandoffBinding = z.infer<typeof HandoffBindingSchema>;

/** `session.configure` 的 `handoff`：材料（0.59.0）与预览的绑定（0.60.0）。 */
export const HandoffConfigureSchema = HandoffMaterialRequestSchema.extend({
  binding: HandoffBindingSchema.optional(),
});
export type HandoffConfigure = z.infer<typeof HandoffConfigureSchema>;

/**
 * 接力预览（0.60.0，`session.handoffPreview`）：照正式切换的算法、此刻的事件与笔记算出的材料，不改任何东西。`resumed` 是按
 * 接着用这个来源以前的引擎会话算的（它恢复过一次失败时按新建算）；正式切换时恢复失败，带绑定的切换回 `HANDOFF_STALE`，
 * 再预览就是新建、整段。`overBudget` 时没有材料，要用户缩减约束或少选笔记。
 */
// ── 规则文件（0.68.0） ────────────────────────────────────────────────

/**
 * 规则文件的种类（0.68.0，domain-model §3.27），开放字符串：`agents`（AGENTS.md）、`claude`（CLAUDE.md、.claude/CLAUDE.md、
 * CLAUDE.local.md）、`gemini`（GEMINI.md）、`cursor`（.cursor/rules 里总是应用的规则与 .cursorrules）。`@` 引入的文件跟着引入它的
 * 那个文件的种类。
 */
export const RuleFileKindSchema = z.string().min(1);
export type RuleFileKind = z.infer<typeof RuleFileKindSchema>;

/** 用户级（家目录里各工具的那份）还是项目里的（从仓库根到会话目录一路上的）。 */
export const RuleFileScopeSchema = z.enum(['user', 'project']);
export type RuleFileScope = z.infer<typeof RuleFileScopeSchema>;

/**
 * 这个文件怎么到的模型：`engine` 会话的引擎自己读（Host 按引擎的规则推断）；`wevir` 引擎不读，Host 补给它；`skipped` 没给，原因见
 * `skipReason`。
 */
export const RuleFileDeliverySchema = z.enum(['engine', 'wevir', 'skipped']);
export type RuleFileDelivery = z.infer<typeof RuleFileDeliverySchema>;

/** 一个规则文件（0.68.0）。 */
export const RuleFileSchema = z.object({
  /** 绝对路径。 */
  path: z.string().min(1),
  scope: RuleFileScopeSchema,
  kind: RuleFileKindSchema,
  delivery: RuleFileDeliverySchema,
  /** 文件的 UTF-8 字节数（Cursor 规则不含 frontmatter）。 */
  bytes: z.int().min(0),
  /** `wevir` 补给的、因预算只给了开头一段。 */
  truncated: z.boolean().optional(),
  /**
   * `skipped` 的原因，开放字符串：`duplicate`（与引擎自己读的内容相同）、`over_budget`（预算用完）、`disabled`（Host 设置
   * `ruleFiles` 关着）、`empty`、`unreadable`。
   */
  skipReason: z.string().min(1).optional(),
  /** 由另一个规则文件 `@` 引入的：那个文件的路径。 */
  importedFrom: z.string().min(1).optional(),
});
export type RuleFile = z.infer<typeof RuleFileSchema>;

/** Host 补给的规则交给引擎的方式：`instructions` 进引擎的系统或开发者说明，`message` 放在下一条消息的开头。 */
export const RuleDeliveryChannelSchema = z.enum(['instructions', 'message']);
export type RuleDeliveryChannel = z.infer<typeof RuleDeliveryChannelSchema>;

/**
 * Host 交给这个会话的用户说明（0.78.0，domain-model §3.34）：有没有“给 Agent 的说明”（去掉首尾空白后不空），以及生效的输出风格
 * （`default` 时省略）。正文与补给的规则文件放在一起，走同一个 `channel`。引擎没有自带写代码做法时，Host 还在最前面放 Wevir 的
 * 编码纪律（prompts/coding-discipline.md），它不单列一项：只有它时 `instructions` 为 false、没有别的项，`bytes` 是它的字节数。
 */
export const SessionCustomInstructionsSchema = z.object({
  instructions: z.boolean(),
  outputStyle: OutputStyleSchema.optional(),
  /**
   * 写作风格（0.95.0，domain-model §3.43），开放字符串：`profile` 交了档案，`setup` 设置开着但还没有档案（只交了建档的用法）。设置
   * 关着时省略。
   */
  writingStyle: z.string().min(1).optional(),
  /** 这一段正文（编码纪律、说明、风格与写作风格）的 UTF-8 字节数。 */
  bytes: z.int().min(1),
});
export type SessionCustomInstructions = z.infer<typeof SessionCustomInstructionsSchema>;

/** 一个会话（对它当前的来源）加载了哪些规则文件（0.68.0）。 */
export const SessionRulesSchema = z.object({
  providerId: ProviderIdSchema,
  /** 用户级在前，项目里的从仓库根到会话目录；引入的文件紧跟在引入它的后面。 */
  files: z.array(RuleFileSchema),
  /** 有 `wevir` 的文件或 `custom` 时才有。 */
  channel: RuleDeliveryChannelSchema.optional(),
  /** 补给的正文（规则文件加上 `custom`）的 UTF-8 字节数；规则文件的预算。没有补给时省略。 */
  bytes: z.int().min(1).optional(),
  budgetBytes: z.int().min(1).optional(),
  /** 用户的说明、输出风格、写作风格与 Wevir 的编码纪律（0.78.0）；一样都没交时省略。 */
  custom: SessionCustomInstructionsSchema.optional(),
  /** 写这份规则时会话所在范围的档案版本（0.85.0，Host 功能 `tuning`）；Host 没记档案时省略。 */
  profileVersion: ProfileVersionRefSchema.optional(),
});
export type SessionRules = z.infer<typeof SessionRulesSchema>;

export const HandoffPreviewSchema = z.object({
  providerId: ProviderIdSchema,
  strategy: HandoffStrategySchema,
  resumed: z.boolean(),
  /** 新来源能不能用读历史的工具拿全文。 */
  historyTool: z.boolean(),
  /** 历史条目覆盖的事件；没有历史条目时省略。 */
  covered: z.object({ fromSeq: SeqSchema, toSeq: SeqSchema }).optional(),
  budgetBytes: z.int().min(1),
  /** 选进材料的历史条目数、因预算省掉的条目数与是哪几段（超出预算时都是 0、空）。 */
  items: z.int().min(0),
  omittedItems: z.int().min(0),
  omitted: z.array(HandoffOmittedRangeSchema),
  /** 材料正文、UTF-8 字节数与散列；没有要交的或超出预算时省略。 */
  context: z.string().min(1).optional(),
  bytes: z.int().min(1).optional(),
  hash: HandoffHashSchema.optional(),
  /** 必须项、笔记与开头说明就已超出预算：一条历史都不放时的字节数。 */
  overBudget: z.object({ bytes: z.int().min(1) }).optional(),
  constraints: z.int().min(0),
  notes: z.array(HandoffNoteRefSchema),
  /**
   * 新来源会加载的规则文件（0.68.0，Host 功能 `rule_files`）：它自己读的，与 Host 补给它的。规则不占接力材料的预算；接着用以前的
   * 引擎会话、规则已随消息交过时，`message` 方式的不再补。
   */
  rules: SessionRulesSchema.optional(),
});
export type HandoffPreview = z.infer<typeof HandoffPreviewSchema>;

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

/** 环境变量名（0.130.0）：字母或下划线开头，只有字母、数字、下划线。 */
export const EnvironmentVariableNameSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/** 一个环境变量最多有多少个、值最长多少字（0.130.0）。 */
export const ENVIRONMENT_VARIABLES_MAX = 100;
export const ENVIRONMENT_VARIABLE_VALUE_MAX = 32_768;

/**
 * 环境里的一个变量（0.130.0，domain-model §3.10）：值只在 Host 的密钥存储里，线缆上只有打码后的 `preview`（长的留开头与结尾，
 * 短的整段换成圆点）。
 */
export const EnvironmentVariableSchema = z.object({
  name: EnvironmentVariableNameSchema,
  preview: z.string().max(64),
});
export type EnvironmentVariable = z.infer<typeof EnvironmentVariableSchema>;

/** 保存的一组会话设置：在哪儿跑、用哪几个文件夹（第一个是主文件夹）、每个文件夹要不要新开 worktree、给会话的环境变量。 */
export const EnvironmentSchema = z.object({
  id: EnvironmentIdSchema,
  name: z.string().min(1).max(60),
  /** 现在只有本机；SSH 与云端以后加。 */
  location: z.object({ kind: z.literal('local') }),
  folders: z.array(EnvironmentFolderSchema).min(1).max(8),
  /** 交给这个环境的会话的环境变量（0.130.0），按填写的顺序；省略表示没有。 */
  variables: z.array(EnvironmentVariableSchema).max(ENVIRONMENT_VARIABLES_MAX).optional(),
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

/**
 * 会话换了目录（0.81.0，`session.move`，domain-model §3.36）：`worktree` 从项目目录（本地 checkout）移进 Host 新开的 worktree，`local`
 * 从 Host 开的 worktree 移回项目目录。没提交的改动与未跟踪文件跟着走，原处回到 HEAD。
 */
export const SessionMoveTargetSchema = z.enum(['worktree', 'local']);
export type SessionMoveTarget = z.infer<typeof SessionMoveTargetSchema>;

/** 一次移动（`session.moved` 事件与 `session.move` 的结果，0.81.0）。 */
export const SessionMoveSchema = z.object({
  to: SessionMoveTargetSchema,
  /** 原来的目录。 */
  from: z.string().min(1),
  /** 现在的目录（`Session.cwd`）。 */
  cwd: z.string().min(1),
  /** 现在检出的分支：移进 worktree 时是新开的分支，移回本地时是本地 checkout 换到的分支；分离 HEAD 时省略。 */
  branch: z.string().min(1).optional(),
  /** 移回本地之前本地 checkout 所在的分支。 */
  previousBranch: z.string().min(1).optional(),
  /** 移动前原处的样子（HEAD 加没提交的改动），挂在原仓库的这个 ref 上，留着找回用。 */
  ref: z.string().min(1).optional(),
  /** `resumed`：接着用原来的引擎会话（引擎能换目录）；`handoff`：新开引擎会话，紧接着的 `session.handoff` 交摘要。 */
  engine: z.enum(['resumed', 'handoff']),
  /** 移进 worktree 后原处没能清回 HEAD（改动两边都有）。 */
  sourceKept: z.literal(true).optional(),
});
export type SessionMove = z.infer<typeof SessionMoveSchema>;

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

// ── 工具预设（0.61.0，Host 功能 `tool_presets`） ─────────────────────────

/**
 * Wevir 应用级工具（Host 的 `wevir` MCP 服务）的组。只是这些工具：引擎自带的工具、读历史与联网、用户接入的 MCP 连接器都不在
 * 任何组里，不受预设管。
 */
export const TOOL_GROUPS = [
  'sessions',
  'catalog',
  'tasks',
  'memory',
  'workbench',
  'browser',
  'lsp',
  'processes',
  'plugins',
] as const;
export const ToolGroupSchema = z.enum(TOOL_GROUPS);
export type ToolGroup = z.infer<typeof ToolGroupSchema>;

/** `full` 是全部应用级工具（没选预设的会话就是它）；`core` 只带核心的几组，别的组另加。 */
export const ToolPresetIdSchema = z.enum(['full', 'core']);
export type ToolPresetId = z.infer<typeof ToolPresetIdSchema>;

/**
 * 会话的工具预设，建会话时选定，之后不变。`groups` 只对 `core` 有意义：在它之上另加的组（Host 去重、按 `TOOL_GROUPS` 排序，`core`
 * 本来就有的组与 `full` 的 `groups` 都丢掉）。预设只能在角色允许的工具里再收窄，不是权限；调用仍逐次检查。
 */
export const ToolPresetSchema = z.object({
  id: ToolPresetIdSchema,
  groups: z.array(ToolGroupSchema).max(32).optional(),
});
export type ToolPreset = z.infer<typeof ToolPresetSchema>;

/** `tools.presets` 里的一个预设：它总带的组。 */
export const ToolPresetInfoSchema = z.object({
  id: ToolPresetIdSchema,
  groups: z.array(ToolGroupSchema),
});
export type ToolPresetInfo = z.infer<typeof ToolPresetInfoSchema>;

/** `tools.presets` 里的一个组：这个 Host 上实际有的工具名（没有浏览器、LSP 等时是空的）。 */
export const ToolGroupInfoSchema = z.object({
  id: ToolGroupSchema,
  tools: z.array(z.string().min(1)),
});
export type ToolGroupInfo = z.infer<typeof ToolGroupInfoSchema>;

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
 * 另一个会话。0.136.0 起还有设置页（`settings`，`page` 是开放字符串：桌面端的设置分页名与 `plugins`，客户端没有这一页时不打开）；
 * 0.140.0 起还有会话侧栏的卡片（`card`，`card` 是开放字符串：桌面端会话侧栏里要在设置中打开的卡片名，客户端没有这张卡片时不显示）。
 * 旧客户端解析不了这条事件，按 host-api.md §4 跳过。
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
  z.object({ kind: z.literal('settings'), page: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/) }),
  z.object({ kind: z.literal('card'), card: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) }),
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

/** 章节标题与说明的上限（0.82.0，`chapter.marked`，按码点）。 */
export const CHAPTER_TITLE_MAX_LENGTH = 80;
export const CHAPTER_SUMMARY_MAX_LENGTH = 200;

/** 会话由哪次自动化运行开出来（0.66.0，`Session.automation`）。 */
export const SessionAutomationSchema = z.object({
  automationId: AutomationIdSchema,
  runId: AutomationRunIdSchema,
});
export type SessionAutomation = z.infer<typeof SessionAutomationSchema>;

/**
 * 频道里的会话（0.120.0，ADR-0020）：`coordinator` 是频道常驻的协调者（各班），`thread` 是频道开出的线程。两者都不出现在
 * `session.list` 与 `sessions.changed` 里，只有开在用户项目里的线程（0.134.0）例外：它是那个项目的会话，照常列出。
 */
export const SessionChannelSchema = z.object({
  channelId: ChannelIdSchema,
  role: z.enum(['coordinator', 'thread']),
});
export type SessionChannel = z.infer<typeof SessionChannelSchema>;

/** 会话是怎么来的（0.16.0）：现在只有“从一项建议开出来”。 */
export const SessionOriginSchema = z.object({
  kind: z.literal('suggested_task'),
  /** 提出建议的会话。 */
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema,
});
export type SessionOrigin = z.infer<typeof SessionOriginSchema>;

// ── 第二意见（0.75.0，domain-model §3.30） ────────────────────────────

/**
 * 第二意见的状态：`running` 意见会话的第一个回合还没结束；`ready` 正常结束、有意见；`failed` 回合没正常结束（看 `outcome`）或结束了却
 * 没有回答。
 */
export const SecondOpinionStatusSchema = z.enum(['running', 'ready', 'failed']);
export type SecondOpinionStatus = z.infer<typeof SecondOpinionStatusSchema>;

/**
 * 另一个来源对一个会话当前改动的意见（0.75.0，domain-model §3.30）：Host 把会话目录现在的样子（HEAD 加上没提交的改动与未跟踪文件）
 * 放进一个新的 worktree，在那里开一个只读审阅的会话（`sessionId`，`Session.opinionOf` 指回来），把任务、目标、验收与改动的范围交给它。
 * 记在原会话的事件流里（`opinion.updated`），不进原会话的引擎上下文，直到被引用（`quoted`）。
 */
export const SecondOpinionSchema = z.object({
  id: OpinionIdSchema,
  /** 给意见的会话。 */
  sessionId: SessionIdSchema,
  providerId: ProviderIdSchema,
  modelId: z.string().min(1),
  /** `user`：用户发起；`agent`：原会话的 agent 用 `wevir_second_opinion` 发起，意见好了 Host 自动引用给它。开放字符串。 */
  requestedBy: z.string().min(1),
  /** 发起时给的侧重点。 */
  focus: z.string().min(1).max(SECOND_OPINION_FOCUS_MAX_LENGTH).optional(),
  /** 意见针对的代码状态：发起时原会话最后一个回合、目录的 HEAD 与分支、改动的基线（与默认分支的分叉点；找不到时省略）。 */
  basis: z.object({
    turnId: TurnIdSchema.optional(),
    head: GitObjectIdSchema,
    branch: z.string().min(1).optional(),
    base: GitObjectIdSchema.optional(),
  }),
  status: SecondOpinionStatusSchema,
  /** 意见会话第一个回合的结局（`running` 时没有）。 */
  outcome: TurnOutcomeSchema.optional(),
  /** 意见（那个回合最后一段回答，最多 `SECOND_OPINION_TEXT_MAX_LENGTH` 字）；没有回答时省略。 */
  text: z.string().min(1).max(SECOND_OPINION_TEXT_MAX_LENGTH).optional(),
  /** 被引用进原会话的时刻与那条消息开始的回合或成为的待发消息；只引用一次。 */
  quoted: z
    .object({
      at: IsoTimeSchema,
      turnId: TurnIdSchema.optional(),
      pendingId: PendingMessageIdSchema.optional(),
    })
    .optional(),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type SecondOpinion = z.infer<typeof SecondOpinionSchema>;

/** 给意见的会话（0.75.0）：它为哪个会话的哪条意见而开。 */
export const SessionOpinionOfSchema = z.object({
  sessionId: SessionIdSchema,
  opinionId: OpinionIdSchema,
});
export type SessionOpinionOf = z.infer<typeof SessionOpinionOfSchema>;

/** 你应该知道（0.79.0）的长度上限（按 UTF-16 code unit）：一句话的提示、展开后的标题与说明。Host 整理后不会超过它们。 */
export const SESSION_INSIGHT_SUMMARY_MAX_LENGTH = 300;
export const SESSION_INSIGHT_TITLE_MAX_LENGTH = 120;
export const SESSION_INSIGHT_DETAIL_MAX_LENGTH = 3000;

/** 提示的口吻：`heads_up` 这次会话里做了的事（一个决定、一个没说清的结果），现在不看有代价；`should_know` 要懂的一个概念或设计。 */
export const SessionInsightTagSchema = z.enum(['heads_up', 'should_know']);
export type SessionInsightTag = z.infer<typeof SessionInsightTagSchema>;

/** `open` 等用户处理；`known` 用户标为已知（之后的检查不再提这个话题）；`dismissed` 用户忽略。后两者不再变化。 */
export const SessionInsightStatusSchema = z.enum(['open', 'known', 'dismissed']);
export type SessionInsightStatus = z.infer<typeof SessionInsightStatusSchema>;

/**
 * 你应该知道（0.79.0，domain-model §3.33）：Host 在回合结束后用会话的模型（不带工具）看一遍会话，挑出一件用户大概没意识到、不知道会有
 * 后果的事。记在会话的事件流里（`insight.updated`），不进引擎上下文。`summary` 是收起时的一句话；展开后是 `title` 与 `detail`
 * （Markdown）。都用会话的语言。
 */
export const SessionInsightSchema = z.object({
  id: InsightIdSchema,
  /** 检查时最后一个结束的回合。 */
  turnId: TurnIdSchema,
  tag: SessionInsightTagSchema,
  summary: z.string().min(1).max(SESSION_INSIGHT_SUMMARY_MAX_LENGTH),
  title: z.string().min(1).max(SESSION_INSIGHT_TITLE_MAX_LENGTH),
  detail: z.string().min(1).max(SESSION_INSIGHT_DETAIL_MAX_LENGTH),
  status: SessionInsightStatusSchema,
  /** 检查看到了会话的哪个事件为止。 */
  throughSeq: SeqCursorSchema,
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type SessionInsight = z.infer<typeof SessionInsightSchema>;

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
  /** 给另一个会话第二意见的会话（0.75.0，Host 功能 `second_opinion`）。 */
  opinionOf: SessionOpinionOfSchema.optional(),
  /**
   * 由自动化开出来的会话（0.66.0，Host 功能 `automations`）：建它的那次运行。`newSessionEachRun` 为 `false` 的自动化之后
   * 的运行也发进这个会话，这里仍是第一次。
   */
  automation: SessionAutomationSchema.optional(),
  /** 工具预设（0.61.0，Host 功能 `tool_presets`）；省略表示没选，等同 `full`。子会话不带，沿用父会话的。 */
  toolPreset: ToolPresetSchema.optional(),
  /** 频道里的会话（0.120.0，Host 功能 `channels`）。 */
  channel: SessionChannelSchema.optional(),
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
  /** 额度恢复后自动继续（0.119.0，最近一次 `session.auto_continue`）；没开、已关、已发出或有了新的回合时省略。 */
  autoContinue: SessionAutoContinueSchema.optional(),
  /** 最近一次回合收尾（0.128.0，`turn.wrap_up`）；新的回合开始、用户发了消息、那个回合被撤销或撤回时省略。 */
  wrapUp: SessionWrapUpSchema.optional(),
  /** 这个会话当前的来源加载的规则文件（0.68.0，最近一次 `session.rules`）；Host 没记过时省略。 */
  rules: SessionRulesSchema.optional(),
  /**
   * 未决的审批数（0.101.0，Host 功能 `session_list_push`）：只出现在 `session.list` 的行与 `sessions.changed` 里，0 时省略。
   */
  pendingApprovalCount: z.number().int().positive().optional(),
  /** 等回答的问题数（0.101.0），同 `pendingApprovalCount`。 */
  pendingQuestionCount: z.number().int().positive().optional(),
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
  /** 回合后验证（0.65.0）：验收状态、最近的验证记录与修复链；会话里从没有过验证时省略。 */
  verification: SessionVerificationSchema.optional(),
  /** 这个会话收到的第二意见（0.75.0，`opinion.updated` 按 `id` 替换），按发起的先后；没有时省略。 */
  opinions: z.array(SecondOpinionSchema).optional(),
  /** 你应该知道（0.79.0，`insight.updated` 按 `id` 替换），按提出的先后，含已处理的；没有时省略。 */
  insights: z.array(SessionInsightSchema).optional(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
