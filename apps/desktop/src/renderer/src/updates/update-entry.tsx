// 侧栏左下角的更新入口（ADR-0007 补记 4，照 Codex 桌面端）：发现新版本时出现，点击开始下载，下载时显示进度，下载完没有回合在跑
// 就直接安装并重启，有回合在跑时变成“重启以更新”等用户点。没有新版本时不占位置。

import { cn } from 'cn';
import { ArrowDownToLine, LoaderCircle, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useWorkbenchData } from '@/data/workbench-data';
import { t } from '@/i18n';
import { hasActiveTurn, shouldInstallNow, type UpdateEntry, updateEntry } from './update-model';
import { useUpdateState } from './update-store';

/** 工作台里有没有回合还没结束（任何工作区的任何会话）。 */
function useHasActiveTurn(): boolean {
  const data = useWorkbenchData();
  return useMemo(
    () =>
      data.status === 'ready' && hasActiveTurn(data.workspaces.flatMap((entry) => entry.sessions)),
    [data],
  );
}

export function UpdateEntryButton({ className }: { className?: string }) {
  const state = useUpdateState();
  const busy = useHasActiveTurn();
  const entry = updateEntry(state, busy);

  // 下载完、没有回合在跑：直接安装。每个版本只请求一次（安装失败时状态会变成 error）。
  const requested = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (state?.phase !== 'downloaded' || !shouldInstallNow(state, busy)) return;
    if (requested.current === state.version) return;
    requested.current = state.version;
    void window.wevir.installUpdate();
  }, [state, busy]);

  if (entry === undefined) return null;
  return (
    <button
      type="button"
      data-testid="update-entry"
      data-update={entry.kind}
      disabled={entry.kind === 'downloading' || entry.kind === 'installing'}
      onClick={() => onClick(entry)}
      className={cn(
        'relative flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg px-2 text-base outline-none',
        'transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 disabled:cursor-default',
        entry.kind === 'restart'
          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : 'hover:bg-sidebar-accent/70',
        className,
      )}
    >
      <EntryIcon entry={entry} />
      <span className="min-w-0 flex-1 truncate text-left">{label(entry)}</span>
      {entry.kind === 'available' && (
        <span className="shrink-0 text-xs text-muted-foreground">{t('update.entry.update')}</span>
      )}
      {entry.kind === 'downloading' && (
        <span
          aria-hidden
          className="absolute inset-x-2 bottom-1 h-0.5 overflow-hidden rounded-full bg-sidebar-foreground/10"
        >
          <span
            className="block h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${entry.percent}%` }}
          />
        </span>
      )}
    </button>
  );
}

function onClick(entry: UpdateEntry): void {
  switch (entry.kind) {
    case 'available':
      void window.wevir.downloadUpdate();
      return;
    case 'restart':
      void window.wevir.installUpdate();
      return;
    case 'failed':
      void window.wevir.checkForUpdates();
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
      return t('update.entry.downloading', { percent: entry.percent });
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
