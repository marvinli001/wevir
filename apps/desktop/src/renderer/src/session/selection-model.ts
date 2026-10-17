// 消息里选中文字的工具条（desktop-tokens §57）：选区能不能引用、引用成什么文字、工具条放在哪。都是不碰 DOM 的纯逻辑，
// DOM 一侧（Selection / Range、事件、渲染）在 selection-toolbar.tsx。

/** 一块区域：选区的两端要落在同一个可引用的区域里（一段回答的文字、一条用户消息）。 */
export interface SelectionProbe<Region> {
  /** `Selection.toString()`：按排版带换行的选中文字。 */
  text: string;
  collapsed: boolean;
  /** 选区起点所在的可引用区域；不在任何区域里时 `null`。 */
  start: Region | null;
  /** 选区终点所在的可引用区域。 */
  end: Region | null;
  /** 任一端落在不能引用的地方（输入框、按钮、工具行……）。 */
  blocked: boolean;
}

/**
 * 能引用的选区返回整理后的文字，否则 `undefined`：折叠的、两端不在同一个区域（跨了多条消息或多段）、落在不能引用的元素里、
 * 只有空白的都不行。
 */
export function quotableText<Region>(probe: SelectionProbe<Region>): string | undefined {
  if (probe.collapsed || probe.blocked) return undefined;
  if (probe.start === null || probe.end === null || probe.start !== probe.end) return undefined;
  const text = normalizeSelection(probe.text);
  return text === '' ? undefined : text;
}

/**
 * 整理选中的文字：统一换行、不换行空格换成空格、去掉每行行尾的空白与首尾的空行、连续的空行压成一行。文字本身不动——
 * 不加任何 Markdown 记号，选中的是渲染后的什么就是什么。
 */
export function normalizeSelection(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/** 引用块：每行前面一个 `> `，空行只留 `>`（Markdown 的块引用，模型照常读）。 */
export function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * 把选中的文字作为引用追加到输入框的文字后面：已有内容时隔一个空行，引用后面留一个空行，光标落在末尾、可以接着写。
 * 选区整理后是空的时返回 `undefined`（输入框不动）。
 */
export function appendQuote(
  current: string,
  selected: string,
): { text: string; cursor: number } | undefined {
  const quote = normalizeSelection(selected);
  if (quote === '') return undefined;
  const base = current.trim() === '' ? '' : `${current.replace(/\s+$/, '')}\n\n`;
  const text = `${base}${quoteBlock(quote)}\n\n`;
  return { text, cursor: text.length };
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface ToolbarPlacement {
  left: number;
  top: number;
  /** 在选区的上方还是下方；大选区盖住了两边时挤在可见区域的顶部。 */
  side: 'above' | 'below' | 'inside';
}

/** 工具条与选区之间、与可见区域边缘之间的空隙。 */
export const TOOLBAR_GAP = 8;
export const TOOLBAR_MARGIN = 8;

/**
 * 工具条的位置（视口坐标）：默认在选区第一行的上方、水平居中；上方放不下（贴着可见区域的顶部）就翻到最后一行的下方；
 * 上下都放不下（选区比可见区域还高）时贴着可见区域的顶部。水平方向夹在视口里。选区完全滚出了可见区域时 `null`。
 *
 * `first` / `last` 是选区第一行与最后一行的矩形，`bounds` 是选区所在的可见区域（消息流的视口，已与窗口求过交）。
 */
export function toolbarPlacement(
  first: Rect,
  last: Rect,
  size: Size,
  bounds: Rect,
  viewport: Size,
): ToolbarPlacement | null {
  if (last.bottom < bounds.top || first.top > bounds.bottom) return null;
  const center = (first.left + first.right) / 2;
  const maxLeft = Math.max(TOOLBAR_MARGIN, viewport.width - size.width - TOOLBAR_MARGIN);
  const left = clamp(center - size.width / 2, TOOLBAR_MARGIN, maxLeft);
  const above = first.top - TOOLBAR_GAP - size.height;
  if (above >= bounds.top + TOOLBAR_MARGIN) return { left, top: above, side: 'above' };
  const below = last.bottom + TOOLBAR_GAP;
  if (below + size.height <= bounds.bottom - TOOLBAR_MARGIN) {
    return { left, top: below, side: 'below' };
  }
  return { left, top: bounds.top + TOOLBAR_MARGIN, side: 'inside' };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
