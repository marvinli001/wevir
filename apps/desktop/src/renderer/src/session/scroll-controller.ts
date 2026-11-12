// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/src/react-app/domains/session/surface/scroll-controller.ts
//（另参照同目录 scroll-store.ts、scroll-overlay.tsx）
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：改写（T5.3，OpenWork 候选 #3）。保留两种模式的状态机：贴底（stickyBottom）时内容或视口尺寸一变就
// 滚到底，手动（manual）时不动；只有真实的输入手势（滚轮、触摸、导航键、拖滚动条）才能切换模式，布局钳位与
// 程序滚动触发的 scroll 事件不算；手势滚到底部回到贴底；贴底时键盘焦点等把旧内容滚进视野也转为手动；
// overflow-anchor 贴底时为 none、手动时为 auto（手动阅读时由浏览器锚定位置）；发送消息即回到贴底。U2：用户在消息流里
// 点开或收起一处（工作组、回合）时转为手动、保持位置，不被拉回底部（holdPosition）；跳到某个事件时直接转为手动（release）。去掉
// 移动端轮次留白、几何信息的落盘、历史分页、“跳到消息开头”；手动阅读的位置按会话记在进程内，只交出
// “是否贴底”给“跳到最新”按钮。交互手感一轮：手势停下时离底部不超过 RESNAP_GAP_PX 就吸回贴底；“跳到最新”只在离底部超过
// JUMP_VISIBLE_GAP_PX 时出现，轻推几像素不闪出来。动效一轮：贴底时只有可能往上带的输入（向上的滚轮、触摸、向上的导航键、按住
// 指针）才暂停跟随，在消息流里点一下、向下滚、横向滚代码块不再让跟随停 GESTURE_WINDOW_MS 之后跳一截；平滑跳到最新途中内容
// 还在长时让它滚完再贴底，不在下一帧改成瞬移。

import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { captureScrollPosition, restoreScrollPosition, scrollPositions } from './scroll-position';

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
const RESTORE_SETTLE_MS = 300;
const RESTORE_MAX_MS = 1500;
const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
/** 会把视图往上带的导航键。 */
const UPWARD_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);
/** 平滑跳到最新最多等这么久；到点还没收到 scrollend 就直接贴底。 */
const SMOOTH_JUMP_MAX_MS = 1200;

/**
 * 贴底时内容长了，要不要立刻滚到底：按着指针（选文字、拖滚动条）或刚有过可能往上带的输入时先不动，等它的 scroll 事件来定模式。
 */
export function shouldFollow(
  pointerDown: boolean,
  sinceUpwardGestureMs: number,
  smoothJump: boolean,
): boolean {
  return !pointerDown && !smoothJump && sinceUpwardGestureMs >= GESTURE_WINDOW_MS;
}

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
  release(preservePosition?: boolean): void;
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
  /**
   * 转为手动模式、不再吸回底部（跳到某个事件的位置：任务回顾的出处 0.76.0、搜索结果 0.77.0）；之后非手势的滚动（滚动锚定、
   * 程序滚动）到了底部也不回到贴底，直到用户自己滚动或跳到最新。
   * 翻页时传 preservePosition，按可见消息锚点校正裁剪前后的位置。
   */
  release(preservePosition?: boolean): void;
}

/**
 * 消息流的滚动控制。`container` 是滚动容器，`content` 是里面随消息增长的内容；`resetKey`（会话 ID）变化时
 * 恢复该会话的阅读位置；没有记录时回到贴底。
 */
