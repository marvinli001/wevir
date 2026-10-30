// 工具预设：一个会话给模型看哪些 Wevir 应用级工具。按组划分，`full` 是全部（不带预设的会话就是它，与以前逐字节相同），`core` 只留
// 会话协作、模型与角色、任务清单、记忆、展示与交文件，浏览器、LSP、后台进程、插件管理（0.136.0 起也含配置 Wevir 本身）按组另加。
//
// 范围：只管 Host 的 `wevir` MCP 服务（app-mcp.ts）里的工具与它给模型的说明。引擎自带的工具（shell、改文件、子 agent……）、读历史与
// 联网这两个另外的 MCP 服务、用户自己接入的 MCP 连接器都不受预设管。预设也不是权限：角色（roles.ts）是上限，预设只能在它之内再收窄，
// 调用仍在 `tools/call` 检查。

import {
  TOOL_GROUPS,
  type ToolGroup,
  type ToolGroupInfo,
  type ToolPreset,
  type ToolPresetInfo,
} from '@wevir/protocol';
import type { AppToolTier } from '@wevir/runtime-adapter';
import type { AppTool } from './app-mcp.js';
import { type RoleDefinition, roleAllowsTool } from './roles.js';

export { TOOL_GROUPS, type ToolGroup, type ToolPreset };

/** `core` 总带的组。 */
export const CORE_TOOL_GROUPS: readonly ToolGroup[] = [
  'sessions',
  'catalog',
  'tasks',
  'memory',
  'workbench',
];

/** 在 `core` 之上可以另加的组。 */
export const OPTIONAL_TOOL_GROUPS: readonly ToolGroup[] = TOOL_GROUPS.filter(
  (group) => !CORE_TOOL_GROUPS.includes(group),
);

/** 按名字前缀归组（先比完整名字，再比前缀）。 */
const EXACT: Readonly<Record<string, ToolGroup>> = {
  wevir_models: 'catalog',
  wevir_roles: 'catalog',
  wevir_tasks: 'tasks',
  wevir_show: 'workbench',
  wevir_share_file: 'workbench',
  wevir_image_generate: 'workbench',
  wevir_notify: 'workbench',
  wevir_mark_chapter: 'workbench',
  wevir_wrap_up: 'workbench',
  wevir_report_findings: 'workbench',
  wevir_plugins_list: 'plugins',
  wevir_plugins_browse: 'plugins',
  wevir_plugins_manage: 'plugins',
  wevir_plugin_install: 'plugins',
  wevir_skill_install: 'plugins',
  wevir_connector_add: 'plugins',
  wevir_automations: 'sessions',
  wevir_workspace_readiness: 'processes',
  wevir_second_opinion: 'sessions',
};
const PREFIXES: ReadonlyArray<readonly [string, ToolGroup]> = [
  ['wevir_session_', 'sessions'],
  // 配置 Wevir 本身（0.136.0，config-tools.ts）同插件管理一组。
  ['wevir_config_', 'plugins'],
  ['wevir_automation_', 'sessions'],
  ['wevir_channel_', 'sessions'],
  ['wevir_task_', 'tasks'],
  ['wevir_memory_', 'memory'],
  ['wevir_writing_style_', 'memory'],
  ['wevir_tuning_', 'memory'],
  ['wevir_process_', 'processes'],
  ['wevir_preview_', 'processes'],
  // 插件管理（说明里写作 `wevir_plugin*`）。
  ['wevir_plugin', 'plugins'],
  ['lsp_', 'lsp'],
  ['browser_', 'browser'],
  // 电脑操作（0.114.0）同属界面操作，归在浏览器一组。
  ['computer_', 'browser'],
  // iOS 模拟器（0.122.0）也是界面操作。
  ['simulator_', 'browser'],
];

/** 应用级工具所在的组；认不出的名字（新加了工具却没归组）是 `undefined`，只有 `full` 里有它。 */
export function toolGroupOf(name: string): ToolGroup | undefined {
  const exact = EXACT[name];
  if (exact !== undefined) return exact;
  return PREFIXES.find(([prefix]) => name.startsWith(prefix))?.[1];
}

/**
 * 规范的写法：`full` 不带组；`core` 的组去重、去掉本来就有的、按 `TOOL_GROUPS` 排序，没有另加的组时省略 `groups`。存储与事件都用
 * 它，同样的选择写出来一样。
 */
export function normalizeToolPreset(preset: ToolPreset): ToolPreset {
  if (preset.id === 'full') return { id: 'full' };
  const extra = OPTIONAL_TOOL_GROUPS.filter((group) => preset.groups?.includes(group) === true);
  return extra.length === 0 ? { id: 'core' } : { id: 'core', groups: extra };
}

/** 预设带的组；`full` 与没有预设时是 `undefined`（不限，包括认不出组的工具）。 */
export function toolPresetGroups(
  preset: ToolPreset | undefined,
): ReadonlySet<ToolGroup> | undefined {
  if (preset === undefined || preset.id === 'full') return undefined;
  return new Set([...CORE_TOOL_GROUPS, ...(normalizeToolPreset(preset).groups ?? [])]);
}

