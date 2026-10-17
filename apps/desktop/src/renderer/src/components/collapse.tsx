import { cn } from 'cn';
import { type ReactNode, useEffect, useLayoutEffect, useState } from 'react';

/** 收起动画的时长（与 className 里的 duration-200 一致），过渡事件没来时按它卸载。 */
const COLLAPSE_MS = 200;

/**
 * 展开收起时高度过渡（U10）：外层 grid 的行高在 0fr 与 1fr 之间过渡，同时淡入淡出，内容从上方 4 px 落下（U24）；收起
 * 结束后卸载内容，长列表里收起的部分不占 DOM。行高用 ease-expand（先快后长尾，照 Claude 桌面端时间线的展开）。减弱动效时
 * 照全局规则瞬时完成。`fromOpen` 只在挂上时看：以展开的样子挂上，`open` 为 false 时随即收起，有收起的过渡（回合结束时
 * 过程自动收进“已处理”，那一刻外面的结构才换成分段）。
 */
export function Collapse({
  open,
  fromOpen = false,
  id,
  className,
  children,
}: {
  open: boolean;
  fromOpen?: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open || fromOpen);
  const [expanded, setExpanded] = useState(open || fromOpen);
  // 以展开的样子挂上、随即要收起：等一帧，展开的样子先画出来，收起才有过渡的起点。
  const [deferClose, setDeferClose] = useState(fromOpen && !open);

  useLayoutEffect(() => {
    if (open) setMounted(true);
    else if (!deferClose) setExpanded(false);
  }, [open, deferClose]);
  useEffect(() => {
    if (!deferClose) return;
    const frame = requestAnimationFrame(() => setDeferClose(false));
    return () => cancelAnimationFrame(frame);
  }, [deferClose]);
  // 先以 0fr 挂上，下一帧再展开，过渡才有起点。
  useEffect(() => {
    if (!open || !mounted || expanded) return;
    const frame = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(frame);
  }, [open, mounted, expanded]);
  // 收起：过渡结束卸载；保险起见到时也卸载（transitionend 不一定来，例如元素不可见时）。
  useEffect(() => {
    if (open || !mounted || deferClose) return;
    const timer = setTimeout(() => setMounted(false), COLLAPSE_MS + 50);
    return () => clearTimeout(timer);
  }, [open, mounted, deferClose]);

  if (!mounted) return null;
  return (
    <div
      id={id}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-200 ease-expand',
        expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        className,
      )}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !open) setMounted(false);
      }}
    >
      <div
        className={cn(
          'min-h-0 overflow-hidden transition-transform duration-200 ease-expand',
          !expanded && '-translate-y-1',
        )}
      >
        {children}
      </div>
    </div>
  );
}
