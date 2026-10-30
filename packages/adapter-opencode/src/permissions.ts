// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-opencode/src/server/adapter.ts（`openCodePermissionRules`、`openCodeChildPermissionRules`、
// `openCodePermissionRequestKind`）与 OpenCodeRuntime.ts（`buildOpenCodePermissionRules`、`toOpenCodePermissionReply`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8；换权限模式时重算子会话规则（`subagentOwnRules`）参照
// 8031991591e22d76830e4acf6358c4fd78ffcf60
// Copyright (c) 2026 T3 Tools Inc.
// 修改：T3 的 runtimePolicy（沙箱类型 + 审批策略）换成 Wevir 的三种权限模式；去掉给子会话继承的 deny 前缀，改由服务器的权限配置
// 兜住子会话的第一步（见下）；放行只读的 list；环境会话的额外目录放行 external_directory；审批选项照 adapter-codex 的四个，
// “拒绝并继续”带一句反馈让 opencode 接着做。
//
// 权限（opencode-event-mapping.md §4）。OpenCode 没有操作系统沙箱，会话的规则集就是边界：规则按顺序匹配、最后一条命中的生效
// （opencode 的 `Permission.evaluate` 用 findLast），`ask` 的经 `permission.asked` 问用户。Wevir 的三种模式：
// - `on_request`：读、搜索、列目录、清单、子 agent、提问放行，命令、改文件、联网、项目目录外与死循环检测都问，读 .env 也问；
// - `auto_review`：同 `on_request`。OpenCode 没有替用户审查的模型（T3：没有 AI 审查的引擎在 auto 下退回到询问）；
// - `full_access`：全部放行。
//
// 子 agent（task 工具）的会话是 opencode 自己建的，只继承父会话的 deny 与 external_directory 规则（deriveSubagentSessionPermission），
// 适配器在 `session.created` 时再给它装上父会话的完整规则（childPermissionRules），换权限模式时按 subagentOwnRules 重算。装上之前的那一小段（opencode 在步开始时取
// 规则，所以是子会话的第一步）子会话按 agent 的默认权限走，默认是全部放行。T3 为此在父会话的规则前面先写一串 deny 让子会话
// 继承，可这也让子会话第一步一个工具都看不到（opencode 把最后命中 `*` 的 deny 的工具整个藏起来），真实的 opencode 上子 agent
// 因此什么都不做就答完了。Wevir 改为给自己起的服务器加一层配置（SERVER_PERMISSION_CONFIG，经 OPENCODE_CONFIG_CONTENT）：
// 命令、改文件与联网对所有 agent 都是 ask，子会话在那一步里照样能用工具、越界的照样问；会话自己的规则仍然盖过它。

import type { ApprovalOption, EngineToolClass, PermissionMode } from '@wevir/runtime-adapter';
import { isAppToolsPlugin, type OpenCodePluginEntry } from './app-tools.js';
import type { PermissionRule, PermissionRuleset } from './sdk.js';

export const PERMISSION_MODES: readonly PermissionMode[] = Object.freeze([
  'on_request',
  'auto_review',
  'full_access',
]);

/** 不问就放行的权限（T3 的 OPENCODE_ALWAYS_ALLOWED_PERMISSIONS，加上只读的 list）。 */
export const ALWAYS_ALLOWED_PERMISSIONS: readonly string[] = Object.freeze([
  'question',
  'read',
  'glob',
  'grep',
  'list',
  'lsp',
  'todowrite',
  'task',
  'skill',
]);

/** 要问的权限（T3 的 OPENCODE_RESTRICTED_PERMISSIONS）。 */
export const RESTRICTED_PERMISSIONS: readonly string[] = Object.freeze([
  'bash',
  'edit',
  'webfetch',
  'websearch',
  'codesearch',
  'external_directory',
  'doom_loop',
]);

/** 引擎工具的类别 → OpenCode 的权限名（`edit` 也管 write 与 patch）。 */
const ENGINE_TOOL_PERMISSIONS: Readonly<Record<EngineToolClass, readonly string[]>> = {
  read: ['read', 'glob', 'grep', 'list', 'lsp'],
  edit: ['edit'],
  shell: ['bash'],
  web: ['webfetch', 'websearch', 'codesearch'],
};

