// 一次请求的详情：右侧滑出的抽屉（components/ui/sheet.tsx），分基本信息、Token 用量、成本明细（USD）、性能四节。会话还在时
// 可以点开它。

import type { ProviderProfile, UsageRecord } from '@wevir/protocol';
import { cn } from 'cn';
import { type ReactNode, useRef } from 'react';
import { Link } from 'react-router';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { formatDuration } from '@/session/format';
import {
  formatCost,
  formatInteger,
  formatSeconds,
  formatSpeed,
  formatUnitPrice,
  fullTime,
  MISSING,
  sourceDisplay,
  speedOf,
  totalTokens,
} from './usage-model';
import { ProviderName } from './usage-tables';

/** 会话还在时它的页面地址与标题（子会话开在父会话的“子智能体”窗格里）。 */
function sessionLink(
  sessionId: string,
  entries: readonly WorkspaceEntry[],
): { to: string; title: string } | undefined {
  for (const entry of entries) {
    const session = entry.sessions.find((item) => item.id === sessionId);
    if (session === undefined) continue;
    const workspaceId = entry.workspace.id;
    return {
      to:
        session.parentSessionId === undefined
          ? paths.session(workspaceId, session.id)
          : paths.agent(workspaceId, session.parentSessionId, session.id),
      title: session.title || t('session.untitled'),
    };
  }
  return undefined;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</h3>
      <dl className="divide-y divide-border rounded-xl border border-border bg-card">{children}</dl>
    </section>
  );
}

function Row({
  label,
  children,
  detail,
  strong,
}: {
  label: string;
  children: ReactNode;
  /** 值左边的说明文字（单价）。 */
  detail?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex min-h-9 items-center gap-3 px-3 py-1.5 text-sm">
      <dt className={cn('shrink-0 text-muted-foreground', strong && 'font-medium text-foreground')}>
        {label}
      </dt>
      <dd
        className={cn('min-w-0 flex-1 truncate text-right tabular-nums', strong && 'font-medium')}
      >
        {detail !== undefined && (
          <span className="mr-2 text-xs text-muted-foreground">{detail}</span>
        )}
        {children}
      </dd>
    </div>
  );
}

