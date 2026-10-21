// 消息流的章节（0.82.0，`chapter.marked`）：目录按滚动位置算出正在读的那一章。纯函数，chapter-nav.tsx 从 DOM 量出位置后调用。

import type { TranscriptChapter } from '@wevir/client-sdk';

/** 目录在会话有几章起出现：只有一章时目录只有一项，没有用。 */
export const CHAPTER_NAV_MIN = 2;

/** 一个画出来的分隔线：`top` 相对滚动区域可视部分的顶边。 */
export interface ChapterAnchor {
  key: string;
  top: number;
}

/**
 * 正在读的那一章（`chapters` 里的下标），在第一章之前时是 -1。从后往前找第一个“已经读到”的章节：分隔线画出来了、在 `threshold`
 * 以上；没画出来的（分段渲染还没铺到更早的消息）在最早画出来的那一块之前（`seq` 小于 `firstRenderedSeq`）就算读过了。
 */
export function currentChapter(
  chapters: readonly TranscriptChapter[],
  anchors: readonly ChapterAnchor[],
  firstRenderedSeq: number | undefined,
  threshold: number,
): number {
  const tops = new Map(anchors.map((anchor) => [anchor.key, anchor.top]));
  for (let index = chapters.length - 1; index >= 0; index -= 1) {
    const chapter = chapters[index] as TranscriptChapter;
    const top = tops.get(chapter.key);
    if (top !== undefined) {
      if (top <= threshold) return index;
    } else if (firstRenderedSeq !== undefined && chapter.seq < firstRenderedSeq) {
      return index;
    }
  }
  return -1;
}
