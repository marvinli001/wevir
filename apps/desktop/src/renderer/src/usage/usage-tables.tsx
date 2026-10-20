// 使用情况页的明细表：请求记录（分页，点一行看详情）与按服务商、按模型的合计。数字都是完整的分组整数，右对齐、等宽数字。

import type {
  ProviderKind,
  ProviderProfile,
  UsageAggregate,
  UsageModelAggregate,
  UsageProviderAggregate,
  UsageRecord,
} from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from '@/components/icon-button';
import { ProviderLogo } from '@/components/provider-logo';
import { t } from '@/i18n';
import {
  averageFirstToken,
  cacheHitRate,
  formatCost,
  formatInteger,
  formatPercent,
  formatSeconds,
  formatSpeed,
  MISSING,
  pageCount,
  providerLogoOf,
  RECORDS_PAGE_SIZE,
  recordTime,
  speedOf,
  timingSpeed,
  totalTokens,
  type UsageRange,
} from './usage-model';

const TABLE_CARD = 'overflow-x-auto rounded-xl border border-border bg-card';
const TH = 'h-9 px-3 text-xs font-medium whitespace-nowrap text-muted-foreground';
const TD = 'h-10 px-3 whitespace-nowrap';
const NUM = 'text-right tabular-nums';

/** 来源的标志与服务商名（表格与详情共用）。 */
export function ProviderName({
  providerId,
  providerName,
  source,
  providers,
  className,
}: {
  providerId: string;
  providerName: string;
  source: ProviderKind;
  providers: readonly ProviderProfile[];
  className?: string;
}) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <ProviderLogo
        logo={providerLogoOf(providerId, source, providers)}
        fallback={providerName}
        className="size-4"
      />
      <span className="min-w-0 truncate">{providerName}</span>
    </span>
  );
}

function costText(cost: number | undefined, locale: string): string {
  return cost === undefined ? MISSING : formatCost(cost, locale);
}

export function RecordsTable({
  records,
  total,
  page,
  range,
  locale,
  providers,
  onPage,
  onOpen,
}: {
  records: readonly UsageRecord[];
  total: number;
  page: number;
  range: UsageRange;
  locale: string;
  providers: readonly ProviderProfile[];
  onPage: (page: number) => void;
  onOpen: (record: UsageRecord) => void;
}) {
  if (records.length === 0 && page === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border-strong px-4 py-8 text-center text-sm text-muted-foreground">
        {t('usage.records.empty')}
      </p>
    );
  }
  const pages = pageCount(total, RECORDS_PAGE_SIZE);
  return (
    <div data-testid="usage-records">
      <div className={TABLE_CARD}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th className={TH}>{t('usage.col.time')}</th>
              <th className={TH}>{t('usage.col.source')}</th>
              <th className={TH}>{t('usage.col.model')}</th>
              <th className={cn(TH, NUM)}>{t('usage.tokens.input')}</th>
              <th className={cn(TH, NUM)}>{t('usage.tokens.output')}</th>
              <th className={cn(TH, NUM)}>{t('usage.tokens.cacheRead')}</th>
              <th className={cn(TH, NUM)}>{t('usage.tokens.cacheWrite')}</th>
              <th className={cn(TH, NUM)}>{t('usage.col.cost')}</th>
              <th className={cn(TH, NUM)}>{t('usage.col.speed')}</th>
              <th className={cn(TH, NUM)}>{t('usage.col.firstToken')}</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr
                key={record.id}
                className="cursor-pointer border-t border-border transition-colors duration-150 ease-smooth hover:bg-muted/50"
                onClick={() => onOpen(record)}
              >
                <td className={TD}>
                  <button
                    type="button"
                    className="rounded-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(record);
                    }}
                  >
                    {recordTime(record.at, range, locale)}
                  </button>
                </td>
                <td className={cn(TD, 'max-w-44')}>
                  <ProviderName
                    providerId={record.providerId}
                    providerName={record.providerName}
                    source={record.source}
                    providers={providers}
                  />
                </td>
                <td className={cn(TD, 'max-w-56 truncate font-mono text-xs')} title={record.model}>
                  {record.model}
                </td>
                <td className={cn(TD, NUM)}>{formatInteger(record.tokens.input, locale)}</td>
                <td className={cn(TD, NUM)}>{formatInteger(record.tokens.output, locale)}</td>
                <td className={cn(TD, NUM)}>{formatInteger(record.tokens.cacheRead, locale)}</td>
                <td className={cn(TD, NUM)}>{formatInteger(record.tokens.cacheWrite, locale)}</td>
                <td className={cn(TD, NUM)}>{costText(record.cost?.total, locale)}</td>
                <td className={cn(TD, NUM, 'text-muted-foreground')}>
                  {formatSpeed(speedOf(record.tokens.output, record.durationMs), locale) ?? MISSING}
                </td>
                <td className={cn(TD, NUM, 'text-muted-foreground')}>
                  {record.firstTokenMs === undefined
                    ? MISSING
                    : formatSeconds(record.firstTokenMs, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <IconButton
            label={t('usage.page.prev')}
            variant="outline"
            disabled={page === 0}
            onClick={() => onPage(page - 1)}
          >
            <ChevronLeft />
          </IconButton>
          <span className="tabular-nums" data-testid="usage-page">
            {t('usage.page', { page: page + 1, pages })}
          </span>
          <IconButton
            label={t('usage.page.next')}
            variant="outline"
            disabled={page + 1 >= pages}
            onClick={() => onPage(page + 1)}
          >
            <ChevronRight />
          </IconButton>
        </div>
      )}
    </div>
  );
}

