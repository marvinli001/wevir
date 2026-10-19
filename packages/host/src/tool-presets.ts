// 工具预设：一个会话给模型看哪些 Wevir 应用级工具。按组划分，`full` 是全部（不带预设的会话就是它，与以前逐字节相同），`core` 只留
// 会话协作、模型与角色、任务清单、记忆、展示与交文件，浏览器、LSP、后台进程、插件管理按组另加。
//
// 范围：只管 Host 的 `wevir` MCP 服务（app-mcp.ts）里的工具与它给模型的说明。引擎自带的工具（shell、改文件、子 agent……）、读历史与
// 联网这两个另外的 MCP 服务、用户自己接入的 MCP 连接器都不受预设管。预设也不是权限：角色（roles.ts）是上限，预设只能在它之内再收窄，
// 调用仍在 `tools/call` 检查。

import type { AppTool } from './app-mcp.js';
import { type RoleDefinition, roleAllowsTool } from './roles.js';

/** 工具组，按给模型看的顺序。 */
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
export type ToolGroup = (typeof TOOL_GROUPS)[number];

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

export const TOOL_PRESET_IDS = ['full', 'core'] as const;
export type ToolPresetId = (typeof TOOL_PRESET_IDS)[number];

/** 会话的工具预设。`groups` 只对 `core` 有意义：在它之上另加的组。 */
export interface ToolPreset {
  id: ToolPresetId;
  groups?: ToolGroup[];
}

/** 按名字前缀归组（先比完整名字，再比前缀）。 */
const EXACT: Readonly<Record<string, ToolGroup>> = {
  wevir_models: 'catalog',
  wevir_roles: 'catalog',
  wevir_tasks: 'tasks',
  wevir_show: 'workbench',
  wevir_share_file: 'workbench',
  wevir_plugins_list: 'plugins',
  wevir_plugin_install: 'plugins',
  wevir_skill_install: 'plugins',
  wevir_connector_add: 'plugins',
};
const PREFIXES: ReadonlyArray<readonly [string, ToolGroup]> = [
  ['wevir_session_', 'sessions'],
  ['wevir_task_', 'tasks'],
  ['wevir_memory_', 'memory'],
  ['wevir_process_', 'processes'],
  ['lsp_', 'lsp'],
  ['browser_', 'browser'],
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
 * 按预设裁剪给模型的说明（app-tools.ts 的 `APP_TOOLS_INSTRUCTIONS`）：去掉讲预设里没有的组的那几行（以 `- <工具名>` 开头、能归到组的
 * 行）。别的行原样留下；`full` 与没有预设时原样返回。
 */
export function toolPresetInstructions(base: string, preset: ToolPreset | undefined): string {
  const groups = toolPresetGroups(preset);
  if (groups === undefined) return base;
  return base
    .split('\n')
    .filter((line) => {
      const group = instructionLineGroup(line);
      return group === undefined || groups.has(group);
    })
    .join('\n');
}

/** 说明里这一行讲的是哪个组的工具（`- wevir_process_*: …`、`- lsp_*: …`）；不是讲工具的行是 `undefined`。 */
export function instructionLineGroup(line: string): ToolGroup | undefined {
  const token = /^- ([a-z][a-z_]*)\*?[\s:/]/.exec(line)?.[1];
  return token === undefined ? undefined : toolGroupOf(token);
}

/** 预设清单：每个组在这个 Host 上实际有哪些工具（没有浏览器、LSP 等时对应的组是空的）。 */
export function toolGroupContents(
  tools: readonly Pick<AppTool, 'name'>[],
): Array<{ id: ToolGroup; core: boolean; tools: string[] }> {
  return TOOL_GROUPS.map((id) => ({
    id,
    core: CORE_TOOL_GROUPS.includes(id),
    tools: tools.filter((tool) => toolGroupOf(tool.name) === id).map((tool) => tool.name),
  }));
}
