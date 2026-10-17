import { z } from 'zod';

// 能力位、功能与权限（host-api.md「兼容规则」）。三者都是开放集合：认不出的键或值照常接受，
// 新老两端互相解析时不会因为对方多了一项而失败。

/**
 * 客户端能力位：客户端在 `host.hello` 里声明自己能理解的新线缆形状，Host 据此决定发新形状还是降级。
 * 新增时按下面的格式写，并在 host-api.md 的能力表里登记：
 *
 * ```ts
 * // COMPAT(fooEnum): added in 0.2.0, remove gate after 2027-06-01
 * fooEnum: 'foo_enum',
 * ```
 */
export const CLIENT_CAPABILITIES = {
  // COMPAT(titleSourceGenerated): added in 0.5.0, remove gate after 2027-06-01
  /** 认得 `TitleSource` 的 `generated`；没有时 Host 把它降级成 `first_prompt`。 */
  titleSourceGenerated: 'title_source_generated',
  // COMPAT(providerKindChatgpt): added in 0.7.0, remove gate after 2027-06-01
  /** 认得 `ProviderKind` 的 `chatgpt`；没有时 Host 从 `provider.list` 的结果里去掉这类 Provider。 */
  providerKindChatgpt: 'provider_kind_chatgpt',
  // COMPAT(providerKindGoogleVertex): added in 0.21.0, remove gate after 2027-06-01
  providerKindGoogleVertex: 'provider_kind_google_vertex',
  // COMPAT(subscriptionKinds): added in 0.19.0, remove gate after 2027-06-01
  /**
   * 认得订阅来源的种类（`SUBSCRIPTION_KINDS`，`ProviderKind` 与 `AccountKind` 都有）；没有时 Host 从 `provider.list` 与
   * `account.list` 的结果里去掉它们，也不发它们的 `account.updated`。
   */
  subscriptionKinds: 'subscription_kinds',
  // COMPAT(userImages): added in 0.28.0, remove gate after 2027-06-01
  /** 认得 `UserContentPart` 的 `image`；没有时 Host 把事件与结果里的图片换成文本 `[image]`。 */
  userImages: 'user_images',
} as const;
export type ClientCapability = (typeof CLIENT_CAPABILITIES)[keyof typeof CLIENT_CAPABILITIES];

/** 已知能力位写成 `z.boolean().optional()`；未知键原样保留。 */
export const ClientCapabilitiesSchema = z.looseObject({
  title_source_generated: z.boolean().optional(),
  provider_kind_chatgpt: z.boolean().optional(),
  provider_kind_google_vertex: z.boolean().optional(),
  subscription_kinds: z.boolean().optional(),
  user_images: z.boolean().optional(),
});
export type ClientCapabilities = z.infer<typeof ClientCapabilitiesSchema>;

/**
 * Host 功能：Host 在 `host.hello` 结果里声明，客户端在一处判断是启用功能还是提示升级 Host。
 * 新增方式同 `CLIENT_CAPABILITIES`，并在 host-api.md 的功能表里登记。功能可能取决于 Host 用的引擎，所以只列名字，值由 Host
 * 每次握手时给出。
 */
