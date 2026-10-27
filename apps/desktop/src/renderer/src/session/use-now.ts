import { useEffect, useState } from 'react';

/** 每隔 `intervalMs` 刷新一次的“现在”；不给间隔时不刷新。 */
export function useNow(intervalMs: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (intervalMs === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
