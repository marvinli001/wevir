import { useEffect, useState } from 'react';
import { formatDuration } from './format';

/** 从 `since` 起的毫秒数，每秒更新一次。 */
export function useElapsed(since: string | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return since ? Math.max(0, now - Date.parse(since)) : undefined;
}

/** 进行中的回合已用的时间（每秒走一次，只重画这一小段）。 */
export function Elapsed({ since, className }: { since: string | undefined; className?: string }) {
  const elapsed = useElapsed(since);
  if (elapsed === undefined) return null;
  return <span className={className}>{formatDuration(elapsed)}</span>;
}