export const HOST_FEATURES = {
  /** Host 全局连接器与 skills 注册表（0.41.0）。 */
  plugins: 'plugins',
  /** Wevir 插件包：`plugin.*` 方法与 `plugins.list` 的 `plugins`（0.42.0）。 */
  pluginPackages: 'plugin_packages',
  /** Ollama model discovery through Host (0.31.0). */
  providerModelDiscovery: 'provider_model_discovery',
  /**
   * ChatGPT 账号（0.7.0，R6）：`account.*` 方法、`account.updated` 通知与 `chatgpt` 类 Provider 可用。只有 Codex 引擎有，
   * dsh 与 echo 引擎的 Host 不声明它。
   */
  chatgptAccount: 'chatgpt_account',
  /** 服务账号认证的 Vertex Provider（0.21.0），只有模型网关支持。 */
  googleVertex: 'google_vertex',
  /** 回合进行中发消息（0.8.0）：`session.send` 的 `delivery`、`pending.*` 方法与事件、`user.steered`。 */
  pendingMessages: 'pending_messages',
  /** Host 设置（0.8.0）：`settings.get` / `settings.update` 与 `settings.updated` 通知。 */
  hostSettings: 'host_settings',
  /** 换会话的模型与推理档位（0.9.0）：`session.configure` 与 `session.configured` 事件。取决于引擎（Codex 有）。 */
  sessionConfigure: 'session_configure',
  /** 引擎向用户提问（0.10.0）：`question.*` 事件与 `question.respond`。取决于引擎（Codex 有）。 */
  userQuestions: 'user_questions',
  /**
   * 权限模式（0.11.0）：`session.create` 与 `session.configure` 的 `permissionMode`，会话与 `session.created` /
   * `session.configured` 带它。取决于引擎（Codex 有，dsh 没有）。
   */
  permissionModes: 'permission_modes',
  /** 工作区的 git 状态（0.13.0，U18）：`workspace.git`。与引擎无关。 */
  workspaceGit: 'workspace_git',
  /** 子会话本身可以 `session.cancel`（0.14.0，U21），父会话不受影响。与引擎无关。 */
  subagentCancel: 'subagent_cancel',
  /** 保存的环境（0.15.0，U22.1）：`environment.*` 与 `session.create` 的 `environmentId`。与引擎无关。 */
  environments: 'environments',
  /** 建议的后续任务（0.16.0，U23）：`tasks.suggested` / `task.*` 事件与 `session.create` 的 `origin`。取决于引擎。 */
  suggestedTasks: 'suggested_tasks',
  /** 支线会话（0.17.0，U23.1）：`session.fork` 与 `Session` 的 `forkedFrom`、`side`。取决于引擎。 */
  sideSessions: 'side_sessions',
  /** 单独新开 worktree 的会话（0.18.0）：`session.create` 的 `worktree`。与引擎无关。 */
  sessionWorktree: 'session_worktree',
  /**
   * 订阅来源（0.19.0，ADR-0005 补记 14）：`account.list`、`account.get` 的 `refresh`、`account.setPath`、`account.install`
   * 与 `AccountState` 的安装字段。Host 有带账号的引擎时声明；有哪些种类看 `account.list`。
   */
  subscriptionSources: 'subscription_sources',
  /** 启用与停用 Provider（0.19.0）：`provider.setEnabled` 与 `ProviderProfile.enabled`。与引擎无关。 */
  providerEnabled: 'provider_enabled',
  /**
   * 改动的 diff 与回合快照（0.20.0）：`workspace.diff`、`workspace.diffFile`、`session.checkpoints`，Host 在每个回合前后给
   * 会话目录打快照。与引擎无关。
   */
  workspaceDiff: 'workspace_diff',
  /**
   * 工作区的文件（0.22.0）：`workspace.files`（按名字找）、`workspace.listDir`（列目录）、`workspace.readFile`（读文本与
   * 图片）。与引擎无关。
   */
  workspaceFiles: 'workspace_files',
  /** 项目改名（0.49.0）：`workspace.update`（只改显示名）。与引擎无关。 */
  workspaceUpdate: 'workspace_update',
  /** 用户给会话改名（0.23.0）：`session.rename`，标题来源 `user`。与引擎无关。 */
  sessionRename: 'session_rename',
  /** 会话归档（0.23.0）：`session.archive`、`session.list` 的 `archived`、`Session.archivedAt`。与引擎无关。 */
  sessionArchive: 'session_archive',
  /**
   * 删除已归档的会话与按会话的占用（0.43.0，domain-model §3.20）：`session.delete`、`session.usage`、`RESOURCE_IN_USE` 的 `worktrees`。
   * 与引擎无关；引擎的数据只在适配器有 `deleteSession` 时删。
   */
  sessionDelete: 'session_delete',
  /**
   * 立即压缩会话的上下文（0.24.0）：`session.compact`，`turn.started` 的 `command`，`context.compacting` / `context.compacted`
   * 事件（引擎自己压缩时也有）。取决于引擎（Codex、Claude 有）：0.27.0 起 `engineFeatures` 的 `commands` 说哪种 Provider 的引擎
   * 会；会话所在的引擎不能压缩时 `INVALID_STATE`。
   */
  sessionCompact: 'session_compact',
  /**
   * 代码审查（0.24.0）：`session.review`。取决于引擎（Codex 有）：0.27.0 起看 `engineFeatures` 的 `commands`；会话所在的引擎不能
   * 审查时 `INVALID_STATE`。
   */
  sessionReview: 'session_review',
  /**
   * 会话目标（0.35.0）：`session.setGoal`、`session.updateGoal`、`session.clearGoal`，`session.goal_changed` 事件，`Session.goal`，
   * `turn.started` 的 `trigger`。取决于引擎（Codex 有，看 `engineFeatures` 的 `goals`）；会话所在的引擎没有目标时 `INVALID_STATE`。
   */
  sessionGoals: 'session_goals',
  /**
   * 接力（0.25.0，domain-model §3.14）：`session.configure` 的 `providerId`、`session.handoff` 事件、`Session.engines` 与
   * `host.hello` 的 `engineFeatures`。已有会话能换到别的来源的模型。与引擎无关。
   */
  sessionHandoff: 'session_handoff',
  /**
   * 消息里的图片（0.28.0）：`image.upload`、`image.read` 与 `UserContentPart` 的 `image`。取决于引擎（Codex、Claude 等有，
   * dsh 没有）；会话所在的引擎或模型不收图片时 `session.send` 回 `INVALID_PARAMS`。
   */
  userImages: 'user_images',
  /**
   * 应用级工具（0.30.0，domain-model §3.15）：Host 给每个会话的引擎挂上 `wevir` MCP 服务，agent 能列出、读、新开会话，给别的
   * 会话发消息、等它、停它，并请求界面显示文件、改动或会话（`ui.show` 事件）。会话之间的消息带 `user.message.from`，agent 开出
   * 的会话带 `Session.openedBy`。取决于引擎：挂得上的引擎才有（`engineFeatures` 的 `appTools`）。
   */
  appTools: 'app_tools',
  /**
   * 文件预览与编辑（0.32.0）：`workspace.fileUrl`（Host 的 RPC 端口上的只读流式地址，PDF、网页、音视频与 Office 文件用）、
   * `workspace.writeFile`（按修改时间检查冲突的写回）与 `workspace.readFile` 结果的 `mtimeMs`。与引擎无关。
   */
  filePreview: 'file_preview',
  /**
   * 内置浏览器（0.33.0，domain-model §3.15）：连接可以用 `browser.register` 登记为浏览器提供方、收 `browser.request` 通知、用
   * `browser.respond` 回答；应用级工具里有 `browser_*` 工具，`wevir_show` 能显示网页。只在有应用级工具时声明。
   */
  browserTools: 'browser_tools',
  /**
   * Agent 的联网工具（0.34.0，docs/architecture/web-tools.md）：`web.get` / `web.update` / `web.test`，经网关的 Codex 会话有
   * `web_search` 与 `web_fetch`。Host 带着联网服务启动时声明（`wevir-host` 总是带）。
   */
  webTools: 'web_tools',
  /**
   * 计划模式（0.36.0，domain-model §3.17）：`session.send` 的 `collaborationMode`、`user.message` 与待发消息的
   * `collaborationMode`、`Session.collaborationMode` 与 `plan.proposed` 事件。取决于引擎（Codex、Claude 有）：`engineFeatures` 的
   * `planMode` 说哪种 Provider 的引擎有；会话所在的引擎没有时 `session.send` 回 `INVALID_PARAMS`。
   */
  planMode: 'plan_mode',
  /**
   * 分支到新会话（0.38.0，domain-model §3.18）：`session.fork` 不带 `side`、可带 `turnId`。取决于引擎（看 `engineFeatures` 的
   * `branch`）；会话所在的引擎不能分支时 `INVALID_STATE`。
   */
  sessionBranches: 'session_branches',
  /**
   * 撤回最后一个回合（0.38.0，domain-model §3.18）：`session.rewind` 与 `turn.rewound` 事件，客户端用它编辑重发最后一条用户消息。
   * 取决于引擎（看 `engineFeatures` 的 `rewind`）；会话所在的引擎不能撤回时 `INVALID_STATE`。
   */
  sessionRewind: 'session_rewind',
  /**
   * 不在项目里的会话（0.39.0，domain-model §3.1）：`session.create` 可以不带 `workspaceId`，会话建在 Host 的“对话”工作区
   * （`Workspace.kind` 是 `chats`），每个会话一个新建的文件夹。
   */
  chatSessions: 'chat_sessions',
  /**
   * Agent 交文件给用户（0.40.0，domain-model §3.15.2）：应用级工具里有 `wevir_share_file`，会话的流里有 `file.shared` 事件。有应用级
   * 工具时声明（同 `app_tools`）。
   */
  sharedFiles: 'shared_files',
} as const;
export type HostFeature = (typeof HOST_FEATURES)[keyof typeof HOST_FEATURES];

