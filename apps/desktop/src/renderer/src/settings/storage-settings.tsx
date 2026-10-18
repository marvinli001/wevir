import { cn } from 'cn';
import { FolderOpen, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { describe } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { IS_MAC } from '@/lib/shortcuts';
import { paths } from '@/routes/paths';
import { formatFileSize } from '@/session/shared-files-model';
import {
  CLEANABLE_CATEGORIES,
  type CleanableCategory,
  type StorageCategory,
  type StorageUsage,
} from '../../../shared/storage.js';
import { LIST_CARD, NoticeBanner, SettingsRow, SettingsSection } from './settings-ui';
import { SessionStorageCard } from './storage-sessions';

/** 占用条与图例的颜色：每类一种图表色（tokens.css 的 --chart-*，照 Codex 桌面端的存储页）。 */
const TONE: Record<StorageCategory, string> = {
  sessions: 'bg-chart-1',
  worktrees: 'bg-chart-2',
  engines: 'bg-chart-3',
  cache: 'bg-chart-4',
  browser: 'bg-chart-5',
  logs: 'bg-chart-6',
  other: 'bg-chart-7',
};

function Dot({ category, className }: { category: StorageCategory; className?: string }) {
  return (
    <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE[category], className)} />
  );
}

/**
 * 设置 → 存储（照 Codex 桌面端的 Storage）：“此设备”下面是 Wevir 一共占了多少、彩色的占用条（悬停一段或图例看这一类）、
 * 每类的图例与大小、数据目录在哪；然后一张卡片逐类清理缓存、内置浏览器的数据与日志；最后一张卡片是按会话的清理与工作树
 * （Host 有 `session_delete` 时，storage-sessions.tsx，在对话框里看和删）与“已归档的会话”的入口。量数据目录与清理在主进程
 * （main/storage.ts），按会话的占用与删除经 Host。
 */