export function RecordDrawer({
  record,
  locale,
  providers,
  entries,
  onClose,
}: {
  record: UsageRecord | undefined;
  locale: string;
  providers: readonly ProviderProfile[];
  entries: readonly WorkspaceEntry[];
  onClose: () => void;
}) {
  // 关闭时内容留到滑出结束。
  const last = useRef<UsageRecord | undefined>(undefined);
  if (record !== undefined) last.current = record;
  const shown = record ?? last.current;

  return (
    <Sheet open={record !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full gap-0 sm:max-w-md"
        data-testid="usage-record-drawer"
      >
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle>{t('usage.detail.title')}</SheetTitle>
        </SheetHeader>
        {shown !== undefined && (
          <ScrollArea className="min-h-0 flex-1">
            <RecordDetail
              record={shown}
              locale={locale}
              providers={providers}
              entries={entries}
              onClose={onClose}
            />
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}

function RecordDetail({
  record,
  locale,
  providers,
  entries,
  onClose,
}: {
  record: UsageRecord;
  locale: string;
  providers: readonly ProviderProfile[];
  entries: readonly WorkspaceEntry[];
  onClose: () => void;
}) {
  const source = sourceDisplay(record.source);
  const session = sessionLink(record.sessionId, entries);
  const { tokens, cost, price } = record;
  const integer = (value: number) => formatInteger(value, locale);
  const unit = (value: number | undefined) =>
    value === undefined
      ? undefined
      : t('usage.detail.unitPrice', { price: formatUnitPrice(value, locale) });
  const speed = formatSpeed(speedOf(tokens.output, record.durationMs), locale);

  return (
    <div className="space-y-5 px-5 py-4">
      <Section title={t('usage.detail.basic')}>
        <Row label={t('usage.detail.time')}>{fullTime(record.at, locale)}</Row>
        <Row label={t('usage.detail.source')}>{source.name}</Row>
        <Row label={t('usage.detail.provider')}>
          <ProviderName
            providerId={record.providerId}
            providerName={record.providerName}
            source={record.source}
            providers={providers}
            className="justify-end"
          />
        </Row>
        {record.upstream !== undefined && (
          <Row label={t('usage.detail.upstream')}>
            <span className="font-mono text-xs">{record.upstream}</span>
          </Row>
        )}
        <Row label={t('usage.detail.model')}>
          <span className="font-mono text-xs" title={record.model}>
            {record.model}
          </span>
        </Row>
        <Row label={t('usage.detail.session')}>
          {session === undefined ? (
            <span className="text-muted-foreground">{t('usage.detail.sessionGone')}</span>
          ) : (
            <Link
              to={session.to}
              onClick={onClose}
              className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
              title={session.title}
            >
              {session.title}
            </Link>
          )}
        </Row>
        <Row label={t('usage.detail.requestId')}>
          <span className="font-mono text-xs select-text" title={record.requestId}>
            {record.requestId}
          </span>
        </Row>
      </Section>

      <Section title={t('usage.detail.tokens')}>
        <Row label={t('usage.tokens.input')}>{integer(tokens.input)}</Row>
        <Row label={t('usage.tokens.output')}>{integer(tokens.output)}</Row>
        <Row label={t('usage.tokens.reasoning')}>{integer(tokens.reasoning)}</Row>
        <Row label={t('usage.tokens.cacheWrite')}>{integer(tokens.cacheWrite)}</Row>
        <Row label={t('usage.tokens.cacheRead')}>{integer(tokens.cacheRead)}</Row>
        <Row label={t('usage.tokens.total')} strong>
          {integer(totalTokens(tokens))}
        </Row>
      </Section>

      <Section title={t('usage.detail.costs')}>
        {cost === undefined ? (
          <Row label={t('usage.tokens.total')}>
            <span className="text-muted-foreground">{t('usage.detail.unpriced')}</span>
          </Row>
        ) : (
          <>
            <Row label={t('usage.tokens.input')} {...withDetail(unit(price?.input))}>
              {formatCost(cost.input, locale)}
            </Row>
            <Row label={t('usage.tokens.output')} {...withDetail(unit(price?.output))}>
              {formatCost(cost.output, locale)}
            </Row>
            <Row
              label={t('usage.tokens.cacheWrite')}
              {...withDetail(unit(price?.cacheWrite ?? price?.input))}
            >
              {formatCost(cost.cacheWrite, locale)}
            </Row>
            <Row
              label={t('usage.tokens.cacheRead')}
              {...withDetail(unit(price?.cacheRead ?? price?.input))}
            >
              {formatCost(cost.cacheRead, locale)}
            </Row>
            {record.priceSource !== undefined && (
              <Row label={t('usage.detail.priceSource')}>
                <span className="font-mono text-xs">{record.priceSource}</span>
                <span className="text-muted-foreground"> · models.dev</span>
              </Row>
            )}
            <Row label={t('usage.tokens.total')} strong>
              {formatCost(cost.total, locale)}
            </Row>
          </>
        )}
      </Section>

      <Section title={t('usage.detail.performance')}>
        <Row label={t('usage.detail.duration')}>
          {record.durationMs === undefined ? MISSING : formatDuration(record.durationMs)}
        </Row>
        <Row label={t('usage.detail.firstToken')}>
          {record.firstTokenMs === undefined ? MISSING : formatSeconds(record.firstTokenMs, locale)}
        </Row>
        <Row label={t('usage.detail.speed')}>{speed ?? MISSING}</Row>
      </Section>
    </div>
  );
}

function withDetail(detail: string | undefined): { detail?: string } {
  return detail === undefined ? {} : { detail };
}
