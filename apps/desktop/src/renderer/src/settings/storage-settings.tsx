import { cn } from 'cn';
import { FolderOpen, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
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
import { SessionStorageSections } from './storage-sessions';

/** 条形图与图例的颜色：静器没有彩色的强调色，各类是同一种墨色的深浅（desktop-tokens.md §53）。 */
const TONE: Record<StorageCategory, string> = {
  sessions: 'bg-foreground/85',
  worktrees: 'bg-foreground/65',
  engines: 'bg-foreground/48',
  cache: 'bg-foreground/34',
  browser: 'bg-foreground/24',
  logs: 'bg-foreground/16',
  other: 'bg-foreground/10',
};

/**
 * 设置 → 存储（照 Codex 桌面端的 Storage）：数据目录一共占了多少、分在哪几类（条形图加图例）、目录在哪；下面勾选缓存、
 * 内置浏览器的数据与日志清理；Host 有 `session_delete`（0.43.0）时再列已归档的会话（勾选后永久删除）与工作树
 * （storage-sessions.tsx）。量数据目录与清理在主进程（main/storage.ts），按会话的占用与删除经 Host。
 */
export function StorageSettings() {
  const navigate = useNavigate();
  const [usage, setUsage] = useState<StorageUsage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selected, setSelected] = useState<ReadonlySet<CleanableCategory>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const locale = currentLocale();
  const size = useCallback((bytes: number) => formatFileSize(bytes, locale), [locale]);

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
  const selectedBytes = [...selected].reduce((sum, id) => sum + bytesOf(id), 0);

  const toggle = (id: CleanableCategory) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const clean = async () => {
    const before = usage?.total ?? 0;
    const next = await window.wevir.cleanStorage([...selected]);
    setUsage(next);
    setSelected(new Set());
    setNotice(t('settings.storage.cleaned', { size: size(Math.max(0, before - next.total)) }));
  };

  return (
    <>
      <SettingsSection
        title={t('settings.storage.device')}
        action={
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RotateCw aria-hidden className={cn(loading && 'animate-spin')} />
            {t('settings.storage.refresh')}
          </Button>
        }
      >
        {error && <NoticeBanner notice={{ tone: 'error', text: error }} />}
        <div className="rounded-xl border border-border bg-card p-4" data-testid="storage-usage">
          <div className="text-sm font-medium tabular-nums">
            {usage
              ? t('settings.storage.used', { size: size(usage.total) })
              : t('settings.storage.measuring')}
          </div>
          <div
            className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted"
            aria-hidden
          >
            {usage &&
              usage.total > 0 &&
              usage.categories
                .filter((category) => category.bytes > 0)
                .map((category) => (
                  <div
                    key={category.id}
                    className={cn(
                      'h-full min-w-1 transition-[flex-grow] duration-500 ease-smooth',
                      TONE[category.id],
                    )}
                    style={{ flexGrow: category.bytes / usage.total }}
                  />
                ))}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
            {(usage?.categories ?? []).map((category) => (
              <div key={category.id} className="min-w-0" data-storage-category={category.id}>
                <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    aria-hidden
                    className={cn('size-2 shrink-0 rounded-full', TONE[category.id])}
                  />
                  <span className="truncate">{t(`settings.storage.category.${category.id}`)}</span>
                </dt>
                <dd className="mt-0.5 pl-3.5 text-xs tabular-nums">{size(category.bytes)}</dd>
              </div>
            ))}
          </dl>
          {usage && (
            <div className="mt-3 flex items-center gap-1 border-t border-border pt-3">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                {usage.root}
              </span>
              <IconButton
                label={t(IS_MAC ? 'files.revealFinder' : 'files.revealFolder')}
                onClick={() => void window.wevir.revealPath(usage.root).catch(() => undefined)}
              >
                <FolderOpen />
              </IconButton>
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.storage.clean')}
        action={
          <Button
            size="sm"
            disabled={selected.size === 0 || loading}
            onClick={() => setConfirming(true)}
            data-action="clean-storage"
          >
            {t('settings.storage.cleanSelected')}
          </Button>
        }
      >
        {notice && <NoticeBanner notice={{ tone: 'success', text: notice }} />}
        <div className={LIST_CARD}>
          {CLEANABLE_CATEGORIES.map((id) => (
            <label
              key={id}
              className="flex min-h-12 cursor-default items-center gap-3 px-4 py-2.5 text-sm"
              data-clean-category={id}
            >
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={selected.has(id)}
                disabled={loading}
                onChange={() => toggle(id)}
              />
              <span className="min-w-0 flex-1 font-medium">
                {t(`settings.storage.category.${id}`)}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {usage ? size(bytesOf(id)) : '—'}
              </span>
            </label>
          ))}
        </div>
      </SettingsSection>

      <SessionStorageSections onDeleted={refresh} />

      <SettingsSection title={t('settings.storage.manage')}>
        <div className={LIST_CARD}>
          <SettingsRow
            title={t('settings.tab.archived')}
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(paths.settings('archived'), { replace: true })}
              >
                {t('settings.storage.open')}
              </Button>
            }
          />
        </div>
      </SettingsSection>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('settings.storage.cleanTitle', { size: size(selectedBytes) })}
        confirmLabel={t('settings.storage.cleanSelected')}
        onConfirm={clean}
        failure={(reason) => t('settings.storage.cleanFailed', { error: reason })}
      >
        <p>
          {CLEANABLE_CATEGORIES.filter((id) => selected.has(id))
            .map((id) => t(`settings.storage.category.${id}`))
            .join(t('common.listSeparator'))}
        </p>
        {selected.has('browser') && <p>{t('settings.storage.browserWarning')}</p>}
      </ConfirmDialog>
    </>
  );
}
