/** 分段展开的列表（侧栏会话列表的“显示更多 / 收起”）：先列 `step` 项，每次再多列 `step` 项，收起回到 `step` 项。 */
export interface MoreWindow {
  /** 现在列出几项。 */
  visible: number;
  /** 收起时留下几项：当前项排在第一段后面时留到它所在的那一段。 */
  floor: number;
  /** 后面还有没列出的，显示“显示更多”。 */
  more: boolean;
  /** 列出的比收起时多，显示“收起”。 */
  less: boolean;
}

/** `shown` 是用户点出来的项数（初始与收起后是 `step`），`activeIndex` 是当前项的下标（没有是 -1）。 */
export function moreWindow(
  length: number,
  step: number,
  shown: number,
  activeIndex: number,
): MoreWindow {
  const floor = Math.min(length, Math.max(step, Math.ceil((activeIndex + 1) / step) * step));
  const visible = Math.min(length, Math.max(shown, floor));
  return { visible, floor, more: visible < length, less: visible > floor };
}

/** 第一段之后每段的起点与项，各自一个展开收起的过渡。 */
export function moreChunks<T>(items: readonly T[], step: number) {
  const chunks: { start: number; items: readonly T[] }[] = [];
  for (let start = step; start < items.length; start += step)
    chunks.push({ start, items: items.slice(start, start + step) });
  return chunks;
}
