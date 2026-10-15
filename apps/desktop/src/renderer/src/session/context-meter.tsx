// 输入框底栏的上下文用量表（0.29.0，照 Codex 桌面端与 T3 Code）：一个随用量填满的圆环，悬停或点开是用量、累计用量、
// 自动压缩的线与“压缩上下文”按钮。圆环与弹层的结构照 T3 Code 的 apps/web/src/components/chat/ContextWindowMeter.tsx
// （MIT，ec1313c）改写；用量的推导用会话侧栏的 contextUsage（layout/rail-model.ts），token 数用 formatTokens。

import type { ProviderProfile, Session } from '@wevir/protocol';
import { cn } from 'cn';
import { FoldVertical } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useTranscript } from '@/data/workbench-data';
import { t } from '@/i18n';
import { ContextBar } from '@/layout/context-bar';
import { type ContextUsage, contextUsage, formatTokens } from '@/layout/rail-model';

const TONE_TEXT: Record<ContextUsage['tone'], string> = {
  normal: 'text-muted-foreground',
  warning: 'text-warning',
  danger: 'text-destructive',
};

const RADIUS = 6.25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * 会话的上下文用量（`usage.updated` 或快照的 `usage`）；引擎还没报过（新会话、Cursor 这类不报的引擎）时不显示。
 * `onCompact` 给了（Host 与引擎都会 `compact`、会话可写）才有按钮，回合进行中按钮不可点。
 */
export function ContextMeter({
  session,
  providers,
  busy,
  onCompact,
}: {
  session: Session;
  providers: readonly ProviderProfile[];
  busy: boolean;
  onCompact?: () => void;
}) {
  const state = useTranscript(session.id);
  const usage = contextUsage(state?.transcript.usage, session, providers);
  const [open, setOpen] = useState(false);
  if (!usage) return null;
  const size = formatTokens(usage.size);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={150}
        data-testid="context-meter"
        data-tone={usage.tone}
        aria-label={t('rail.context.meter', { percent: usage.percent })}
        className="flex size-7 shrink-0 items-center justify-center rounded-full outline-none transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-muted"
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className={cn('size-4 -rotate-90', TONE_TEXT[usage.tone])}
        >
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            strokeWidth="2"
            className="stroke-muted-foreground/25"
          />
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - usage.percent / 100)}
            className="transition-[stroke-dashoffset] duration-500 ease-smooth motion-reduce:transition-none"
          />
        </svg>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-64 gap-2 p-3 text-xs"
        data-testid="context-meter-popover"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium text-sm">{t('rail.context')}</span>
          <span className="text-muted-foreground tabular-nums">
            {t('rail.context.used', { percent: usage.percent })} · {formatTokens(usage.used)} /{' '}
            {usage.estimated ? t('rail.context.approx', { size }) : size}
          </span>
        </div>
        <ContextBar usage={usage} />
        {(usage.total !== undefined || usage.autoCompactAt !== undefined) && (
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-muted-foreground">
            {usage.autoCompactAt !== undefined && (
              <>
                <dt>{t('rail.context.autoCompact')}</dt>
                <dd className="tabular-nums">{formatTokens(usage.autoCompactAt)}</dd>
              </>
            )}
            {usage.total !== undefined && (
              <>
                <dt>{t('rail.context.total')}</dt>
                <dd className="tabular-nums">{formatTokens(usage.total)}</dd>
              </>
            )}
          </dl>
        )}
        {onCompact && (
          <button
            type="button"
            disabled={busy}
            data-testid="context-meter-compact"
            onClick={() => {
              setOpen(false);
              onCompact();
            }}
            className="pressable mt-1 inline-flex h-7 items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 text-xs outline-none transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          >
            <FoldVertical aria-hidden className="size-3.5" />
            {t('command.compact')}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