/** 预设留不留这个工具。 */
export function presetAllowsTool(preset: ToolPreset | undefined, name: string): boolean {
  const groups = toolPresetGroups(preset);
  if (groups === undefined) return true;
  const group = toolGroupOf(name);
  return group !== undefined && groups.has(group);
}

/** 角色与预设都留下的工具：角色是上限，预设只能再收窄。两者都没有时原样返回。 */
export function toolsAllowed<T extends Pick<AppTool, 'name' | 'annotations'>>(
  tools: readonly T[],
  limits: {
    role?: Pick<RoleDefinition, 'tools' | 'disallowedTools'> | undefined;
    preset?: ToolPreset | undefined;
  },
): readonly T[] {
  const { role, preset } = limits;
  if (role === undefined && toolPresetGroups(preset) === undefined) return tools;
  return tools.filter((tool) => roleAllowsTool(role, tool) && presetAllowsTool(preset, tool.name));
}

/**
 * 按这个会话实际列出的工具裁剪给模型的说明（app-tools.ts 的 `APP_TOOLS_INSTRUCTIONS`）：讲工具的行只在它讲的工具至少有一个列出时
 * 留下，所以预设、角色、频道与 Host 设置去掉的工具（电脑操作关着时的 `computer_*`）不再出现在说明里。别的行原样留下。
 */
export function listedToolInstructions(base: string, listed: Iterable<string>): string {
  const names = [...listed];
  return base
    .split('\n')
    .filter((line) => {
      const tools = instructionLineTools(line);
      return (
        tools === undefined ||
        tools.some((tool) =>
          tool.endsWith('*')
            ? names.some((name) => name.startsWith(tool.slice(0, -1)))
            : names.includes(tool),
        )
      );
    })
    .join('\n');
}

/**
 * 说明里这一行讲的工具：`- wevir_session_send / wevir_session_wait: …`、`- lsp_*: …` 冒号前用 “ / ” 分开的名字（`*` 结尾的是前缀）；
 * 不是讲工具的行是 `undefined`。
 */
export function instructionLineTools(line: string): string[] | undefined {
  const head = /^- ([a-z][a-z_]*\*?(?: \/ [a-z][a-z_]*\*?)*):/.exec(line)?.[1];
  return head?.split(' / ');
}

/**
 * 常驻的核心工具：模型在还不知道要用它时就需要的（会话连续性、多会话协作、记忆、交付），以及不给就会被 shell 绕过去的后台进程。
 * 其余按需：支持工具搜索的引擎延迟加载它们（Codex 的 `tool_search`、Claude 的 ToolSearch），首个请求里只有核心工具。分层不是
 * 权限：角色、预设与设置去掉的工具照样不列、不能调。
 */
export const CORE_TIER_TOOLS: readonly string[] = [
  'wevir_session_list',
  'wevir_session_read',
  'wevir_session_search',
  'wevir_session_retro',
  'wevir_session_create',
  'wevir_session_send',
  'wevir_session_wait',
  'wevir_tasks',
  'wevir_task_create',
  'wevir_task_update',
  'wevir_memory_list',
  'wevir_memory_read',
  'wevir_memory_save',
  'wevir_show',
  'wevir_share_file',
  'wevir_image_generate',
  'wevir_wrap_up',
  'wevir_process_start',
  'wevir_process_output',
];

/**
 * 应用级工具的层：核心名单里的常驻；频道工具也常驻（只列给频道里的会话，它们的说明靠这些工具）。归得到组的其余工具按需；认不
 * 出组的（新加了工具却没归组）是 `undefined`，当作按需。
 */
export function toolTier(name: string): AppToolTier | undefined {
  if (CORE_TIER_TOOLS.includes(name) || name.startsWith('wevir_channel_')) return 'core';
  return toolGroupOf(name) === undefined ? undefined : 'more';
}

/** 每个组在这个 Host 上实际有哪些工具（没有浏览器、LSP 等时对应的组是空的）。 */
export function toolGroupContents(
  tools: readonly Pick<AppTool, 'name'>[],
): Array<ToolGroupInfo & { core: boolean }> {
  return TOOL_GROUPS.map((id) => ({
    id,
    core: CORE_TOOL_GROUPS.includes(id),
    tools: tools.filter((tool) => toolGroupOf(tool.name) === id).map((tool) => tool.name),
  }));
}

/** `tools.presets` 的结果：两个预设各自总带的组，与每个组的工具。 */
export function toolPresetsInfo(tools: readonly Pick<AppTool, 'name'>[]): {
  presets: ToolPresetInfo[];
  groups: ToolGroupInfo[];
} {
  return {
    presets: [
      { id: 'full', groups: [...TOOL_GROUPS] },
      { id: 'core', groups: [...CORE_TOOL_GROUPS] },
    ],
    groups: toolGroupContents(tools).map(({ id, tools }) => ({ id, tools })),
  };
}
