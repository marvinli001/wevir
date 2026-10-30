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

import type { EnginePluginConfig } from './plugins.js';

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
  /**
   * 应用级工具的会话上下文：记忆索引与自动化、频道会话的须知。只有 `appToolsContextInPrompt` 回答 true 且挂了 `appTools` 的会话会
   * 收到；适配器把它接在引擎的系统说明后面（Claude 的 `systemPrompt.append`）。建立、恢复与分支时 Host 按当时的记忆重新给，会话内
   * 不变。
   */
  appToolsContext?: string;
  /**
   * Host 补给的规则文件（0.68.0，domain-model §3.27）：引擎自己不读的 AGENTS.md / CLAUDE.md / GEMINI.md / Cursor 规则，已排好、带
   * 来源路径的一段正文。只有 `ruleFiles(providerId).instructions` 为 true 的适配器会收到；适配器把它放进引擎每次请求都带的系统或
   * 开发者说明（Codex 的 `developerInstructions`、Claude 的 `systemPrompt.append`、OpenCode 每条消息的 `system`），恢复会话时
   * Host 按当时的文件重新给。
   */
  ruleInstructions?: string;
  /**
   * 只给这个会话所在项目的连接器（0.74.0，domain-model §3.19）：Host 按会话的工作区给，不看 `cwd`（worktree 里的会话也拿得到），
   * 恢复会话时按当时的设置重新给。全局的连接器仍经 `bindPlugins` 的 `read`。接用户连接器的适配器（Codex）把它们只挂到这一个引擎
   * 会话上，别的适配器忽略。
   */
  connectors?: EnginePluginConfig['connectors'];
  /**
   * 挂到这个引擎会话上的 hooks（护栏，domain-model §3.40）：Host 的检查程序与用户启用的仓库 hooks。只有 `hookDialect` 回答 `codex` 的来源
   * 会收到（Codex：`thread/start` 等的 SessionFlags 层，带信任散列）；恢复与分支会话时 Host 按当时的规则重新给。
   */
  hooks?: EngineHook[];
  /**
   * 引擎自己会从仓库读的 hooks 的键（Codex 的 `<文件>:<事件>:<组>:<处理器>`）：适配器把它们停用（护栏，默认不执行仓库带来的脚本；
   * Codex 本来也不执行没有信任记录的，这是第二道）。用户启用的仓库 hook 由 Host 改写成 `hooks` 里的一项，原处的仍停用。
   */
  disabledHooks?: string[];
  /**
   * 生命周期钩子的接点（0.137.0，ADR-0023）：只有 `hookCallbacks` 回答 true 的来源会收到。适配器为 `NATIVE_HOOK_EVENTS` 注册引擎自己的
   * 回调（Claude Agent SDK 的 `hooks`），回调把事件交给 `run`、把结果原样交回引擎；同时停掉引擎自己从设置文件与插件执行 hooks
   * （Claude：`disableAllHooks`），Wevir 之外没有第二条执行路径。恢复与分支会话时 Host 重新给。
   */
  hookTap?: HookTap;
  /**
   * 环境的变量（0.130.0，domain-model §3.10）：Host 按会话的环境给，恢复与分出会话时按当时存的值重新给。能按会话设变量的适配器
   * 才用（Codex：`shell_environment_policy.set`，交给模型跑的命令；Claude：并进 `claude` 进程的环境），共用一个引擎进程的忽略。
   * 值是密钥，不得写进日志或事件。
   */
  env?: Record<string, string>;
  /**
   * 角色对引擎自带工具的限制（domain-model §3.15 的“角色”）：Host 按会话的角色给，恢复与分出会话时照样给。各适配器按引擎能做到的
   * 程度执行（Claude 按名字精确去掉；Codex 关 shell、只读沙箱、关联网搜索；OpenCode 加 deny 规则；ACP 引擎拒掉这些类别的审批请求），
   * 做不到的部分靠权限模式与角色说明。没有角色或角色不限引擎工具时省略。
   */
  engineTools?: EngineToolLimits;
}

