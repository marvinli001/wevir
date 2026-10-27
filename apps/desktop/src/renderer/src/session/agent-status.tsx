import { cn } from 'cn';
import { type AgentActivity, formatClock } from './agent-status-model';
import { useElapsed } from './elapsed';

// 侧栏运行中的会话行的第二行（layout/sidebar.tsx 的 SessionActivityLine）用的两块：当前动作与计时。

/** 计时：从 `since` 起，0:07 这样的写法，等宽数字。 */
export function RunClock({ since, className }: { since: string | undefined; className?: string }) {
  const elapsed = useElapsed(since);
  if (elapsed === undefined) return null;
  return <span className={cn('tabular-nums', className)}>{formatClock(elapsed)}</span>;
}

/** 当前动作的一行：进行中的扫光，等用户处理时用待审批色；目标（文件名、命令）等宽。 */
export function ActivityText({
  activity,
  className,
}: {
  activity: AgentActivity;
  className?: string;
}) {
  return (
    <span className={cn('flex min-w-0 items-baseline gap-1.5', className)}>
      <span className={cn('shrink-0', activity.tone === 'awaiting' ? 'text-warning' : 'shimmer')}>
        {activity.label}
      </span>
      {activity.target && (
        <span className="min-w-0 truncate font-mono text-[0.92em] text-muted-foreground">
          {activity.target}
        </span>
      )}
    </span>
  );
}
