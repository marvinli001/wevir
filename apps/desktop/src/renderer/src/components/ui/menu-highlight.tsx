// 来源 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/dropdown-menu/dropdown-menu.tsx
// 来源提交 8302b52ed9dc79ae7ca699b158a98dfdf09656f7 · MIT License · Copyright (c) 2026 Elia Kuratli
import { cn } from 'cn';
import { useLayoutEffect, useRef } from 'react';
import { placeMark } from '@/components/glide';
import styles from './dropdown-menu.module.css';

/** Base UI 自己决定键盘、指针与子菜单的高亮项，指示块只跟随它。 */
export function MenuHighlight() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const mark = ref.current;
    const list = mark?.parentElement;
    if (!mark || !list) return;
    let current: HTMLElement | null = null;
    const place = () => {
      const item = list.querySelector<HTMLElement>('[data-highlighted]:not([data-disabled])');
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
    };
  }, []);
  return <span ref={ref} aria-hidden className={cn('glide-mark', styles.highlight)} />;
}
