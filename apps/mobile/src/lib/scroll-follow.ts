// 会话时间线贴着底部的规则：什么时候跟随新内容、什么时候浮出“最新消息”按钮。纯逻辑，页面把滚动事件交进来。

/** 一次滚动事件里的尺寸（iOS 的 contentOffset 等，单位 pt）。 */
export interface ScrollMetrics {
  contentHeight: number;
  offset: number;
  viewport: number;
}

/** 松手时离底部不到这么远就继续跟随。 */
export const FOLLOW_DISTANCE = 120;
/** 离底部超过这么远时浮出“最新消息”按钮。 */
export const LATEST_DISTANCE = 240;

export function distanceFromEnd(m: ScrollMetrics): number {
  return m.contentHeight - m.offset - m.viewport;
}

export function showsLatest(m: ScrollMetrics): boolean {
  return distanceFromEnd(m) > LATEST_DISTANCE;
}

/**
 * 只认用户拖动来决定跟不跟随：程序滚动在 iOS 上也会触发 onMomentumScrollEnd，读到的偏移可能已经过时。
 * 拖动与随后的惯性期间不自己滚到底，免得和手指抢。
 */
export class ScrollFollow {
  following = true;
  #dragging = false;

  beginDrag(): void {
    this.#dragging = true;
  }

  /** 松手。带速度时还有惯性，等 `momentumEnd` 再算拖动结束。 */
  endDrag(m: ScrollMetrics, velocity: number): void {
    this.#settle(m);
    if (velocity === 0) this.#dragging = false;
  }

  momentumEnd(m: ScrollMetrics): void {
    this.#settle(m);
    this.#dragging = false;
  }

  /**
   * 点“最新消息”或发出消息：回到跟随。惯性还没停时点的，被打断的那段惯性随后还会报一次 onMomentumScrollEnd，
   * 偏移还在上面；这里先结束拖动，那次事件就不会把跟随关掉。
   */
  jump(): void {
    this.following = true;
    this.#dragging = false;
  }

  /** 展开或收起消息流中间的一段：停止跟随，留在点的那一处，不被内容变高推到底部。 */
  release(): void {
    this.following = false;
  }

  /** 内容或可视区变了时要不要滚到底。 */
  get sticks(): boolean {
    return this.following && !this.#dragging;
  }

  #settle(m: ScrollMetrics): void {
    if (!this.#dragging) return;
    this.following = distanceFromEnd(m) < FOLLOW_DISTANCE;
  }
}
