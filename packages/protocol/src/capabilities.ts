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
   * 消息流章节（0.82.0，domain-model §3.15.7）：应用级工具里有 `wevir_mark_chapter`，会话的流里有 `chapter.marked` 事件，任务回顾有
   * `chapters`。有应用级工具时声明（同 `app_tools`）。
   */
  transcriptChapters: 'transcript_chapters',
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
  session_handoff: z.boolean().optional(),
  user_images: z.boolean().optional(),
  app_tools: z.boolean().optional(),
  file_preview: z.boolean().optional(),
  browser_tools: z.boolean().optional(),
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
  transcript_chapters: z.boolean().optional(),
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
