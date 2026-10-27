import { cn } from 'cn';
import { type ComponentProps, type ReactElement, type ReactNode, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** 文字被截断（单行省略或多行 line-clamp）了。 */
function isClipped(element: HTMLElement | null): boolean {
  if (!element) return false;
  return (
    element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1
  );
}

/**
 * 原生 `title` 的替代（照 Claude Code 桌面端 2026-10-27，悬停提示统一用 Tooltip）：悬停 `children`（一个元素，提示挂在它上面）
 * 时显示 `label`；`label` 为空时原样返回 `children`。长文字按原样换行，最多 12 行。`whenClipped` 时只在 `children` 的文字被截断时
 * 出现（截断的标题悬停看全名）。
 */
export function Hint({
  label,
  children,
  side,
  whenClipped = false,
  className,
}: {
  label: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  side?: ComponentProps<typeof TooltipContent>['side'];
  whenClipped?: boolean;
  className?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (label === undefined || label === null || label === '' || label === false) return children;
  return (
    <Tooltip
      {...(whenClipped && {
        open,
        onOpenChange: (next: boolean) => setOpen(next && isClipped(trigger.current)),
      })}
    >
      <TooltipTrigger ref={trigger} render={children} />
      <TooltipContent side={side} className={cn('max-w-sm', className)}>
        <span className="line-clamp-12 whitespace-pre-wrap break-words">{label}</span>
      </TooltipContent>
    </Tooltip>
  );
}