interface AggregateRow {
  key: string;
  name: ReactNode;
  aggregate: UsageAggregate;
}

function AggregateTable({
  nameLabel,
  rows,
  locale,
}: {
  nameLabel: string;
  rows: readonly AggregateRow[];
  locale: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border-strong px-4 py-8 text-center text-sm text-muted-foreground">
        {t('usage.records.empty')}
      </p>
    );
  }
  const sorted = [...rows].sort((a, b) => b.aggregate.requests - a.aggregate.requests);
  return (
    <div className={TABLE_CARD}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left">
            <th className={TH}>{nameLabel}</th>
            <th className={cn(TH, NUM)}>{t('usage.requests')}</th>
            <th className={cn(TH, NUM)}>{t('usage.total')}</th>
            <th className={cn(TH, NUM)}>{t('usage.col.cost')}</th>
            <th className={cn(TH, NUM)}>{t('usage.cacheHitRate')}</th>
            <th className={cn(TH, NUM)}>{t('usage.col.speed')}</th>
            <th className={cn(TH, NUM)}>{t('usage.col.avgFirstToken')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(({ key, name, aggregate }) => {
            const rate = cacheHitRate(aggregate.tokens);
            const firstToken = averageFirstToken(aggregate.timing);
            return (
              <tr key={key} className="border-t border-border">
                <td className={cn(TD, 'max-w-64')}>{name}</td>
                <td className={cn(TD, NUM)}>{formatInteger(aggregate.requests, locale)}</td>
                <td className={cn(TD, NUM)}>
                  {formatInteger(totalTokens(aggregate.tokens), locale)}
                </td>
                <td
                  className={cn(TD, NUM)}
                  title={
                    aggregate.unpriced > 0
                      ? t('usage.cost.unpriced', { count: aggregate.unpriced })
                      : undefined
                  }
                >
                  {aggregate.requests > 0 && aggregate.unpriced === aggregate.requests
                    ? MISSING
                    : formatCost(aggregate.cost, locale)}
                </td>
                <td className={cn(TD, NUM)}>
                  {rate === undefined ? MISSING : formatPercent(rate, locale)}
                </td>
                <td className={cn(TD, NUM, 'text-muted-foreground')}>
                  {formatSpeed(timingSpeed(aggregate.timing), locale) ?? MISSING}
                </td>
                <td className={cn(TD, NUM, 'text-muted-foreground')}>
                  {firstToken === undefined ? MISSING : formatSeconds(firstToken, locale)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ProvidersTable({
  rows,
  locale,
  providers,
}: {
  rows: readonly UsageProviderAggregate[];
  locale: string;
  providers: readonly ProviderProfile[];
}) {
  return (
    <AggregateTable
      nameLabel={t('usage.tab.providers')}
      locale={locale}
      rows={rows.map((row) => ({
        key: row.providerId,
        name: (
          <ProviderName
            providerId={row.providerId}
            providerName={row.providerName}
            source={row.source}
            providers={providers}
          />
        ),
        aggregate: row,
      }))}
    />
  );
}

export function ModelsTable({
  rows,
  locale,
}: {
  rows: readonly UsageModelAggregate[];
  locale: string;
}) {
  return (
    <AggregateTable
      nameLabel={t('usage.tab.models')}
      locale={locale}
      rows={rows.map((row) => ({
        key: row.model,
        name: (
          <span className="block truncate font-mono text-xs" title={row.model}>
            {row.model}
          </span>
        ),
        aggregate: row,
      }))}
    />
  );
}
