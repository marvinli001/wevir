import type { AcpSessionUpdate } from '@wevir/adapter-acp';
import type { ToolDisplay, ToolDisplayKind } from '@wevir/runtime-adapter';
import { record } from './models.js';

/**
 * Kiro CLI 的内置工具名（`--trust-tools` 认的 `fs_read`、`fs_write`、`execute_bash`、`grep`、`glob`、`web_search`、`web_fetch`、
 * `todo_list`、`use_subagent` 等，取自 2.36.0 的程序）。ACP 的 `tool_call.title` 可能是给人看的标题，认不出时看 `kind`。
 */
const KINDS: Readonly<Record<string, ToolDisplayKind>> = {
  executebash: 'shell',
  executecmd: 'shell',
  shell: 'shell',
  fsread: 'read',
  read: 'read',
  fswrite: 'write',
  write: 'write',
  grep: 'search',
  glob: 'search',
  websearch: 'search',
  webfetch: 'fetch',
  todolist: 'plan',
  usesubagent: 'sub_agent',
  delegate: 'sub_agent',
};
const ACP_KINDS: Readonly<Record<string, ToolDisplayKind>> = {
  execute: 'shell',
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'search',
  fetch: 'fetch',
  think: 'plan',
};

export function kiroToolDisplay(
  name: string,
  rawInput: unknown,
  update: AcpSessionUpdate,
): ToolDisplay {
  const input = record(rawInput) ?? {};
  const string = (...keys: string[]) =>
    keys
      .map((key) => input[key])
      .find((value): value is string => typeof value === 'string' && value.trim() !== '');
  const short = (value: string) => value.split('\n')[0]?.slice(0, 200) ?? '';
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name) ?? /^@(.+?)\/(.+)$/.exec(name);
  if (mcp !== null) return { kind: 'unknown', mcpServer: mcp[1] as string, summary: name };
  const kind =
    KINDS[name.toLowerCase().replaceAll(/[\s_-]/g, '')] ??
    (typeof update.kind === 'string' ? ACP_KINDS[update.kind] : undefined) ??
    'unknown';
  if (kind === 'shell') {
    const command = string('command', 'command_line', 'cmd');
    return { kind, ...(command !== undefined && { command, summary: short(command) }) };
  }
  if (kind === 'read' || kind === 'write' || kind === 'edit') {
    const file = string('path', 'file_path', 'filePath');
    const operations = Array.isArray(input.operations) ? input.operations : [];
    const fromOperations = operations.flatMap((operation) => {
      const path = record(operation)?.path;
      return typeof path === 'string' && path !== '' ? [path] : [];
    });
    const paths =
      file !== undefined
        ? [file]
        : fromOperations.length > 0
          ? fromOperations
          : Array.isArray(update.locations)
            ? update.locations.flatMap((location) =>
                typeof record(location)?.path === 'string'
                  ? [record(location)?.path as string]
                  : [],
              )
            : [];
    return { kind, ...(paths.length > 0 && { paths, summary: paths[0] as string }) };
  }
  if (kind === 'search') {
    const query = string('pattern', 'query');
    return { kind, ...(query !== undefined && { query, summary: short(query) }) };
  }
  if (kind === 'fetch') {
    const url = string('url');
    return { kind, ...(url !== undefined && { url, summary: url }) };
  }
  const summary = string('summary', 'description', 'prompt', 'task');
  return { kind, ...(summary !== undefined && { summary: short(summary) }) };
}
