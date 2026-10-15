// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts（`CLAUDE_KNOWN_TOOL_CLASSIFICATIONS`、`classifyClaudeNativeTool`、`summarizeClaudeToolRequest`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：工具分类改成 Wevir 的 `ToolDisplay`（展示类型、路径、命令、查询词、网址、MCP 服务器）。
//
// Claude Code 的工具名 → Wevir 的展示类型（claude-event-mapping.md §5.3）。工具名是 Claude Code 自己的（Bash、Read、Edit…），
// 按 T3 的做法先去掉大小写、空白、下划线和连字符再查表；MCP 工具是 `mcp__<server>__<tool>`。

import type { ToolDisplay, ToolDisplayKind } from '@wevir/runtime-adapter';

/** 子 agent 的工具（新版叫 Agent，旧版叫 Task）。 */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['agent', 'task']);

const KINDS: Readonly<Record<string, ToolDisplayKind>> = {
  agent: 'sub_agent',
  task: 'sub_agent',
  sendmessage: 'sub_agent',
  taskstop: 'sub_agent',
  bash: 'shell',
  monitor: 'shell',
  bashoutput: 'shell',
  killshell: 'shell',
  read: 'read',
  ls: 'read',
  glob: 'search',
  grep: 'search',
  toolsearch: 'search',
  websearch: 'search',
  webfetch: 'fetch',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  write: 'write',
  todowrite: 'plan',
  taskcreate: 'plan',
  taskupdate: 'plan',
  tasklist: 'plan',
  taskget: 'plan',
  exitplanmode: 'plan',
  enterplanmode: 'plan',
};

/** T3 的 `normalizedClaudeToolName`。 */
export function normalizeToolName(toolName: string): string {
  return toolName.toLowerCase().replaceAll(/[\s_-]/g, '');
}

export function isSubagentTool(toolName: string): boolean {
  return SUBAGENT_TOOLS.has(normalizeToolName(toolName));
}

function record(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** 第一个非空的字符串字段（T3 的 `firstStringInputField`）。 */
function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function oneLine(text: string, max = 200): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** 工具输入的一行摘要（T3 的 `summarizeClaudeToolRequest`，去掉工具名前缀，限长）。 */
export function summarizeToolInput(input: unknown): string | undefined {
  const fields = record(input);
  const command = firstString(fields, ['command', 'cmd', 'script']);
  if (command !== undefined) return oneLine(command);
  const target = firstString(fields, ['file_path', 'notebook_path', 'path', 'filename', 'url']);
  if (target !== undefined) return oneLine(target);
  const text = firstString(fields, ['description', 'pattern', 'query', 'subject', 'prompt']);
  if (text !== undefined) return oneLine(text);
  if (typeof input === 'string') return oneLine(input);
  return undefined;
}

/** 一次工具调用的展示（`tool.started.display`）。 */
export function claudeToolDisplay(toolName: string, input: unknown): ToolDisplay {
  const fields = record(input);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp !== null) {
    const summary = summarizeToolInput(input);
    return {
      kind: 'unknown',
      mcpServer: mcp[1] as string,
      ...(summary !== undefined && { summary }),
    };
  }
  const kind = KINDS[normalizeToolName(toolName)] ?? 'unknown';
  switch (kind) {
    case 'shell': {
      const command = firstString(fields, ['command', 'cmd', 'script']);
      const summary = command === undefined ? summarizeToolInput(input) : oneLine(command);
      return {
        kind,
        ...(command !== undefined && { command }),
        ...(summary !== undefined && { summary }),
      };
    }
    case 'read':
    case 'edit':
    case 'write': {
      const file = firstString(fields, ['file_path', 'notebook_path', 'path']);
      return { kind, ...(file !== undefined && { paths: [file], summary: file }) };
    }
    case 'search': {
      const query = firstString(fields, ['pattern', 'query']);
      const dir = firstString(fields, ['path']);
      return {
        kind,
        ...(query !== undefined && { query, summary: oneLine(query) }),
        ...(dir !== undefined && { paths: [dir] }),
      };
    }
    case 'fetch': {
      const url = firstString(fields, ['url']);
      return { kind, ...(url !== undefined && { url, summary: url }) };
    }
    case 'sub_agent': {
      const summary = firstString(fields, ['description', 'subagent_type', 'to', 'task_id']);
      return { kind, ...(summary !== undefined && { summary: oneLine(summary) }) };
    }
    default: {
      const summary = summarizeToolInput(input);
      return { kind, ...(summary !== undefined && { summary }) };
    }
  }
}
