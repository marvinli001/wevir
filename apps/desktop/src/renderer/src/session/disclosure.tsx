import { cn } from 'cn';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

/**
 * 可折叠的一行：标题行是按钮（aria-expanded），展开后显示内容。思考过程、工具卡片、审批的完整参数共用。
 * 内容在折叠时不渲染（长会话里折叠的卡片不占 DOM）。
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
  summaryClassName,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  summaryClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          summaryClassName,
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        {summary}
      </button>
      {open && <div id={id}>{children}</div>}
    </div>
  );
}
