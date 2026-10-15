// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-grok/src/server/xaiAcpExtension.ts（`isGenericAcpToolTitle`、`resolveXAiAcpToolTitle`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：T3 只修正工具的标题；这里另按 Grok 的工具名与 `_meta["x.ai/tool"]` 给出 Wevir 的 `ToolDisplay`（展示类型、路径、
// 命令、查询词、网址），标题的修正只用在摘要上。
//
// Grok 的工具展示（grok-event-mapping.md §3）。`tool_call` 的 `title` 是工具名（`run_terminal_command`、`read_file`…），不带
// ACP 的 `kind`；之后的 `tool_call_update` 才带 `kind` 与给人看的标题（“Execute `ls`”）。两种更新都带
// `_meta["x.ai/tool"]`（`name`、`kind`、`label`、`read_only`），工具名优先从那里取，其次是 `tool_call` 的标题，再按 ACP 的
// `kind` 与 `rawInput.variant` 兜底。

import type { AcpSessionUpdate } from '@wevir/adapter-acp';
import type { ToolDisplay, ToolDisplayKind } from '@wevir/runtime-adapter';

/** Grok 写待办的工具：完整的列表随后以 ACP `plan` 发出（`isPlanTool`）。 */
export const GROK_TODO_TOOL = 'todo_write';

const KINDS: Readonly<Record<string, ToolDisplayKind>> = {
  runterminalcommand: 'shell',
  monitor: 'shell',
  bash: 'shell',
  getcommandorsubagentoutput: 'shell',
  readfile: 'read',
  listdir: 'read',
  write: 'write',
  writefile: 'write',
  searchreplace: 'edit',
  edit: 'edit',
  multiedit: 'edit',
  grep: 'search',
  glob: 'search',
  filesearch: 'search',
  codebasesearch: 'search',
  searchtool: 'search',
  websearch: 'search',
  xkeywordsearch: 'search',
  xsemanticsearch: 'search',
  webfetch: 'fetch',
  todowrite: 'plan',
  enterplanmode: 'plan',
  exitplanmode: 'plan',
  spawnsubagent: 'sub_agent',
  task: 'sub_agent',
};

/** ACP `kind` 与 `x.ai/tool` 的 `kind` 兜底。 */
const BY_KIND: Readonly<Record<string, ToolDisplayKind>> = {
  execute: 'shell',
  read: 'read',
  list: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'search',
  search_tool: 'search',
  fetch: 'fetch',
  think: 'plan',
  plan: 'plan',
};

