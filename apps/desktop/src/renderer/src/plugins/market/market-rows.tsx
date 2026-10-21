// 市场分段的条目行、图标与骨架（plugin-market.md §9.1）。整行是一个盖满行的链接（进详情），徽章与“+”浮在它上面，
// 互不嵌套。

import type { MarketEntry } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight, Plus } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { currentLocale, t } from '@/i18n';
import { paths } from '@/routes/paths';
import {
  entryIconPath,
  entryInitial,
  entryText,
  iconMimeType,
  type MarketGroup,
  OFFICIAL_SOURCE,
} from './market-model';
import { type MarketSource, useMarketFile } from './use-market';
import { VerificationBadge } from './verification-badge';

const ICON_SIZES = {
  xs: 'size-5 rounded-sm text-[0.625rem]',
  md: 'size-10 rounded-lg text-base',
  lg: 'size-16 rounded-xl text-2xl',
} as const;

/** 条目图标：`market.file` 读到就显示，没有图标或读不到时是名称首字的占位块。 */
export function EntryIcon({
  entry,
  source,
  commit,
  size = 'md',
}: {
  entry: MarketEntry;
  source: MarketSource | undefined;
  commit: string;
  size?: keyof typeof ICON_SIZES;
}) {
  const path = entryIconPath(entry);
  const file = useMarketFile(source, commit, entry.id, path);
  const mime = path === undefined ? undefined : iconMimeType(path);
  if (file.status === 'ready' && mime !== undefined) {
    return (
      <img
        src={`data:${mime};base64,${file.data}`}
        alt=""
        draggable={false}
        className={cn(
          'shrink-0 bg-card object-contain ring-1 ring-border ring-inset',
          ICON_SIZES[size],
        )}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center bg-muted font-medium text-muted-foreground',
        ICON_SIZES[size],
      )}
      data-icon-placeholder
    >
      {entryInitial(entryText(entry, currentLocale()).name)}
    </span>
  );
}

/** 一个条目：图标、名称与徽章、一行描述，右边“+”（安装做好前进详情页）。 */
export function EntryRow({
  entry,
  source,
  commit,
}: {
  entry: MarketEntry;
  source: MarketSource | undefined;
  commit: string;
}) {
  const navigate = useNavigate();
  const text = entryText(entry, currentLocale());
  const to = paths.marketEntry(OFFICIAL_SOURCE, entry.id);
  return (
    <li
      className="relative flex min-h-16 items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 hover:bg-muted/50"
      data-market-entry={entry.id}
    >
      <EntryIcon entry={entry} source={source} commit={commit} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <Link
            to={to}
            className="truncate text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:focus-ring"
            data-action="open-entry"
          >
            {text.name}
          </Link>
          {entry.verification && (
            <VerificationBadge
              verification={entry.verification}
              upstream={entry.upstream}
              className="z-10"
            />
          )}
        </div>
        {text.description !== '' && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{text.description}</p>
        )}
      </div>
      <IconButton
        label={t('plugins.market.install')}
        className="relative z-10"
        onClick={() => navigate(to)}
        data-action="install"
      >
        <Plus />
      </IconButton>
    </li>
  );
}

/** 两列网格（容器窄于 720px 时一列）。 */
export function EntryGrid({
  entries,
  source,
  commit,
}: {
  entries: readonly MarketEntry[];
  source: MarketSource | undefined;
  commit: string;
}) {
  return (
    <div className="@container">
      <ul className="-mx-3 grid grid-cols-1 gap-x-4 gap-y-0.5 @min-[720px]:grid-cols-2">
        {entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} source={source} commit={commit} />
        ))}
      </ul>
    </div>
  );
}

/** 首页的一组：标题后跟“›”，点了进完整列表；只显示前 `limit` 个。 */
export function GroupSection({
  group,
  limit,
  source,
  commit,
}: {
  group: MarketGroup;
  limit: number;
  source: MarketSource | undefined;
  commit: string;
}) {
  return (
    <section className="mb-8 last:mb-0" data-market-group={group.id}>
      <h2 className="mb-2">
        <Link
          to={paths.marketGroup(group.id)}
          className="-mx-1 inline-flex items-center gap-0.5 rounded-md px-1 text-sm font-semibold outline-none transition-colors duration-150 hover:text-soft-foreground focus-visible:focus-ring"
        >
          {group.name}
          <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
        </Link>
      </h2>
      <EntryGrid entries={group.entries.slice(0, limit)} source={source} commit={commit} />
    </section>
  );
}

/** 首次读取时的骨架：两组，每组六行。 */
export function MarketSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('common.loading')}
      data-testid="market-skeleton"
    >
      {[0, 1].map((group) => (
        <div key={group} className="mb-8">
          <div className="mb-3 h-4 w-24 animate-pulse rounded-sm bg-muted" />
          <div className="@container">
            <div className="-mx-3 grid grid-cols-1 gap-x-4 gap-y-0.5 @min-[720px]:grid-cols-2">
              {[0, 1, 2, 3, 4, 5].map((row) => (
                <div key={row} className="flex min-h-16 items-center gap-3 px-3 py-2.5">
                  <div className="size-10 shrink-0 animate-pulse rounded-lg bg-muted" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="h-3.5 w-1/3 animate-pulse rounded-sm bg-muted" />
                    <div className="h-3 w-2/3 animate-pulse rounded-sm bg-muted/70" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
