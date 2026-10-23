// 大输出落盘（domain-model §3.15）：应用级工具的结果太长时，引擎会截掉中间（Codex 给模型的工具输出约 10 KB，见
// adapter-codex 的 truncation_policy），模型就丢了大块内容。Host 把这样的结果整份写进 `<数据目录>/tool-output/<会话 ID>/`，
// 只回开头、结尾、大小与路径，模型按需用 rg / sed 读。后台进程（processes.ts）的输出日志也在这里。
// 删除会话时随会话删（session-delete.ts），Host 启动时清掉超过 `TOOL_OUTPUT_MAX_AGE_MS` 的文件。

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import type { AppToolResult } from './app-mcp.js';

/** 文本超过这么多字节（UTF-8）就落盘：比 Codex 的 10 000 字节留出余量。 */
export const TOOL_OUTPUT_INLINE_BYTES = 8000;
/**
 * 个别工具的结果要整份留在对话里，上限放到 Codex 的 10 000 字节：电脑操作第一次批准时附上的操作说明（约 9 KB）要模型
 * 读全，落盘后模型多半只看开头。
 */
const TOOL_OUTPUT_INLINE_OVERRIDES: Readonly<Record<string, number>> = {
  computer_request_access: 10_000,
};
/** 落盘后结果里留的开头与结尾（字节，按行截）。 */
export const TOOL_OUTPUT_HEAD_BYTES = 2000;
export const TOOL_OUTPUT_TAIL_BYTES = 1000;
/** 文件留多久。 */
export const TOOL_OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface SpilledFile {
  path: string;
  bytes: number;
  lines: number;
}

export class ToolOutputStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** 这个会话的目录（0700，第一次用时建）。 */
  async sessionDir(sessionId: SessionId): Promise<string> {
    const dir = join(this.dir, sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** 这个会话的目录（不建）。 */
  sessionPath(sessionId: SessionId): string {
    return join(this.dir, sessionId);
  }

  /** 写一份结果，文件名 `<时间>-<工具>-<随机>.<扩展名>`。 */
  async write(
    sessionId: SessionId,
    label: string,
    text: string,
    extension = 'txt',
  ): Promise<SpilledFile> {
    const dir = await this.sessionDir(sessionId);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const name = `${stamp}-${safeName(label)}-${randomBytes(3).toString('hex')}.${extension}`;
    const path = join(dir, name);
    await writeFile(path, text, { mode: 0o600 });
    return { path, bytes: Buffer.byteLength(text), lines: countLines(text) };
  }

  /** 清掉超过 `maxAgeMs` 的文件与空了的会话目录。出错跳过。 */
  async prune(maxAgeMs = TOOL_OUTPUT_MAX_AGE_MS, now = Date.now()): Promise<void> {
    const sessions = await readdir(this.dir).catch(() => [] as string[]);
    for (const session of sessions) {
      const dir = join(this.dir, session);
      const files = await readdir(dir).catch(() => [] as string[]);
      let kept = 0;
      for (const file of files) {
        const path = join(dir, file);
        const info = await stat(path).catch(() => undefined);
        if (info !== undefined && now - info.mtimeMs > maxAgeMs) {
          await rm(path, { force: true }).catch(() => {});
        } else {
          kept += 1;
        }
      }
      if (kept === 0) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * 结果的文本超过 `TOOL_OUTPUT_INLINE_BYTES` 时落盘，换成说明、开头、结尾与路径；图片原样保留，`structuredContent` 去掉（Codex
   * 有它时只把它给模型）。JSON 结果（`jsonResult`）写成缩进的 JSON，按行读得了。写失败时原样返回。
   */
  async spill(
    sessionId: SessionId,
    toolName: string,
    result: AppToolResult,
  ): Promise<AppToolResult> {
    const texts = result.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
    const joined = texts.join('\n\n');
    const limit = TOOL_OUTPUT_INLINE_OVERRIDES[toolName] ?? TOOL_OUTPUT_INLINE_BYTES;
    if (Buffer.byteLength(joined) <= limit) return result;
    const json = result.structuredContent !== undefined && texts.length === 1;
    const body = json ? `${JSON.stringify(result.structuredContent, null, 2)}\n` : joined;
    let file: SpilledFile;
    try {
      file = await this.write(sessionId, toolName, body, json ? 'json' : 'txt');
    } catch {
      return result;
    }
    const images = result.content.filter((part) => part.type === 'image');
    return {
      content: [{ type: 'text', text: spilledText(file, body) }, ...images],
      ...(result.isError === true && { isError: true }),
    };
  }
}

/** 落盘后给模型的文本。 */
export function spilledText(file: SpilledFile, body: string): string {
  const { head, tail } = headAndTail(body, TOOL_OUTPUT_HEAD_BYTES, TOOL_OUTPUT_TAIL_BYTES);
  const lines = [
    `The full result is ${formatBytes(file.bytes)} (${file.lines} lines), too large to show here, so Wevir saved it to:`,
    file.path,
    "Read the parts you need with rg, sed -n 'START,ENDp', head or tail instead of guessing.",
    '',
    `--- first lines ---`,
    head,
  ];
  if (tail !== '') lines.push(`--- last lines ---`, tail);
  return lines.join('\n');
}

/** 开头与结尾，都在行边界上截（单行超长时按字节截）；两段会重叠时结尾为空。 */
export function headAndTail(
  text: string,
  headBytes: number,
  tailBytes: number,
): { head: string; tail: string } {
  const lines = text.replace(/\n$/, '').split('\n');
  const head: string[] = [];
  let used = 0;
  let index = 0;
  for (; index < lines.length; index += 1) {
    const size = Buffer.byteLength(lines[index] as string) + 1;
    if (used + size > headBytes) break;
    head.push(lines[index] as string);
    used += size;
  }
  if (head.length === 0 && lines.length > 0) {
    head.push(`${truncateBytes(lines[0] as string, headBytes)} …`);
    index = 1;
  }
  const tail: string[] = [];
  used = 0;
  for (let end = lines.length - 1; end >= index; end -= 1) {
    const size = Buffer.byteLength(lines[end] as string) + 1;
    if (used + size > tailBytes) break;
    tail.unshift(lines[end] as string);
    used += size;
  }
  if (index + tail.length >= lines.length) {
    return { head: [...head, ...tail].join('\n'), tail: '' };
  }
  return { head: head.join('\n'), tail: tail.join('\n') };
}

function truncateBytes(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  // 去掉截断处半个 UTF-8 字符。
  return buffer.subarray(0, bytes).toString('utf8').replace(/�$/, '');
}

export function countLines(text: string): number {
  if (text === '') return 0;
  let count = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    count += 1;
  }
  return text.endsWith('\n') ? count : count + 1;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function safeName(label: string): string {
  return label.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'output';
}
