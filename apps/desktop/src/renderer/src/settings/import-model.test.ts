import type { ImportScanResult } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  applyItems,
  checkedCount,
  groupCheck,
  hasRenameErrors,
  initialSelection,
  needsValues,
  reasonLabel,
  renameError,
  rowState,
  selectable,
  setGroup,
  summarize,
  updateRow,
} from './import-model';

/** 取第几个（测试数据里一定有）。 */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`没有第 ${index} 个`);
  return item;
}

const base = { path: '/home/u/.claude/x', recommended: true } as const;

function scan(): ImportScanResult {
  return {
    app: 'claude',
    found: true,
    home: '/home/u/.claude',
    memories: [
      {
        ...base,
        key: 'm-new',
        status: 'new',
        name: 'style',
        type: 'feedback',
        description: 'Style',
        content: 'Short.',
        scope: 'global',
      },
      {
        ...base,
        key: 'm-project',
        status: 'new',
        recommended: false,
        name: 'stack',
        type: 'project',
        description: 'Stack',
        content: 'TS',
        scope: 'project',
        workspaceId: 'ws_a',
        project: '/code/a',
      },
      {
        ...base,
        key: 'm-exists',
        status: 'exists',
        name: 'style',
        type: 'user',
        description: 'Other',
        content: 'x',
        scope: 'global',
      },
      {
        ...base,
        key: 'm-same',
        status: 'same',
        name: 'done',
        type: 'user',
        description: 'Done',
        content: 'x',
        scope: 'global',
      },
      {
        ...base,
        key: 'm-big',
        status: 'new',
        problem: 'too_large',
        name: 'big',
        type: 'user',
        description: 'Big',
        content: 'x',
        scope: 'global',
      },
    ],
    connectors: [
      {
        ...base,
        key: 'c-new',
        status: 'new',
        name: 'github',
        config: { transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: true } },
        workspaceId: 'ws_b',
      },
      {
        ...base,
        key: 'c-exists',
        status: 'exists',
        name: 'linear',
        config: { transport: 'http', url: 'https://mcp.linear.app/mcp' },
      },
    ],
    skills: [
      { ...base, key: 's-new', status: 'new', name: 'pdf', description: 'PDF' },
      { ...base, key: 's-exists', status: 'exists', name: 'docx', description: 'Docx' },
    ],
    unsupported: [],
  };
}

describe('能不能勾', () => {
  it('有问题的、已导入的、已存在的 Skill 不能勾', () => {
    const result = scan();
    expect(selectable('memory', nth(result.memories, 4))).toBe(false);
    expect(selectable('memory', nth(result.memories, 3))).toBe(false);
    expect(selectable('memory', nth(result.memories, 2))).toBe(true);
    expect(selectable('skill', nth(result.skills, 1))).toBe(false);
    expect(selectable('skill', nth(result.skills, 0))).toBe(true);
  });
});

describe('初始状态', () => {
  it('建议的、能勾、不用改名的默认勾上，目标取扫描的建议', () => {
    const selection = initialSelection(scan());
    expect(rowState(selection, 'm-new')).toEqual({ checked: true, target: 'global', rename: '' });
    expect(rowState(selection, 'm-project')).toEqual({
      checked: false,
      target: 'ws_a',
      rename: '',
    });
    expect(rowState(selection, 'm-exists').checked).toBe(false);
    expect(rowState(selection, 'm-same').checked).toBe(false);
    expect(rowState(selection, 'm-big').checked).toBe(false);
    expect(rowState(selection, 'c-new')).toMatchObject({ checked: true, target: 'ws_b' });
    expect(rowState(selection, 'c-exists')).toMatchObject({ checked: false, target: 'global' });
    expect(rowState(selection, 's-new').checked).toBe(true);
    expect(checkedCount(scan(), selection)).toBe(3);
  });

  it('项目范围但没对上项目的记忆按全局', () => {
    const result = scan();
    const { workspaceId: _, ...memory } = nth(result.memories, 1);
    result.memories[1] = memory;
    expect(rowState(initialSelection(result), 'm-project').target).toBe('global');
  });
});

describe('全选', () => {
  it('只动能勾的，按勾选数给出全选框状态', () => {
    const result = scan();
    let selection = initialSelection(result);
    expect(groupCheck('memory', result.memories, selection)).toBe('some');
    selection = setGroup('memory', result.memories, selection, true);
    expect(groupCheck('memory', result.memories, selection)).toBe('all');
    expect(rowState(selection, 'm-same').checked).toBe(false);
    expect(rowState(selection, 'm-big').checked).toBe(false);
    selection = setGroup('memory', result.memories, selection, false);
    expect(groupCheck('memory', result.memories, selection)).toBe('none');
    expect(groupCheck('skill', [nth(result.skills, 1)], selection)).toBe('none');
  });
});