export function StorageSettings() {
  const navigate = useNavigate();
  const [usage, setUsage] = useState<StorageUsage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [cleaning, setCleaning] = useState<CleanableCategory>();
  const [confirming, setConfirming] = useState(false);
  const [hovered, setHovered] = useState<StorageCategory>();
  const locale = currentLocale();
  const size = useCallback((bytes: number) => formatFileSize(bytes, locale), [locale]);
  const percent = useMemo(
    () => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }),
    [locale],
  );

  const refresh = useCallback(() => {
    setLoading(true);
    setError(undefined);
    let stopped = false;
    window.wevir
      .getStorageUsage()
      .then((next) => {
        if (!stopped) setUsage(next);
      })
      .catch((reason: unknown) => {
        if (!stopped) setError(t('settings.storage.failed', { error: describe(reason) }));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, []);
  useEffect(refresh, [refresh]);

  const bytesOf = useMemo(() => {
    const map = new Map(usage?.categories.map((category) => [category.id, category.bytes]));
    return (id: StorageCategory) => map.get(id) ?? 0;
  }, [usage]);

  const clean = async (category: CleanableCategory) => {
    const before = usage?.total ?? 0;
    const next = await window.wevir.cleanStorage([category]);
    setUsage(next);
    setNotice(t('settings.storage.cleaned', { size: size(Math.max(0, before - next.total)) }));
  };

  const segments =
    usage && usage.total > 0 ? usage.categories.filter((category) => category.bytes > 0) : [];

  return (
    <>
      <SettingsSection title={t('settings.storage.device')}>
        {error && (
          <div className="mb-3">
            <NoticeBanner notice={{ tone: 'error', text: error }} />
          </div>
        )}
        <div data-testid="storage-usage">
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold tabular-nums">
              {usage
                ? t('settings.storage.used', { size: size(usage.total) })
                : t('settings.storage.measuring')}
            </span>
            <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>
              <RotateCw aria-hidden className={cn(loading && 'animate-spin')} />
              {t('settings.storage.refresh')}
            </Button>
          </div>
          <div
            className={cn(
              'mt-3 flex h-3.5 gap-0.5 overflow-hidden rounded-full',
              segments.length === 0 && 'bg-muted',
              segments.length === 0 && loading && 'animate-pulse',
            )}
            onPointerLeave={() => setHovered(undefined)}
          >
            {usage &&
              segments.map((category) => (
                <Tooltip key={category.id}>
                  <TooltipTrigger
                    render={
                      <div
                        role="img"
                        aria-label={`${t(`settings.storage.category.${category.id}`)} ${size(category.bytes)}`}
                        data-storage-segment={category.id}
                        onPointerEnter={() => setHovered(category.id)}
                        className={cn(
                          'h-full min-w-1 transition-[flex-grow,opacity] duration-500 ease-smooth first:rounded-l-full last:rounded-r-full',
                          TONE[category.id],
                          hovered !== undefined && hovered !== category.id && 'opacity-35',
                        )}
                        style={{ flexGrow: category.bytes / usage.total }}
                      />
                    }
                  />
                  <TooltipContent>
                    {t(`settings.storage.category.${category.id}`)} · {size(category.bytes)} ·{' '}
                    {percent.format(category.bytes / usage.total)}
                  </TooltipContent>
                </Tooltip>
              ))}
          </div>
          <dl className="mt-4 flex flex-wrap gap-x-7 gap-y-3">
            {(usage?.categories ?? []).map((category) => (
              <div
                key={category.id}
                className={cn(
                  'min-w-0 transition-opacity duration-200',
                  hovered !== undefined && hovered !== category.id && 'opacity-45',
                )}
                data-storage-category={category.id}
                onPointerEnter={() => category.bytes > 0 && setHovered(category.id)}
                onPointerLeave={() => setHovered(undefined)}
              >
                <dt className="flex items-center gap-1.5 text-xs text-soft-foreground">
                  <Dot category={category.id} />
                  <span className="truncate">{t(`settings.storage.category.${category.id}`)}</span>
                </dt>
                <dd className="mt-0.5 pl-3.5 text-xs text-muted-foreground tabular-nums">
                  {size(category.bytes)}
                </dd>
              </div>
            ))}
          </dl>
          {usage && (
            <div className="mt-3 flex items-center gap-1">
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {usage.root}
              </span>
              <IconButton
                size="icon-xs"
                label={t(IS_MAC ? 'files.revealFinder' : 'files.revealFolder')}
                onClick={() => void window.wevir.revealPath(usage.root).catch(() => undefined)}
              >
                <FolderOpen />
              </IconButton>
            </div>
          )}
        </div>
      </SettingsSection>

      <section className="mb-9 space-y-3 last:mb-0">
        {notice && <NoticeBanner notice={{ tone: 'success', text: notice }} />}
        <div className={LIST_CARD}>
          {CLEANABLE_CATEGORIES.map((id) => (
            <SettingsRow
              key={id}
              data-clean-category={id}
              title={
                <span className="flex items-center gap-2">
                  <Dot category={id} />
                  {t(`settings.storage.category.${id}`)}
                </span>
              }
              control={
                <>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {usage ? size(bytesOf(id)) : '—'}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={loading || !usage || bytesOf(id) === 0}
                    onClick={() => {
                      setCleaning(id);
                      setConfirming(true);
                    }}
                    data-action="clean-storage"
                  >
                    {t('settings.storage.clean')}
                  </Button>
                </>
              }
            />
          ))}
        </div>
        <SessionStorageCard
          onDeleted={refresh}
          onOpenArchived={() => navigate(paths.settings('archived'), { replace: true })}
        />
      </section>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('settings.storage.cleanTitle', { size: size(cleaning ? bytesOf(cleaning) : 0) })}
        confirmLabel={t('settings.storage.clean')}
        onConfirm={() => (cleaning ? clean(cleaning) : Promise.resolve())}
        failure={(reason) => t('settings.storage.cleanFailed', { error: reason })}
      >
        {cleaning && <p>{t(`settings.storage.category.${cleaning}`)}</p>}
        {cleaning === 'browser' && <p>{t('settings.storage.browserWarning')}</p>}
      </ConfirmDialog>
    </>
  );
}
