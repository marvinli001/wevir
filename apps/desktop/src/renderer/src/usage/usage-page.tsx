// 使用统计页（0.62.0，Host 功能 `usage_stats`）：工作台主窗格里的一列。顶上是标题与价格表状态、刷新；下面是筛选（模型服务里
// 添加的服务商，模型、时间段），然后是合计卡片、趋势图、明细（请求记录 / 服务商 / 模型）。数据见 use-usage.ts，写法与计算见 usage-model.ts。

import type { WevirClient } from '@wevir/client-sdk';
import type { ProviderProfile, UsageAggregate, UsagePricing, UsageRecord } from '@wevir/protocol';
import { cn } from 'cn';
import { ChartColumn, CircleAlert, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { IconButton } from '@/components/icon-button';
import { ProviderLogo } from '@/components/provider-logo';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, type SelectOption } from '@/components/ui/select';
import { useWorkbenchData } from '@/data/workbench-data';
import { describe } from '@/host/host-connection';
import { currentLocale, type PlainMessageKey, t } from '@/i18n';
import { formatRelativeTime } from '@/session/subagent-model';
import { type Notice, NoticeBanner, Segmented } from '@/settings/settings-ui';
import { RecordDrawer } from './record-drawer';
import { UsageChart } from './usage-chart';
import {
  approxNote,
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
  type UsageRange,
  type UsageSelection,
  type UsageTab,
} from './usage-model';
import { usagePrefs } from './usage-prefs';
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
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<UsageRecord>();
  const [notice, setNotice] = useState<Notice>();
  const locale = currentLocale();
  const workbench = useWorkbenchData();
  const providers = workbench.status === 'ready' ? workbench.providers : [];
  const entries = workbench.status === 'ready' ? workbench.workspaces : [];
  const data = useUsage(client, prefs.range, selection, page);
  const summary = data.summary.data;

  // 选中的连接被删了（用量随之删除）：回到全部。
  const selectedGone =
    selection.providerId !== undefined &&
    workbench.status === 'ready' &&
    !providers.some((provider) => provider.id === selection.providerId);
  useEffect(() => {
    if (selectedGone) setSelection({});
  }, [selectedGone]);

  // 换时间段或筛选时回到第一页。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在时间段或筛选变化时触发。
  useEffect(() => setPage(0), [prefs.range, selection]);

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
            onSelection={setSelection}
            onRange={(range) => usagePrefs.set((current) => ({ ...current, range }))}
            providers={providers}
          />

          {notice && (
            <div className="mb-4">
              <NoticeBanner notice={notice} />
            </div>
          )}
          {data.summary.error !== undefined && (
            <div className="mb-4 flex items-center gap-3" data-testid="usage-error">
              <div className="min-w-0 flex-1">
                <NoticeBanner
                  notice={{
                    tone: 'error',
                    text: t('usage.loadFailed', { error: describe(data.summary.error) }),
                  }}
                />
              </div>
              <Button variant="outline" onClick={data.reload}>
                {t('usage.retry')}
              </Button>
            </div>
          )}

          {summary === undefined ? (
            data.summary.error === undefined && <Skeleton />
          ) : summary.result.totals.requests === 0 ? (
            <EmptyState
              icon={<ChartColumn />}
              title={isFiltered(selection) ? t('usage.emptyFiltered') : t('usage.empty')}
            />
          ) : (
            <div
              className={cn(
                'space-y-5 transition-opacity duration-150 ease-smooth',
                data.summary.loading && 'opacity-70',
              )}
            >
              <Hero totals={summary.result.totals} locale={locale} />
              <UsageChart
                data={summary}
                metric={prefs.metric}
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
                  <Records
                    data={data.records}
                    range={summary.range}
                    locale={locale}
                    providers={providers}
                    onPage={setPage}
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

function Records({
  data,
  range,
  locale,
  providers,
  onPage,
  onOpen,
}: {
  data: ReturnType<typeof useUsage>['records'];
  range: UsageRange;
  locale: string;
  providers: Parameters<typeof RecordsTable>[0]['providers'];
  onPage: (page: number) => void;
  onOpen: (record: UsageRecord) => void;
}) {
  if (data.data === undefined) {
    if (data.error !== undefined) {
      return (
        <NoticeBanner
          notice={{ tone: 'error', text: t('usage.loadFailed', { error: describe(data.error) }) }}
        />
      );
    }
    return <div className="h-40 animate-pulse rounded-xl bg-muted" />;
  }
  return (
    <div
      className={cn('transition-opacity duration-150 ease-smooth', data.loading && 'opacity-70')}
    >
      <RecordsTable
        records={data.data.records}
        total={data.data.total}
        page={data.data.page}
        range={range}
        locale={locale}
        providers={providers}
        onPage={onPage}
        onOpen={onOpen}
      />
    </div>
  );
}

function PricingStatus({ pricing }: { pricing: UsagePricing }) {
  if (pricing.fetchedAt === undefined) {
    return (
      <span
        className="flex items-center gap-1.5 text-xs text-warning"
        title={pricing.lastError}
        data-testid="usage-pricing"
      >
        <CircleAlert className="size-3.5" aria-hidden />
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
        <CircleAlert className="size-3.5 text-warning" aria-hidden />
      )}
      {t('usage.pricing.status', { source: pricing.source, time })}
    </span>
  );
}

function Filters({
  summary,
  selection,
  range,
  onSelection,
  onRange,
  providers,
}: {
  summary: SummaryData | undefined;
  selection: UsageSelection;
  range: UsageRange;
  onSelection: (selection: UsageSelection) => void;
  onRange: (range: UsageRange) => void;
  providers: readonly ProviderProfile[];
}) {
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
            {providerTitle(provider)}
          </Chip>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
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
        <div className="ml-auto shrink-0">
          <Segmented<UsageRange>
            label={t('usage.range')}
            value={range}
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
        'inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs whitespace-nowrap pressable outline-none transition-[color,background-color,box-shadow] duration-150 ease-smooth focus-visible:ring-2 focus-visible:ring-ring/50',
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
        {value}
      </div>
      {children}
    </div>
  );
}

function Hero({ totals, locale }: { totals: UsageAggregate; locale: string }) {
  const total = totalTokens(totals.tokens);
  const approx = approxNote(total, locale);
  const rate = cacheHitRate(totals.tokens);
  const exactCost = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: 6,
  }).format(totals.cost);
  const costTitle =
    totals.unpriced > 0
      ? `${exactCost}\n${t('usage.cost.unpriced', { count: totals.unpriced })}`
      : exactCost;
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
              {formatInteger(total, locale)}
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
              {formatInteger(totals.requests, locale)}
            </div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">{t('usage.cost')}</div>
            <div
              className="mt-1 flex items-baseline gap-1.5 text-xl font-semibold tabular-nums"
              title={costTitle}
            >
              {totals.requests > 0 && totals.unpriced === totals.requests
                ? '—'
                : formatCost(totals.cost, locale)}
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