describe('改名', () => {
  const result = scan();
  const exists = nth(result.memories, 2);
  const state = { checked: true, target: 'global', rename: '' };

  it('已存在的勾上时要填新名字', () => {
    expect(renameError('memory', exists, state)).toBe('required');
    expect(renameError('memory', exists, { ...state, checked: false })).toBeUndefined();
    expect(renameError('memory', nth(result.memories, 0), state)).toBeUndefined();
  });

  it('记忆按记忆的命名规则', () => {
    expect(renameError('memory', exists, { ...state, rename: 'style-2' })).toBeUndefined();
    expect(renameError('memory', exists, { ...state, rename: ' style-2 ' })).toBeUndefined();
    expect(renameError('memory', exists, { ...state, rename: 'Style_2' })).toBe('invalid');
    expect(renameError('memory', exists, { ...state, rename: '-x' })).toBe('invalid');
    expect(renameError('memory', exists, { ...state, rename: 'style' })).toBe('unchanged');
  });

  it('连接器按连接器的命名规则，不能以 wevir 开头', () => {
    const connector = nth(result.connectors, 1);
    expect(renameError('connector', connector, { ...state, rename: 'linear_2' })).toBeUndefined();
    expect(renameError('connector', connector, { ...state, rename: 'Linear' })).toBe('invalid');
    expect(renameError('connector', connector, { ...state, rename: 'wevir-x' })).toBe('reserved');
  });

  it('勾上的条目有改名错误时不能提交', () => {
    let selection = updateRow(initialSelection(result), 'm-exists', { checked: true });
    expect(hasRenameErrors(result, selection)).toBe(true);
    selection = updateRow(selection, 'm-exists', { rename: 'style-2' });
    expect(hasRenameErrors(result, selection)).toBe(false);
  });
});

describe('import.apply 的参数', () => {
  it('记忆写明范围，连接器全局写 scope、项目带 workspaceId，Skills 只有 key', () => {
    const result = scan();
    let selection = initialSelection(result);
    selection = updateRow(selection, 'm-project', { checked: true, target: 'ws_c' });
    selection = updateRow(selection, 'm-exists', { checked: true, rename: ' style-2 ' });
    selection = updateRow(selection, 'c-exists', { checked: true, rename: 'linear-2' });
    // 勾不上的条目即使状态里勾着也不提交。
    selection = updateRow(selection, 'm-same', { checked: true });
    selection = updateRow(selection, 's-exists', { checked: true, rename: 'x' });
    expect(applyItems(result, selection)).toEqual([
      { key: 'm-new', scope: 'global' },
      { key: 'm-project', scope: 'project', workspaceId: 'ws_c' },
      { key: 'm-exists', scope: 'global', name: 'style-2' },
      { key: 'c-new', workspaceId: 'ws_b' },
      { key: 'c-exists', scope: 'global', name: 'linear-2' },
      { key: 's-new' },
    ]);
  });
});

describe('结果汇总', () => {
  it('按结局计数，失败的带名字与原因', () => {
    const summary = summarize(
      {
        results: [
          { key: 'm-new', outcome: 'imported', kind: 'memory', name: 'style' },
          { key: 's-new', outcome: 'skipped' },
          { key: 'm-exists', outcome: 'failed', reason: 'exists' },
          { key: 'c-new', outcome: 'failed', kind: 'connector', name: 'gh', reason: 'odd' },
          { key: 'gone', outcome: 'failed' },
        ],
      },
      scan(),
    );
    expect(summary).toEqual({
      imported: 1,
      skipped: 1,
      failed: [
        { key: 'm-exists', kind: 'memory', name: 'style', reason: 'exists' },
        { key: 'c-new', kind: 'connector', name: 'gh', reason: 'odd' },
        { key: 'gone', name: 'gone' },
      ],
    });
  });

  it('认得的原因有文案，不认得的没有', () => {
    expect(reasonLabel('limit')).toBe('settings.import.reason.limit');
    expect(reasonLabel('looks_secret')).toBe('settings.import.reason.looksSecret');
    expect(reasonLabel('odd')).toBeUndefined();
    expect(reasonLabel('toString')).toBeUndefined();
  });
});

describe('连接器要填值', () => {
  it('有环境变量或请求头键时要填', () => {
    const result = scan();
    expect(needsValues(nth(result.connectors, 0))).toBe(true);
    expect(needsValues(nth(result.connectors, 1))).toBe(false);
    expect(needsValues({ ...nth(result.connectors, 1), config: undefined })).toBe(false);
  });
});
