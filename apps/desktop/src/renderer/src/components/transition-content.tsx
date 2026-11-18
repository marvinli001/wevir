import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@/fx/motion';

/** 量自然高度，过渡只作用在外层，结束后由内容继续定高。 */
export function AnimatedHeight({
  contentKey,
  children,
}: {
  contentKey: string;
  children: ReactNode;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const size = useRef<{ width: number; height: number }>(undefined);
  const animation = useRef<Animation>(undefined);
  const reduced = useReducedMotion();
  const resize = useCallback(() => {
    const shell = outer.current;
    const content = inner.current;
    if (!shell || !content) return;
    const { width, height } = content.getBoundingClientRect();
    const previous = size.current;
    size.current = { width, height };
    if (reduced || previous?.width !== width) {
      animation.current?.cancel();
      animation.current = undefined;
      shell.style.overflow = '';
      return;
    }
    if (height === previous.height) return;
    // 行自身已经在展开时，外层跟着它走，避免对每一帧再开一次过渡。
    if (
      !animation.current &&
      content
        .getAnimations({ subtree: true })
        .some(
          (item) =>
            item instanceof CSSTransition && item.transitionProperty === 'grid-template-rows',
        )
    )
      return;
    const from = animation.current ? shell.getBoundingClientRect().height : previous.height;
    animation.current?.cancel();
    shell.style.overflow = 'clip';
    const next = shell.animate([{ height: `${from}px` }, { height: `${height}px` }], {
      duration: 200,
      easing: getComputedStyle(shell).getPropertyValue('--ease-expand').trim(),
      fill: 'backwards',
    });
    animation.current = next;
    next.onfinish = () => {
      animation.current = undefined;
      shell.style.overflow = '';
    };
  }, [reduced]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换来源或账号时先量一次，背景更新由 ResizeObserver 接手。
  useLayoutEffect(resize, [resize, contentKey]);
  useLayoutEffect(() => {
    const content = inner.current;
    if (!content || reduced) return;
    const observer = new ResizeObserver(resize);
    observer.observe(content);
    return () => {
      observer.disconnect();
      animation.current?.cancel();
      animation.current = undefined;
    };
  }, [resize, reduced]);

  return (
    <div ref={outer}>
      <div ref={inner} className="flow-root">
        {children}
      </div>
    </div>
  );
}

/** 只在内容键改变时交叉淡化，退场层不参与排版或交互。 */
export function ContentCrossfade({
  contentKey,
  children,
}: {
  contentKey: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const current = useRef({ key: contentKey, children });
  const [key, setKey] = useState(contentKey);
  const [previous, setPrevious] = useState<typeof current.current>();
  const entering = useRef<HTMLDivElement>(null);
  const leaving = useRef<HTMLDivElement>(null);
  if (contentKey !== key) {
    setKey(contentKey);
    setPrevious(reduced ? undefined : current.current);
  } else if (reduced && previous !== undefined) {
    setPrevious(undefined);
  }
  useLayoutEffect(() => {
    current.current = { key: contentKey, children };
  }, [contentKey, children]);
  useLayoutEffect(() => {
    if (!previous || reduced || !entering.current || !leaving.current) return;
    const easing = getComputedStyle(entering.current).getPropertyValue('--ease-smooth').trim();
    const outgoing = leaving.current.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 80,
      easing,
      fill: 'both',
    });
    const incoming = entering.current.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 120,
      easing,
      fill: 'backwards',
    });
    incoming.onfinish = () => setPrevious(undefined);
    return () => {
      outgoing.cancel();
      incoming.cancel();
    };
  }, [previous, reduced]);

  return (
    <div className="relative">
      <div key={contentKey} ref={entering} className="flow-root">
        {children}
      </div>
      {previous && !reduced && previous.key !== contentKey && (
        <div
          key={previous.key}
          ref={leaving}
          inert
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 flow-root"
        >
          {previous.children}
        </div>
      )}
    </div>
  );
}