/** 引擎自带工具的类别：读与搜索文件、改文件、跑命令、联网。 */
export type EngineToolClass = 'read' | 'edit' | 'shell' | 'web';

/**
 * 角色对引擎自带工具的限制（`SessionConfig.engineTools`）。`denied` 是整类关掉的（只能按类关的引擎用它；角色只禁了某一类里的一个
 * 工具时这一类也算关掉，宁严勿松）。`deniedNames` / `allowedNames` 是 Claude Code 的工具名（类别名已展开，`mcp__<服务>__<工具>` 与
 * `mcp__<服务>__*` 原样），只有认这些名字的引擎（Claude）用：前者从模型的工具里去掉，后者是只许的内置工具（省略表示不按名字收窄）。
 */
export interface EngineToolLimits {
  denied: EngineToolClass[];
  deniedNames: string[];
  allowedNames?: string[];
}

/**
 * 一个命令 hook（Codex 与 Claude Code 同一套写法）：`event` 是引擎的事件名（`PreToolUse`、`Stop`…），`matcher` 选工具（`Bash`、
 * `apply_patch`，正则或 `|` 分隔），`command` 是交给 shell 的整条命令行（stdin 是事件的 JSON），`timeoutSec` 是时限。
 */
export interface EngineHook {
  event: string;
  matcher?: string;
  command: string;
  timeoutSec?: number;
  statusMessage?: string;
}

/**
 * 经引擎接点转回 Host 的事件（0.137.0，ADR-0023）：工具前后、结束、压缩与子 agent 起止。会话起止、提交提示与权限请求由 Host 自己派发，
 * 不经接点。
 */
export const NATIVE_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
] as const;
export type NativeHookEvent = (typeof NATIVE_HOOK_EVENTS)[number];

