// SPDX-License-Identifier: MIT
// 改写自 kuratlielia/arc-library registry/components/floating-button-group/floating-button-group.tsx 与
// registry/components/tabs/tabs.tsx（共享高亮与选中指示）
// 来源提交 fff39c044c6e3b86006e3a6acc9a32a821a80d99
// Copyright (c) 2026 Elia Kuratli
// 由 Wevir 修改：不用 motion 的 layoutId，量出目标按钮相对容器的位置写进 CSS 变量，平移与宽高走 theme.css 的 snap 弹簧；
// 第一次出现时跳到位、只淡入；颜色与圆角用 Wevir 的令牌，减弱动效时由全局规则瞬时完成。

import { cn } from 'cn';
import {
  type ComponentProps,
  type FocusEvent,
  type PointerEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
} from 'react';

/** 目标相对容器的位置：沿 offsetParent 往上累加，不受按压缩放（scale）影响。 */
function offsetWithin(target: HTMLElement, root: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = target;
  while (node && node !== root) {
    x += node.offsetLeft;
    y += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    // offsetParent 越过了容器（容器不是定位元素时）：退回到按两者的矩形算。
    if (parent && !root.contains(parent)) {
      const a = target.getBoundingClientRect();
      const b = root.getBoundingClientRect();
      return { x: a.left - b.left, y: a.top - b.top };
    }
    node = parent;
  }
  return { x, y };
}

/**
 * 把一块高亮（theme.css 的 glide-mark）移到 `target` 上。`instant` 时跳到位（先关掉位置与尺寸的过渡、写值、强制重排，再还原），只有不透明度过渡。
 */
function placeMark(mark: HTMLElement, root: HTMLElement, target: HTMLElement, instant: boolean) {
  const { x, y } = offsetWithin(target, root);
  if (instant) mark.dataset.instant = '';
  mark.style.setProperty('--mark-x', `${x}px`);
  mark.style.setProperty('--mark-y', `${y}px`);
  mark.style.setProperty('--mark-w', `${target.offsetWidth}px`);
  mark.style.setProperty('--mark-h', `${target.offsetHeight}px`);
  if (instant) {
    void mark.offsetWidth;
    delete mark.dataset.instant;
  }
}

/**
 * 一组按钮共用一块悬停高亮（照 Arc 的 floating-button-group）：指针在按钮之间移动时，高亮从一个按钮滑到另一个，离开整组时
 * 淡出；键盘焦点（:focus-visible）同样带着它走。组里按钮自己的悬停底色关掉（theme.css 的 glide-group），按下的缩放、
 * 菜单展开时的底色照旧。停用的按钮不接高亮。
 */
export function GlideGroup({ className, children, ...props }: ComponentProps<'div'>) {
  const root = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const shown = useRef(false);

  const show = (target: EventTarget | null) => {
    const container = root.current;
    const highlight = mark.current;
    if (!container || !highlight || !(target instanceof Element)) return;
    const button = target.closest('button');
    if (!button || !container.contains(button) || button.disabled) return;
    placeMark(highlight, container, button, !shown.current);
    shown.current = true;
    highlight.dataset.shown = '';
  };
  const hide = () => {
    shown.current = false;
    delete mark.current?.dataset.shown;
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 指针与焦点的事件只为移动高亮，组本身不是控件。
    <div
      ref={root}
      className={cn('glide-group relative isolate', className)}
      onPointerOver={(event: PointerEvent) => {
        if (event.pointerType === 'mouse') show(event.target);
      }}
      onPointerLeave={hide}
      onFocus={(event: FocusEvent) => {
        if (event.target instanceof Element && event.target.matches(':focus-visible'))
          show(event.target);
      }}
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hide();
      }}
      {...props}
    >
      <span
        ref={mark}
        aria-hidden
        className="glide-mark rounded-lg bg-muted opacity-0 data-shown:opacity-100 dark:bg-muted/50"
      />
      {children}
    </div>
  );
}

/**
 * 选中指示（照 Arc 的 tabs）：`root` 里选中的那一项（`[aria-selected="true"]` 的 `[data-indicator-target]` 祖先）
 * 换了时，指示块滑过去；第一次与目标不在时跳到位或隐藏。选中项的尺寸变了（标题改了、窗口缩放）也跟着。
 * 返回的 ref 接在指示块上，指示块用 `glide-mark` 加自己的外观，`data-shown` 时显示。
 */
export function useSelectionIndicator(
  root: RefObject<HTMLElement | null>,
  selectedKey: string | undefined,
): RefObject<HTMLSpanElement | null> {
  const mark = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedKey 变了（换了选中项、标签增减）要重新量。
  useLayoutEffect(() => {
    const container = root.current;
    const highlight = mark.current;
    if (!container || !highlight) return;
    const target = () =>
      container
        .querySelector('[aria-selected="true"]')
        ?.closest<HTMLElement>('[data-indicator-target]') ?? null;
    const place = () => {
      const item = target();
      if (!item) {
        placed.current = false;
        delete highlight.dataset.shown;
        return;
      }
      placeMark(highlight, container, item, !placed.current);
      placed.current = true;
      highlight.dataset.shown = '';
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(container);
    const item = target();
    if (item) observer.observe(item);
    return () => observer.disconnect();
  }, [root, selectedKey]);

  return mark;
}
