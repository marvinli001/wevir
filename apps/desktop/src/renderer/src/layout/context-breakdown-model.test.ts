import type { UsageBreakdown } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  BUFFER_SWATCH,
  categoryLabel,
  contextBreakdown,
  FREE_SWATCH,
  formatPercent,
  groupLabel,
} from './context-breakdown-model';

/** 照 Claude Code `/context` 的样子（500k 窗口）：已用 169.3k 里消息最多，另有按需载入的工具。 */
const claude: UsageBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 9_600, kind: 'used' },
    { name: 'System tools', tokens: 14_500, kind: 'used' },
    { name: 'MCP tools', tokens: 22_900, kind: 'used' },
    { name: 'Skills', tokens: 10_000, kind: 'used' },
    { name: 'Messages', tokens: 105_200, kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
    { name: 'Free space', tokens: 297_700, kind: 'free' },
    { name: 'System tools (deferred)', tokens: 23_800, kind: 'deferred' },
    { name: 'MCP tools (deferred)', tokens: 274_800, kind: 'deferred' },
  ],
  groups: [
    {
      group: 'mcp_tools',
      count: 406,
      items: [{ name: 'create_issue', source: 'linear', tokens: 320 }],
    },
    { group: 'agents', count: 0, items: [] },
    {
      group: 'memory_files',
      count: 2,
      items: [{ name: '/p/AGENTS.md', source: 'Project', tokens: 2400 }],
    },
  ],
};

describe('contextBreakdown', () => {
  it('占用的从多到少，压缩余量与剩余空间垫后，按需载入的另列；占比相对窗口（不含按需载入）', () => {
    const view = contextBreakdown(claude);
    expect(view?.rows.map((row) => row.label)).toEqual([
      '消息',
      'MCP 工具',
      '系统工具',
      '技能',
      '系统提示',
      '自动压缩预留',
      '剩余空间',
    ]);
    const messages = view?.rows[0];
    expect(messages?.tokens).toBe(105_200);
    // 窗口 = 9.6 + 14.5 + 22.9 + 10 + 105.2 + 33 + 297.7 = 492.9k
    expect(messages?.percent).toBeCloseTo((105_200 / 492_900) * 100, 6);
    expect(view?.rows.reduce((sum, row) => sum + row.percent, 0)).toBeCloseTo(100, 6);
    expect(view?.rows.at(-2)).toMatchObject({ kind: 'buffer', swatch: BUFFER_SWATCH });
    expect(view?.rows.at(-1)).toMatchObject({ kind: 'free', swatch: FREE_SWATCH });
    expect(view?.deferred.map((row) => [row.label, row.tokens, row.percent])).toEqual([
      ['MCP 工具（按需载入）', 274_800, 0],
      ['系统工具（按需载入）', 23_800, 0],
    ]);
  });

  it('已知类别的色块固定，不认识的类别照写名字、也各有色块', () => {
    const view = contextBreakdown({
      categories: [
        { name: 'Messages', tokens: 10, kind: 'used' },
        { name: 'Plugin thing', tokens: 5, kind: 'used' },
        { name: 'Another new one', tokens: 5, kind: 'future-kind' },
      ],
    });
    expect(view?.rows.map((row) => row.label)).toEqual(['消息', 'Plugin thing', 'Another new one']);
    const swatches = view?.rows.map((row) => row.swatch) ?? [];
    expect(swatches[0]).toBe('bg-running');
    expect(new Set(swatches).size).toBe(3);
    // 不认识的 kind 按占用算。
    expect(view?.rows[2]?.kind).toBe('used');
  });

  it('细项分组：没有项的组不要，其余带项数与前几项', () => {
    const view = contextBreakdown(claude);
    expect(view?.groups.map((group) => [group.id, group.label, group.count])).toEqual([
      ['mcp_tools', 'MCP 工具', 406],
      ['memory_files', '记忆文件', 2],
    ]);
    expect(view?.groups[0]?.items).toEqual([
      { name: 'create_issue', source: 'linear', tokens: 320 },
    ]);
  });

  it('没有分布、或占用全是 0 时没有视图；零占用的行不画', () => {
    expect(contextBreakdown(undefined)).toBeUndefined();
    expect(contextBreakdown({ categories: [] })).toBeUndefined();
    expect(
      contextBreakdown({ categories: [{ name: 'Messages', tokens: 0, kind: 'used' }] }),
    ).toBeUndefined();
    const view = contextBreakdown({
      categories: [
        { name: 'Messages', tokens: 7, kind: 'used' },
        { name: 'Skills', tokens: 0, kind: 'used' },
      ],
    });
    expect(view?.rows).toHaveLength(1);
  });

  it('Codex 的输入输出拆分', () => {
    const view = contextBreakdown({
      categories: [
        { name: 'Input', tokens: 2_500, kind: 'used' },
        { name: 'Cached input', tokens: 7_500, kind: 'used' },
        { name: 'Output', tokens: 500, kind: 'used' },
        { name: 'Reasoning', tokens: 1_500, kind: 'used' },
        { name: 'Free space', tokens: 88_000, kind: 'free' },
      ],
    });
    expect(view?.rows.map((row) => row.label)).toEqual([
      '缓存输入',
      '输入',
      '推理',
      '输出',
      '剩余空间',
    ]);
  });
});

describe('写法', () => {
  it('类别名与分组名：认得的翻译，其余照写', () => {
    expect(categoryLabel('MCP server instructions')).toBe('MCP 服务说明');
    expect(categoryLabel('memory FILES')).toBe('记忆文件');
    expect(categoryLabel('Something else')).toBe('Something else');
    expect(groupLabel('agents')).toBe('自定义智能体');
    expect(groupLabel('plugins')).toBe('plugins');
  });

  it('占比一位小数，极小的写 <0.1%', () => {
    expect([21, 0, 0.04, 0.05, 99.96].map(formatPercent)).toEqual([
      '21.0%',
      '0.0%',
      '<0.1%',
      '0.1%',
      '100.0%',
    ]);
  });
});
