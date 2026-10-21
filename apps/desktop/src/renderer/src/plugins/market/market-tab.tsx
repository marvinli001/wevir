// 插件页的“市场”分段（plugin-market.md §9.1）：顶行右边的搜索、刷新与齿轮，首页的分组（先推荐位再按分类，每组最多 6 个），
// 搜索结果（平铺一组），以及一个分组的完整列表（`/plugins/market/group/:id`）。

import { ChevronLeft, CloudOff, RefreshCw, Search, Settings, X } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { currentLocale, t } from '@/i18n';
import { paths } from '@/routes/paths';
import { findGroup, GROUP_PREVIEW_LIMIT, marketGroups, searchEntries } from './market-model';
import { EntryGrid, GroupSection, MarketSkeleton } from './market-rows';
import type { MarketData, MarketIndexResult, MarketSource } from './use-market';

/** 顶行右边的搜索框、刷新（转圈时停用，失败时旁边一个警告点）与齿轮（设置里的市场源）。 */
export function MarketToolbar({
  data,
  query,
  onQuery,
}: {
  data: MarketData;
  query: string;
  onQuery: (query: string) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { state } = data;
  const refreshing = state.status === 'loading' || (state.status === 'ready' && state.refreshing);
  const warning = state.status === 'ready' ? state.warning : undefined;
  return (
    <>
      <label className="flex h-8 w-56 min-w-0 items-center gap-2 rounded-full bg-muted/70 px-3 text-muted-foreground focus-within:bg-muted focus-within:focus-ring">
        <Search aria-hidden className="size-3.5 shrink-0" />
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && onQuery('')}
          placeholder={t('plugins.market.search')}
          aria-label={t('plugins.market.search')}
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          data-testid="market-search"
        />
        {query && (
          <button
            type="button"
            aria-label={t('settings.searchClear')}
            onClick={() => onQuery('')}
            className="-mr-1 rounded-full p-0.5 outline-none hover:text-foreground focus-visible:focus-ring"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        )}
      </label>
      <span className="relative inline-flex">
        <IconButton
          label={t('plugins.market.refresh')}
          disabled={refreshing}
          onClick={data.refresh}
          data-action="refresh"
        >
          <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
        </IconButton>
        {warning !== undefined && !refreshing && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t('plugins.market.stale', { error: warning })}
                  className="absolute top-0.5 right-0.5 size-2 rounded-full bg-warning ring-2 ring-background outline-none focus-visible:focus-ring"
                  data-testid="market-warning"
                />
              }
            />
            <TooltipContent className="max-w-80 break-words">
              {t('plugins.market.stale', { error: warning })}
            </TooltipContent>
          </Tooltip>
        )}
      </span>
      <IconButton
        label={t('plugins.market.sources')}
        onClick={() =>
          navigate(paths.settings('general'), {
            state: { from: location, focus: 'market-mirror' },
          })
        }
        data-action="market-settings"
      >
        <Settings />
      </IconButton>
    </>
  );
}

/** 读取中、失败、空的索引；读到了交给 `children`。 */
function MarketGate({
  data,
  children,
}: {
  data: MarketData;
  children: (result: MarketIndexResult) => ReactNode;
}) {
  const { state } = data;
  if (state.status === 'loading') return <MarketSkeleton />;
  if (state.status === 'error') {
    return (
      <EmptyState
        icon={<CloudOff />}
        title={t('plugins.market.loadFailed')}
        action={
          <Button variant="outline" onClick={data.refresh} data-action="retry">
            {t('plugins.market.retry')}
          </Button>
        }
      >
        <span className="text-sm">{state.error}</span>
      </EmptyState>
    );
  }
  if (state.result.index.entries.length === 0) {
    return <EmptyState icon={<CloudOff />} title={t('plugins.market.empty')} />;
  }
  return children(state.result);
}

/** 市场首页：没有搜索词时是分组，有时是平铺的搜索结果。 */
export function MarketHome({
  data,
  source,
  query,
}: {
  data: MarketData;
  source: MarketSource | undefined;
  query: string;
}) {
  return (
    <MarketGate data={data}>
      {(result) => <MarketHomeContent result={result} source={source} query={query} />}
    </MarketGate>
  );
}

function MarketHomeContent({
  result,
  source,
  query,
}: {
  result: MarketIndexResult;
  source: MarketSource | undefined;
  query: string;
}) {
  const locale = currentLocale();
  const { index } = result;
  const groups = useMemo(() => marketGroups(index, locale), [index, locale]);
  const found = useMemo(() => searchEntries(index, query, locale), [index, query, locale]);
  if (query.trim() !== '') {
    return found.length === 0 ? (
      <p
        className="py-10 text-center text-sm text-muted-foreground"
        data-testid="market-no-results"
      >
        {t('plugins.market.noResults')}
      </p>
    ) : (
      <EntryGrid entries={found} source={source} commit={index.commit} />
    );
  }
  return (
    <div data-testid="market-home">
      {groups.map((group) => (
        <GroupSection
          key={group.id}
          group={group}
          limit={GROUP_PREVIEW_LIMIT}
          source={source}
          commit={index.commit}
        />
      ))}
    </div>
  );
}

/** 返回上一页；历史里退无可退（直接打开的地址）时去 `fallback`。 */
export function BackButton({ label, fallback }: { label: string; fallback: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 text-muted-foreground"
      onClick={() => (location.key === 'default' ? navigate(fallback) : navigate(-1))}
      data-action="back"
    >
      <ChevronLeft data-icon="inline-start" />
      {label}
    </Button>
  );
}

/** 一个分组的完整列表。分组不在（索引变了）时转回市场首页。 */
export function MarketGroupPage({
  data,
  source,
  groupId,
}: {
  data: MarketData;
  source: MarketSource | undefined;
  groupId: string;
}) {
  const locale = currentLocale();
  return (
    <div data-testid="market-group">
      <div className="mb-4">
        <BackButton label={t('plugins.title')} fallback={paths.plugins('market')} />
      </div>
      <MarketGate data={data}>
        {({ index }) => {
          const group = findGroup(index, locale, groupId);
          if (group === undefined) {
            return <EmptyState icon={<CloudOff />} title={t('plugins.market.groupMissing')} />;
          }
          return (
            <>
              <h1 className="mb-4 text-xl font-semibold">{group.name}</h1>
              <EntryGrid entries={group.entries} source={source} commit={index.commit} />
            </>
          );
        }}
      </MarketGate>
    </div>
  );
}
