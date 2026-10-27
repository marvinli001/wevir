// 频道列表的预览行（`Channel.lastPost.preview`）：帖子正文是 Markdown，列表里只放一行纯文字。取第一行有字的内容，去掉
// 块级记号（标题、引用、列表、任务框）与行内记号（强调、删除线、行内代码、链接与图片），表格行的格子用 ` · ` 连起来；
// 代码围栏、表格分隔行与分隔线跳过。不求完整解析 Markdown，只求列表里看不到记号。

const FENCE = /^\s*(```|~~~)/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** `text` 的第一行有字的内容，去掉 Markdown 记号；没有时空串。 */
export function plainPreviewLine(text: string): string {
  for (const raw of text.split('\n')) {
    if (raw.trim() === '' || FENCE.test(raw) || TABLE_DIVIDER.test(raw) || RULE.test(raw)) continue;
    const line = plainLine(raw);
    if (line !== '') return line;
  }
  return '';
}

function plainLine(raw: string): string {
  let line = raw
    .trim()
    .replace(/^(>\s*)+/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '');
  if (line.startsWith('|')) {
    line = line
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell !== '')
      .join(' · ');
  }
  return inline(line).trim();
}

function inline(text: string): string {
  return (
    text
      // 行内代码先换成占位，里面的记号原样保留。
      .replace(/`+([^`]+)`+/g, (_, code: string) => `\uE000${code}\uE001`)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
      .replace(/(\*\*|__)(?=\S)([^\uE000]*?\S)\1/g, '$2')
      .replace(/~~(?=\S)([^\uE000]*?\S)~~/g, '$1')
      .replace(/(^|[^\w*])\*(?=\S)([^*\uE000]*?\S)\*(?![\w*])/g, '$1$2')
      .replace(/(^|[^\w_])_(?=\S)([^_\uE000]*?\S)_(?![\w_])/g, '$1$2')
      .replace(/[\uE000\uE001]/g, '')
  );
}
