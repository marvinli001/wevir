// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/src/react-app/domains/session/surface/scroll-controller.ts
//（另参照同目录 scroll-store.ts、scroll-overlay.tsx）
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：改写（T5.3，OpenWork 候选 #3）。保留两种模式的状态机：贴底（stickyBottom）时内容或视口尺寸一变就
// 滚到底，手动（manual）时不动；只有真实的输入手势（滚轮、触摸、导航键、拖滚动条）才能切换模式，布局钳位与
// 程序滚动触发的 scroll 事件不算；手势滚到底部回到贴底；贴底时键盘焦点等把旧内容滚进视野也转为手动；
// overflow-anchor 贴底时为 none、手动时为 auto（手动阅读时由浏览器锚定位置）；发送消息即回到贴底。U2：用户在消息流里
// 点开或收起一处（工作组、回合）时转为手动、保持位置，不被拉回底部（holdPosition）。去掉
// 移动端轮次留白、滚动位置与几何信息的持久化、历史分页、“跳到消息开头”，状态不进全局 store，只交出
// “是否贴底”给“跳到最新”按钮。交互手感一轮：手势停下时离底部不超过 RESNAP_GAP_PX 就吸回贴底；“跳到最新”只在离底部超过
// JUMP_VISIBLE_GAP_PX 时出现，轻推几像素不闪出来。

import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react';

/** 距底部不超过这么多像素算在底部。 */
const BOTTOM_GAP_PX = 2;
/** 手势停下时离底部不超过这么多像素，就吸回贴底（轻推一下不算离开）。 */
export const RESNAP_GAP_PX = 32;
/** 离底部超过这么多像素才显示“跳到最新”。 */
export const JUMP_VISIBLE_GAP_PX = 120;
/** 滚动事件停了这么久算手势停下（触控板惯性期间事件是连续的）。 */
const GESTURE_SETTLE_MS = 160;
/** 手势之后这段时间内的滚动算手势造成的（触控板惯性会比原始事件持续更久）。 */
const GESTURE_WINDOW_MS = 600;
const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/** 手势停下时：离底部不远就吸回贴底。 */
export function shouldResnap(distanceFromBottom: number): boolean {
  return distanceFromBottom > BOTTOM_GAP_PX && distanceFromBottom <= RESNAP_GAP_PX;
}

/** “跳到最新”是否显示：手动模式且离底部够远。 */
export function jumpVisible(sticky: boolean, distanceFromBottom: number): boolean {
  return !sticky && distanceFromBottom > JUMP_VISIBLE_GAP_PX;
}

interface Controller {
  jumpToLatest(behavior: ScrollBehavior): void;
  holdPosition(): void;
  release(): void;
}

export interface StickToBottom {
  /** 贴底模式。 */
  sticky: boolean;
  /** 显示“跳到最新”：手动模式且离底部超过 JUMP_VISIBLE_GAP_PX。 */
  showJump: boolean;
  /** 回到贴底并滚到最新（“跳到最新”、发送消息）。 */
  jumpToLatest(behavior?: ScrollBehavior): void;
  /**
   * 用户点开或收起了消息流里的一处：贴底时转为手动，展开的内容不会在下一个片段到达时被拉回底部；布局之后仍在
   * 底部（内容不满一屏、收起了一处）就回到贴底。
   */
  holdPosition(): void;
  /** 转为手动模式、不再吸回底部（跳到某个事件的位置，0.73.0）。 */
  release(): void;
}

/**
 * 消息流的滚动控制。`container` 是滚动容器，`content` 是里面随消息增长的内容；`resetKey`（会话 ID）变化时
 * 回到贴底。
 */
