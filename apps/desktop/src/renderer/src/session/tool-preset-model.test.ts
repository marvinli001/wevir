import { describe, expect, it } from 'vitest';
import {
  availablePreset,
  createToolPreset,
  FULL_PRESET,
  optionalGroups,
  parseStoredPreset,
  presetGroups,
  presetToolCount,
  sessionToolPreset,
  type ToolPresetsInfo,
  toggleGroup,
  totalToolCount,
} from './tool-preset-model';

const names = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);

/** 同 wevir-host 的清单，只是这个 Host 没有浏览器（组是空的）。 */
const info: ToolPresetsInfo = {
  presets: [
    {
      id: 'full',
      groups: [
        'sessions',
        'catalog',
        'tasks',
        'memory',
        'workbench',
        'browser',
        'lsp',
        'processes',
        'plugins',
      ],
    },
    { id: 'core', groups: ['sessions', 'catalog', 'tasks', 'memory', 'workbench'] },
  ],
  groups: [
    { id: 'sessions', tools: names('wevir_session_', 9) },
    { id: 'catalog', tools: ['wevir_models', 'wevir_roles'] },
    { id: 'tasks', tools: names('wevir_task_', 3) },
    { id: 'memory', tools: names('wevir_memory_', 4) },
    { id: 'workbench', tools: ['wevir_show', 'wevir_share_file'] },
    { id: 'browser', tools: [] },
    { id: 'lsp', tools: names('lsp_', 7) },
    { id: 'processes', tools: names('wevir_process_', 6) },
    { id: 'plugins', tools: names('wevir_plugin_', 4) },
  ],
};

describe('工具预设的选择', () => {
  it('可另加的组：core 没有、这个 Host 上有工具的', () => {
    expect(optionalGroups(info).map((group) => group.id)).toEqual(['lsp', 'processes', 'plugins']);
  });

  it('各个选择带来的组与工具数', () => {
    expect(totalToolCount(info)).toBe(37);
    expect(presetToolCount(FULL_PRESET, info)).toBe(37);
    expect(presetToolCount({ id: 'core' }, info)).toBe(20);
    expect(presetGroups({ id: 'core', groups: ['lsp'] }, info).map((group) => group.id)).toEqual([
      'sessions',
      'catalog',
      'tasks',
      'memory',
      'workbench',
      'lsp',
    ]);
    expect(presetToolCount({ id: 'core', groups: ['lsp', 'plugins'] }, info)).toBe(31);
    // full 不看另加的组；空的组不列。
    expect(presetGroups({ id: 'full', groups: ['lsp'] }, info)).toHaveLength(8);
  });

  it('勾选与取消：按清单的顺序，取消完了回到不带组；full 不变', () => {
    let choice = toggleGroup({ id: 'core' }, 'plugins', info);
    choice = toggleGroup(choice, 'lsp', info);
    expect(choice).toEqual({ id: 'core', groups: ['lsp', 'plugins'] });
    choice = toggleGroup(toggleGroup(choice, 'lsp', info), 'plugins', info);
    expect(choice).toEqual({ id: 'core' });
    expect(toggleGroup(FULL_PRESET, 'lsp', info)).toBe(FULL_PRESET);
  });

  it('session.create 带什么：full 不带，core 带另加的组', () => {
    expect(createToolPreset(FULL_PRESET)).toBeUndefined();
    expect(createToolPreset({ id: 'core' })).toEqual({ id: 'core' });
    expect(createToolPreset({ id: 'core', groups: [] })).toEqual({ id: 'core' });
    expect(createToolPreset({ id: 'core', groups: ['lsp'] })).toEqual({
      id: 'core',
      groups: ['lsp'],
    });
  });

  it('会话没有这一项时是 full', () => {
    expect(sessionToolPreset(undefined)).toEqual(FULL_PRESET);
    expect(sessionToolPreset({ id: 'core' })).toEqual({ id: 'core' });
  });

  it('记下的上次选择：认不出的写法当没记过，认不出的组丢掉；放到这个 Host 上只留能选的组', () => {
    expect(parseStoredPreset({ id: 'full', groups: ['lsp'] })).toEqual(FULL_PRESET);
    expect(parseStoredPreset({ id: 'core' })).toEqual({ id: 'core' });
    expect(parseStoredPreset({ id: 'core', groups: ['plugins', 'terminal', 'lsp'] })).toEqual({
      id: 'core',
      groups: ['lsp', 'plugins'],
    });
    expect(parseStoredPreset({ id: 'minimal' })).toBeUndefined();
    expect(parseStoredPreset('core')).toBeUndefined();
    // 这个 Host 没有浏览器：记下的浏览器去掉，别的留着。
    const stored = { id: 'core' as const, groups: ['browser' as const, 'lsp' as const] };
    expect(availablePreset(stored, info)).toEqual({ id: 'core', groups: ['lsp'] });
    expect(availablePreset({ id: 'core', groups: ['browser'] }, info)).toEqual({ id: 'core' });
    const kept = { id: 'core' as const, groups: ['lsp' as const] };
    expect(availablePreset(kept, info)).toBe(kept);
    expect(availablePreset(FULL_PRESET, info)).toBe(FULL_PRESET);
  });
});
