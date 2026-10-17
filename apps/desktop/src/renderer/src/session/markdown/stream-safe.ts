// 流式 Markdown 的末尾修补：还没写完的语法先不露出来。思路同 Vercel streamdown 的 remend（没有移植代码）：只动文本末尾，
// 写完以后与整篇渲染一致。
//
// - 末行是还没写完的围栏开头（``` 加半截语言名）：先不显示这一行；
// - 末行只有块标记（`#`、`-`、`1.`、`>`）：先不显示；
// - 末尾以 `|` 开头的几行还没有分隔行（`|---|`）：表头先不显示，分隔行到了整张表一起出现；
// - 末行没闭合的 `**`、`*`、`~~`、`` ` ``：补上闭合（刚写出开头、后面还没有字时去掉开头）；
// - 末行写到一半的链接 `[文字](https://…`：先只显示文字。
//
// 只看末行与末尾的表格行，代码块里的内容不动。

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function lastLineStart(text: string): number {
  return text.lastIndexOf('\n') + 1;
}

/** 末尾是否在没闭合的围栏代码块里。 */
function insideFence(lines: readonly string[]): boolean {
  let open: string | undefined;
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (!match) continue;
    const marker = match[1] as string;
    if (open === undefined) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length && line.trim() === marker) {
      open = undefined;
    }
  }
  return open !== undefined;
}

const SEPARATOR = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const TABLE_ROW = /^ {0,3}\|/;

function cellCount(row: string): number {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length;
}

/** 末尾的表格行（以 `|` 开头）还没有完整的分隔行（列数与表头相同、已经换行）时，去掉这几行。 */
function hidePendingTable(text: string): string {
  const complete = text.endsWith('\n');
  const lines = (complete ? text.slice(0, -1) : text).split('\n');
  let first = lines.length;
  while (first > 0 && TABLE_ROW.test(lines[first - 1] as string)) first -= 1;
  if (first === lines.length) return text;
  const rows = lines.slice(first);
  const header = rows[0] as string;
  const separator = rows[1];
  const established =
    separator !== undefined &&
    SEPARATOR.test(separator) &&
    cellCount(separator) === cellCount(header) &&
    (rows.length >= 3 || complete);
  if (established) return text;
  return first === 0 ? '' : `${lines.slice(0, first).join('\n')}\n`;
}

const BARE_MARKER = /^ {0,3}(?:#{1,6}|[-*+]|\d{1,9}[.)]?|>)\s*$/;
const PARTIAL_FENCE = /^ {0,3}(?:`{1,2}|~{1,2}|`{3,}[^`]*|~{3,}.*)$/;

/** 去掉还没换行的末行里写到一半的链接与图片：只留文字。 */
function trimPartialLink(line: string): string {
  return line.replace(/!?\[([^[\]]*)\]\([^()\s]*$/, '$1').replace(/!?\[([^[\]]*)$/, '$1');
}

/** 行内代码之外的部分，代码换成同长度的占位，下标不变。 */
function maskInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (code) => ' '.repeat(code.length));
}

function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

/**
 * 一种强调标记在末行里是否没闭合：按左右是否贴着字认开头与结尾（CommonMark 的 flanking 的简化）。返回没闭合的开头的下标，
 * 都闭合了是 -1。`*` 不认 `**` 里的。
 */
function unclosed(masked: string, marker: string): number {
  let open = -1;
  for (let index = 0; index < masked.length; ) {
    if (!masked.startsWith(marker, index)) {
      index += 1;
      continue;
    }
    const before = masked[index - 1];
    const after = masked[index + marker.length];
    if (marker === '*' && (before === '*' || after === '*')) {
      index += 1;
      continue;
    }
    if (open >= 0 && !isSpace(before)) open = -1;
    else if (open < 0 && !isSpace(after)) open = index;
    index += marker.length;
  }
  return open;
}

const MARKERS = ['~~', '**', '*'] as const;

/** 末尾那串标记（`**`、`*`、`~~`、`` ` ``）是不是刚写出的开头：前面没有它能闭合的开头。 */
function danglingAt(line: string): number | undefined {
  const run = /[*~`]+$/.exec(line);
  if (!run) return undefined;
  const head = line.slice(0, run.index);
  const tail = run[0];
  if (tail.includes('`') && (head.match(/`/g) ?? []).length % 2 === 1) return undefined;
  const masked = maskInlineCode(head);
  for (const marker of MARKERS) {
    if (tail.includes(marker) && unclosed(masked, marker) >= 0) return undefined;
  }
  return run.index;
}

function closeEmphasis(line: string): string {
  const dangling = danglingAt(line);
  let result = dangling === undefined ? line : line.slice(0, dangling);
  if ((result.match(/`/g) ?? []).length % 2 === 1) result += '`';
  const masked = maskInlineCode(result);
  // 后开的先闭合。
  const open = MARKERS.map((marker) => ({ marker, at: unclosed(masked, marker) }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => b.at - a.at);
  return result + open.map(({ marker }) => marker).join('');
}

/** 流式时给渲染器的文本：修补末尾。文本写完以后结果与原文渲染一致。 */
export function repairStreamingMarkdown(text: string): string {
  if (text === '') return text;
  // 末行之前已经在代码块里：末行是代码或写到一半的闭合围栏，都原样显示。
  if (insideFence(text.split('\n').slice(0, -1))) return text;
  let result = text;
  const start = lastLineStart(result);
  const last = result.slice(start);
  if (last !== '' && (PARTIAL_FENCE.test(last) || BARE_MARKER.test(last))) {
    result = result.slice(0, start);
  }
  result = hidePendingTable(result);
  const lineStart = lastLineStart(result);
  const line = result.slice(lineStart);
  if (line.trim() === '') return result;
  // 末行在表格里（分隔行之后正在写的行）时不补强调，竖线之间的标记各算各的。
  if (TABLE_ROW.test(line)) return result;
  const repaired = closeEmphasis(trimPartialLink(line));
  return result.slice(0, lineStart) + repaired;
}
