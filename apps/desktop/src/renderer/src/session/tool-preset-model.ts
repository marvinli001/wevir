// 工具预设（0.61.0，Host 功能 `tool_presets`）的纯逻辑：新会话选的预设带来哪些组、几个 Wevir 工具，`session.create` 带什么。
// 数目来自 Host 的 `tools.presets`（这个 Host 上每组实际有的工具），只是 Wevir 应用级工具；引擎自带的工具与用户接入的 MCP 不在里面。

import type {
  MethodResult,
  ToolGroup,
  ToolGroupInfo,
  ToolPreset,
  ToolPresetId,
} from '@wevir/protocol';

export type ToolPresetsInfo = MethodResult<'tools.presets'>;

export const FULL_PRESET: ToolPreset = { id: 'full' };

function presetGroupsOf(info: ToolPresetsInfo, id: ToolPresetId): readonly ToolGroup[] {
  return info.presets.find((preset) => preset.id === id)?.groups ?? [];
}

/** `core` 之上能另加的组：`full` 有、`core` 没有，而且这个 Host 上有工具的（没有浏览器时不给选浏览器）。 */
export function optionalGroups(info: ToolPresetsInfo): ToolGroupInfo[] {
  const core = presetGroupsOf(info, 'core');
  const full = presetGroupsOf(info, 'full');
  return info.groups.filter(
    (group) => full.includes(group.id) && !core.includes(group.id) && group.tools.length > 0,
  );
}

/** 这个选择带来的组（按 `tools.presets` 的顺序），只列这个 Host 上有工具的。 */
export function presetGroups(choice: ToolPreset, info: ToolPresetsInfo): ToolGroupInfo[] {
  const base = presetGroupsOf(info, choice.id);
  const extra = choice.id === 'core' ? (choice.groups ?? []) : [];
  return info.groups.filter(
    (group) => (base.includes(group.id) || extra.includes(group.id)) && group.tools.length > 0,
  );
}

/** 这个选择给模型几个 Wevir 工具；角色还可能再少一些。 */
export function presetToolCount(choice: ToolPreset, info: ToolPresetsInfo): number {
  return presetGroups(choice, info).reduce((sum, group) => sum + group.tools.length, 0);
}

/** 这个 Host 上一共几个 Wevir 工具（`full`）。 */
export function totalToolCount(info: ToolPresetsInfo): number {
  return presetToolCount(FULL_PRESET, info);
}

/** 选预设：换到 `full` 时丢掉另加的组，换回 `core` 时从空开始。 */
export function choosePreset(id: ToolPresetId): ToolPreset {
  return { id };
}

/** `core` 下勾选或取消一个组；`full` 不变。另加的组按 `tools.presets` 的顺序排。 */
export function toggleGroup(
  choice: ToolPreset,
  group: ToolGroup,
  info: ToolPresetsInfo,
): ToolPreset {
  if (choice.id !== 'core') return choice;
  const current = new Set(choice.groups ?? []);
  if (current.has(group)) current.delete(group);
  else current.add(group);
  const groups = info.groups.map((entry) => entry.id).filter((id) => current.has(id));
  return groups.length === 0 ? { id: 'core' } : { id: 'core', groups };
}

/** `session.create` 的 `toolPreset`：`full` 不带（同不选，会话与以前一样），`core` 带上另加的组。 */
export function createToolPreset(choice: ToolPreset): ToolPreset | undefined {
  if (choice.id === 'full') return undefined;
  return choice.groups !== undefined && choice.groups.length > 0
    ? { id: 'core', groups: [...choice.groups] }
    : { id: 'core' };
}

/** 会话的预设：没有这一项（以前建的会话、旧客户端建的）等同 `full`。 */
export function sessionToolPreset(preset: ToolPreset | undefined): ToolPreset {
  return preset ?? FULL_PRESET;
}
