import { describe, expect, it } from 'vitest';
import { CONTEXT_GROUP_ITEMS, claudeContextBreakdown } from './context-breakdown.js';
import type { SDKControlGetContextUsageResponse } from './sdk.js';

/** 只填测试用到的字段（真实响应还有 gridRows 等）。 */
function response(overrides: Record<string, unknown>): SDKControlGetContextUsageResponse {
  return {
    categories: [],
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    ...overrides,
  } as unknown as SDKControlGetContextUsageResponse;
}

describe('claudeContextBreakdown', () => {
  it('分类原样带上，零占用的行不要，kind 缺了时看 isDeferred', () => {
    const breakdown = claudeContextBreakdown(
      response({
        categories: [
          { name: 'Messages', tokens: 105_200, color: 'x', kind: 'used' },
          { name: 'System tools', tokens: 0, color: 'x', kind: 'used' },
          { name: 'Autocompact buffer', tokens: 33_000, color: 'x', kind: 'buffer' },
          { name: 'Free space', tokens: 297_700, color: 'x', kind: 'free' },
          { name: 'MCP tools (deferred)', tokens: 274_800, color: 'x', isDeferred: true },
          { name: 'Skills', tokens: 10_000.4, color: 'x' },
        ],
      }),
    );
    expect(breakdown?.categories).toEqual([
      { name: 'Messages', tokens: 105_200, kind: 'used' },
      { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
      { name: 'Free space', tokens: 297_700, kind: 'free' },
      { name: 'MCP tools (deferred)', tokens: 274_800, kind: 'deferred' },
      { name: 'Skills', tokens: 10_000, kind: 'used' },
    ]);
    expect(breakdown).not.toHaveProperty('groups');
  });

  it('全是零占用时没有分布', () => {
    expect(
      claudeContextBreakdown(
        response({ categories: [{ name: 'Messages', tokens: 0, color: 'x', kind: 'used' }] }),
      ),
    ).toBeUndefined();
  });

  it('细项按占用从多到少，MCP 工具去掉前缀并跳过没载入的，每组只带前 50 项但数全', () => {
    const tools = Array.from({ length: 60 }, (_, index) => ({
      name: `mcp__linear__tool_${index}`,
      serverName: 'linear',
      tokens: index + 1,
    }));
    const breakdown = claudeContextBreakdown(
      response({
        categories: [{ name: 'MCP tools', tokens: 1830, color: 'x', kind: 'used' }],
        mcpTools: [
          ...tools,
          { name: 'mcp__linear__unloaded', serverName: 'linear', tokens: 9999, isLoaded: false },
        ],
        memoryFiles: [
          { path: '/p/AGENTS.md', type: 'Project', tokens: 2400 },
          { path: '/u/CLAUDE.md', type: 'User', tokens: 600 },
        ],
        agents: [{ agentType: 'reviewer', source: 'projectSettings', tokens: 80 }],
        skills: {
          totalSkills: 2,
          includedSkills: 2,
          tokens: 30,
          skillFrontmatter: [
            { name: 'pdf', source: 'plugin', tokens: 10 },
            { name: 'docx', source: 'plugin', tokens: 20 },
          ],
        },
      }),
    );
    const byGroup = Object.fromEntries((breakdown?.groups ?? []).map((g) => [g.group, g]));
    expect(byGroup.mcp_tools?.count).toBe(60);
    expect(byGroup.mcp_tools?.items).toHaveLength(CONTEXT_GROUP_ITEMS);
    expect(byGroup.mcp_tools?.items[0]).toEqual({ name: 'tool_59', source: 'linear', tokens: 60 });
    expect(byGroup.memory_files?.items.map((item) => item.name)).toEqual([
      '/p/AGENTS.md',
      '/u/CLAUDE.md',
    ]);
    expect(byGroup.memory_files?.items[0]).toMatchObject({ source: 'Project', tokens: 2400 });
    expect(byGroup.agents?.items).toEqual([
      { name: 'reviewer', source: 'projectSettings', tokens: 80 },
    ]);
    expect(byGroup.skills?.items.map((item) => item.name)).toEqual(['docx', 'pdf']);
  });
});
