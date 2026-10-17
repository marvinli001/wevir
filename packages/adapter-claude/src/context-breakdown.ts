// Claude 的 `getContextUsage()`（SDK 控制请求，`/context` 的结构化版本）→ Wevir 的上下文分布（`usage.updated.breakdown`，0.50.0）。
// 分类名原样传（桌面端认得的按界面语言显示），细项取每组占用最多的前几项。

import type { UsageBreakdown } from '@wevir/runtime-adapter';
import type { SDKControlGetContextUsageResponse } from './sdk.js';

/** 每组细项带多少项（线缆上限是 100；MCP 工具动辄几百个，只带占得最多的）。 */
export const CONTEXT_GROUP_ITEMS = 50;
const NAME_MAX = 300;
const SOURCE_MAX = 100;

type Item = { name: string; source?: string; tokens: number };

export function claudeContextBreakdown(
  response: SDKControlGetContextUsageResponse,
): UsageBreakdown | undefined {
  // 零占用的行不显示（SDK 也说渲染方通常隐藏它们）；`kind` 以 SDK 的分类为准，旧版本没有时看 `isDeferred`。
  const categories = (response.categories ?? [])
    .filter((row) => row.name !== '' && Number.isFinite(row.tokens) && row.tokens > 0)
    .map((row) => ({
      name: row.name.slice(0, 100),
      tokens: Math.round(row.tokens),
      kind: row.kind ?? (row.isDeferred === true ? 'deferred' : 'used'),
    }));
  if (categories.length === 0) return undefined;

  const groups = [
    group(
      'mcp_tools',
      (response.mcpTools ?? [])
        // 没载入的（按需载入的工具定义）不占窗口，在 deferred 那一行里。
        .filter((tool) => tool.isLoaded !== false)
        .map((tool) => ({
          name: stripMcpPrefix(tool.name, tool.serverName),
          source: tool.serverName,
          tokens: tool.tokens,
        })),
    ),
    group(
      'memory_files',
      (response.memoryFiles ?? []).map((file) => ({
        name: file.path,
        source: file.type,
        tokens: file.tokens,
      })),
    ),
    group(
      'agents',
      (response.agents ?? []).map((agent) => ({
        name: agent.agentType,
        source: agent.source,
        tokens: agent.tokens,
      })),
    ),
    group(
      'skills',
      (response.skills?.skillFrontmatter ?? []).map((skill) => ({
        name: skill.name,
        source: skill.source,
        tokens: skill.tokens,
      })),
    ),
  ].filter((entry) => entry !== undefined);

  return { categories, ...(groups.length > 0 && { groups }) };
}

function group(name: string, items: Array<{ name: string; source?: string; tokens: number }>) {
  const valid: Item[] = items
    .filter((item) => item.name !== '' && Number.isFinite(item.tokens) && item.tokens >= 0)
    .map((item) => ({
      name: item.name.slice(0, NAME_MAX),
      ...(item.source !== undefined &&
        item.source !== '' && { source: item.source.slice(0, SOURCE_MAX) }),
      tokens: Math.round(item.tokens),
    }));
  if (valid.length === 0) return undefined;
  valid.sort((a, b) => b.tokens - a.tokens);
  return { group: name, count: valid.length, items: valid.slice(0, CONTEXT_GROUP_ITEMS) };
}

/** `mcp__linear__create_issue` → `create_issue`（服务名另放在 `source`）。 */
function stripMcpPrefix(name: string, serverName: string): string {
  const prefix = `mcp__${serverName}__`;
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
}
