import type { AcpSessionUpdate } from '@wevir/adapter-acp';
import type { ToolDisplay, ToolDisplayKind } from '@wevir/runtime-adapter';
import { record } from './models.js';

const KINDS: Readonly<Record<string, ToolDisplayKind>> = {
  bash: 'shell',
  powershell: 'shell',
  read: 'read',
  readfile: 'read',
  ls: 'read',
  write: 'write',
  writefile: 'write',
  edit: 'edit',
  multiedit: 'edit',
  grep: 'search',
  glob: 'search',
  websearch: 'search',
  webfetch: 'fetch',
  todowrite: 'plan',
  exitplanmode: 'plan',
  enterplanmode: 'plan',
  agent: 'sub_agent',
  task: 'sub_agent',
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

export function workBuddyToolName(toolName: string, meta: unknown): string {
  const name = record(meta)?.['codebuddy.ai/toolName'];
  return typeof name === 'string' && name.trim() ? name : toolName;
}

export function workBuddyToolDisplay(
  name: string,
  rawInput: unknown,
  update: AcpSessionUpdate,
): ToolDisplay {
  name = workBuddyToolName(name, update._meta);
  const input = record(rawInput) ?? {};
  const string = (...keys: string[]) =>
    keys
      .map((key) => input[key])
      .find((value): value is string => typeof value === 'string' && value.trim() !== '');
  const short = (value: string) => value.split('\n')[0]?.slice(0, 200) ?? '';
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp !== null) return { kind: 'unknown', mcpServer: mcp[1] as string, summary: name };
  const kind =
    KINDS[name.toLowerCase().replaceAll(/[\s_-]/g, '')] ??
    (typeof update.kind === 'string' ? ACP_KINDS[update.kind] : undefined) ??
    'unknown';
  if (kind === 'shell') {
    const command = string('command', 'command_line');
    return { kind, ...(command !== undefined && { command, summary: short(command) }) };
  }
  if (kind === 'read' || kind === 'write' || kind === 'edit') {
    const file = string('file_path', 'path');
    const paths =
      file !== undefined
        ? [file]
        : Array.isArray(update.locations)
          ? update.locations.flatMap((location) =>
              typeof record(location)?.path === 'string' ? [record(location)?.path as string] : [],
            )
          : [];
    return { kind, ...(paths.length > 0 && { paths, summary: paths[0] as string }) };
  }
  if (kind === 'search') {
    const query = string('query', 'pattern');
    return { kind, ...(query !== undefined && { query, summary: short(query) }) };
  }
  if (kind === 'fetch') {
    const url = string('url');
    return { kind, ...(url !== undefined && { url, summary: url }) };
  }
  const summary = string('description', 'prompt');
  return { kind, ...(summary !== undefined && { summary: short(summary) }) };
}
