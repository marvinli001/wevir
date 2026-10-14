import { cn } from 'cn';
import { type ReactNode, useEffect, useLayoutEffect, useState } from 'react';

/** 收起动画的时长（与 className 里的 duration-200 一致），过渡事件没来时按它卸载。 */
const COLLAPSE_MS = 200;

/**
 * 展开收起时高度过渡（U10）：外层 grid 的行高在 0fr 与 1fr 之间过渡，同时淡入淡出；收起结束后卸载内容，长列表里收起的
 * 部分不占 DOM。减弱动效时照全局规则瞬时完成。
 */
export function Collapse({
  open,
  id,
  className,
  children,
}: {
  open: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);

  useLayoutEffect(() => {
    if (open) setMounted(true);
    else setExpanded(false);
  }, [open]);
  // 先以 0fr 挂上，下一帧再展开，过渡才有起点。
  useEffect(() => {
    if (!open || !mounted || expanded) return;
    const frame = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(frame);
  }, [open, mounted, expanded]);
  // 收起：过渡结束卸载；保险起见到时也卸载（transitionend 不一定来，例如元素不可见时）。
  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => setMounted(false), COLLAPSE_MS + 50);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  if (!mounted) return null;
  return (
    <div
      id={id}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-200 ease-smooth',
        expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        className,
      )}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !open) setMounted(false);
      }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
