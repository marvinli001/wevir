import type { ChatPartOf } from '@wevir/client-sdk';
import { cn } from 'cn';
import { ChevronRight, CircleAlert, MessageSquarePlus, Replace, ShieldBan } from 'lucide-react';
import { useId } from 'react';
import { Collapse } from '@/components/collapse';
import { Hint } from '@/components/hint';
import { type PlainMessageKey, t } from '@/i18n';
import { useFold } from './fold-state';

const ACTION_KEYS = {
  blocked: 'hook.action.blocked',
  denied: 'hook.action.denied',
  allowed: 'hook.action.allowed',
  continued: 'hook.action.continued',
  context: 'hook.action.context',
  failed: 'hook.action.failed',
  limit: 'hook.action.limit',
} as const satisfies Record<string, PlainMessageKey>;

export function HookPart({ part }: { part: ChatPartOf<'hook'> }) {
  const { outcome } = part;
  const [open, setOpen] = useFold(`line:${part.key}`, false);
  const id = useId();
  const action = Object.hasOwn(ACTION_KEYS, outcome.action)
    ? t(ACTION_KEYS[outcome.action as keyof typeof ACTION_KEYS])
    : outcome.action;
  const blocked = outcome.action === 'blocked' || outcome.action === 'denied';
  const changed = outcome.action === 'allowed' || outcome.action === 'continued';
  const context = outcome.action === 'context';
  const Icon = blocked ? ShieldBan : changed ? Replace : context ? MessageSquarePlus : CircleAlert;
  const tone =
    blocked || outcome.action === 'failed'
      ? 'text-destructive'
      : context
        ? 'text-running'
        : 'text-warning';
  const hasDetail = Boolean(outcome.command || outcome.reason);
  const target = outcome.tool ?? outcome.command;
  return (
    <div data-hook-outcome={outcome.action}>
      <button
        type="button"
        aria-expanded={hasDetail ? open : undefined}
        aria-controls={hasDetail ? id : undefined}
        disabled={!hasDetail}
        onClick={() => setOpen(!open)}
        className="flex min-h-6 w-full min-w-0 items-center gap-2 rounded-lg text-left text-sm text-muted-foreground outline-none enabled:hover:text-foreground focus-visible:focus-ring"
      >
        <Icon aria-hidden className={cn('size-3.5 shrink-0', tone)} />
        <span className={cn('shrink-0', tone)}>{action}</span>
        <code className="shrink-0 font-mono text-xs">{outcome.event}</code>
        {target && (
          <Hint label={target} whenClipped>
            <code className="min-w-0 truncate font-mono text-xs text-soft-foreground">
              {target}
            </code>
          </Hint>
        )}
        {hasDetail && (
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3 shrink-0 opacity-70 transition-transform duration-200 ease-expand',
              open && 'rotate-90',
            )}
          />
        )}
      </button>
      <Collapse open={open && hasDetail} id={id}>
        <div className="mt-1 mb-2 ml-5.5 max-h-60 space-y-2 overflow-auto font-mono text-xs text-muted-foreground">
          {outcome.command && (
            <pre className="break-words whitespace-pre-wrap">{outcome.command}</pre>
          )}
          {outcome.reason && (
            <pre className="break-words whitespace-pre-wrap">{outcome.reason}</pre>
          )}
        </div>
      </Collapse>
    </div>
  );
}
