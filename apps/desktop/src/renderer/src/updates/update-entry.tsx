// 侧栏左下角的更新入口（ADR-0007 补记 4，照 Codex 桌面端）：发现新版本时出现，点击开始下载，下载时整行是一条进度条，
// 下载完填满变成墨色底的“重启以更新”，等用户点。没有新版本时不占位置。Linux 的 deb 不在应用里下载，点了打开官网的下载页。

import { cn } from 'cn';
import { ArrowDownToLine, LoaderCircle, RotateCw } from 'lucide-react';
import { currentLocale, t } from '@/i18n';
import { platformApi } from '@/platform/platform';
import { downloadPageUrl, type UpdateEntry, updateEntry } from './update-model';
import { useUpdateState } from './update-store';

export function UpdateEntryButton({ className }: { className?: string }) {
  const entry = updateEntry(useUpdateState());
  if (entry === undefined) return null;
  const filled = entry.kind === 'restart' || entry.kind === 'installing';
  return (
    <button
      type="button"
      data-testid="update-entry"
      data-update={entry.kind}
      disabled={entry.kind === 'downloading' || entry.kind === 'installing'}
      onClick={() => onClick(entry)}
      className={cn(
        'group relative flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg px-2 text-base outline-none',
        'transition-colors duration-300 ease-smooth focus-visible:focus-ring disabled:cursor-default',
        filled && 'text-primary-foreground',
        (entry.kind === 'available' || entry.kind === 'failed') && 'hover:bg-sidebar-accent/70',
        entry.kind === 'downloading' && 'bg-sidebar-foreground/[0.06]',
        className,
      )}
    >
      {/* 进度填充：下载时按百分比变宽（淡墨色加流光），下载完填满并转成墨色，成为“重启以更新”的底。 */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-0 overflow-hidden transition-[width,background-color] duration-500 ease-smooth',
          filled ? 'bg-primary group-enabled:group-hover:bg-primary/90' : 'bg-primary/15',
        )}
        style={{
          width: entry.kind === 'downloading' ? `${entry.percent}%` : filled ? '100%' : '0%',
        }}
      >
        {entry.kind === 'downloading' && <span className="progress-sheen block size-full" />}
      </span>
      <span className="relative flex min-w-0 flex-1 items-center gap-2">
        <EntryIcon entry={entry} />
        <span className="min-w-0 flex-1 truncate text-left">{label(entry)}</span>
        {entry.kind === 'available' && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t(entry.manual ? 'update.action.downloadPage' : 'update.entry.update')}
          </span>
        )}
        {entry.kind === 'downloading' && (
          <span
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={entry.percent}
            className="shrink-0 text-xs text-muted-foreground tabular-nums"
          >
            {entry.percent}%
          </span>
        )}
      </span>
    </button>
  );
}

function onClick(entry: UpdateEntry): void {
  switch (entry.kind) {
    case 'available':
      if (entry.manual) void platformApi().openExternal(downloadPageUrl(currentLocale()));
      else void platformApi().downloadUpdate();
      return;
    case 'restart':
      void platformApi().installUpdate();
      return;
    case 'failed':
      void platformApi().checkForUpdates();
      return;
    default:
      return;
  }
}

function label(entry: UpdateEntry): string {
  switch (entry.kind) {
    case 'available':
      return t('update.entry.available', { version: entry.version });
    case 'downloading':
      return t('update.entry.downloading');
    case 'restart':
      return t('update.entry.restart');
    case 'installing':
      return t('update.entry.installing');
    case 'failed':
      return t('update.entry.failed');
  }
}

function EntryIcon({ entry }: { entry: UpdateEntry }) {
  const icon = 'size-4 shrink-0';
  if (entry.kind === 'installing')
    return <LoaderCircle className={cn(icon, 'animate-spin')} aria-hidden />;
  if (entry.kind === 'restart' || entry.kind === 'failed')
    return <RotateCw className={icon} aria-hidden />;
  return <ArrowDownToLine className={cn(icon, 'text-primary')} aria-hidden />;
}