/**
 * 角色关掉的引擎工具（`SessionConfig.engineTools`）：每一类的权限都写成 deny，接在模式的规则后面（最后命中的生效），完全访问也
 * 盖不过它。opencode 把最后命中 `*` 的 deny 的工具整个藏起来，模型看不到。
 */
export function engineToolRules(denied: readonly EngineToolClass[]): PermissionRuleset {
  return denied.flatMap((kind) =>
    ENGINE_TOOL_PERMISSIONS[kind].map((permission) => ({
      permission,
      pattern: '*',
      action: 'deny' as const,
    })),
  );
}

/**
 * 会话的规则集（T3 的 `openCodePermissionRules` / `buildOpenCodePermissionRules`，去掉了给子会话继承的 deny 前缀，见文件头）。
 * `additionalRoots`：环境会话的其他文件夹，放行进入（external_directory），改文件照样按模式问。
 */
export function permissionRules(
  mode: PermissionMode | undefined,
  additionalRoots: readonly string[] = [],
): PermissionRuleset {
  if (mode === 'full_access') {
    return [
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'allow' },
    ];
  }
  const rules: PermissionRule[] = [
    { permission: '*', pattern: '*', action: 'ask' },
    ...RESTRICTED_PERMISSIONS.map(
      (permission): PermissionRule => ({ permission, pattern: '*', action: 'ask' }),
    ),
    ...ALWAYS_ALLOWED_PERMISSIONS.map(
      (permission): PermissionRule => ({ permission, pattern: '*', action: 'allow' }),
    ),
    { permission: 'read', pattern: '*.env', action: 'ask' },
    { permission: 'read', pattern: '*.env.*', action: 'ask' },
    { permission: 'read', pattern: '*.env.example', action: 'allow' },
  ];
  for (const root of additionalRoots) {
    const trimmed = root.trim().replace(/[/\\]+$/, '');
    if (trimmed === '') continue;
    rules.push({ permission: 'external_directory', pattern: `${trimmed}/*`, action: 'allow' });
  }
  return rules;
}

/**
 * Wevir 起的 opencode 服务器的权限配置（opencode 配置的 `permission`，排在每个 agent 自己的权限之后）：命令、改文件与联网对所有
 * agent 都先问。只在子会话装上完整规则之前起作用（会话规则排在它之后）。项目目录外与死循环检测 opencode 的默认就是 ask。
 */
export const SERVER_PERMISSION_CONFIG: Readonly<Record<string, 'ask'>> = Object.freeze({
  bash: 'ask',
  edit: 'ask',
  webfetch: 'ask',
  websearch: 'ask',
  codesearch: 'ask',
});

/**
 * 交给服务器的 `OPENCODE_CONFIG_CONTENT`：用户自己设了的照留（T3：不能盖掉用户的配置），只把 SERVER_PERMISSION_CONFIG 并进它的
 * `permission`，有应用级工具时把那个插件（app-tools.ts）加到 `plugin` 的最后（去掉以前的）。用户的值不是 JSON 对象时原样交出
 * （opencode 自己会报错）。
 */
