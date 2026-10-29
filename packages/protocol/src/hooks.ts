// 生命周期钩子（0.137.0，Host 功能 `lifecycle_hooks`，domain-model §3.40，ADR-0023）。
//
// 用户写 Claude Code / Codex 同一种写法的 hooks（事件 → matcher → 命令），Wevir 统一持有配置、信任与执行：Host 自己派发会话起止、
// 提交提示与权限请求，工具前后、结束、压缩与子 agent 起止经引擎的接点（Codex 的会话层命令 hook、Claude Agent SDK 的回调）转回 Host
// 执行。命令在去掉 `WEVIR_*` 的环境里跑，stdin 是事件的 JSON，输出协议与 Claude Code 相同。
//
// 来源：Wevir 自己的（存在 Host 数据目录，建立即信任）；仓库里的 `.wevir/hooks.json`、`.claude/settings.json`、
// `.claude/settings.local.json` 与 `.codex/` 的（默认不执行，逐个启用，启用记内容散列，含命令引用的仓库文件）；Claude 用户层的
// `settings.json`（默认执行，可停用）；已装插件自带的（安装即信任，可停用）。兼容来源只在原引擎上跑（“写给谁的就跑在谁上”）。

import { z } from 'zod';
import { IsoTimeSchema, TurnIdSchema, WorkspaceIdSchema } from './common.js';

/** Wevir 认的事件（Claude Code / Codex 的名字）。线缆上是开放字符串，以后加不破坏兼容。 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Host 自己派发、所有引擎都有的事件。 */
export const HOST_HOOK_EVENTS: readonly HookEventName[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'SessionEnd',
];

/** 处理器的时限（秒，默认与上限）。 */
export const HOOK_TIMEOUT_DEFAULT_SEC = 60;
export const HOOK_TIMEOUT_MAX_SEC = 600;
/** 命令与 matcher 的长度上限（字符）。 */
export const HOOK_COMMAND_MAX_LENGTH = 2000;
export const HOOK_MATCHER_MAX_LENGTH = 500;
/** 名字的长度上限。 */
export const HOOK_NAME_MAX_LENGTH = 80;
/** 一个范围（全局或一个项目）里最多几条 Wevir 自己的 hooks。 */
export const HOOKS_MAX_PER_SCOPE = 50;
/** 同一回合里 Stop 最多让 Agent 继续几次（任何来源合计），之后放行。 */
export const HOOK_STOP_CONTINUE_MAX = 3;
/** `hook.outcome` 里理由与命令的长度上限（按码点，超出截断）。 */
export const HOOK_OUTCOME_TEXT_MAX_LENGTH = 2000;

export const HookEventSchema = z.enum(HOOK_EVENTS);

/**
 * 命令处理器（Wevir 自己的 hooks 只有这一种）。退出码 0 放行，stdout 可给 Claude Code 的 JSON 输出；退出码 2 拦下，stderr 是理由；
 * 其他退出码与超时是不拦的错误，`onFailure: 'block'` 时改为拦下。
 */
export const HookCommandHandlerSchema = z.object({
  type: z.literal('command'),
  command: z.string().trim().min(1).max(HOOK_COMMAND_MAX_LENGTH),
  /** 秒，默认 60。 */
  timeout: z.int().min(1).max(HOOK_TIMEOUT_MAX_SEC).optional(),
  onFailure: z.enum(['block', 'continue']).optional(),
});
export type HookCommandHandler = z.infer<typeof HookCommandHandlerSchema>;

/**
 * 列表里的一条 hook（一个处理器）。
 * - `id`：Wevir 自己的是 `hok_…`；文件里的是 `<来源>:<相对路径>:<事件>:<组序号>:<处理器序号>`；插件的是 `plugin:<插件 ID>:…`；
 *   Codex 仓库 hooks 沿用 `repoHook` 的 ID。在同一个项目里稳定。
 * - `source`（开放字符串）：`wevir` Wevir 自己的；`project` `.wevir/hooks.json`；`claude_project` `.claude/settings*.json`；
 *   `claude_user` Claude 用户层的 `settings.json`；`codex` `.codex/`；`plugin` 插件自带。
 * - `status`（开放字符串）：`enabled` 会执行；`disabled` 没启用或被停用；`changed` 启用过但内容（含引用的文件）变了，要重新启用；
 *   `unsupported` 处理器种类 Wevir 不执行（`http`、`prompt`、`agent`、`mcp_tool`）。
 * - `engines`：跑在哪些引擎上（Provider 种类，如 `claude`、`codex`）；`['*']` 是全部。事件在某个引擎上没有接点时照样不跑，见
 *   `hook.list` 的 `support`。
 */
