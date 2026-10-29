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
  // COMPAT(subscriptionAccounts): added in 0.63.0, remove gate after 2027-06-01
  /**
   * 认得同一来源的多个账号（`AccountState.id`）；没有时 Host 从 `account.list` 里去掉添加的账号，也不发它们的
   * `account.updated`（客户端按种类找账号，会把它们当成首个账号）。
   */
  subscriptionAccounts: 'subscription_accounts',
  // COMPAT(userImages): added in 0.28.0, remove gate after 2027-06-01
  /** 认得 `UserContentPart` 的 `image`；没有时 Host 把事件与结果里的图片换成文本 `[image]`。 */
  userImages: 'user_images',
  // COMPAT(questionTimeout): added in 0.72.0, remove gate after 2027-06-01
  /** 认得 `QuestionResolutionReason` 的 `timeout`；没有时 Host 把它降级成 `user`（回答照旧，没有 `answeredBy`）。 */
  questionTimeout: 'question_timeout',
  // COMPAT(approvalRules): added in 0.80.0, remove gate after 2027-06-01
  /** 认得 `ApprovalResolutionReason` 的 `rule`；没有时 Host 把它降级成 `user`（没有 `decidedBy`）。 */
  approvalRules: 'approval_rules',
  // COMPAT(approvalTimeout): added in 0.105.0, remove gate after 2027-06-01
  /**
   * 认得 `ApprovalResolutionReason` 的 `timeout` 与错误码 `APPROVAL_EXPIRED`；没有时 Host 把 `timeout` 降级成 `host_restarted`（状态照旧
   * 是 `expired`），回复过期审批时回 `ALREADY_DECIDED`。
   */
  approvalTimeout: 'approval_timeout',
  // COMPAT(hookDecisions): added in 0.137.0, remove gate after 2027-06-01
  /** 认得 `ApprovalResolutionReason` 的 `hook`；没有时 Host 把它降级成 `rule`。 */
  hookDecisions: 'hook_decisions',
  // COMPAT(devPreview): added in 0.84.0, remove gate after 2027-06-01
  /** 认得 `ProcessSource` 的 `preview`；没有时 Host 从 `process.list` 与 `process.changed` 里去掉预览进程。 */
  devPreview: 'dev_preview',
  // COMPAT(toolDisplayImage): added in 0.118.0, remove gate after 2027-06-01
  /** 认得 `ToolDisplayKind` 的 `image`；没有时 Host 把它降级成 `unknown`（`tool.finished` 的 `images` 照发，旧客户端忽略）。 */
  toolDisplayImage: 'tool_display_image',
} as const;
export type ClientCapability = (typeof CLIENT_CAPABILITIES)[keyof typeof CLIENT_CAPABILITIES];