export function useStickToBottom(
  containerRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  resetKey: string,
): StickToBottom {
  const [sticky, setSticky] = useState(true);
  const [showJump, setShowJump] = useState(false);
  const controller = useRef<Controller | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey 变化时重建，回到贴底。
  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    let mode: 'sticky' | 'manual' = 'sticky';
    let lastGestureAt = Number.NEGATIVE_INFINITY;
    let pointerDown = false;
    let smoothJump = false;
    let lastKnownTop = container.scrollTop;
    /** holdPosition 之后、布局之前：布局完仍在底部就回到贴底。 */
    let held = false;
    let heldTimer: number | undefined;
    let settleTimer: number | undefined;
    let jumpShown = false;

    const distance = () => container.scrollHeight - container.scrollTop - container.clientHeight;
    const updateJump = () => {
      const next = jumpVisible(mode === 'sticky', distance());
      if (next === jumpShown) return;
      jumpShown = next;
      setShowJump(next);
    };
    const setMode = (next: 'sticky' | 'manual') => {
      if (mode === next) return;
      mode = next;
      container.style.overflowAnchor = next === 'manual' ? 'auto' : 'none';
      setSticky(next === 'sticky');
      updateJump();
    };
    const hasGesture = () => pointerDown || performance.now() - lastGestureAt < GESTURE_WINDOW_MS;
    const atBottom = () => distance() <= BOTTOM_GAP_PX;
    const jumpTo = (behavior: ScrollBehavior) => {
      lastGestureAt = Number.NEGATIVE_INFINITY;
      setMode('sticky');
      smoothJump = behavior === 'smooth';
      container.scrollTo({ top: container.scrollHeight, behavior });
      if (!smoothJump) lastKnownTop = container.scrollTop;
    };
    /** 手势停下（滚动事件停了一会儿、松开了滚动条）：离底部不远就吸回贴底。 */
    const settleGesture = () => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        if (pointerDown || mode !== 'manual' || !shouldResnap(distance())) return;
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        jumpTo(reduced ? 'auto' : 'smooth');
      }, GESTURE_SETTLE_MS);
    };
    const toBottom = () => {
      container.scrollTop = container.scrollHeight;
      lastKnownTop = container.scrollTop;
    };

    const settleHold = () => {
      if (!held) return;
      held = false;
      window.clearTimeout(heldTimer);
      if (mode === 'manual' && atBottom()) setMode('sticky');
    };

    const reconcile = () => {
      settleHold();
      if (mode === 'sticky' && !hasGesture() && !atBottom()) {
        smoothJump = false;
        toBottom();
      }
      updateJump();
    };

    const onScroll = () => {
      const top = container.scrollTop;
      if (top === lastKnownTop) return;
      if (hasGesture()) {
        // 只有真实输入能换模式；惯性滚动延长手势窗口。
        lastGestureAt = performance.now();
        smoothJump = false;
        setMode(atBottom() ? 'sticky' : 'manual');
        settleGesture();
      } else if (smoothJump) {
        if (atBottom()) smoothJump = false;
      } else if (mode === 'sticky' && top < lastKnownTop && !atBottom()) {
        // 没有滚动手势却往上移了：键盘焦点等把旧内容滚进视野，用户在读它，不要在下一个片段到达时拉回去。
        setMode('manual');
      } else if (mode === 'manual' && atBottom()) {
        // 别的方式（查找、焦点移动）把视图带到了底部：同样回到贴底。
        setMode('sticky');
      }
      lastKnownTop = container.scrollTop;
      updateJump();
    };

    const markGesture = () => {
      lastGestureAt = performance.now();
      if (smoothJump) {
        // 平滑跳转途中又动了滚轮：停在当前位置，交给用户。
        container.scrollTo({ top: container.scrollTop, behavior: 'instant' });
        smoothJump = false;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }
      if (NAVIGATION_KEYS.has(event.key)) markGesture();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.isPrimary && event.button === 0) pointerDown = true;
    };
    const onPointerUp = () => {
      if (!pointerDown) return;
      pointerDown = false;
      lastGestureAt = performance.now();
      settleGesture();
    };

    container.style.overflowAnchor = 'none';
    setSticky(true);
    setShowJump(false);
    toBottom();

    const observer = new ResizeObserver(reconcile);
    observer.observe(content);
    observer.observe(container);
    container.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('wheel', markGesture, { passive: true });
    container.addEventListener('touchmove', markGesture, { passive: true });
    container.addEventListener('keydown', onKeyDown);
    container.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    controller.current = {
      jumpToLatest: jumpTo,
      holdPosition() {
        if (mode !== 'sticky') return;
        smoothJump = false;
        setMode('manual');
        held = true;
        // 尺寸没变时 ResizeObserver 不回调，稍后自己核对一次。
        window.clearTimeout(heldTimer);
        heldTimer = window.setTimeout(settleHold, 200);
      },
      release() {
        smoothJump = false;
        held = false;
        window.clearTimeout(heldTimer);
        window.clearTimeout(settleTimer);
        setMode('manual');
      },
    };

    return () => {
      window.clearTimeout(heldTimer);
      window.clearTimeout(settleTimer);
      observer.disconnect();
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('wheel', markGesture);
      container.removeEventListener('touchmove', markGesture);
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      controller.current = null;
    };
  }, [containerRef, contentRef, resetKey]);

  const jumpToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    controller.current?.jumpToLatest(reduced ? 'auto' : behavior);
  }, []);

  const holdPosition = useCallback(() => controller.current?.holdPosition(), []);
  const release = useCallback(() => controller.current?.release(), []);

  return { sticky, showJump, jumpToLatest, holdPosition, release };
}
