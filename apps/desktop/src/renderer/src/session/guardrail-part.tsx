// 护栏拦下的一步（0.86.0，`guardrail.blocked`）：消息流里一行工具行，“已拦截 · 禁止命令  rm -rf /”，结束前检查带第几次；点开是交给
// Agent 的理由。

import type { ChatPartOf } from '@wevir/client-sdk';
import { cn } from 'cn';
import { ChevronRight, ShieldAlert } from 'lucide-react';
import { useId } from 'react';
import { Collapse } from '@/components/collapse';
import { type PlainMessageKey, t } from '@/i18n';
import { guardrailKindName } from '@/tuning/guardrails-model';
import { useFold } from './fold-state';

const ACTION_KEYS = {
  denied: 'guardrail.action.denied',
  continued: 'guardrail.action.continued',
  allowed: 'guardrail.action.allowed',
} as const satisfies Record<string, PlainMessageKey>;

const ACTION_TONES: Record<string, string> = {
  denied: 'text-destructive',
  continued: 'text-warning',
};

export function GuardrailPart({ part }: { part: ChatPartOf<'guardrail'> }) {
  const { blocked } = part;
  const [open, setOpen] = useFold(`line:${part.key}`, false);
  const id = useId();
  const action = Object.hasOwn(ACTION_KEYS, blocked.action)
    ? t(ACTION_KEYS[blocked.action as keyof typeof ACTION_KEYS])
    : blocked.action;
  const target = blocked.command ?? blocked.path;
  const attempt =
    blocked.attempt !== undefined && blocked.maxAttempts !== undefined
      ? `${blocked.attempt}/${blocked.maxAttempts}`
      : undefined;
  const hasDetail = blocked.reason.trim() !== '';
  return (
    <div data-guardrail-blocked={blocked.action} data-guardrail-kind={blocked.kind}>
      <button
        type="button"
        aria-expanded={hasDetail ? open : undefined}
        aria-controls={hasDetail ? id : undefined}
        disabled={!hasDetail}
        onClick={() => setOpen(!open)}
        className="flex min-h-6 w-full min-w-0 items-center gap-2 rounded-lg text-left text-sm text-muted-foreground outline-none enabled:hover:text-foreground focus-visible:focus-ring"
      >
        <ShieldAlert aria-hidden className="size-3.5 shrink-0 opacity-85" />
        <span className={cn('shrink-0', ACTION_TONES[blocked.action])}>{action}</span>
        <span className="shrink-0">{guardrailKindName(blocked.kind)}</span>
        {target !== undefined && (
          <code className="min-w-0 truncate font-mono text-xs text-soft-foreground" title={target}>
            {target}
          </code>
        )}
        {attempt !== undefined && <span className="shrink-0 text-xs tabular-nums">{attempt}</span>}
        {hasDetail && (
          <ChevronRight
            aria-hidden
            className={cn('size-3 shrink-0 opacity-70 transition-transform', open && 'rotate-90')}
          />
        )}
      </button>
      <Collapse open={open && hasDetail} id={id}>
        <pre className="mt-1 mb-2 ml-5.5 max-h-60 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
          {blocked.reason}
        </pre>
      </Collapse>
    </div>
  );
}
