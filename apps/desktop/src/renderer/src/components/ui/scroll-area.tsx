// 来源 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/scroll-area/scroll-area.tsx
// 来源提交 8302b52ed9dc79ae7ca699b158a98dfdf09656f7 · MIT License · Copyright (c) 2026 Elia Kuratli
// Base UI 组合沿用 shadcn/ui，MIT License，Copyright (c) 2023 shadcn。

import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area';
import { cn } from 'cn';
import { useRef } from 'react';
import { useScrollFade } from '@/components/scroll-fade';
import { withClasses } from './classes';
import styles from './scroll-area.module.css';

function ScrollArea({
  className,
  children,
  fade = false,
  ...props
}: ScrollAreaPrimitive.Root.Props & { fade?: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  useScrollFade(viewportRef, { top: fade, bottom: fade });
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={withClasses(styles.root, className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(styles.viewport, fade && 'scroll-fade')}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={withClasses(styles.scrollbar, className)}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb data-slot="scroll-area-thumb" className={styles.thumb} />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
