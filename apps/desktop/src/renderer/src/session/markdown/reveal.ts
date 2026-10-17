// 流式回答的渐进显示：收到的文字先进缓冲，按帧匀速放出来（落后越多放得越快），新放出的字淡入。纯逻辑与 DOM 小工具，
// 由 markdown-view.tsx 的 useStreamingReveal 驱动。

/** 两次放字之间至少隔多久（约 30 帧每秒：每帧都要重新 lex 与清洗末尾的块）。 */
export const REVEAL_FRAME_MS = 32;
/** 新字淡入的时长；回答写完后等这么久再换成整篇渲染，最后几个字的淡入不被打断。 */
export const FRESH_FADE_MS = 360;

/** 最慢每秒放多少字：缓冲很少时也像在打字，不会一顿一顿。 */
const MIN_CHARS_PER_SECOND = 60;
/** 缓冲多久能放完：落后的字数除以它就是速度。 */
const CATCH_UP_MS = 320;
/** 回答写完以后剩下的放得更快。 */
const FINISH_MS = 140;

/**
 * 下一帧显示到第几个字（UTF-16 下标）。`shown` 是现在显示的，`target` 是收到的全文，`elapsedMs` 是离上一帧多久，
 * `ended` 是不会再有新字了。不会切开代理对。
 */
export function revealStep(
  shown: number,
  target: string,
  elapsedMs: number,
  ended: boolean,
): number {
  const backlog = target.length - shown;
  if (backlog <= 0) return target.length;
  const perMs = Math.max(MIN_CHARS_PER_SECOND / 1000, backlog / (ended ? FINISH_MS : CATCH_UP_MS));
  let next = Math.min(target.length, shown + Math.max(1, Math.round(perMs * elapsedMs)));
  const code = target.charCodeAt(next - 1);
  if (code >= 0xd800 && code <= 0xdbff && next < target.length) next += 1;
  return next;
}

/** 一段新出现的字：在整篇文字（`textContent`）里的下标范围与出现的时刻。 */
export interface FreshRange {
  start: number;
  end: number;
  at: number;
}

/**
 * 这一帧之后还在淡入的范围：文字变长时把新的一段记下，过了淡入时长的去掉，文字变短（末尾修补收回了半截语法）时截掉。
 */
export function trackFresh(
  ranges: readonly FreshRange[],
  previousLength: number,
  length: number,
  now: number,
): FreshRange[] {
  const kept = ranges
    .filter((range) => now - range.at < FRESH_FADE_MS)
    .map((range) => ({ ...range, end: Math.min(range.end, length) }))
    .filter((range) => range.start < range.end);
  if (length > previousLength) kept.push({ start: previousLength, end: length, at: now });
  return kept;
}

/**
 * 把一个块里落在淡入范围内的字包进 `span.md-fresh`。`offset` 是这个块的第一个字在整篇文字里的下标。块是刚换了 HTML 的
 * （旧的 span 已经没了）；`animation-delay` 取负的已过时长，重画的块接着上一帧的淡入进度，不会从头闪一下。只含空白的文字
 * 节点不包（表格、列表元素之间的换行，包了会多出匿名单元格）。
 */
export function wrapFresh(
  block: Element,
  offset: number,
  ranges: readonly FreshRange[],
  now: number,
): void {
  if (ranges.length === 0) return;
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let position = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    nodes.push({ node: text, start: position });
    position += text.data.length;
  }
  for (const { node, start } of nodes) {
    if (node.data.trim() === '') continue;
    const end = start + node.data.length;
    // 从后往前切，前面的下标不受影响。
    const hits = ranges
      .filter((range) => range.start < end && range.end > start)
      .sort((a, b) => b.start - a.start);
    for (const range of hits) {
      const from = Math.max(range.start, start) - start;
      const to = Math.min(range.end, end) - start;
      if (to < node.data.length) node.splitText(to);
      const piece = from > 0 ? node.splitText(from) : node;
      const span = block.ownerDocument.createElement('span');
      span.className = 'md-fresh';
      span.style.animationDelay = `-${Math.round(now - range.at)}ms`;
      piece.replaceWith(span);
      span.append(piece);
    }
  }
}
