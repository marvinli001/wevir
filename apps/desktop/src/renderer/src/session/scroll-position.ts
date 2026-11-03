import { LruMap } from '@/lib/lru';

interface ScrollPosition {
  top: number;
  start?: string;
  anchor?: { id: string; offset: number };
}

/** 只记手动阅读的位置；没有记录的会话从最新消息开始。 */
export const scrollPositions = new LruMap<string, ScrollPosition>(32);

export function captureScrollPosition(
  container: HTMLElement,
  content: HTMLElement,
): ScrollPosition {
  const top = container.getBoundingClientRect().top;
  const anchor = [...content.querySelectorAll<HTMLElement>('[data-message-id]')].find(
    (block) => block.getBoundingClientRect().bottom > top,
  );
  return {
    top: container.scrollTop,
    ...(content.dataset.renderStart && { start: content.dataset.renderStart }),
    ...(anchor && {
      anchor: {
        id: anchor.dataset.messageId as string,
        offset: anchor.getBoundingClientRect().top - top,
      },
    }),
  };
}

export function restoreScrollPosition(
  container: HTMLElement,
  content: HTMLElement,
  position: ScrollPosition,
): void {
  const anchor = position.anchor;
  const block =
    anchor &&
    [...content.querySelectorAll<HTMLElement>('[data-message-id]')].find(
      (block) => block.dataset.messageId === anchor.id,
    );
  container.scrollTop =
    block && anchor
      ? container.scrollTop +
        block.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        anchor.offset
      : position.top;
}
