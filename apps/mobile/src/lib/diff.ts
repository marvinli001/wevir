// 变更页的 diff：把 `workspace.diff` 的统一格式 `patch` 按文件切开、解析成一行一项（给虚拟化列表），再按文件分页。
// `patch` 只含没有 `omitted` 的文件，路径相对会话目录（`git diff --relative`，`a/`、`b/` 前缀）。

import type { DiffFile } from '@wevir/protocol';

export type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'context' | 'add' | 'remove'; text: string; oldLine?: number; newLine?: number }
  /** `\ No newline at end of file`。 */
  | { kind: 'note'; text: string };

export interface FilePatch {
  path: string;
  /** 从 `diff --git` 起的原文。 */
  text: string;
}

/** 按 `diff --git` 切开，每块认出新的一侧的路径（删除的文件是原来的路径，同 `DiffFile.path`）。 */
export function splitPatch(patch: string): FilePatch[] {
  const out: FilePatch[] = [];
  const lines = patch.split('\n');
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    const block = lines.slice(start, end);
    const path = blockPath(block);
    if (path !== undefined) out.push({ path, text: block.join('\n') });
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.startsWith('diff --git ')) {
      flush(i);
      start = i;
    }
  }
  flush(lines.length);
  return out;
}

function blockPath(block: readonly string[]): string | undefined {
  let minus: string | undefined;
  let plus: string | undefined;
  for (const line of block) {
    if (line.startsWith('@@')) break;
    if (line.startsWith('rename to ')) return unquote(line.slice('rename to '.length));
    if (line.startsWith('copy to ')) return unquote(line.slice('copy to '.length));
    if (line.startsWith('--- ')) minus = sidePath(line.slice(4), 'a/');
    else if (line.startsWith('+++ ')) plus = sidePath(line.slice(4), 'b/');
  }
  return plus ?? minus ?? headerPath(block[0] ?? '');
}

/** `--- a/x`、`+++ b/x`；`/dev/null` 没有路径。git 在有空格的路径后面加一个制表符。 */
function sidePath(raw: string, prefix: string): string | undefined {
  const value = unquote(raw.replace(/\t$/, ''));
  if (value === '/dev/null') return undefined;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** 二进制文件、只改了权限的文件没有 `---` / `+++`：从 `diff --git a/P b/P` 取（两侧路径相同时才拆得开）。 */
function headerPath(header: string): string | undefined {
  const rest = header.slice('diff --git '.length);
  if (rest.endsWith('"')) {
    const match = /"(?:[^"\\]|\\.)*"$/.exec(rest);
    return match === null ? undefined : unquote(match[0]).replace(/^b\//, '');
  }
  const n = (rest.length - 5) / 2;
  if (!Number.isInteger(n) || n <= 0) return undefined;
  const a = rest.slice(0, n + 2);
  const b = rest.slice(n + 3);
  if (!a.startsWith('a/') || !b.startsWith('b/') || a.slice(2) !== b.slice(2)) return undefined;
  return b.slice(2);
}

/** git 的 C 风格引号（路径里有引号、反斜杠、控制字符时）；八进制转义是 UTF-8 字节。 */
export function unquote(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  const simple: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    '"': 34,
    '\\': 92,
    a: 7,
    b: 8,
    f: 12,
    v: 11,
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (ch !== '\\') {
      bytes.push(...utf8(ch));
      continue;
    }
    const next = body[i + 1] ?? '';
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return decodeUtf8(Uint8Array.from(bytes));
}

function utf8(ch: string): number[] {
  return [...new TextEncoder().encode(ch)];
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** 一个文件的 diff 拆成行：`@@` 段头、上下文、增、删与“文件末尾没有换行”，带两侧的行号；文件头（`diff --git` 到第一个 `@@`）不要。 */
export function parseFilePatch(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match === null) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      inHunk = true;
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (!inHunk) continue;
    const mark = line[0];
    const body = line.slice(1);
    if (mark === '+') rows.push({ kind: 'add', text: body, newLine: newLine++ });
    else if (mark === '-') rows.push({ kind: 'remove', text: body, oldLine: oldLine++ });
    else if (mark === '\\') rows.push({ kind: 'note', text: line });
    else rows.push({ kind: 'context', text: body, oldLine: oldLine++, newLine: newLine++ });
  }
  return rows;
}

/** 文件列表里每一项的 diff 行；没给 diff 的（`omitted`、二进制、没有内容的改动）是空数组。 */
export function diffRowsByPath(patch: string | undefined): Map<string, DiffRow[]> {
  const map = new Map<string, DiffRow[]>();
  if (patch === undefined || patch === '') return map;
  for (const file of splitPatch(patch)) map.set(file.path, parseFilePatch(file.text));
  return map;
}

/** 一页（一个文件）在列表里的位置，给“上一个 / 下一个”。 */
export interface FilePage {
  index: number;
  count: number;
  previous?: string;
  next?: string;
}

export function filePage(files: readonly DiffFile[], path: string): FilePage | undefined {
  const index = files.findIndex((file) => file.path === path);
  if (index < 0) return undefined;
  const previous = files[index - 1]?.path;
  const next = files[index + 1]?.path;
  return {
    index,
    count: files.length,
    ...(previous !== undefined && { previous }),
    ...(next !== undefined && { next }),
  };
}

/** 文件为什么没有 diff：二进制、超过上限、没有内容的改动（只改了权限、空文件）。有 diff 时 undefined。 */
export type NoDiffReason = 'binary' | 'too_large' | 'empty';

export function noDiffReason(file: DiffFile, rows: readonly DiffRow[]): NoDiffReason | undefined {
  if (file.binary === true) return 'binary';
  if (file.omitted !== undefined) return 'too_large';
  return rows.length === 0 ? 'empty' : undefined;
}

/** 等宽字体下一行的宽度大致按字符数算；全角字符占两格。制表符先由 `displayLine` 换成空格。 */
export function columns(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += code >= 0x1100 && isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** 路径拆成文件名与所在目录（目录带结尾的 `/`，根目录下是空串）。 */
export function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? { name: path, dir: '' }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash + 1) };
}

/** 一行最多显示这么多个字符，再长（压缩过的脚本、数据）截掉，免得一行的文字排版太宽。 */
export const MAX_LINE_CHARS = 1000;

/** 显示用的一行：制表符换成四个空格，过长的截断。 */
export function displayLine(text: string): string {
  const expanded = text.includes('\t') ? text.replace(/\t/g, '    ') : text;
  return expanded.length > MAX_LINE_CHARS ? `${expanded.slice(0, MAX_LINE_CHARS)}…` : expanded;
}

/** 一组行里最宽的一行（等宽字符数），给横向滚动的宽度。 */
export function widestLine(lines: readonly string[]): number {
  let widest = 0;
  for (const line of lines) {
    // 宽字符最多占两格：字符数的两倍都不超过当前最宽的，不必细算。
    if (line.length * 2 <= widest) continue;
    widest = Math.max(widest, columns(line));
  }
  return widest;
}
