// 来源 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/dropdown-menu/dropdown-menu.tsx
// 来源提交 8302b52ed9dc79ae7ca699b158a98dfdf09656f7 · MIT License · Copyright (c) 2026 Elia Kuratli
import { cn } from 'cn';
import { useLayoutEffect, useRef } from 'react';
import { placeMark } from '@/components/glide';
import styles from './dropdown-menu.module.css';

/** 指示块所在的容器带这个属性；外层的指示块不管嵌套容器里的项。 */
const SCOPE = 'data-menu-highlight-scope';

/**
 * Base UI 自己决定键盘、指针与子菜单的高亮项，指示块只跟随它。指示块绝对定位在父元素里，父元素要是定位元素。
 *
 * 菜单里另有一段自己滚动的列表（项目菜单的项目列表）时，在那个滚动容器里再放一个：指示块随列表内容一起滚动、一起被
 * 边缘渐隐，外层的指示块只管不在嵌套容器里的项。只放外层那一个时，它按未滚动的位置摆放，会落在列表外面并撑大菜单的
 * 滚动高度。
 */
export function MenuHighlight() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const mark = ref.current;
    const list = mark?.parentElement;
    if (!mark || !list) return;
    list.setAttribute(SCOPE, '');
    let current: HTMLElement | null = null;
    const place = () => {
      const item =
        Array.from(
          list.querySelectorAll<HTMLElement>('[data-highlighted]:not([data-disabled])'),
        ).find((candidate) => candidate.parentElement?.closest(`[${SCOPE}]`) === list) ?? null;
      if (item !== current) {
        if (current) resize.unobserve(current);
        if (item) resize.observe(item);
      }
      if (item) placeMark(mark, list, item, !current);
      mark.toggleAttribute('data-shown', !!item);
      current = item;
    };
    const resize = new ResizeObserver(place);
    const observer = new MutationObserver(place);
    resize.observe(list);
    observer.observe(list, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-highlighted', 'data-disabled'],
    });
    place();
    return () => {
      resize.disconnect();
      observer.disconnect();
      list.removeAttribute(SCOPE);
    };
  }, []);
  return <span ref={ref} aria-hidden className={cn('glide-mark', styles.highlight)} />;
}