export const HostFeaturesSchema = z.looseObject({
  plugins: z.boolean().optional(),
  plugin_packages: z.boolean().optional(),
  provider_model_discovery: z.boolean().optional(),
  chatgpt_account: z.boolean().optional(),
  google_vertex: z.boolean().optional(),
  pending_messages: z.boolean().optional(),
  host_settings: z.boolean().optional(),
  session_configure: z.boolean().optional(),
  user_questions: z.boolean().optional(),
  permission_modes: z.boolean().optional(),
  workspace_git: z.boolean().optional(),
  subagent_cancel: z.boolean().optional(),
  environments: z.boolean().optional(),
  suggested_tasks: z.boolean().optional(),
  side_sessions: z.boolean().optional(),
  session_worktree: z.boolean().optional(),
  subscription_sources: z.boolean().optional(),
  provider_enabled: z.boolean().optional(),
  workspace_diff: z.boolean().optional(),
  workspace_files: z.boolean().optional(),
  workspace_update: z.boolean().optional(),
  session_rename: z.boolean().optional(),
  session_archive: z.boolean().optional(),
  session_delete: z.boolean().optional(),
  session_compact: z.boolean().optional(),
  session_review: z.boolean().optional(),
  session_goals: z.boolean().optional(),
  session_handoff: z.boolean().optional(),
  user_images: z.boolean().optional(),
  app_tools: z.boolean().optional(),
  file_preview: z.boolean().optional(),
  browser_tools: z.boolean().optional(),
  web_tools: z.boolean().optional(),
  plan_mode: z.boolean().optional(),
  session_branches: z.boolean().optional(),
  session_rewind: z.boolean().optional(),
  chat_sessions: z.boolean().optional(),
  shared_files: z.boolean().optional(),
});
export type HostFeatures = z.infer<typeof HostFeaturesSchema>;

/**
 * 权限词表。每个方法需要其中一项（`MethodSchemas[*].permission`）；骨架阶段 Host 对每个连接都给全部，
 * 词表为将来的设备权限预留（ADR-0002 未决事项 3）。
 */
export const PERMISSIONS = [
  'host.manage',
  'workspace.read',
  'workspace.write',
  'provider.read',
  'provider.write',
  'session.read',
  'session.write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** 线缆上是开放的字符串数组，旧客户端遇到新权限名不会解析失败。 */
export const PermissionsSchema = z.array(z.string().min(1));
