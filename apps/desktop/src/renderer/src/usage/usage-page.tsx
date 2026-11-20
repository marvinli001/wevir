// 使用统计页（0.62.0，Host 功能 `usage_stats`）：工作台主窗格里的一列。顶上是标题与价格表状态、刷新；下面是筛选（模型服务里
// 添加的服务商，模型、时间段：预设或自定义起止），然后是合计卡片、趋势图、明细（请求记录 / 服务商 / 模型）。数据见 use-usage.ts，
// 写法与计算见 usage-model.ts。换服务商、模型、精度或时间段时保留上次的内容，新结果到了数字滚动、柱子过渡；
// 骨架屏只在第一次读到之前。

import type { WevirClient } from '@wevir/client-sdk';
import type {
  ProviderProfile,
  UsageAggregate,
  UsagePricing,
  UsageRecord,
  UsageSavings,
} from '@wevir/protocol';
import { cn } from 'cn';
import { ChartColumn, CircleAlert, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { IconButton } from '@/components/icon-button';
import { ProviderLogo } from '@/components/provider-logo';
import { RollingNumber } from '@/components/rolling-number';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, type SelectOption } from '@/components/ui/select';
import { useAccounts, useWorkbenchData } from '@/data/workbench-data';
import { describe } from '@/host/host-connection';
import { currentLocale, type PlainMessageKey, t } from '@/i18n';
import { formatRelativeTime } from '@/session/subagent-model';
import { type Notice, NoticeBanner, Segmented } from '@/settings/settings-ui';
import { RangePicker } from './range-picker';
import { RecordDrawer } from './record-drawer';
import { UsageChart } from './usage-chart';
import {
  aggregateCost,
  approxNote,
  type CustomRange,
  cacheHitRate,
  filterProviders,
  formatCost,
  formatInteger,
  formatPercent,
  formatTokensFit,
  isFiltered,
  providerLogoOf,
  providerTitle,
  selectModel,
  selectProvider,
  totalTokens,
  USAGE_RANGES,
  USAGE_TABS,
  type UsagePeriod,
  type UsageRange,
  type UsageSelection,
  type UsageTab,
} from './usage-model';
import { prefsWindow, usagePrefs } from './usage-prefs';
import { ModelsTable, ProvidersTable, RecordsTable } from './usage-tables';
import { type SummaryData, useUsage } from './use-usage';

const RANGE_LABEL: Record<UsageRange, PlainMessageKey> = {
  today: 'usage.range.today',
  '7d': 'usage.range.7d',
  '30d': 'usage.range.30d',
  '90d': 'usage.range.90d',
};

const TAB_LABEL: Record<UsageTab, PlainMessageKey> = {
  records: 'usage.tab.records',
  providers: 'usage.tab.providers',
  models: 'usage.tab.models',
};

/** 下拉里的“全部”。 */
const ALL = '__all__';