function normalize(name: string): string {
  return name.toLowerCase().replaceAll(/[\s_-]/g, '');
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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

/** 更新里的 `_meta["x.ai/tool"]`。 */
export function xaiTool(update: AcpSessionUpdate | undefined): {
  name?: string;
  kind?: string;
} {
  const tool = record(record(update?._meta)['x.ai/tool']);
  return {
    ...(typeof tool.name === 'string' && tool.name !== '' && { name: tool.name }),
    ...(typeof tool.kind === 'string' && tool.kind !== '' && { kind: tool.kind }),
  };
}

/** T3 的 `isGenericAcpToolTitle`：Grok 常给 `Tool` 这样不说明问题的标题。 */
export function isGenericToolTitle(title: string | undefined): boolean {
  const key = (title ?? '').trim().toLowerCase();
  return key === '' || key === 'tool' || key === 'tool call' || key === 'terminal';
}

/** 标题不说明问题时的替代（T3 的 `resolveXAiAcpToolTitle`）：描述、变体（Monitor、Task…）、命令。 */
export function resolveToolTitle(title: string | undefined, rawInput: unknown): string | undefined {
  if (!isGenericToolTitle(title)) return title?.trim();
  const input = record(rawInput);
  const description = firstString(input, ['description']);
  const variant = firstString(input, ['variant'])?.toLowerCase();
  if (description !== undefined) {
    return variant === 'monitor' && !description.toLowerCase().startsWith('monitor')
      ? `Monitor: ${description}`
      : description;
  }
  if (variant === 'monitor') return 'Monitor';
  if (variant === 'task' || variant === 'cursortask' || variant === 'spawn_subagent') return 'Task';
  if (variant === 'taskoutput' || variant === 'task_output') return 'Task output';
  if (variant !== undefined) return variant;
  const command = firstString(input, ['command']);
  if (command !== undefined) return command.length > 80 ? `${command.slice(0, 77)}...` : command;
  return title?.trim() || undefined;
}

/** 展示类型：工具名查表，查不到按 `x.ai/tool` 的 `kind`、ACP 的 `kind`、`rawInput.variant`。 */
function displayKind(
  toolName: string,
  rawInput: unknown,
  update: AcpSessionUpdate,
): ToolDisplayKind {
  const meta = xaiTool(update);
  for (const name of [meta.name, toolName, firstString(record(rawInput), ['variant'])]) {
    if (name === undefined) continue;
    if (/^mcp__/.test(name)) return 'unknown';
    const kind = KINDS[normalize(name)];
    if (kind !== undefined) return kind;
  }
  for (const kind of [meta.kind, typeof update.kind === 'string' ? update.kind : undefined]) {
    const found = kind === undefined ? undefined : BY_KIND[kind];
    if (found !== undefined) return found;
  }
  return 'unknown';
}

/** 一次工具调用的展示（`tool.started.display`，带标题的 `tool.updated.display`）。 */
export function grokToolDisplay(
  toolName: string,
  rawInput: unknown,
  update: AcpSessionUpdate,
): ToolDisplay {
  const input = record(rawInput);
  const name = xaiTool(update).name ?? toolName;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const kind = displayKind(toolName, rawInput, update);
  const fallback = () => {
    const summary =
      firstString(input, [
        'command',
        'file_path',
        'target_file',
        'path',
        'url',
        'query',
        'description',
      ]) ?? (isGenericToolTitle(toolName) ? resolveToolTitle(toolName, rawInput) : undefined);
    return summary === undefined ? undefined : oneLine(summary);
  };
  switch (kind) {
    case 'shell': {
      const command = firstString(input, ['command', 'cmd']);
      const summary =
        command !== undefined
          ? oneLine(command)
          : oneLine(resolveToolTitle(undefined, rawInput) ?? name);
      return { kind, ...(command !== undefined && { command }), summary };
    }
    case 'read':
    case 'edit':
    case 'write': {
      const file = firstString(input, [
        'file_path',
        'target_file',
        'path',
        'target_directory',
        'directory',
      ]);
      const locations = Array.isArray(update.locations)
        ? update.locations.flatMap((location) => {
            const path = record(location).path;
            return typeof path === 'string' && path !== '' ? [path] : [];
          })
        : [];
      const paths = file !== undefined ? [file] : locations;
      return {
        kind,
        ...(paths.length > 0 && { paths, summary: paths[0] as string }),
      };
    }
    case 'search': {
      const query = firstString(input, ['query', 'pattern', 'regex', 'search_term']);
      const dir = firstString(input, ['path', 'target_directory', 'directory']);
      return {
        kind,
        ...(query !== undefined && { query, summary: oneLine(query) }),
        ...(dir !== undefined && { paths: [dir] }),
      };
    }
    case 'fetch': {
      const url = firstString(input, ['url']);
      return { kind, ...(url !== undefined && { url, summary: url }) };
    }
    case 'sub_agent': {
      const summary = firstString(input, ['description', 'subagent_type', 'prompt']);
      return { kind, ...(summary !== undefined && { summary: oneLine(summary) }) };
    }
    case 'plan': {
      const summary = firstString(input, ['description', 'planContent']);
      return { kind, ...(summary !== undefined && { summary: oneLine(summary) }) };
    }
    default: {
      const summary = fallback();
      return {
        kind,
        ...(mcp !== null && { mcpServer: mcp[1] as string }),
        ...(summary !== undefined && { summary }),
      };
    }
  }
}

/** `todo_write` 的调用：它的完整列表随后以 ACP `plan` 发出。 */
export function isGrokTodoTool(toolName: string): boolean {
  return normalize(toolName) === normalize(GROK_TODO_TOOL);
}