/** Host 执行生命周期钩子的入口（`SessionConfig.hookTap`）。 */
export interface HookTap {
  /**
   * 执行这个事件的 hooks：`input` 是引擎给 hook 的输入（Claude Code 的形状，`hook_event_name` 等），返回 Claude Code 形状的 JSON 输出
   * （没有要说的时是空对象）。不抛错：Host 内部的错误按放行处理。
   */
  run(
    event: NativeHookEvent,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

/** 规则文件的种类（0.68.0，protocol 的 `RuleFileKind` 已知的那几个）。 */
export type RuleFileKind = 'agents' | 'claude' | 'gemini' | 'cursor';

/**
 * 引擎自己读哪些规则文件（0.68.0，`AgentRuntimeAdapter.ruleFiles`）。`user` 指 Host 找的那几份用户级文件（`agents`：Codex 的
 * `~/.codex/AGENTS.md`；`claude`：`~/.claude/CLAUDE.md`；`gemini`：`~/.gemini/GEMINI.md`），引擎读的是自己目录里另一份同名文件
 * 时不算；`project` 指从仓库根到会话目录一路上的那种文件。`imports`：引擎自己展开 CLAUDE.md / GEMINI.md 里的 `@路径`。
 * `instructions`：适配器把 `SessionConfig.ruleInstructions` 放进引擎的说明；false 时 Host 把正文放在下一条消息的开头。
 */
export interface EngineRuleFiles {
  user: readonly RuleFileKind[];
  project: readonly RuleFileKind[];
  /**
   * 项目里一份 `project` 的种类都没有时引擎才读的（OpenCode：没有 AGENTS.md 时读 CLAUDE.md；Claude Code 2.1.277 起：没有 CLAUDE.md
   * 时读 AGENTS.md）。
   */
  projectFallback?: readonly RuleFileKind[];
  imports: boolean;
  instructions: boolean;
  /**
   * 引擎自己已经带着写代码的做法（Claude Code）：true 时 Host 不再补 Wevir 的编码纪律（prompts/coding-discipline.md），其余引擎
   * 都补。省略当作 false。
   */
  codingGuidance?: boolean;
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
 * 按需加载的应用级工具（Codex）：同一个端点、同一个令牌拆成两个服务，`wevir` 只列常驻的核心工具，`wevir_more` 列其余的
 * （`mcp__wevir_more__browser_click` 这样），模型打开工具搜索时延迟加载。别的引擎仍是一个 `wevir`。
 */
export const APP_TOOLS_MORE_SERVER = 'wevir_more';

/** 应用级工具的层：`core` 常驻，`more` 按需。 */
export type AppToolTier = 'core' | 'more';

/**
 * 端点的一种列法：一层（`core` / `more`），或 `dispatch`（没有自带工具搜索的引擎，OpenCode）——常驻那层加上
 * `wevir_tool_search` 与两个分发工具，按需那层的工具不列，搜到后经分发工具调用。
 */
export type AppToolsView = AppToolTier | 'dispatch';

/** 按需的工具在 `dispatch` 列法里怎么找：按关键词搜，回名字、描述与参数。 */
export const APP_TOOLS_SEARCH = 'wevir_tool_search';
/** 经分发调用只读的工具（`readOnlyHint`，不用批准）；目标工具不是只读的，Host 回错。 */
export const APP_TOOLS_CALL_READONLY = 'wevir_call_readonly';
/** 经分发调用会改东西的工具，按引擎的审批策略问用户。 */
export const APP_TOOLS_CALL = 'wevir_call';

/** 只列一层工具（或换一种列法）的端点地址（`?tier=core` / `?tier=more` / `?tier=dispatch`，令牌不变）。 */
export function appToolsTierUrl(url: string, tier: AppToolsView): string {
  return `${url}${url.includes('?') ? '&' : '?'}tier=${tier}`;
}

/** 应用级工具调用的工具名（`mcp__wevir__x` 或 `mcp__wevir_more__x`）去掉服务前缀；别的服务的工具原样返回。 */
export function appToolBaseName(toolName: string): string {
  return toolName.replace(/^mcp__wevir(?:_more)?__/, '');
}

/** 应用级工具调用来自哪个服务（显示用）：`mcp__wevir_more__` 开头的是 `wevir_more`，其余当作 `wevir`。 */
export function appToolServerOf(toolName: string): string {
  return toolName.startsWith(`mcp__${APP_TOOLS_MORE_SERVER}__`)
    ? APP_TOOLS_MORE_SERVER
    : APP_TOOLS_SERVER;
}

/**
 * 不用批准的应用级工具（0.30.0）：只读的，加上只请界面显示的 `wevir_show` 与（0.40.0）交文件卡片的 `wevir_share_file`、（0.83.0）报审查发现的 `wevir_report_findings`；0.33.0 起还有只读的浏览器工具（列标签页、快照、
 * 截图、等待、日志，0.48.0 起还有查元素与网络记录，Host 的 `BROWSER_READ_ONLY_TOOLS`）。其余（新开会话、给别的会话发消息、停别的会话、在网页上点击填写与跳转）
 * 按会话的权限模式走引擎自己的审批。P3 的 wevir_plugins_list 也只读；三个插件写工具由 Host 核对用户批准，不在这张表里。0.47.0 起
 * 还有后台进程的列出、读输出与等待（起进程、写 stdin、发信号按权限模式）；0.95.0 起写作风格的 `wevir_writing_style_*` 同记忆工具，只读写 Host 数据目录，不用批准；0.108.0 起调优的 `wevir_tuning_*` 也不用批准（改项目的 `AGENTS.md`、技能、记忆与护栏，但改动进入试用、可以撤销；写的两个不标 `readOnlyHint`）；代码智能的 `lsp_*` 只读（Host 的 `LSP_TOOLS`，会按需启动项目的语言服务器）。0.66.0 起列出自动化的 `wevir_automations` 只读（建、改、删、运行按权限模式）。0.82.0 起只在消息流里画分隔线的 `wevir_mark_chapter` 也不用批准，0.128.0 起放回合末卡片的 `wevir_wrap_up` 同样。 0.84.0 起列出运行配置的 `wevir_preview_list` 只读（启动按权限模式）。0.89.0 起浏览器的收尾 `browser_finalize_tabs` 也不用批准（只关 agent 自己开的标签页；接管用户标签页的 `browser_claim_tab` 按权限模式）。2026-10-22（第四轮冒烟，维护者定）起只动 agent 自己创建的东西的也不用批准：停自己起的后台进程（`wevir_process_kill`，用户起的预览与检查进程拒绝）、关闭与归档自己开的会话（`wevir_session_close` / `wevir_session_archive`）、关自己开的标签页（`browser_close_tab`）；它们标 `destructiveHint: false, openWorldHint: false`，不标 `readOnlyHint`（角色的 `readonly` 不含它们）。0.114.0 起电脑操作的 `computer_*` 全部不用批准：用户在 `computer_request_access` 的授权框里逐个应用批准就是这组工具的批准，之后每个动作按应用的档位核对（Host 的 `COMPUTER_TOOLS`）。0.122.0 起 iOS 模拟器的 `simulator_control` 不用批准（只碰模拟器；`launch` 安装 .app 时 Host 自己请用户批准），构建的 `simulator_build` 按权限模式。0.136.0 起配置 Wevir 本身的工具里，只读的 `wevir_config_read` 与只改自己或自己开出的会话的 `wevir_config_session`（不改权限模式）不用批准；其余四个按权限模式，其中会放宽 Agent 权限或碰到密钥的改动由 Host 核对用户批准（同插件写工具）。2026-10-29 起插件管理的 `wevir_plugins_browse`（搜市场、扫描可导入的内容）只读、不用批准；`wevir_plugins_manage` 按权限模式，其中移除、改连接器、改输入项、市场安装与导入由 Host 核对用户批准。
 * 引擎要按名字放行时用它（Claude 的 `allowedTools`）；Codex 看工具的 annotations。
 */
export const APP_TOOLS_NO_APPROVAL: readonly string[] = Object.freeze([
  'wevir_session_list',
  'wevir_session_read',
  'wevir_session_retro',
  'wevir_session_wait',
  'wevir_session_progress',
  'wevir_session_close',
  'wevir_session_archive',
  'wevir_config_session',
  'wevir_config_read',
  'wevir_models',
  'wevir_roles',
  'wevir_tasks',
  'wevir_task_create',
  'wevir_task_update',
  'wevir_show',
  'wevir_share_file',
  'wevir_image_generate',
  'wevir_mark_chapter',
  'wevir_wrap_up',
  'wevir_report_findings',
  'wevir_plugins_list',
  'wevir_plugins_browse',
  'wevir_memory_list',
  'wevir_memory_read',
  'wevir_memory_save',
  'wevir_memory_delete',
  'wevir_writing_style_setup',
  'wevir_writing_style_samples',
  'wevir_writing_style_read',
  'wevir_writing_style_save',
  'wevir_tuning_status',
  'wevir_tuning_propose',
  'wevir_tuning_decide',
  'wevir_automations',
  'wevir_channel_status',
  'wevir_channel_timeline',
  'wevir_channel_post',
  'wevir_channel_needs',
  'wevir_channel_suggest',
  'wevir_channel_start_thread',
  'wevir_channel_forward',
  'wevir_channel_resolve',
  'wevir_channel_assistants',
  'wevir_channel_message',
  'wevir_process_list',
  'wevir_process_output',
  'wevir_process_wait',
  'wevir_process_kill',
  'wevir_preview_list',
  'browser_list_tabs',
  'browser_snapshot',
  'browser_screenshot',
  'browser_wait',
  'browser_logs',
  'browser_query',
  'browser_network',
  'browser_finalize_tabs',
  'browser_close_tab',
  'lsp_definition',
  'lsp_references',
  'lsp_hover',
  'lsp_document_symbols',
  'lsp_workspace_symbols',
  'lsp_call_hierarchy',
  'lsp_diagnostics',
  'computer_request_access',
  'computer_list_apps',
  'computer_screenshot',
  'computer_zoom',
  'computer_ax_tree',
  'computer_ax_find',
  'computer_open_app',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_drag',
  'computer_set_value',
  'computer_clipboard_read',
  'computer_clipboard_write',
  'computer_batch',
  'simulator_control',
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

/** `supports` 能问的：可选方法，计划模式（0.36.0，`planMode`），分支与撤回（0.38.0，`branch` 是 `fork` 的 `{ kind: 'branch' }`），补说明（0.51.0，撤销与重做靠它告诉引擎）。 */
export type SessionCapability =
  | SessionCommandMethod
  | 'planMode'
  | 'branch'
  | 'rewind'
  | 'injectNote';

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
  /**
   * 这次请求的 token 用量（0.76.0，任务回顾的模型摘要要显示消耗）：拿得到时适配器每个模型请求调一次，拿不到不调。Host 也把它
   * 记进用量统计（标题、输入建议、摘要同样按会话的模型计费）。
   */
  onUsage?: (usage: TitleUsage) => void;
}

/** `generateTitle` 一次模型请求的用量。`inputTokens` 含缓存的读写（OpenAI 口径），`reasoningTokens` 含在 `outputTokens` 里。 */
export interface TitleUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** 实际回答的模型；不报时 Host 用会话的模型。 */
  model?: string;
  /** 来源后面实际接的上游（OpenCode 的 `providerID`）。 */
  upstream?: string;
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
  /**
   * 引擎提议的“以后这个前缀不再问”（Codex 的 `proposedExecpolicyAmendment`，按词）。只是给 Host 提议审批规则作参考
   * （domain-model §3.35），Host 自己判断用不用；没有时省略。
   */
  proposedPrefix?: string[];
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
  /** 生成或编辑图片（0.118.0）。 */
  | 'image'
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
  /** 引擎标出的推荐选项的 `label`（0.72.0）；没有时 Host 自己判断。 */
  defaultOption?: string;
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
  toolSearch?: 'native' | 'dispatch' | 'off';
  requestCompression?: 'gzip';
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
export type SubscriptionKind =
  | 'claude'
  | 'cursor'
  | 'opencode'
  | 'grok'
  | 'antigravity'
  | 'workbuddy'
  | 'devin'
  | 'copilot'
  | 'kiro';

/** 与 @wevir/protocol 的 `AccountKind` 同形。 */
export type AccountKind = 'chatgpt' | SubscriptionKind;

/** 与 @wevir/protocol 的 `AccountLoginMethod` 同形。 */
export type AccountLoginMethod = 'browser' | 'device_code';

/** 与 @wevir/protocol 的 `AccountLoginOption` 同形（0.56.0）。 */
export interface AccountLoginOption {
  id: string;
  label: string;
}

/** 与 @wevir/protocol 的 `AccountUpstreamMethod` 同形（0.56.0）。 */
export interface AccountUpstreamMethod {
  type: 'oauth' | 'api_key';
  label: string;
  option: string;
}

/** 与 @wevir/protocol 的 `AccountUpstream` 同形（0.56.0）：订阅来源后面接着的一家上游。 */
export interface AccountUpstream {
  id: string;
  name: string;
  connected: boolean;
  featured: boolean;
  methods: AccountUpstreamMethod[];
}

/**
 * `account.login` 的附加参数（0.56.0）：`upstream` 与 `option` 选订阅来源后面的哪一家上游、哪种方式（`upstreams()` 给的）；没有
 * `upstream` 时 `option` 是 `AccountState.loginOptions` 里的一项。`apiKey` 只交给引擎，不进日志与状态。
 */
export interface AccountLoginOptions {
  upstream?: string;
  option?: string;
  apiKey?: string;
}

/** 与 @wevir/protocol 的 `AccountState` 同形（domain-model §3.6）。 */
export interface AccountState {
  kind: AccountKind;
  /**
   * 0.63.0 多账号的字段：账号 ID、标签、本机登录、能不能添加账号。由 Host 按它的账号登记填，引擎不填（一个引擎实例只有一个
   * 这种账号，见 Host 的 accounts.ts）。
   */
  id?: string;
  label?: string;
  localLogin?: true;
  multiAccount?: true;
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
  /** 0.56.0：未登录时可选的登录方式（WorkBuddy 的国内 / 国际站），第一项是缺省。 */
  loginOptions?: AccountLoginOption[];
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