export const HookSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  /** Wevir 自己的项目 hooks 有；全局的与仓库文件里的没有。 */
  workspaceId: WorkspaceIdSchema.optional(),
  /** 文件来源：相对项目根（Claude 用户层是 `~/.claude/settings.json` 一类的显示路径），`/` 分隔。 */
  file: z.string().optional(),
  pluginId: z.string().optional(),
  name: z.string().optional(),
  event: z.string().min(1),
  matcher: z.string().optional(),
  /** 处理器种类：`command`、`http`、`prompt`、`agent`、`mcp_tool`；开放字符串。 */
  handler: z.string().min(1),
  command: z.string().optional(),
  timeoutSec: z.int().min(1).optional(),
  onFailure: z.string().optional(),
  engines: z.array(z.string().min(1)),
  status: z.string().min(1),
  /** 内容散列（仓库来源与插件）；内容一改就变。 */
  hash: z.string().optional(),
  /** 仓库来源：命令引用了仓库里的文件，但没有全部纳入散列（太多或太大）。 */
  unhashedFiles: z.literal(true).optional(),
  enabledAt: IsoTimeSchema.optional(),
});
export type Hook = z.infer<typeof HookSchema>;
export type HookStatus = 'enabled' | 'disabled' | 'changed' | 'unsupported';
export type HookSource =
  | 'wevir'
  | 'project'
  | 'claude_project'
  | 'claude_user'
  | 'codex'
  | 'plugin';

/** 一种引擎（Provider 种类）上有接点的事件。 */
export const HookSupportSchema = z.object({
  engine: z.string().min(1),
  events: z.array(z.string().min(1)),
});
export type HookSupport = z.infer<typeof HookSupportSchema>;

/**
 * 一条 hook 的结果（`hook.outcome` 事件）。只记有作用的：`blocked` 拦下了工具调用或这条消息；`continued` 结束前要求 Agent 接着做；
 * `allowed` / `denied` 替用户答了权限请求或放行了工具调用；`context` 给 Agent 附加了上下文；`limit` 结束前的要求已到次数上限、放行；
 * `failed` 命令出错或超时（不拦）。开放字符串。
 */
export const HookOutcomeSchema = z.object({
  /** 起作用的 hook；多条合在一起时是第一条。 */
  hookId: z.string().min(1).optional(),
  source: z.string().optional(),
  event: z.string().min(1),
  action: z.string().min(1),
  turnId: TurnIdSchema.optional(),
  /** 工具类事件：引擎的工具名。 */
  tool: z.string().optional(),
  command: z.string().max(HOOK_OUTCOME_TEXT_MAX_LENGTH).optional(),
  /** 交给 Agent 或显示给用户的理由、上下文或错误。 */
  reason: z.string().max(HOOK_OUTCOME_TEXT_MAX_LENGTH).optional(),
});
export type HookOutcome = z.infer<typeof HookOutcomeSchema>;

// ── hook.* ──────────────────────────────────────────────────────────────

export const HookListParamsSchema = z.object({
  /** 给了列全局的、这个项目的与仓库、插件、Claude 用户层的；省略只列全局的与插件、Claude 用户层的。 */
  workspaceId: WorkspaceIdSchema.optional(),
});

/** Wevir 自己的在前（全局、项目），然后是仓库、Claude 用户层与插件的。读不出的文件不列，原因在 `warnings`。 */
export const HookListResultSchema = z.object({
  hooks: z.array(HookSchema),
  warnings: z.array(z.string()),
  /** 这个 Host 上各引擎有接点的事件。 */
  support: z.array(HookSupportSchema),
});

export const HookAddParamsSchema = z.object({
  /** 省略加全局的。 */
  workspaceId: WorkspaceIdSchema.optional(),
  name: z.string().trim().max(HOOK_NAME_MAX_LENGTH).optional(),
  event: HookEventSchema,
  /** 工具类事件匹配工具名（原生名或别名 `Bash`、`Edit`、`Read`、`mcp__…`），按整串正则；省略或 `*` 匹配全部。 */
  matcher: z.string().trim().max(HOOK_MATCHER_MAX_LENGTH).optional(),
  handler: HookCommandHandlerSchema,
  /** 默认 true。 */
  enabled: z.boolean().optional(),
});

/** matcher 不是合法正则、范围里已满时 `INVALID_PARAMS`。 */
export const HookResultSchema = z.object({
  hook: HookSchema,
});

/** 只能改 Wevir 自己的；没有这条时 `INVALID_PARAMS`。 */
export const HookUpdateParamsSchema = z.object({
  hookId: z.string().min(1),
  /** `null` 去掉名字。 */
  name: z.string().trim().max(HOOK_NAME_MAX_LENGTH).nullable().optional(),
  event: HookEventSchema.optional(),
  /** `null` 去掉 matcher。 */
  matcher: z.string().trim().max(HOOK_MATCHER_MAX_LENGTH).nullable().optional(),
  handler: HookCommandHandlerSchema.optional(),
});

export const HookDeleteParamsSchema = z.object({
  hookId: z.string().min(1),
});

/**
 * 启用或停用一条：Wevir 自己的是开关；仓库来源的启用记下当前内容散列（信任这一版）；插件与 Claude 用户层的是开关。仓库来源要给
 * `workspaceId`。处理器种类不支持时启用回 `INVALID_PARAMS`。
 */
export const HookSetEnabledParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional(),
  hookId: z.string().min(1),
  enabled: z.boolean(),
});
