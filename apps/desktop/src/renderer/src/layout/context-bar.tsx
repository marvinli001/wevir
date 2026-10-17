// 上下文的用量条（0.29.0）：颜色随用量（rail-model.ts 的 `tone`），有自动压缩的线时画一道竖线。

import { cn } from 'cn';
import type { ContextUsage } from './rail-model';

const TONE_FILL: Record<ContextUsage['tone'], string> = {
  normal: 'bg-muted-foreground',
  warning: 'bg-warning',
  danger: 'bg-destructive',
};

/**
 * 用量条；有自动压缩的线时在条上画一道竖线。会话侧栏的“上下文”“用量”卡片与输入框底栏的用量表（session/context-meter.tsx）
 * 共用。
 */
export function ContextBar({
  usage,
  mark = true,
  className,
}: {
  usage: Pick<ContextUsage, 'percent' | 'tone' | 'autoCompactPercent'>;
  /** 画自动压缩的线（太窄的条不画）。 */
  mark?: boolean;
  className?: string;
}) {
  return (
    <span aria-hidden className={cn('relative block h-1.5 w-full', className)}>
      <span className="block h-full overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            'block h-full rounded-full transition-[width] duration-300 ease-smooth',
            TONE_FILL[usage.tone],
          )}
          style={{ width: `${Math.max(usage.percent, 2)}%` }}
        />
      </span>
      {mark && usage.autoCompactPercent !== undefined && (
        <span
          data-testid="context-auto-compact-mark"
          className="absolute -top-0.5 -bottom-0.5 w-px bg-foreground/40"
          style={{ left: `${usage.autoCompactPercent}%` }}
        />
      )}
    </span>
  );
}
