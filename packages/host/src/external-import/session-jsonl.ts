import { createReadStream } from 'node:fs';
import type { ToolDisplay } from '@wevir/protocol';
import { record } from '../plugin-skills.js';
import { redactSecrets } from '../secret-patterns.js';

export const SESSION_LINE_MAX_BYTES = 4 * 1024 * 1024;

/** Discard oversized lines before decoding; a truncated final line counts once. */
export async function* sessionLines(path: string): AsyncGenerator<Record<string, unknown> | null> {
  let parts: Buffer[] = [];
  let size = 0;
  let oversized = false;
  const decode = () => {
    if (oversized) return null;
    const line = Buffer.concat(parts)
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .trim();
    if (line === '') return undefined;
    try {
      const value: unknown = JSON.parse(line);
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    let start = 0;
    while (start < buffer.length) {
      const end = buffer.indexOf(10, start);
      const part = buffer.subarray(start, end < 0 ? buffer.length : end);
      size += part.length;
      if (size > SESSION_LINE_MAX_BYTES) {
        oversized = true;
        parts = [];
      } else if (!oversized) parts.push(part);
      if (end < 0) break;
      const line = decode();
      if (line !== undefined) yield line;
      parts = [];
      size = 0;
      oversized = false;
      start = end + 1;
    }
  }
  if (size > 0) {
    const line = decode();
    if (line !== undefined) yield line;
  }
}

export type ExternalSessionItem = { at: string } & (
  | { kind: 'user' | 'assistant'; text: string; id?: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; display: ToolDisplay }
  | { kind: 'result'; id: string; text: string; failed: boolean }
  | { kind: 'end'; interrupted?: boolean }
);

export interface ExternalSessionInfo {
  externalId: string;
  project: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  turns: number;
  skipped: number;
  modelId?: string;
  /** Incomplete lineage cannot be resumed as if it were a complete history. */
  nativeCompatible: boolean;
}

export type SessionVisitor = (item: ExternalSessionItem) => void | Promise<void>;
export type SessionParser = (
  path: string,
  visit?: SessionVisitor,
) => Promise<ExternalSessionInfo | undefined>;

export function sessionInfo(): ExternalSessionInfo {
  return {
    externalId: '',
    project: '',
    title: '',
    startedAt: '',
    updatedAt: '',
    turns: 0,
    skipped: 0,
    nativeCompatible: true,
  };
}

export function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

export function touch(info: ExternalSessionInfo, at: string): void {
  if (info.startedAt === '' || at < info.startedAt) info.startedAt = at;
  if (at > info.updatedAt) info.updatedAt = at;
}

export function textContent(content: unknown): string {
  if (typeof content === 'string') return redactSecrets(content).text;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const block = record(item);
      return typeof block.text === 'string' ? redactSecrets(block.text).text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function firstPrompt(info: ExternalSessionInfo, text: string): void {
  if (info.title === '' && text.trim() !== '') {
    info.title = Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, 160).join('');
  }
}

export function toolDisplay(name: string, input: unknown): ToolDisplay {
  const args = record(input);
  const command = args.command ?? args.cmd;
  if (/^(Bash|exec_command|shell_command|shell|local_shell)$/i.test(name)) {
    return { kind: 'shell', ...(typeof command === 'string' && { command }) };
  }
  if (/^(Edit|MultiEdit|Write|apply_patch)$/i.test(name)) {
    const file = args.file_path ?? args.path;
    const patch = typeof input === 'string' ? input : args.patch;
    const paths =
      typeof file === 'string'
        ? [file]
        : typeof patch === 'string'
          ? Array.from(
              patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm),
              (m) => m[1] as string,
            )
          : [];
    return { kind: name === 'Write' ? 'write' : 'edit', ...(paths.length > 0 && { paths }) };
  }
  return { kind: 'unknown', summary: name };
}

export function cleanInput(input: unknown): unknown {
  if (typeof input === 'string') return redactSecrets(input).text;
  if (Array.isArray(input)) return input.map(cleanInput);
  if (input !== null && typeof input === 'object')
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, cleanInput(value)]),
    );
  return input ?? {};
}

export function validInfo(info: ExternalSessionInfo): ExternalSessionInfo | undefined {
  return info.externalId !== '' && info.project !== '' && info.startedAt !== '' && info.turns > 0
    ? info
    : undefined;
}