export function useStickToBottom(
  containerRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  resetKey: string,
  hasLaterRef?: RefObject<boolean>,
): StickToBottom {
  const [sticky, setSticky] = useState(() => !scrollPositions.has(resetKey));
  const [showJump, setShowJump] = useState(false);
  const controller = useRef<Controller | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    const saved = scrollPositions.get(resetKey);
    let mode: 'sticky' | 'manual' = saved ? 'manual' : 'sticky';
    let lastGestureAt = Number.NEGATIVE_INFINITY;
    /** 上一次可能把视图往上带的输入（向上的滚轮、触摸、向上的导航键）。 */
    let lastUpwardAt = Number.NEGATIVE_INFINITY;
    let pointerDown = false;
    let smoothJump = false;
    /** 平滑跳转已经追过一次途中新长出来的内容。 */
    let smoothCatchUp = false;
    let smoothTimer: number | undefined;
    let lastKnownTop = container.scrollTop;
    /** holdPosition 之后、布局之前：布局完仍在底部就回到贴底。 */
    let held = false;
    /** release 之后：非手势的滚动（滚动锚定、程序滚动）到了底部也不回到贴底，直到用户自己滚动或跳到最新。 */
    let parked = saved !== undefined;
    let heldTimer: number | undefined;
    let settleTimer: number | undefined;
    let jumpShown = false;
    let restoring = saved;
    let restoreFrame = 0;
    let restoreMovedAt = performance.now();

    const stopRestoring = () => {
      if (restoring) container.style.overflowAnchor = mode === 'manual' ? 'auto' : 'none';
      restoring = undefined;
      cancelAnimationFrame(restoreFrame);
    };
    const restore = () => {
      if (!restoring) return;
      const before = container.scrollTop;
      restoreScrollPosition(container, content, restoring);
      if (Math.abs(container.scrollTop - before) > 1) restoreMovedAt = performance.now();
      lastKnownTop = container.scrollTop;
    };
    const startRestoring = () => {
      container.style.overflowAnchor = 'none';
      restoreMovedAt = performance.now();
      const startedAt = restoreMovedAt;
      const step = () => {
        restore();
        updateJump();
        const now = performance.now();
        if (now - startedAt < RESTORE_MAX_MS && now - restoreMovedAt < RESTORE_SETTLE_MS) {
          restoreFrame = requestAnimationFrame(step);
        } else {
          stopRestoring();
        }
      };
      restoreFrame = requestAnimationFrame(step);
    };

    const distance = () => container.scrollHeight - container.scrollTop - container.clientHeight;
    const updateJump = () => {
      const next =
        mode !== 'sticky' && (hasLaterRef?.current === true || jumpVisible(false, distance()));
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
    const atBottom = () => !hasLaterRef?.current && distance() <= BOTTOM_GAP_PX;
    const jumpTo = (behavior: ScrollBehavior) => {
      stopRestoring();
      lastGestureAt = Number.NEGATIVE_INFINITY;
      parked = false;
      if (hasLaterRef) hasLaterRef.current = false;
      lastUpwardAt = Number.NEGATIVE_INFINITY;
      setMode('sticky');
      // 已经在底部时没有可滚的距离，也就没有 scrollend：不算平滑跳转，否则跟随要等到超时。
      smoothJump = behavior === 'smooth' && distance() > BOTTOM_GAP_PX;
      smoothCatchUp = false;
      window.clearTimeout(smoothTimer);
      if (smoothJump)
        smoothTimer = window.setTimeout(() => endSmoothJump(true), SMOOTH_JUMP_MAX_MS);
      container.scrollTo({ top: container.scrollHeight, behavior });
      if (!smoothJump) lastKnownTop = container.scrollTop;
    };
    /**
     * 平滑跳转滚完了（scrollend）或超时：途中内容又长了一截。长得多（流式输出中）就再平滑滚一次追上去，只追一次；剩下的
     * 一小截直接贴底。
     */
    const endSmoothJump = (timedOut = false) => {
      if (!smoothJump) return;
      if (!timedOut && !smoothCatchUp && mode === 'sticky' && distance() > RESNAP_GAP_PX) {
        smoothCatchUp = true;
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        return;
      }
      window.clearTimeout(smoothTimer);
      smoothJump = false;
      if (mode === 'sticky' && !atBottom()) toBottom();
      updateJump();
    };
    /** 手势停下（滚动事件停了一会儿、松开了滚动条）：离底部不远就吸回贴底。 */
    const settleGesture = () => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        if (pointerDown || hasLaterRef?.current || mode !== 'manual' || !shouldResnap(distance()))
          return;
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
      restore();
      settleHold();
      if (
        mode === 'sticky' &&
        shouldFollow(pointerDown, performance.now() - lastUpwardAt, smoothJump) &&
        !atBottom()
      ) {
        toBottom();
      }
      updateJump();
    };

    const onScroll = () => {
      const top = container.scrollTop;
      if (top === lastKnownTop) return;
      if (restoring) {
        lastKnownTop = top;
      } else if (hasGesture()) {
        // 只有真实输入能换模式；惯性滚动延长手势窗口。
        lastGestureAt = performance.now();
        smoothJump = false;
        parked = false;
        // 贴底时往下移不算离开底部：内容刚长了一截、滚轮又往下推了一点，离底部可能暂时超过 BOTTOM_GAP_PX。
        const stillSticky = mode === 'sticky' && top > lastKnownTop;
        setMode(atBottom() || stillSticky ? 'sticky' : 'manual');
        settleGesture();
      } else if (smoothJump) {
        if (atBottom()) smoothJump = false;
      } else if (mode === 'sticky' && top < lastKnownTop && !atBottom()) {
        // 没有滚动手势却往上移了：键盘焦点等把旧内容滚进视野，用户在读它，不要在下一个片段到达时拉回去。
        setMode('manual');
      } else if (mode === 'manual' && atBottom() && !parked) {
        // 别的方式（查找、焦点移动）把视图带到了底部：同样回到贴底。
        setMode('sticky');
      }
      lastKnownTop = container.scrollTop;
      updateJump();
    };

    const markGesture = (upward: boolean) => {
      stopRestoring();
      lastGestureAt = performance.now();
      if (upward) lastUpwardAt = lastGestureAt;
      if (smoothJump) {
        // 平滑跳转途中又动了滚轮：停在当前位置，交给用户。
        container.scrollTo({ top: container.scrollTop, behavior: 'instant' });
        smoothJump = false;
        window.clearTimeout(smoothTimer);
      }
    };
    const onScrollEnd = () => endSmoothJump();
    const onWheel = (event: WheelEvent) => markGesture(event.deltaY < 0);
    // 触摸的方向要等 scroll 事件才知道，按可能往上算。
    const onTouchMove = () => markGesture(true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }
      if (NAVIGATION_KEYS.has(event.key)) {
        markGesture(UPWARD_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey));
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.isPrimary && event.button === 0) {
        stopRestoring();
        pointerDown = true;
      }
    };
    const onPointerUp = () => {
      if (!pointerDown) return;
      pointerDown = false;
      lastGestureAt = performance.now();
      settleGesture();
    };

    container.style.overflowAnchor = 'none';
    setSticky(!saved);
    setShowJump(false);
    if (saved) {
      container.scrollTop = saved.top;
      restore();
      updateJump();
      // content-visibility 的估高在挂载后还会变，等可见内容的排版稳定再停止校正。
      startRestoring();
    } else {
      toBottom();
    }

    const observer = new ResizeObserver(reconcile);
    observer.observe(content);
    observer.observe(container);
    container.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('scrollend', onScrollEnd);
    container.addEventListener('wheel', onWheel, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('keydown', onKeyDown);
    container.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    controller.current = {
      jumpToLatest: jumpTo,
      holdPosition() {
        stopRestoring();
        if (mode !== 'sticky') return;
        smoothJump = false;
        setMode('manual');
        held = true;
        // 尺寸没变时 ResizeObserver 不回调，稍后自己核对一次。
        window.clearTimeout(heldTimer);
        heldTimer = window.setTimeout(settleHold, 200);
      },
      release(preservePosition) {
        stopRestoring();
        smoothJump = false;
        parked = true;
        held = false;
        window.clearTimeout(heldTimer);
        window.clearTimeout(settleTimer);
        setMode('manual');
        if (preservePosition) {
          restoring = captureScrollPosition(container, content);
          startRestoring();
        }
      },
    };

    return () => {
      if (mode === 'manual') {
        // Suspense 可能在排版稳定前隐藏消息流，保留尚未恢复完的位置。
        scrollPositions.set(resetKey, restoring ?? captureScrollPosition(container, content));
      } else {
        scrollPositions.delete(resetKey);
      }
      stopRestoring();
      window.clearTimeout(heldTimer);
      window.clearTimeout(settleTimer);
      window.clearTimeout(smoothTimer);
      observer.disconnect();
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('scrollend', onScrollEnd);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      controller.current = null;
    };
  }, [containerRef, contentRef, resetKey, hasLaterRef]);

  const jumpToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    controller.current?.jumpToLatest(reduced ? 'auto' : behavior);
  }, []);

  const holdPosition = useCallback(() => controller.current?.holdPosition(), []);
  const release = useCallback(
    (preservePosition = false) => controller.current?.release(preservePosition),
    [],
  );

  return { sticky, showJump, jumpToLatest, holdPosition, release };
}
