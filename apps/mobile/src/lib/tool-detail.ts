// 工具一行点开后的内容（同桌面端 tool-details.tsx、tool-model.ts 与 file-preview-model.ts）：修改与写文件是按文件的改动预览，
// 别的是参数与结果（带退出码）；失败的那行下面一行说明取结果的第一行。纯逻辑。

import type { ChatPartOf } from '@wevir/client-sdk';

type ToolPart = ChatPartOf<'tool'>;

export interface PreviewLine {
  kind: 'add' | 'remove' | 'context';
  text: string;
  /** 文件里的行号：新增与上下文是新文件的，删除是旧文件的；不知道位置时（替换一段文字）省略。 */
  number?: number;
  /** 和上一段之间隔着没改的行（统一 diff 的第二个及之后的 `@@`）。 */
  gap?: true;
}

export interface FilePreview {
  path: string;
  lines: PreviewLine[];
}

/** 一段文字，过长时只给开头（`truncatedFrom` 是原长）。 */
export interface DetailText {
  text: string;
  truncatedFrom?: number;
}

export type ToolDetail =
  /** 修改与写文件：按文件的改动；没成功时另带结果。 */
  | { kind: 'previews'; previews: FilePreview[]; output?: string }
  /**
   * 参数与结果。`output` 省略是没有输出；`showOutput` 为 false 时不写结果一段（托管的网页搜索只把结果交给模型）。
   */
  | {
      kind: 'io';
      input: DetailText;
      showOutput: boolean;
      output?: DetailText;
      exitCode?: number;
    };

/** 手机上一段文字最多画多少字：再长 Text 排版就卡了。 */
export const DETAIL_TEXT_MAX = 20_000;

function clip(text: string, originalLength = text.length): DetailText {
  if (text.length <= DETAIL_TEXT_MAX && originalLength === text.length) return { text };
  return { text: text.slice(0, DETAIL_TEXT_MAX), truncatedFrom: originalLength };
}

export function toolDetail(part: ToolPart): ToolDetail {
  const previews = filePreviews(part);
  if (previews !== undefined) {
    const output = part.status !== 'completed' ? part.output?.text : undefined;
    return {
      kind: 'previews',
      previews,
      ...(output !== undefined && output !== '' && { output: clip(output).text }),
    };
  }
  const output = part.output;
  return {
    kind: 'io',
    input: formatJson(toolParameters(part) ?? {}),
    showOutput: !(part.toolName === 'webSearch' && part.status === 'completed' && !output?.text),
    ...(output !== undefined && {
      output: clip(
        output.text,
        output.truncated === true ? (output.originalLength ?? output.text.length) : undefined,
      ),
    }),
    ...(part.exitCode !== undefined && { exitCode: part.exitCode }),
  };
}

/**
 * 失败那行下面的一行说明：结果的第一行非空文字。命令以非零退出码失败时不写：退出码在详情里，此前的成功输出也不是失败原因。
 */
export function failureSummary(part: ToolPart): string | undefined {
  if (part.status === 'failed' && part.exitCode !== undefined && part.exitCode !== 0) {
    return undefined;
  }
  const text = part.output?.text;
  if (!text) return undefined;
  for (const line of text.split('\n')) {
    if (line.trim()) return line.trim();
  }
  return undefined;
}

/** 参数：Codex 的命令只留命令、目录与理由；MCP 与动态工具是它们的参数；托管的网页搜索是动作。 */
function toolParameters(part: ToolPart): unknown {
  const input = part.input;
  if (!isRecord(input)) return input;
  if (part.toolName === 'commandExecution' && input.type === 'commandExecution') {
    return {
      command: input.command,
      cwd: input.cwd,
      ...(input.justification !== undefined && { justification: input.justification }),
    };
  }
  if (input.type === 'mcpToolCall' || input.type === 'dynamicToolCall') return input.arguments;
  if (part.toolName === 'webSearch' && input.type === 'webSearch') {
    return isRecord(input.action) ? input.action : { query: input.query };
  }
  return input;
}

/** 参数写成 JSON；Host 截断过的（`$truncated`）只有开头。 */
function formatJson(value: unknown): DetailText {
  if (
    isRecord(value) &&
    value.$truncated === true &&
    typeof value.preview === 'string' &&
    typeof value.originalLength === 'number'
  ) {
    return clip(value.preview, value.originalLength);
  }
  if (typeof value === 'string') return clip(value);
  try {
    return clip(JSON.stringify(value, null, 2) ?? '');
  } catch {
    return clip(String(value));
  }
}

/**
 * 一次修改 / 写文件的预览，没有可以预览的内容时为 undefined。认 Codex 的 `fileChange`（`changes[].diff`：新建与删除是文件全文，
 * 修改是统一 diff），dsh 与 Claude 的 edit（`old_string` / `new_string`）与 write（`content`）。
 */
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

/** 整个文件都是新增（新建、写入）或都是删除：行号从 1 起。 */
function wholeFile(text: string, kind: 'add' | 'remove'): PreviewLine[] {
  return splitLines(text).map((line, index) => ({ kind, text: line, number: index + 1 }));
}

/** 统一 diff：`@@ -a,b +c,d @@` 定行号；第一个 `@@` 之前的文件头不要。 */
function unifiedDiff(diff: string): PreviewLine[] {
  const lines: PreviewLine[] = [];
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

/** 替换一段文字：首尾相同的行是上下文，中间旧的算删除、新的算新增；不知道在文件里的位置，没有行号。 */
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
