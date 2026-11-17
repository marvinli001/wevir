import { useEffect, useEffectEvent } from 'react';
import { getShortcut, matchesShortcut } from '@/lib/shortcuts';

export function useEffortShortcuts(
  enabled: boolean,
  efforts: readonly string[],
  current: string | undefined,
  choose: (effort: string) => void,
): void {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || event.defaultPrevented || event.repeat || !efforts.length) return;
    const lower = matchesShortcut(event, getShortcut('lowerEffort'));
    if (!lower && !matchesShortcut(event, getShortcut('higherEffort'))) return;
    if (document.querySelector('[role="dialog"]:not([hidden]), [role="alertdialog"]:not([hidden])'))
      return;
    event.preventDefault();
    const index = current === undefined ? -1 : efforts.indexOf(current);
    const next = efforts[Math.max(0, Math.min(efforts.length - 1, index + (lower ? -1 : 1)))];
    if (next && next !== current) choose(next);
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => handle(event);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