export function UsagePage({ client }: { client: WevirClient }) {
  const prefs = usagePrefs.use();
  const [selection, setSelection] = useState<UsageSelection>({});
  const [open, setOpen] = useState<UsageRecord>();
  const [notice, setNotice] = useState<Notice>();
  const locale = currentLocale();
  const workbench = useWorkbenchData();
  const providers = workbench.status === 'ready' ? workbench.providers : [];
  const entries = workbench.status === 'ready' ? workbench.workspaces : [];
  const window = prefsWindow(prefs);
  const data = useUsage(client, window, selection);
  const summary = data.data;

  // 选中的连接被删了（用量随之删除）：回到全部。
  const selectedGone =
    selection.providerId !== undefined &&
    workbench.status === 'ready' &&
    !providers.some((provider) => provider.id === selection.providerId);
  useEffect(() => {
    if (selectedGone) setSelection(selectProvider(undefined));
  }, [selectedGone]);

  const refresh = () => {
    setNotice(undefined);
    data
      .refreshPricing()
      .catch((reason: unknown) =>
        setNotice({ tone: 'error', text: t('usage.pricing.failed', { error: describe(reason) }) }),
      );
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="usage-page">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-250 px-5 pt-6 pb-16 sm:px-10">
          <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-xl font-semibold">{t('usage.title')}</h1>
            <div className="flex items-center gap-2">
              {summary !== undefined && <PricingStatus pricing={summary.result.pricing} />}
              <IconButton
                label={t('usage.refresh')}
                onClick={refresh}
                disabled={data.refreshingPricing}
                data-action="refresh"
              >
                <RefreshCw className={cn(data.refreshingPricing && 'animate-spin')} />
              </IconButton>
            </div>
          </header>

          <Filters
            summary={summary}
            selection={selection}
            range={prefs.range}
            custom={prefs.custom}
            period={summary?.period}
            locale={locale}
            onSelection={setSelection}
            onRange={(range) => usagePrefs.set((current) => ({ ...current, range }))}
            onCustom={(custom) =>
              usagePrefs.set((current) => ({ ...current, range: 'custom', custom }))
            }
            providers={providers}
          />

          {summary?.result.savings !== undefined && (
            <Savings value={summary.result.savings} locale={locale} />
          )}

          {notice && (
            <div className="mb-4">
              <NoticeBanner notice={notice} />
            </div>
          )}
          {data.error !== undefined && (
            <div className="mb-4 flex items-center gap-3" data-testid="usage-error">
              <div className="min-w-0 flex-1">
                <NoticeBanner
                  notice={{
                    tone: 'error',
                    text: t('usage.loadFailed', { error: describe(data.error) }),
                  }}
                />
              </div>
              <Button variant="outline" onClick={data.reload}>
                {t('usage.retry')}
              </Button>
            </div>
          )}

          {summary === undefined ? (
            data.error === undefined && <Skeleton />
          ) : summary.result.totals.requests === 0 ? (
            <div
              key="empty"
              aria-busy={data.loading}
              className="animate-in fade-in duration-200 ease-smooth"
            >
              <EmptyState
                icon={<ChartColumn />}
                title={isFiltered(selection) ? t('usage.emptyFiltered') : t('usage.empty')}
              />
            </div>
          ) : (
            <div
              key="content"
              className="animate-in fade-in space-y-5 duration-200 ease-smooth"
              aria-busy={data.loading}
            >
              <Hero totals={summary.result.totals} locale={locale} />
              <UsageChart
                data={summary}
                metric={
                  prefs.metric === 'requests' && summary.result.totals.modelRequests === null
                    ? 'tokens'
                    : prefs.metric
                }
                onMetric={(metric) => usagePrefs.set((current) => ({ ...current, metric }))}
                locale={locale}
              />
              <section>
                <div className="mb-3">
                  <Segmented<UsageTab>
                    label={t('usage.tabs')}
                    value={prefs.tab}
                    onChange={(tab) => usagePrefs.set((current) => ({ ...current, tab }))}
                    options={USAGE_TABS.map((value) => ({ value, label: t(TAB_LABEL[value]) }))}
                  />
                </div>
                {prefs.tab === 'records' && (
                  <RecordsTable
                    records={summary.records}
                    total={summary.total}
                    page={summary.page}
                    loading={data.loading}
                    period={summary.period}
                    locale={locale}
                    providers={providers}
                    onPage={data.setPage}
                    onOpen={setOpen}
                  />
                )}
                {prefs.tab === 'providers' && (
                  <ProvidersTable
                    rows={summary.result.byProvider}
                    locale={locale}
                    providers={providers}
                  />
                )}
                {prefs.tab === 'models' && (
                  <ModelsTable rows={summary.result.byModel} locale={locale} />
                )}
              </section>
            </div>
          )}
        </div>
      </ScrollArea>
      <RecordDrawer
        record={open}
        locale={locale}
        providers={providers}
        entries={entries}
        onClose={() => setOpen(undefined)}
      />
    </div>
  );
}

