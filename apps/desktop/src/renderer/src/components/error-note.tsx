import { cn } from 'cn';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import type { ComponentProps } from 'react';

/**
 * 界面里的出错与提醒（照 Codex app、Claude Code 桌面端）：前面一个状态色的小图标，文字用普通前景色，不铺底色。
 * 状态色不上文字（ui-rules.test.ts）。外层是 flex 的 span，放进 label 也合法；动作失败又没有地方放时用 reportActionFailure 弹到通知区。
 */
export function ErrorNote({
  tone = 'danger',
  className,
  children,
  ...props
}: { tone?: 'danger' | 'warning' } & ComponentProps<'span'>) {
  const Icon = tone === 'danger' ? CircleAlert : TriangleAlert;
  return (
    <span
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex min-w-0 items-start gap-1.5 text-soft-foreground', className)}
      {...props}
    >
      <Icon
        aria-hidden
        className={cn(
          'mt-[0.2em] size-[1.1em] shrink-0',
          tone === 'danger' ? 'text-icon-danger' : 'text-icon-warning',
        )}
      />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}