/** 已知能力位写成 `z.boolean().optional()`；未知键原样保留。 */
export const ClientCapabilitiesSchema = z.looseObject({
  title_source_generated: z.boolean().optional(),
  provider_kind_chatgpt: z.boolean().optional(),
  provider_kind_google_vertex: z.boolean().optional(),
  subscription_kinds: z.boolean().optional(),
  subscription_accounts: z.boolean().optional(),
  user_images: z.boolean().optional(),
  question_timeout: z.boolean().optional(),
  approval_rules: z.boolean().optional(),
  approval_timeout: z.boolean().optional(),
  hook_decisions: z.boolean().optional(),
  dev_preview: z.boolean().optional(),
  tool_display_image: z.boolean().optional(),
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
  /**
   * 项目的多个源文件夹（0.64.0）：`Workspace.extraFolders`，`workspace.add` / `workspace.update` 的 `extraFolders`。项目里的会话
   * 把它们作为额外的可写目录交给引擎（要引擎的 `additionalRoots`）。
   */
  workspaceFolders: 'workspace_folders',
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
   * 额度恢复后自动继续（0.119.0）：`session.setAutoContinue`、`session.auto_continue` 事件、`Session.autoContinue` 与
   * `MessageFrom.usageLimit`。与引擎无关；回合因用量上限失败时 `engine.error` 带 `usageLimit`（引擎能认出时）。
   */
  usageAutoContinue: 'usage_auto_continue',
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
   * 电脑操作（0.114.0，domain-model §3.15.8）：连接可以用 `computer.register` 登记为电脑操作的提供方、收 `computer.request` 通知、
   * 用 `computer.respond` 回答；设置的 `computerUse` 打开时应用级工具里有 `computer_*` 工具。只在有应用级工具时声明。
   */
  computerUse: 'computer_use',
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
   * 撤销与重做（0.51.0，domain-model §3.22）：`session.undo` / `session.redo` 与 `turn.undone` / `turn.redone` 事件。撤销把会话目录里的
   * 文件还原到最后一个回合开始前（靠回合快照，目录要在 git 仓库里），消息记录隐藏这个回合，引擎的上下文里补一条说明。取决于引擎
   * （看 `engineFeatures` 的 `undo`）；会话所在的引擎不行时 `INVALID_STATE`。
   */
  sessionUndo: 'session_undo',
  /**
   * 离开后摘要（0.54.0，domain-model §3.24）：`session.recap`，用户离开一阵再回到会话时，Host 用会话的模型生成一到三句话的小结。
   * 取决于引擎能不能生成文字（同会话标题的 `generateTitle`），设置 `sessionRecap` 可以关掉。
   */
  sessionRecap: 'session_recap',
  /**
   * 你应该知道（0.79.0，domain-model §3.33）：`insight.updated` 事件、快照的 `insights` 与 `session.respondInsight`。Host 设置
   * `sessionInsights` 开着时（默认关），回合结束后按频率限制用会话的模型在后台看一遍会话。取决于引擎能不能生成文字（`generateTitle`）。
   */
  sessionInsights: 'session_insights',
  /**
   * 订阅来源的上游（0.56.0，domain-model §3.6）：`account.upstreams`，`account.login` 的 `upstream` / `option` / `apiKey`，
   * `account.logout` 的 `upstream`。取决于引擎（OpenCode 有，别的订阅来源没有）。
   */
  subscriptionUpstreams: 'subscription_upstreams',
  /**
   * 共享任务清单（0.52.0，domain-model §3.15）：会话树的根会话里有 `tasks.board_updated` 事件与快照的 `taskBoard`，agent 用
   * `wevir_tasks` 系列工具分工，界面只读。随应用级工具（`app_tools`）一起声明。
   */
  taskBoard: 'task_board',
  /**
   * 输入建议（0.53.0，domain-model §3.23）：`suggestion.updated` 事件与快照的 `promptSuggestion`，Host 设置 `promptSuggestions`
   * 开着时每个正常结束的回合后生成一条。需要引擎能发一次不带工具的请求（`generateTitle`，dsh 没有）并且读得到提示词。
   */
  promptSuggestions: 'prompt_suggestions',
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
  /**
   * 记忆管理（0.57.0，domain-model §3.21）：`memory.*` 方法、`memory.changed` 通知与 Host 设置的 `autoMemory`；笔记带 `enabled`，
   * 停用的 Agent 看不到。与引擎无关。0.58.0 起笔记带来源（`origin` / `lastEdit`），Agent 的保存与删除也按版本检查。
   */
  memory: 'memory',
  /**
   * 接力的额外材料（0.59.0，domain-model §3.14）：`session.configure` 的 `handoff`（必须携带的约束、选入的笔记），`session.handoff`
   * 事件带递交记录（字节数、散列、省掉的条目、笔记的版本）。有 `session_handoff` 时声明。
   */
  handoffMaterial: 'handoff_material',
  /**
   * 接力预览（0.60.0）：`session.handoffPreview`、`session.configure` 的 `handoff.binding` 与 `HANDOFF_STALE`。有
   * `handoff_material` 时声明。
   */
  handoffPreview: 'handoff_preview',
  /**
   * 工具预设（0.61.0）：`session.create` 的 `toolPreset`、`Session.toolPreset` 与 `session.created` 的 `toolPreset`、只读的
   * `tools.presets`。只管 Wevir 应用级工具，有应用级工具时声明（同 `app_tools`）。
   */
  toolPresets: 'tool_presets',
  /**
   * 用量统计（0.62.0）：`usage.summary`、`usage.records`、`usage.pricing` 与 `usage.changed` 通知。每次模型请求的 token 与按
   * models.dev 价格估的成本。与引擎无关，哪些来源有记录取决于各引擎报不报。
   */
  usageStats: 'usage_stats',
  /**
   * 订阅多账号（0.63.0）：`account.add`、`account.remove`、`account.setLabel`，`account.*` 的 `id`，`AccountState` 的 `id`、
   * `label`、`localLogin`、`multiAccount`。哪些种类能添加看 `multiAccount`。
   */
  subscriptionAccounts: 'subscription_accounts',
  /**
   * 回合后验证与有限自动修复（0.65.0，ADR-0008）：`checks.*`（工作区的检查配置、仓库里的候选、自动修复设置）、`verification.*`
   * （运行、取消、重算、读完整输出），会话流里的 `verification.updated`、`acceptance.changed`、`repair.updated` 与快照的
   * `verification`，`MessageFrom.repair`。与引擎无关。
   */
  verification: 'verification',
  /**
   * 自动化（0.66.0）：`automation.*` 方法、`automation.changed` 通知、`Session.automation`，有应用级工具时还有
   * `wevir_automation_*`。按计划反复交给 Agent 的指令，只在 Host 运行时执行。
   */
  automations: 'automations',
  /**
   * 跨引擎的规则文件（0.68.0，domain-model §3.27）：Host 找出用户与项目的 AGENTS.md / CLAUDE.md / GEMINI.md / Cursor 规则，会话的引擎
   * 自己不读的那些由 Host 补给它（建会话、恢复与接力时）；`session.rules` 事件、`Session.rules`、接力预览的 `rules` 说明这个会话
   * 加载了哪些、各是谁读的，Host 设置 `ruleFiles` 可以关掉补给。与引擎无关。
   */
  ruleFiles: 'rule_files',
  /**
   * 行级批注（0.67.0，ADR-0009）：`review.*`。“变更”窗格的 diff 上写批注，存在 Host，按原文片段重新定位或标过期，一组发给指定会话。
   * 与引擎无关。
   */
  reviewComments: 'review_comments',
  /**
   * 暂存与提交（0.67.0，ADR-0009）：`git.status`、`git.stage`、`git.unstage`、`git.commit` 与 `workspace.diff` 的 `staged`。只由用户在
   * “变更”窗格发起，不是 Agent 的工具。与引擎无关。
   */
  gitCommit: 'git_commit',
  /**
   * 进程输出（0.69.0）：`process.list`、`process.output`、`process.stop` 与 `process.changed` 通知。客户端看 Agent 起的后台进程与
   * 回合后验证的检查进程、读输出、停止；不是终端，不能输入。有后台进程或回合后验证时声明。
   */
  processOutput: 'process_output',
  /**
   * 用户的交互终端（0.69.0）：`terminal.*` 方法、`terminal.output` 与 `terminal.changed` 通知。Host 上的 PTY，跑用户的登录 shell，
   * Agent 看不到。Host 装得上终端模块（node-pty）时声明。
   */
  userTerminal: 'user_terminal',
  /**
   * 项目环境就绪（0.70.0）：`readiness.*` 方法与 `readiness.changed` 通知（只读的预检、用户发起的项目安装、安装凭据），`VerificationRun`
   * 的 `readiness`，有应用级工具时还有只读的 `wevir_workspace_readiness`。与引擎无关。
   */
  workspaceReadiness: 'workspace_readiness',
  /**
   * 语言服务器的状态与安装（0.71.0）：`lsp.status`、`lsp.restart`、`lsp.log`、`lsp.install`、`lsp.cancelInstall` 与 `lsp.changed`
   * 通知。有代码智能（`lsp_*` 工具）时声明。
   */
  lspStatus: 'lsp_status',
  /**
   * 提问超时（0.72.0）：无人值守的会话里，问题带 `autoAnswerAt`，到时没人回答就按 `defaultOption` 回答（`timeout`）。Host 有
   * `user_questions` 时声明。
   */
  questionTimeout: 'question_timeout',
  /**
   * 自动化的条件与目标（0.73.0）：`automation.create` / `update` 的 `sessionId`（发进已有会话）与 `check`（检查脚本决定唤不唤醒
   * Agent）、`automation.testCheck`、运行状态 `checking` / `silent`、通知 `changes` 与连续失败自动停用（`autoPausedAt`）。
   * 有 `automations` 时声明。
   */
  automationConditions: 'automation_conditions',
  /** 从 Claude Code、Codex、Grok Build、Antigravity 导入记忆、MCP 服务器与 skills（0.74.0）：`import.*` 方法。 */
  externalImport: 'external_import',
  /**
   * 第二意见（0.75.0，domain-model §3.30）：`session.secondOpinion`、`session.quoteOpinion`、`opinion.updated` 事件、快照的 `opinions`、
   * `Session.opinionOf` 与 `MessageFrom.opinion`。Host 能开 worktree 时声明，与引擎无关（意见会话用哪个来源由请求决定）。
   */
  secondOpinion: 'second_opinion',
  /**
   * 任务回顾（0.76.0，ADR-0012）：`retro.get`（从事件确定性生成的回顾，每行带出处，按需增量更新）与 `retro.summarize`（用户触发的
   * 模型摘要，引擎实现了 `generateTitle` 时才写得成），有应用级工具时还有 `wevir_session_retro`。与引擎无关。
   */
  sessionRetro: 'session_retro',
  /**
   * 会话全文搜索（0.77.0）：`search.query`、`search.status`、`search.rebuild`。索引是 Host 从事件派生的，与引擎无关；运行时的
   * SQLite 没有 FTS5 trigram 时照样声明，查询都是有上限的扫描（`search.status` 的 `fts` 为 false）。
   */
  sessionSearch: 'session_search',
  /**
   * 用户的说明与输出风格（0.78.0，domain-model §3.34）：Host 设置的 `agentInstructions`、`outputStyle`，`session.rules` 的 `custom`。
   * Host 把它们与补给的规则文件一起交给引擎，选了带提醒的风格时每条用户消息末尾附一行提醒。与引擎无关。
   */
  agentInstructions: 'agent_instructions',
  /**
   * 审批规则（0.80.0，domain-model §3.35）：`approvalRule.*`、`ApprovalRequest.proposedRule`、`approval.respond` 的 `remember` 与
   * `ApprovalResolution` 的 `rule` / `ruleIds`。Host 在审批前按规则替用户允许命令，与引擎无关。
   */
  approvalRules: 'approval_rules',
  /**
   * 归档时的 worktree 快照（0.81.0，domain-model §3.36）：`session.archive` 归档时给会话开的 worktree 打快照、删目录，取消归档与恢复
   * 会话时重开；结果的 `worktrees`、`SessionWorktreeUsage.archived`。与引擎无关。
   */
  worktreeArchive: 'worktree_archive',
  /**
   * 会话在本地 checkout 与 worktree 之间换目录（0.81.0，domain-model §3.36）：`session.move`、`session.moved` 事件、`engineFeatures` 的
   * `relocate`。与引擎无关（换不了目录的引擎新开引擎会话、交摘要）。
   */
  sessionMove: 'session_move',
  /**
   * 消息流章节（0.82.0，domain-model §3.15.7）：应用级工具里有 `wevir_mark_chapter`，会话的流里有 `chapter.marked` 事件，任务回顾有
   * `chapters`。有应用级工具时声明（同 `app_tools`）。
   */
  transcriptChapters: 'transcript_chapters',
  /**
   * 审查发现（0.83.0）：`review.findings` 事件与 `ReviewComment.finding`；有应用级工具时还有 `wevir_report_findings`。Codex 审查命令
   * 的结果由适配器拆成结构化的发现；其他引擎的 agent 调工具报出。发现存成批注，可以跳到那几行、发给会话去修。
   */
  reviewFindings: 'review_findings',
  /**
   * 开发服务器预览（0.84.0，ADR-0013）：`preview.*` 方法与 `preview.changed` 通知、`ProcessSource` 的 `preview` 与
   * `HostProcess.preview`；有应用级工具时还有 `wevir_preview_list` / `wevir_preview_start`。项目的运行配置存在 Host，启动是会话里的
   * 后台进程。有后台进程（应用级工具）时声明。
   */
  devPreview: 'dev_preview',
  /**
   * 调优的档案（0.85.0，domain-model §3.39，ADR-0014）：`tuning.*` 方法与 `tuning.changed` 通知、`session.rules` 的 `profileVersion`。
   * 建会话时记下用的档案版本。与引擎无关。
   */
  tuning: 'tuning',
  /**
   * 护栏（0.86.0，domain-model §3.40）：`guardrail.*`、`repoHook.*`、`guardrail.changed` 通知与 `guardrail.blocked` 事件。规则只对
   * 声明了 hooks 的引擎（Codex）生效；Host 有这样的引擎时声明。
   */
  tuningGuardrails: 'tuning_guardrails',
  /**
   * 调优的建议（0.87.0，domain-model §3.41，ADR-0016）：`tuning.proposal.*` 方法与 `tuning.proposal.changed` 通知、档案版本的 `cause`、
   * 记忆来源的 `proposalId`。引擎能不带工具生成（适配器有 `generateTitle`）时声明。
   */
  tuningProposals: 'tuning_proposals',
  /** 官方插件市场（0.91.0）：`market.*` 方法与设置项 `marketMirror`。 */
  pluginMarket: 'plugin_market',
  /** 读市场条目里的文件（0.94.0）：`market.file`，详情页的 README 与列表的图标用它。 */
  marketFiles: 'market_files',
  /** 安装市场条目（0.99.0）：`market.install` / `market.installCancel` 与 `market.installProgress` 通知。 */
  marketInstall: 'market_install',
  /**
   * 听写（0.92.0，domain-model §3.42）：`speech.*` 方法与 `speech.changed` 通知、`SPEECH_FAILED` 错误、设置 `speechTranscriber` /
   * `speechPolish`、`ProviderProfile.transcriptionModels`。本机模型能不能用看 `speech.status`。与引擎无关。
   */
  speech: 'speech',
  /**
   * 写作风格（0.95.0，domain-model §3.43）：设置 `writingStyle`、`writingStyle.*` 方法、`session.rules` 的 `custom.writingStyle` 与
   * `wevir_writing_style_*` 工具。与引擎无关。
   */
  writingStyle: 'writing_style',
  /**
   * 远程 MCP 服务的 OAuth 登录（0.97.0）：http 连接器的 `auth` / `oauth` 设置、`Connector.oauth`、`connector.login` /
   * `loginCancel` / `logout` 与 `MCP_OAUTH_FAILED` 错误。没有这个功能位的 Host 不显示登录。
   */
  mcpOAuth: 'mcp_oauth',
  /**
   * 权限执行（0.98.0，ADR-0017 §4）：`host.hello` 的 `permissions` 是这条连接的实际权限，Host 按方法与参数检查每个请求、按
   * `NOTIFICATION_PERMISSIONS` 过滤通知，越权回 `DEVICE_FORBIDDEN`。本机连接拥有全部权限。与引擎无关。
   */
  permissionEnforcement: 'permission_enforcement',
  /**
   * 会话列表推送（0.101.0，ADR-0017 §5，domain-model §3.46）：`session.list` 的 `listVersion` 与待处理数、`sessions.changed` 通知。
   * 与引擎无关。
   */
  sessionListPush: 'session_list_push',
  /** 分块读文件（0.102.0，ADR-0017 §5）：`files.read`，远程客户端读文件用它，`GET /files/…` 只服务本机。与引擎无关。 */
  filesRead: 'files_read',
  /**
   * 防休眠由 Host 判定（0.102.0，ADR-0017 §5）：设置 `preventSleep`、`power.get` 与 `power.changed` 通知。执行仍在桌面主进程。与引擎无关。
   */
  preventSleep: 'prevent_sleep',
  /** 收件箱（0.105.0，ADR-0017 §5，domain-model §3.47）：`inbox.list`、`inbox.dismiss` 与 `inbox.changed` 通知。与引擎无关。 */
  inbox: 'inbox',
  /**
   * 无人值守会话的审批过期（0.105.0，domain-model §5 第 10 条）：设置 `unattendedApprovalTimeoutMinutes`、`ApprovalRequest.expiresAt`、
   * `timeout` 结算与 `APPROVAL_EXPIRED`。与引擎无关。
   */
  approvalTimeout: 'approval_timeout',
  /**
   * 通知意图与在场（0.106.0，ADR-0017 §5，domain-model §3.48）：`notification.subscribe`、`notification.intent`、`presence.update` 与设置
   * `notifications`。与引擎无关。
   */
  notificationIntents: 'notification_intents',
  /**
   * 远程设备与配对的管理（0.107.0，ADR-0017 §3，domain-model §3.49）：设置 `remote`、`device.*`、`pairing.*` 与 `devices.changed`、
   * `pairing.request`、`pairing.ended` 通知。远程监听本身不在这一项里。与引擎无关。
   */
  remoteDevices: 'remote_devices',
  /**
   * 自动调优（0.108.0，domain-model §3.50，ADR-0018）：设置 `autoTuning` / `autoTuningMonthlyTokens`、`tuning.overview`、
   * `tuning.proposal.revert`、建议的 `trial` / `reverted` 状态与 `origin` / `outcome`；生成的建议直接进入试用，按之后会话的指标保留或
   * 回退。有建议服务（`tuning_proposals`）时声明。
   */
  tuningAuto: 'tuning_auto',
  /**
   * 直连的远程监听（0.109.0，ADR-0017 §1）：设置 `remote.port` 与 `remote.interfaces.lanInterfaces`、`remote.status` 与
   * `remote.changed`，配对窗口带上直连的候选地址。与引擎无关。
   */
  remoteListener: 'remote_listener',
  /**
   * 中继（0.110.0，ADR-0017 §1）：开了 `remote.relay` 时 Host 向中继发起出站连接并注册路由 ID，经中继来的连接走与直连相同的握手；
   * `remote.status` 的 `relay`、握手负载与配对窗口的 `relayUrl`。没有官方中继，只连用户填的地址（0.111.0 起没填地址等于关）。
   * 与引擎无关。
   */
  remoteRelay: 'remote_relay',
  /**
   * 推送（0.112.0，ADR-0017 §6，host-api.md §1.3）：设备的 `push.get` / `push.register` / `push.unregister` 与 `push.changed`，设置
   * `remote.push` 的两路开关，设备记录的 `push`、`device.update` 与 `pairing.respond` 的 `push`，`remote.status` 的 `push`。电脑前没人时
   * 把通知意图加密后经推送网关发给开了推送的设备。与引擎无关。
   */
  remotePush: 'remote_push',
  /**
   * 网页设备（0.117.0，ADR-0017 补记 8）：中继的三态（`remote.relay.mode` 可选官方中继 `OFFICIAL_RELAY_URL`）、`pairing.start` 的
   * `web`（经中继的 https 配对链接）、设备平台 `web`、设置 `remote.web`（网页地址与闲置自动移除）。与引擎无关。
   */
  remoteWeb: 'remote_web',
  /**
   * 频道与助理（0.120.0，ADR-0020，domain-model §3.53）：`channel.*`、`channels.changed` / `channel.posted` / `channel.updated`、
   * `Session.channel`、`Workspace.kind: 'assistant'`。频道里的会话不进会话列表。与引擎无关；协调者的 `wevir_channel_*` 工具要
   * 引擎能挂 Wevir 工具。
   */
  channels: 'channels',
  /**
   * 助理的日程（0.121.0）：`Automation.channelId` / `brief`、建助理时的晨间简报、`brief` 卡片的内容，通知种类 `channel`、意图与
   * 收件箱项的 `channelId`。
   */
  channel_schedules: 'channel_schedules',
  /**
   * 助理之间与助理群（0.133.0）：频道种类 `group` 与 `Channel.group`、`channel.create` / `channel.update` 的 `members`、`channel.post`
   * 的 `mentions`、帖子作者 `assistant` 与帖子的 `to` / `mentions`、说明卡片的 `assistantId`，协调者的 `wevir_channel_assistants` 与
   * `wevir_channel_message`。
   */
  channel_groups: 'channel_groups',
  /**
   * 助理的输入框（0.135.0）：`channel.post` 的图片由 Host 收下（同 `session.send`，协调者的模型看不了图片时换成说明），`channel.stop`
   * 与 `Channel.answering`。
   */
  channel_composer: 'channel_composer',
  /**
   * iOS 模拟器（0.122.0，domain-model §3.15.9）：`simulator.*` 方法、`simulator.changed` / `simulator.show` / `simulator.orientation`
   * 通知与 RPC 端口上的 `/simulator/stream`；设置的 `iosSimulator` 开着（默认）且有应用级工具时还有 `simulator_control` 与
   * `simulator_build`。Host 在 macOS 上、找得到 helper（`WEVIR_IOS_SIMULATOR_BIN`）时声明。
   */
  iosSimulator: 'ios_simulator',
  /**
   * 回合末的下一步卡片（0.128.0，domain-model §3.15.10）：应用级工具里有 `wevir_wrap_up`，会话的流里有 `turn.wrap_up` 事件，`Session`
   * 有 `wrapUp`。有应用级工具时声明（同 `app_tools`）。
   */
  turnWrapUp: 'turn_wrap_up',
  /**
   * 预先启动引擎（0.129.0）：`provider.prewarm`。新会话页选中某个 Provider 时客户端调用，承载它的引擎有冷启动（ACP 运行体）时
   * Host 先把进程拉起来，第一条消息不再等它。Host 有能预先启动的引擎时声明。
   */
  enginePrewarm: 'engine_prewarm',
  /**
   * 环境变量（0.130.0）：`Environment.variables` 与 `environment.create` / `environment.update` 的 `variables`。Host 在建立、恢复与分出
   * 环境的会话时交给引擎；能按会话设变量的引擎（Codex 交给模型跑的命令，Claude 交给 `claude` 进程）才用，共用一个进程的引擎
   * （ACP、OpenCode）不用。与引擎无关地声明。
   */
  environmentVariables: 'environment_variables',
  /**
   * 审批的风险（0.131.0）：`ApprovalRequest.risk` 与收件箱审批项的 `ref.risk`，`ALREADY_DECIDED` / `APPROVAL_EXPIRED` 的
   * `resolvedAt`。Host 按命令与沙箱请求判定，手机据此在作答前要求验证本人。与引擎无关地声明。
   */
  approvalRisk: 'approval_risk',
  /**
   * 生命周期钩子（0.137.0，ADR-0023）：`hook.*` 方法、`hook.outcome` 事件、`ApprovalResolutionReason` 的 `hook` 与 `MessageFrom.hook`。
   * 会话起止、提交提示与权限请求由 Host 派发、对所有引擎有效；工具前后、结束、压缩与子 agent 起止要引擎有接点（`hook.list` 的
   * `support`）。与引擎无关地声明。
   */
  lifecycleHooks: 'lifecycle_hooks',
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
  workspace_folders: z.boolean().optional(),
  session_rename: z.boolean().optional(),
  session_archive: z.boolean().optional(),
  session_delete: z.boolean().optional(),
  session_compact: z.boolean().optional(),
  session_review: z.boolean().optional(),
  session_goals: z.boolean().optional(),
  usage_auto_continue: z.boolean().optional(),
  session_handoff: z.boolean().optional(),
  user_images: z.boolean().optional(),
  app_tools: z.boolean().optional(),
  file_preview: z.boolean().optional(),
  browser_tools: z.boolean().optional(),
  computer_use: z.boolean().optional(),
  web_tools: z.boolean().optional(),
  plan_mode: z.boolean().optional(),
  session_branches: z.boolean().optional(),
  session_rewind: z.boolean().optional(),
  session_undo: z.boolean().optional(),
  session_recap: z.boolean().optional(),
  session_insights: z.boolean().optional(),
  subscription_upstreams: z.boolean().optional(),
  task_board: z.boolean().optional(),
  prompt_suggestions: z.boolean().optional(),
  chat_sessions: z.boolean().optional(),
  shared_files: z.boolean().optional(),
  memory: z.boolean().optional(),
  handoff_material: z.boolean().optional(),
  handoff_preview: z.boolean().optional(),
  tool_presets: z.boolean().optional(),
  usage_stats: z.boolean().optional(),
  subscription_accounts: z.boolean().optional(),
  verification: z.boolean().optional(),
  automations: z.boolean().optional(),
  rule_files: z.boolean().optional(),
  review_comments: z.boolean().optional(),
  git_commit: z.boolean().optional(),
  process_output: z.boolean().optional(),
  user_terminal: z.boolean().optional(),
  workspace_readiness: z.boolean().optional(),
  lsp_status: z.boolean().optional(),
  question_timeout: z.boolean().optional(),
  automation_conditions: z.boolean().optional(),
  external_import: z.boolean().optional(),
  second_opinion: z.boolean().optional(),
  session_retro: z.boolean().optional(),
  session_search: z.boolean().optional(),
  agent_instructions: z.boolean().optional(),
  approval_rules: z.boolean().optional(),
  worktree_archive: z.boolean().optional(),
  session_move: z.boolean().optional(),
  transcript_chapters: z.boolean().optional(),
  review_findings: z.boolean().optional(),
  dev_preview: z.boolean().optional(),
  tuning: z.boolean().optional(),
  tuning_guardrails: z.boolean().optional(),
  tuning_proposals: z.boolean().optional(),
  plugin_market: z.boolean().optional(),
  market_files: z.boolean().optional(),
  market_install: z.boolean().optional(),
  speech: z.boolean().optional(),
  writing_style: z.boolean().optional(),
  mcp_oauth: z.boolean().optional(),
  permission_enforcement: z.boolean().optional(),
  session_list_push: z.boolean().optional(),
  files_read: z.boolean().optional(),
  prevent_sleep: z.boolean().optional(),
  inbox: z.boolean().optional(),
  approval_timeout: z.boolean().optional(),
  notification_intents: z.boolean().optional(),
  remote_devices: z.boolean().optional(),
  tuning_auto: z.boolean().optional(),
  remote_listener: z.boolean().optional(),
  remote_relay: z.boolean().optional(),
  remote_push: z.boolean().optional(),
  remote_web: z.boolean().optional(),
  channels: z.boolean().optional(),
  channel_schedules: z.boolean().optional(),
  channel_groups: z.boolean().optional(),
  channel_composer: z.boolean().optional(),
  ios_simulator: z.boolean().optional(),
  turn_wrap_up: z.boolean().optional(),
  engine_prewarm: z.boolean().optional(),
  environment_variables: z.boolean().optional(),
  approval_risk: z.boolean().optional(),
  lifecycle_hooks: z.boolean().optional(),
});
export type HostFeatures = z.infer<typeof HostFeaturesSchema>;

/**
 * 权限词表。每个方法需要其中一项（`MethodSchemas[*].permission`），每种通知也标了一项（`NOTIFICATION_PERMISSIONS`）。
 * 0.98.0 起 Host 按连接的权限检查（ADR-0017 §4）：本机连接拥有全部，远程设备的取自设备记录。只增不减。
 */
export const PERMISSIONS = [
  'host.manage',
  'workspace.read',
  'workspace.write',
  'provider.read',
  'provider.write',
  'session.read',
  'session.write',
  /** 用户终端的建、输入、改尺寸、关（0.98.0，原为 `session.write`）；读输出仍是 `session.read`。 */
  'terminal.write',
  /** 审批规则、护栏、仓库 hooks 的写方法，以及“完全访问”与“总是允许”（0.98.0，原为 `host.manage` / `session.write`）。 */
  'policy.write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** 线缆上是开放的字符串数组，旧客户端遇到新权限名不会解析失败。 */
export const PermissionsSchema = z.array(z.string().min(1));
