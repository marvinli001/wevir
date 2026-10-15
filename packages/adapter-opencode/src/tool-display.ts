// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-opencode/src/server/toolItems.ts（`openCodeToolProjectionKind`、`openCodeToolTurnItem`
// 读的输入字段）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：T3 的回合条目换成 Wevir 的 `ToolDisplay`（展示类型、路径、命令、查询词、网址）；apply_patch 从补丁里取文件路径。
//
// opencode 的工具名 → Wevir 的展示类型（opencode-event-mapping.md §5.3）。内置工具：bash、read、write、edit、apply_patch、glob、
// grep、list、webfetch、websearch、codesearch、todowrite、task、question、skill、lsp；其余（MCP 工具是 `<server>_<tool>`）按未知
// 工具显示摘要。

import type { ToolDisplay, ToolDisplayKind } from '@wevir/runtime-adapter';

function record(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

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

/** 工具名 → 展示类型（T3 的 `openCodeToolProjectionKind`，再细分到 Wevir 的类型）。 */
export function toolKind(toolName: string): ToolDisplayKind {
  const name = toolName.toLowerCase();
  if (name === 'task') return 'sub_agent';
  if (name === 'todowrite' || name === 'todoread') return 'plan';
  if (name.includes('bash') || name.includes('shell')) return 'shell';
  if (name === 'write') return 'write';
  if (name.includes('edit') || name.includes('patch')) return 'edit';
  if (name === 'webfetch' || name === 'fetch') return 'fetch';
  if (name === 'read' || name === 'list' || name === 'ls') return 'read';
  if (
    name.includes('web') ||
    name === 'codesearch' ||
    name === 'code_search' ||
    name.includes('glob') ||
    name.includes('grep') ||
    name.includes('search') ||
    name === 'lsp'
  ) {
    return 'search';
  }
  return 'unknown';
}

/** apply_patch 的补丁里改了哪些文件（`*** Add File:` / `*** Update File:` / `*** Delete File:`）。 */
export function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const file = match[1]?.trim();
    if (file !== undefined && file !== '' && !paths.includes(file)) paths.push(file);
  }
  return paths;
}

/** 工具输入的一行摘要。 */
export function summarizeToolInput(input: unknown): string | undefined {
  const fields = record(input);
  const command = firstString(fields, ['command', 'cmd']);
  if (command !== undefined) return oneLine(command);
  const target = firstString(fields, ['filePath', 'path', 'file', 'url']);
  if (target !== undefined) return oneLine(target);
  const text = firstString(fields, ['description', 'pattern', 'query', 'name', 'prompt']);
  if (text !== undefined) return oneLine(text);
  return undefined;
}

/** 一次工具调用的展示（`tool.started.display` / `tool.updated.display`）。 */
export function openCodeToolDisplay(toolName: string, input: unknown): ToolDisplay {
  const fields = record(input);
  const kind = toolKind(toolName);
  switch (kind) {
    case 'shell': {
      const command = firstString(fields, ['command', 'cmd']);
      const summary = command === undefined ? summarizeToolInput(input) : oneLine(command);
      return {
        kind,
        ...(command !== undefined && { command }),
        ...(summary !== undefined && { summary }),
      };
    }
    case 'read':
    case 'write':
    case 'edit': {
      const patch = firstString(fields, ['patchText', 'patch']);
      const paths =
        patch !== undefined
          ? patchPaths(patch)
          : [firstString(fields, ['filePath', 'path', 'file'])].filter(
              (file): file is string => file !== undefined,
            );
      return {
        kind,
        ...(paths.length > 0 && { paths, summary: paths.join(', ') }),
      };
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
      const summary = firstString(fields, ['description', 'subagent_type', 'prompt']);
      return { kind, ...(summary !== undefined && { summary: oneLine(summary) }) };
    }
    default: {
      const summary = summarizeToolInput(input);
      return { kind, ...(summary !== undefined && { summary }) };
    }
  }
}
