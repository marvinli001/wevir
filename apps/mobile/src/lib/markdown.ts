// 回答里的 Markdown 解析成块与行内片段，画在 components/markdown.tsx。只认聊天回答常见的写法：标题、段落、列表（含任务框与
// 缩进的子列表）、引用、代码块、表格、分隔线；行内是粗体、斜体、删除线、行内代码、链接与裸露的网址。不支持的写法原样当文字。
// 纯逻辑。

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em' | 'del'; children: Inline[] }
  | { kind: 'link'; url: string; children: Inline[] };

export interface ListItem {
  /** 任务框：`- [x]` 为真，`- [ ]` 为假；普通列表项省略。 */
  checked?: boolean;
  inline: Inline[];
  /** 缩进的子列表。 */
  children: Block[];
}

/** 表格一列的对齐：分隔行里 `:---` 左、`:---:` 中、`---:` 右，没有冒号按左。 */
export type TableAlign = 'left' | 'center' | 'right';

export type Block =
  | { kind: 'heading'; level: number; inline: Inline[] }
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; header: Inline[][]; align: TableAlign[]; rows: Inline[][][] }
  | { kind: 'rule' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, '\n').split('\n'));
}

function parseBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith(marker)) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      blocks.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1]?.length ?? 1,
        inline: parseInline(heading[2] ?? ''),
      });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        body.push(QUOTE.exec(lines[i] ?? '')?.[1] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(body) });
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = splitRow(line).map(parseInline);
      const columns = header.length;
      const align = splitRow(lines[i + 1] ?? '')
        .slice(0, columns)
        .map(alignOf);
      while (align.length < columns) align.push('left');
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        // 每行的格子数按表头：多的丢掉，少的补空格子，列才对得齐。
        const row = splitRow(lines[i] ?? '')
          .slice(0, columns)
          .map(parseInline);
        while (row.length < columns) row.push([]);
        rows.push(row);
        i += 1;
      }
      blocks.push({ kind: 'table', header, align, rows });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const end = listEnd(lines, i);
      blocks.push(parseList(lines.slice(i, end)));
      i = end;
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !startsBlock(lines, i)) {
      body.push((lines[i] ?? '').trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', inline: parseInline(body.join('\n')) });
  }
  return blocks;
}

function startsBlock(lines: readonly string[], i: number): boolean {
  const line = lines[i] ?? '';
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    isTableStart(lines, i)
  );
}

function isTableStart(lines: readonly string[], i: number): boolean {
  const line = lines[i] ?? '';
  const next = lines[i + 1] ?? '';
  return line.includes('|') && next.includes('-') && TABLE_DIVIDER.test(next);
}

/** 一行表格的各格文字：去掉首尾的竖线，按没转义的竖线切开，`\\|` 还原成竖线。 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  const body = line.trim();
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === '\\' && body[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (char === '|') {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  if (body.startsWith('|')) cells.shift();
  if (cells.length > 1 && cells.at(-1) === '') cells.pop();
  return cells.map((text) => text.trim());
}

function alignOf(divider: string): TableAlign {
  const left = divider.startsWith(':');
  const right = divider.endsWith(':');
  return left && right ? 'center' : right ? 'right' : 'left';
}

/** 行内片段的纯文字（量列宽用）。 */
export function plainText(inline: readonly Inline[]): string {
  return inline.map((span) => ('text' in span ? span.text : plainText(span.children))).join('');
}

/**
 * 表格各列的宽度（点）：按这一列最长的格子估算，全角字按两个字宽，夹在 `min` 与 `max` 之间，超出的格子在列里换行。
 * RN 的 Text 量不出宽度再回头排版，各行按同一组列宽排，列才对得齐。
 */
export function tableColumnWidths(
  block: { header: readonly Inline[][]; rows: readonly Inline[][][] },
  {
    charWidth,
    padding,
    min,
    max,
  }: { charWidth: number; padding: number; min: number; max: number },
): number[] {
  return block.header.map((_, column) => {
    let widest = 0;
    for (const row of [block.header, ...block.rows]) {
      let units = 0;
      for (const char of plainText(row[column] ?? [])) {
        units += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
      }
      widest = Math.max(widest, units);
    }
    return Math.min(max, Math.max(min, Math.ceil(widest * charWidth + padding)));
  });
}

