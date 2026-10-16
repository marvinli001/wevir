// 自动更新的下载进度条（设置 → 关于）：轨道、填充与填充上的流光，宽度变化 300 ms。

import { cn } from 'cn';

export function UpdateProgress({ percent, className }: { percent: number; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)} data-testid="update-progress">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="relative h-1.5 w-40 overflow-hidden rounded-full bg-foreground/10"
      >
        <div
          className="h-full overflow-hidden rounded-full bg-primary transition-[width] duration-300 ease-smooth"
          style={{ width: `${percent}%` }}
        >
          <div className="progress-sheen size-full" />
        </div>
      </div>
      <span className="w-9 text-right text-xs text-muted-foreground tabular-nums">{percent}%</span>
    </div>
  );
}
