import type { ToolPart, WorkEntry } from './tool-model';

// 文件改动的预览（§56，照 Codex 桌面端）：把一次修改 / 写文件的输入整理成按文件的若干行，带新旧文件里的行号。认的输入同
// tool-model.ts 的 editStats：Codex 的 `fileChange`（`changes[].diff`：新建与删除是文件全文，修改是统一 diff）；dsh 与
// Claude 的 edit（`old_string` / `new_string`）与 write（`content`）。只有路径没有内容的（Antigravity 的 locations）没有预览。

export interface PreviewLine {
  kind: 'add' | 'remove' | 'context';
  text: string;
  /** 文件里的行号：新增与上下文是新文件的，删除是旧文件的；不知道位置时（替换一段文字）省略。 */
  number?: number;
}

/** 一个文件的预览。`gap` 标在一段之前，表示和上一段之间隔着没改的行（统一 diff 的第二个及之后的 `@@`）。 */
export interface FilePreview {
  path: string;
  lines: Array<PreviewLine & { gap?: true }>;
}

/** 一次修改 / 写文件的预览，没有可以预览的内容时为 undefined。 */
export function filePreviews(part: ToolPart): FilePreview[] | undefined {
  if (part.display.kind !== 'edit' && part.display.kind !== 'write') return undefined;
  const input = part.input;
  if (!isRecord(input)) return undefined;
  if (Array.isArray(input.changes)) {
    const previews = input.changes.flatMap((change: unknown): FilePreview[] => {
      if (!isRecord(change) || typeof change.path !== 'string' || typeof change.diff !== 'string') {
        return [];
      }
      const kind = isRecord(change.kind) ? change.kind.type : undefined;
      const lines =
        kind === 'add'
          ? wholeFile(change.diff, 'add')
          : kind === 'delete'
            ? wholeFile(change.diff, 'remove')
            : unifiedDiff(change.diff);
      return lines.length > 0 ? [{ path: change.path, lines }] : [];
    });
    return previews.length > 0 ? previews : undefined;
  }
  const path =
    part.display.paths?.find((candidate) => candidate.trim() !== '') ??
    (typeof input.file_path === 'string' ? input.file_path : undefined) ??
    (typeof input.path === 'string' ? input.path : undefined) ??
    '';
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const lines = replacement(input.old_string, input.new_string);
    return lines.length > 0 ? [{ path, lines }] : undefined;
  }
  if (typeof input.content === 'string') {
    const lines = wholeFile(input.content, 'add');
    return lines.length > 0 ? [{ path, lines }] : undefined;
  }
  return undefined;
}

/**
 * 进行中的工作组里自动展开预览的一条（§56）：列出来的最近一次成功的修改 / 写文件。之后又写了别的文件时换成那一条；这一组
 * 做完（后面有了正文或回合结束）就不再自动展开，点开那一行才看到。
 */
export function livePreviewKey(listed: readonly WorkEntry[]): string | undefined {
  return listed.findLast(
    (entry) =>
      entry.type === 'tool' && entry.status === 'completed' && filePreviews(entry) !== undefined,
  )?.key;
}

/** 整个文件都是新增（新建、写入）或都是删除：行号从 1 起。 */
function wholeFile(text: string, kind: 'add' | 'remove'): PreviewLine[] {
  return splitLines(text).map((line, index) => ({ kind, text: line, number: index + 1 }));
}

/** 统一 diff：`@@ -a,b +c,d @@` 定行号；第一个 `@@` 之前的文件头（`diff --git`、`---`、`+++` 等）不要。 */
function unifiedDiff(diff: string): FilePreview['lines'] {
  const lines: FilePreview['lines'] = [];
  let inHunk = false;
  let gap = false;
  let oldNumber: number | undefined;
  let newNumber: number | undefined;
  for (const line of splitLines(diff)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk || line.startsWith('@@')) {
      gap = inHunk;
      inHunk = true;
      oldNumber = hunk ? Number(hunk[1]) : undefined;
      newNumber = hunk ? Number(hunk[2]) : undefined;
      continue;
    }
    if (!inHunk || line.startsWith('\\') || line === '*** End of File') continue;
    const sign = line[0];
    const kind = sign === '+' ? 'add' : sign === '-' ? 'remove' : 'context';
    const number = kind === 'remove' ? oldNumber : newNumber;
    lines.push({
      kind,
      // 有的 diff 把空的上下文行写成空行（连前面的空格也没有）。
      text: sign === '+' || sign === '-' || sign === ' ' ? line.slice(1) : line,
      ...(number !== undefined && { number }),
      ...(gap && { gap: true as const }),
    });
    gap = false;
    if (kind !== 'add' && oldNumber !== undefined) oldNumber += 1;
    if (kind !== 'remove' && newNumber !== undefined) newNumber += 1;
  }
  return lines;
}

/** 替换一段文字：首尾相同的行是上下文，中间旧的算删除、新的算新增（同 editStats 的计法）；不知道在文件里的位置，没有行号。 */
function replacement(before: string, after: string): PreviewLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const context = (text: string): PreviewLine => ({ kind: 'context', text });
  return [
    ...a.slice(0, head).map(context),
    ...a.slice(head, a.length - tail).map((text): PreviewLine => ({ kind: 'remove', text })),
    ...b.slice(head, b.length - tail).map((text): PreviewLine => ({ kind: 'add', text })),
    ...b.slice(b.length - tail).map(context),
  ];
}

/** 按行切开；结尾的换行不算多出一行。 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r?\n$/, '').split(/\r?\n/);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