/** 列表到哪一行为止：空行后不再缩进的行、不是列表项也不缩进的行、同一层换了种类（有序与无序）的列表项结束它。 */
function listEnd(lines: readonly string[], start: number): number {
  const first = LIST_ITEM.exec(lines[start] ?? '');
  const indent = first?.[1]?.length ?? 0;
  const ordered = first?.[3] !== undefined;
  const sameList = (line: string) => {
    const item = LIST_ITEM.exec(line);
    if (item === null) return false;
    return (item[1]?.length ?? 0) > indent || (item[3] !== undefined) === ordered;
  };
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      const next = lines[i + 1] ?? '';
      if (next.trim() === '' || !(/^\s+/.test(next) || sameList(next))) return i;
      i += 1;
      continue;
    }
    if (LIST_ITEM.test(line) ? !sameList(line) : !/^\s+/.test(line) && startsBlock(lines, i)) {
      return i;
    }
    i += 1;
  }
  return i;
}

function parseList(lines: readonly string[]): Block {
  const first = LIST_ITEM.exec(lines[0] ?? '');
  const indent = first?.[1]?.length ?? 0;
  const ordered = first?.[3] !== undefined;
  const items: ListItem[] = [];
  let current: { text: string[]; nested: string[] } | undefined;
  const flush = () => {
    if (current === undefined) return;
    let text = current.text.join('\n');
    let checked: boolean | undefined;
    const box = /^\[([ xX])\]\s+/.exec(text);
    if (box) {
      checked = box[1] !== ' ';
      text = text.slice(box[0].length);
    }
    const nested = current.nested.filter((line) => line.trim() !== '');
    items.push({
      ...(checked !== undefined && { checked }),
      inline: parseInline(text),
      children: nested.length > 0 ? parseBlocks(dedent(nested)) : [],
    });
  };
  for (const line of lines) {
    const item = LIST_ITEM.exec(line);
    if (item && (item[1]?.length ?? 0) <= indent) {
      flush();
      current = { text: [item[4] ?? ''], nested: [] };
    } else if (current !== undefined) {
      if (item || current.nested.length > 0) current.nested.push(line);
      else if (line.trim() !== '') current.text.push(line.trim());
    }
  }
  flush();
  return { kind: 'list', ordered, start: ordered ? Number(first?.[3] ?? 1) : 1, items };
}

function dedent(lines: readonly string[]): string[] {
  const widths = lines
    .filter((line) => line.trim() !== '')
    .map((line) => /^\s*/.exec(line)?.[0].length ?? 0);
  const cut = Math.min(...widths);
  return lines.map((line) => line.slice(cut));
}

// 行内：每次找最早出现的记号；嵌套的强调递归解析，行内代码与网址里的记号不再解析。斜体的前一个字符用捕获组判断（不用后行
// 断言），所以记号从第一组之后算起。
const INLINE_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'code', re: /(`+)([\s\S]*?[^`])\1(?!`)/ },
  { kind: 'link', re: /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/ },
  { kind: 'autolink', re: /<(https?:\/\/[^>\s]+)>/ },
  { kind: 'url', re: /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/ },
  { kind: 'strong', re: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/ },
  { kind: 'del', re: /~~(?=\S)([\s\S]*?\S)~~/ },
  { kind: 'em', re: /(^|[^\w*])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?![\w*])/ },
  { kind: 'em', re: /(^|[^\w_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w_])/ },
];

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest !== '') {
    let best: { kind: string; match: RegExpExecArray; start: number } | undefined;
    for (const pattern of INLINE_PATTERNS) {
      const match = pattern.re.exec(rest);
      if (match === null) continue;
      const start = match.index + (pattern.kind === 'em' ? (match[1]?.length ?? 0) : 0);
      if (best === undefined || start < best.start) best = { kind: pattern.kind, match, start };
    }
    if (best === undefined) {
      pushText(out, rest);
      break;
    }
    const { kind, match, start } = best;
    if (start > 0) pushText(out, rest.slice(0, start));
    switch (kind) {
      case 'code':
        out.push({ kind: 'code', text: (match[2] ?? '').trim() });
        break;
      case 'link':
        out.push({ kind: 'link', url: match[2] ?? '', children: parseInline(match[1] ?? '') });
        break;
      case 'autolink':
      case 'url': {
        const url = kind === 'url' ? match[0] : (match[1] ?? '');
        out.push({ kind: 'link', url, children: [{ kind: 'text', text: url }] });
        break;
      }
      case 'strong':
        out.push({ kind: 'strong', children: parseInline(match[2] ?? '') });
        break;
      case 'del':
        out.push({ kind: 'del', children: parseInline(match[1] ?? '') });
        break;
      default:
        out.push({ kind: 'em', children: parseInline(match[2] ?? '') });
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return out;
}

function pushText(out: Inline[], text: string): void {
  const last = out.at(-1);
  if (last?.kind === 'text') last.text += text;
  else out.push({ kind: 'text', text });
}