function PricingStatus({ pricing }: { pricing: UsagePricing }) {
  if (pricing.fetchedAt === undefined) {
    return (
      <span
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        title={pricing.lastError}
        data-testid="usage-pricing"
      >
        <CircleAlert className="size-3.5 text-icon-warning" aria-hidden />
        {t('usage.pricing.missing')}
      </span>
    );
  }
  const time = formatRelativeTime(new Date(pricing.fetchedAt).toISOString(), Date.now());
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      title={
        pricing.lastError === undefined
          ? undefined
          : t('usage.pricing.failed', { error: pricing.lastError })
      }
      data-testid="usage-pricing"
    >
      {pricing.lastError !== undefined && (
        <CircleAlert className="size-3.5 text-icon-warning" aria-hidden />
      )}
      {t('usage.pricing.status', { source: pricing.source, time })}
    </span>
  );
}

function Filters({
  summary,
  selection,
  range,
  custom,
  period,
  locale,
  onSelection,
  onRange,
  onCustom,
  providers,
}: {
  summary: SummaryData | undefined;
  selection: UsageSelection;
  range: UsageRange | 'custom';
  custom: CustomRange | undefined;
  period: UsagePeriod | undefined;
  locale: string;
  onSelection: (selection: UsageSelection) => void;
  onRange: (range: UsageRange) => void;
  onCustom: (range: CustomRange) => void;
  providers: readonly ProviderProfile[];
}) {
  const accounts = useAccounts();
  const options = summary?.result.options;
  const listed = filterProviders(providers, options?.providers ?? []);
  const models = [...(options?.models ?? [])];
  if (selection.model !== undefined && !models.includes(selection.model))
    models.push(selection.model);
  const modelOptions: SelectOption[] = [
    { value: ALL, label: t('usage.filter.allModels') },
    ...models.map((model) => ({ value: model, label: model })),
  ];

  return (
    <div className="mb-5 space-y-3">
      <fieldset className="flex min-w-0 flex-wrap items-center gap-1" data-testid="usage-providers">
        <legend className="sr-only">{t('usage.filter.provider')}</legend>
        <Chip
          active={selection.providerId === undefined}
          onClick={() => onSelection(selectProvider(undefined))}
        >
          {t('usage.filter.all')}
        </Chip>
        {listed.map((provider) => (
          <Chip
            key={provider.id}
            active={selection.providerId === provider.id}
            onClick={() => onSelection(selectProvider(provider.id))}
          >
            <ProviderLogo
              logo={providerLogoOf(provider.id, provider.kind, providers)}
              fallback={provider.displayName}
              className="size-3.5"
            />
            {providerTitle(provider, accounts)}
          </Chip>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        {options?.precisions !== undefined && (
          <Select
            aria-label={t('usage.precision')}
            value={selection.precision ?? ALL}
            options={[
              { value: ALL, label: t('usage.precision.all') },
              ...(['exact', 'engine', 'turn'] as const)
                .filter(
                  (value) => options.precisions?.includes(value) || value === selection.precision,
                )
                .map((value) => ({ value, label: t(`usage.precision.${value}`) })),
            ]}
            onValueChange={(value) =>
              onSelection({ ...selection, precision: value === ALL ? undefined : value })
            }
            className="w-32"
            data-filter="precision"
          />
        )}
        <Select
          aria-label={t('usage.filter.model')}
          value={selection.model ?? ALL}
          options={modelOptions}
          onValueChange={(value) =>
            onSelection(selectModel(selection, value === ALL ? undefined : value))
          }
          className={cn('w-52', selection.model !== undefined && 'font-mono text-xs')}
          popupClassName="font-mono text-xs"
          data-filter="model"
        />
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
          <RangePicker
            active={range === 'custom'}
            value={custom}
            start={period?.edges[0] ?? Date.now()}
            locale={locale}
            onApply={onCustom}
          />
          <Segmented<UsageRange>
            label={t('usage.range')}
            value={range === 'custom' ? undefined : range}
            onChange={onRange}
            options={USAGE_RANGES.map((value) => ({ value, label: t(RANGE_LABEL[value]) }))}
          />
        </div>
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs whitespace-nowrap pressable outline-none transition-[color,background-color,box-shadow] duration-150 ease-smooth focus-visible:focus-ring',
        active
          ? 'bg-selected font-medium text-foreground ring-1 ring-selected-border ring-inset'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Skeleton() {
  return (
    <div className="space-y-5" aria-busy data-testid="usage-loading">
      <div className="h-44 animate-pulse rounded-xl bg-muted" />
      <div className="h-72 animate-pulse rounded-xl bg-muted" />
      <span className="sr-only">{t('common.loading')}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  title,
  children,
}: {
  label: string;
  value: string;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-base font-medium tabular-nums" title={title ?? value}>
        <RollingNumber value={value} />
      </div>
      {children}
    </div>
  );
}

function Hero({ totals, locale }: { totals: UsageAggregate; locale: string }) {
  const total = totalTokens(totals.tokens);
  const approx = approxNote(total, locale);
  const rate = cacheHitRate(totals.tokens);
  const cost = aggregateCost(totals);
  const costTitle =
    totals.unpriced > 0
      ? t('usage.cost.unpriced', { count: totals.unpriced })
      : cost === undefined
        ? undefined
        : new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: 'USD',
            currencyDisplay: 'narrowSymbol',
            maximumFractionDigits: 6,
          }).format(cost);
  const tokenStat = (label: PlainMessageKey, value: number) => (
    <Stat
      label={t(label)}
      value={formatTokensFit(value, locale)}
      title={formatInteger(value, locale)}
    />
  );

  return (
    <section className="rounded-xl border border-border bg-card p-5" data-testid="usage-hero">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <div className="min-w-0">
          <div className="text-sm text-muted-foreground">{t('usage.total')}</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className="text-3xl font-semibold tracking-tight tabular-nums"
              data-testid="usage-total"
            >
              <RollingNumber value={formatInteger(total, locale)} />
            </span>
            {approx !== undefined && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground tabular-nums">
                {t('usage.approx', { value: approx })}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-10">
          <div>
            <div className="text-sm text-muted-foreground">{t('usage.requests')}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              <RollingNumber
                value={
                  totals.modelRequests === null
                    ? '—'
                    : formatInteger(totals.modelRequests ?? totals.requests, locale)
                }
              />
            </div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">{t('usage.cost')}</div>
            <div
              className="mt-1 flex items-baseline gap-1.5 text-xl font-semibold tabular-nums"
              title={costTitle}
            >
              {cost === undefined ? '—' : <RollingNumber value={formatCost(cost, locale)} />}
              {totals.unpriced > 0 && (
                <CircleAlert className="size-3.5 self-center text-muted-foreground" aria-hidden />
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-5">
        {tokenStat('usage.tokens.input', totals.tokens.input)}
        {tokenStat('usage.tokens.output', totals.tokens.output)}
        {tokenStat('usage.tokens.cacheWrite', totals.tokens.cacheWrite)}
        {tokenStat('usage.tokens.cacheRead', totals.tokens.cacheRead)}
        <Stat
          label={t('usage.cacheHitRate')}
          value={rate === undefined ? '—' : formatPercent(rate, locale)}
        >
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div
              className="h-full rounded-full bg-foreground/60 transition-[width] duration-500 ease-smooth"
              style={{ width: `${Math.round((rate ?? 0) * 1000) / 10}%` }}
            />
          </div>
        </Stat>
      </div>
    </section>
  );
}

function Savings({ value, locale }: { value: UsageSavings; locale: string }) {
  return (
    <div
      className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-y border-border py-3"
      data-testid="usage-savings"
      title={t('usage.savings.scope', {
        pairs: value.pairs,
        low: formatCost(-value.costInterval[1], locale),
        high: formatCost(-value.costInterval[0], locale),
      })}
    >
      <div className="flex items-baseline gap-3">
        <span className="text-sm text-muted-foreground">{t('usage.savings')}</span>
        <span className="font-semibold tabular-nums">
          {t('usage.savings.value', { cost: formatCost(value.costPerTask, locale) })}
        </span>
      </div>
      <span className="text-xs text-muted-foreground">
        {t('usage.savings.baseline', { baseline: value.baseline, candidate: value.candidate })} ·{' '}
        {value.model}
      </span>
    </div>
  );
}
