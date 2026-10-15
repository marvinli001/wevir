import { cn } from 'cn';
import { type ComponentProps, type RefObject, useLayoutEffect, useRef } from 'react';
import { fadeEdges } from './scroll-fade-model';

export interface ScrollFadeOptions {
  /** 顶部能渐隐（默认是）。 */
  top?: boolean;
  /** 底部能渐隐（默认是）；消息流贴底时传 false，底部渐隐归零。 */
  bottom?: boolean;
}

/**
 * 滚动边缘渐隐（交互手感一轮，desktop-tokens.md §44）：滚动容器带上 `scroll-fade` 类（styles/scroll-fade.css），这里按
 * 滚动位置给它加减 data-fade-top / data-fade-bottom，到头的一边渐隐长度归零（长度是注册过的 <length>，出现与消失
 * 有过渡）。滚动、容器或内容的尺寸变化都在下一帧核对一次；经典滚动条的宽度写进 --scroll-fade-bar，那一条不遮。
 */
export function useScrollFade(
  ref: RefObject<HTMLElement | null>,
  { top = true, bottom = true }: ScrollFadeOptions = {},
): void {
  const enabled = useRef({ top, bottom });
  const update = useRef<() => void>(undefined);
  const any = top || bottom;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !any) return;
    let frame = 0;
    const measureEdges = () => {
      const edges = fadeEdges(element.scrollTop, element.scrollHeight, element.clientHeight);
      element.toggleAttribute('data-fade-top', enabled.current.top && edges.top);
      element.toggleAttribute('data-fade-bottom', enabled.current.bottom && edges.bottom);
    };
    const measureAll = () => {
      frame = 0;
      const style = getComputedStyle(element);
      const bar =
        element.offsetWidth -
        element.clientWidth -
        Number.parseFloat(style.borderLeftWidth) -
        Number.parseFloat(style.borderRightWidth);
      element.style.setProperty('--scroll-fade-bar', `${Math.max(0, Math.round(bar))}px`);
      measureEdges();
    };
    let scrollFrame = 0;
    const onScroll = () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        measureEdges();
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measureAll);
    };

    // 内容变高、容器变小都要核对：观察容器和它的每个子元素，子元素换了就重新观察。
    const resize = new ResizeObserver(schedule);
    const observeChildren = () => {
      resize.disconnect();
      resize.observe(element);
      for (const child of element.children) resize.observe(child);
    };
    const mutation = new MutationObserver(() => {
      observeChildren();
      schedule();
    });
    observeChildren();
    mutation.observe(element, { childList: true });
    element.addEventListener('scroll', onScroll, { passive: true });
    update.current = measureEdges;
    measureAll();
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(scrollFrame);
      resize.disconnect();
      mutation.disconnect();
      element.removeEventListener('scroll', onScroll);
      update.current = undefined;
    };
  }, [ref, any]);

  useLayoutEffect(() => {
    enabled.current = { top, bottom };
    update.current?.();
  }, [top, bottom]);
}

/**
 * 带边缘渐隐的滚动容器（菜单、列表），overflow 与最大高度由调用方写。弹层里的列表用它而不是直接用 hook：弹层打开时
 * 才挂载，hook 要跟着元素一起挂载。
 */
export function ScrollFade({
  as: Tag = 'div',
  className,
  top,
  bottom,
  ...props
}: Omit<ComponentProps<'div'>, 'ref'> & ScrollFadeOptions & { as?: 'div' | 'ul' }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollFade(ref, { top, bottom });
  const Element = Tag as 'div';
  return <Element ref={ref} className={cn('scroll-fade', className)} {...props} />;
}