export function serverConfigContent(
  existing: string | undefined,
  appToolsPlugin?: OpenCodePluginEntry,
): string {
  let parsed: unknown = {};
  if (existing !== undefined && existing.trim() !== '') {
    try {
      parsed = JSON.parse(existing);
    } catch {
      return existing;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return existing ?? '{}';
  }
  const config = parsed as Record<string, unknown>;
  const permission =
    typeof config.permission === 'object' &&
    config.permission !== null &&
    !Array.isArray(config.permission)
      ? (config.permission as Record<string, unknown>)
      : typeof config.permission === 'string'
        ? { '*': config.permission }
        : {};
  const plugins = Array.isArray(config.plugin)
    ? config.plugin.filter((entry) => !isAppToolsPlugin(entry))
    : [];
  return JSON.stringify({
    ...config,
    permission: { ...permission, ...SERVER_PERMISSION_CONFIG },
    ...(appToolsPlugin !== undefined
      ? { plugin: [...plugins, appToolsPlugin] }
      : config.plugin !== undefined && { plugin: plugins }),
  });
}

function sameRule(left: PermissionRule, right: PermissionRule): boolean {
  return (
    left.permission === right.permission &&
    left.pattern === right.pattern &&
    left.action === right.action
  );
}

/**
 * 子会话的规则集（T3 的 `openCodeChildPermissionRules`）：opencode 给 task 子会话的规则只有父会话的 deny 与 external_directory，
 * 外加子 agent 自己的限制（例如不许再派子 agent）。装上父会话完整的规则，再留下子 agent 特有的那几条。
 */
export function childPermissionRules(
  parentRules: PermissionRuleset,
  nativeChildRules: PermissionRuleset,
): PermissionRuleset {
  return [...parentRules, ...subagentOwnRules(parentRules, nativeChildRules)];
}

/**
 * opencode 给子会话的规则里子 agent 自己的那几条：去掉建它时从父会话继承来的 deny 与 external_directory。换权限模式时子会话的
 * 规则按它重算（T3 记下上次写进子会话的父会话规则 inheritedPermission 来去掉旧的）：否则旧模式继承来的规则会留在新规则后面。
 */
export function subagentOwnRules(
  parentRules: PermissionRuleset,
  nativeChildRules: PermissionRuleset,
): PermissionRuleset {
  const inherited = parentRules.filter(
    (rule) => rule.permission === 'external_directory' || rule.action === 'deny',
  );
  return nativeChildRules.filter(
    (rule) => !inherited.some((candidate) => sameRule(rule, candidate)),
  );
}

/**
 * 生成标题的临时会话（title.ts）的规则：什么工具都不给（T3 的 textGeneration.ts 同样全部 deny），只留 `format: json_schema` 时
 * opencode 加上的 StructuredOutput——opencode 按规则过滤工具时不区分它，全部 deny 会把它也藏掉，模型就交不出结构化结果。
 */
export const TITLE_PERMISSION_RULES: PermissionRuleset = Object.freeze([
  { permission: '*', pattern: '*', action: 'deny' },
  { permission: 'StructuredOutput', pattern: '*', action: 'allow' },
]) as PermissionRuleset;

/** 审批选项：照 adapter-codex 的四个；`kind` 以 `allow_` / `reject_` 开头决定批准与否。 */
export const APPROVAL_OPTIONS: readonly ApprovalOption[] = Object.freeze([
  { optionId: 'accept', label: '允许', kind: 'allow_accept' },
  { optionId: 'acceptForSession', label: '允许，本会话不再询问', kind: 'allow_accept_for_session' },
  { optionId: 'decline', label: '拒绝并继续', kind: 'reject_decline' },
  { optionId: 'cancel', label: '拒绝并停止', kind: 'reject_cancel' },
]);

/** 拒绝并继续时给模型的反馈（opencode 收到带 message 的 reject 记成 CorrectedError，工具失败、回合接着做）。 */
export const DECLINE_FEEDBACK = 'The user declined this action. Continue without it.';

/**
 * 审批的决定 → `permission.reply`（T3 的 `toOpenCodePermissionReply`）：
 * - 允许 → `once`；
 * - 本会话不再询问 → `always`：opencode 把请求带的 `always` 模式记进这个目录实例的已批准列表（只在内存里，opencode 服务器
 *   重启就没了，不写用户的配置）；
 * - 拒绝并继续 → `reject` 带反馈；
 * - 拒绝并停止 → `reject` 不带反馈：opencode 记成 RejectedError，停下这个会话的循环（同一会话里别的未决请求一并拒绝）。
 */
export function permissionReply(
  optionId: string,
): { reply: 'once' | 'always' | 'reject'; message?: string } | undefined {
  switch (optionId) {
    case 'accept':
      return { reply: 'once' };
    case 'acceptForSession':
      return { reply: 'always' };
    case 'decline':
      return { reply: 'reject', message: DECLINE_FEEDBACK };
    case 'cancel':
      return { reply: 'reject' };
    default:
      return undefined;
  }
}
