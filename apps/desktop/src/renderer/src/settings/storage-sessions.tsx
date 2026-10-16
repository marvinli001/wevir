import { hostSupports, isRpcError } from '@wevir/client-sdk';
import type { Session, SessionId, SessionUsage } from '@wevir/protocol';
import { FolderOpen, GitBranch } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { useWorkbenchData } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { IS_MAC } from '@/lib/shortcuts';
import { workspaceLabel } from '@/projects/chats';
import { formatFileSize } from '@/session/shared-files-model';
import { EmptyList, LIST_CARD, type Notice, NoticeBanner, SettingsSection } from './settings-ui';
import { archivedChatRows, deleteChats, worktreeRows } from './storage-model';

/** 量过之后才改出来的工作树改动：Host 回 `RESOURCE_IN_USE` 带 `worktrees`（通用的说法是“仍有未关闭的会话”）。 */
function describeDeleteError(reason: unknown): string {
  return isRpcError(reason, 'RESOURCE_IN_USE') && (reason.data?.worktrees?.length ?? 0) > 0
    ? t('settings.storage.dirty')
    : describe(reason);
}

interface Loaded {
  archived: Session[];
  open: Session[];
  usage: SessionUsage[];
}

/**
 * 设置 → 存储里按会话的两组（0.43.0，Host 的 `session.usage` / `session.delete`，desktop-layout §24）：已归档的会话各占多少、
 * 勾选后永久删除（照 Codex 桌面端的 Clean up old chats）；Host 为会话开的工作树各占多少（Manage worktrees）。Host 没有
 * `session_delete` 时不显示。删完之后 `onDeleted` 让上面重新量一遍。
 */
export function SessionStorageSections({ onDeleted }: { onDeleted: () => void }) {
  const { client, view } = useHostConnection();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'session_delete');
  const data = useWorkbenchData();
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [selected, setSelected] = useState<ReadonlySet<SessionId>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const locale = currentLocale();
  const size = useCallback((bytes: number) => formatFileSize(bytes, locale), [locale]);
  const date = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }), [locale]);

  const load = useCallback(async () => {
    if (!client) return;
    const [archived, open, archivedUsage, openUsage] = await Promise.all([
      client.request('session.list', { archived: true }),
      client.request('session.list', {}),
      client.request('session.usage', { archived: true }),
      client.request('session.usage', {}),
    ]);
    setLoaded({
      archived: archived.sessions,
      open: open.sessions,
      usage: [...archivedUsage.sessions, ...openUsage.sessions],
    });
  }, [client]);

  useEffect(() => {
    if (!supported) return;
    setError(undefined);
    load().catch((reason: unknown) =>
      setError(t('settings.storage.failed', { error: describe(reason) })),
    );
  }, [supported, load]);

  const projectName = useMemo(() => {
    const names = new Map<string, string>();
    if (data.status === 'ready') {
      for (const entry of data.workspaces) {
        names.set(entry.workspace.id, workspaceLabel(entry.workspace));
      }
    }
    return names;
  }, [data]);

  const chats = useMemo(
    () => (loaded ? archivedChatRows(loaded.archived, loaded.usage) : []),
    [loaded],
  );
  const worktrees = useMemo(
    () => (loaded ? worktreeRows([...loaded.archived, ...loaded.open], loaded.usage) : []),
    [loaded],
  );
  const chosen = chats.filter((row) => selected.has(row.session.id as SessionId));
  const chosenBytes = chosen.reduce((sum, row) => sum + row.bytes, 0);
  const chosenDirty = chosen.reduce((sum, row) => sum + row.dirtyWorktrees, 0);
  const allSelected = chats.length > 0 && chosen.length === chats.length;

  const toggle = (sessionId: SessionId) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(chats.map((row) => row.session.id as SessionId)));

  const remove = async () => {
    if (!client) return;
    setNotice(undefined);
    const outcome = await deleteChats(
      chosen,
      (sessionId, force) =>
        client.request('session.delete', { sessionId, ...(force && { force: true }) }),
      describeDeleteError,
    );
    if (outcome.deleted.length === 0 && outcome.failed[0]) throw new Error(outcome.failed[0].error);
    const freed = chosen
      .filter((row) => outcome.deleted.includes(row.session.id as SessionId))
      .reduce((sum, row) => sum + row.bytes, 0);
    const parts = [
      t('settings.storage.deleted', { count: outcome.deleted.length, size: size(freed) }),
    ];
    if (outcome.keptBranches.length > 0) {
      parts.push(
        t('settings.storage.keptBranches', {
          branches: outcome.keptBranches.join(t('common.listSeparator')),
        }),
      );
    }
    if (outcome.engineDataKept) parts.push(t('settings.storage.engineDataKept'));
    if (outcome.failed[0]) {
      parts.push(
        t('settings.storage.deleteFailed', {
          count: outcome.failed.length,
          error: outcome.failed[0].error,
        }),
      );
    }
    setNotice({ tone: outcome.failed.length > 0 ? 'warning' : 'success', text: parts.join(' ') });
    setSelected(new Set());
    onDeleted();
    await load().catch((reason: unknown) =>
      setError(t('settings.storage.failed', { error: describe(reason) })),
    );
  };

  if (!supported) return null;

  return (
    <>
      <SettingsSection
        title={t('settings.storage.chats')}
        action={
          <Button
            size="sm"
            disabled={chosen.length === 0}
            onClick={() => setConfirming(true)}
            data-action="delete-chats"
          >
            {t('settings.storage.deleteSelected')}
          </Button>
        }
      >
        {(notice || error) && (
          <div className="mb-3 space-y-2">
            {notice && <NoticeBanner notice={notice} />}
            {error && <NoticeBanner notice={{ tone: 'error', text: error }} />}
          </div>
        )}
        {loaded === undefined ? (
          !error && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : chats.length === 0 ? (
          <EmptyList>{t('settings.storage.chatsEmpty')}</EmptyList>
        ) : (
          <div className={LIST_CARD} data-testid="storage-chats">
            <label className="flex min-h-11 cursor-default items-center gap-3 px-4 py-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={allSelected}
                onChange={toggleAll}
                data-select-all
              />
              <span className="min-w-0 flex-1 text-muted-foreground">
                {t('settings.storage.selectAll')}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {size(chats.reduce((sum, row) => sum + row.bytes, 0))}
              </span>
            </label>
            {chats.map((row) => (
              <label
                key={row.session.id}
                className="flex min-h-14 cursor-default items-center gap-3 px-4 py-2.5 text-sm"
                data-storage-chat={row.session.id}
              >
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={selected.has(row.session.id as SessionId)}
                  onChange={() => toggle(row.session.id as SessionId)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {row.session.title || t('session.untitled')}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[
                      projectName.get(row.session.workspaceId),
                      row.session.archivedAt && date.format(new Date(row.session.archivedAt)),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    {row.dirtyWorktrees > 0 && (
                      <span className="text-warning">
                        {' · '}
                        {t('settings.storage.dirty')}
                      </span>
                    )}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {size(row.bytes)}
                </span>
              </label>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t('settings.storage.worktrees')}>
        {loaded === undefined ? null : worktrees.length === 0 ? (
          <EmptyList>{t('settings.storage.worktreesEmpty')}</EmptyList>
        ) : (
          <ul className={LIST_CARD} data-testid="storage-worktrees">
            {worktrees.map((row) => (
              <li
                key={row.path}
                className="flex min-h-14 items-center gap-3 px-4 py-2.5 text-sm"
                data-storage-worktree={row.path}
              >
                <GitBranch aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs">{row.branch}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[
                      row.title || t('session.untitled'),
                      projectName.get(row.workspaceId),
                      row.archived && t('settings.storage.archived'),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    {(row.dirty || row.missing) && (
                      <span className="text-warning">
                        {' · '}
                        {t(row.missing ? 'settings.storage.missing' : 'settings.storage.dirty')}
                      </span>
                    )}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {size(row.bytes)}
                </span>
                {!row.missing && (
                  <IconButton
                    label={t(IS_MAC ? 'files.revealFinder' : 'files.revealFolder')}
                    onClick={() => void window.wevir.revealPath(row.path).catch(() => undefined)}
                  >
                    <FolderOpen />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('settings.storage.deleteTitle', { count: chosen.length })}
        confirmLabel={t('settings.storage.deleteSelected')}
        onConfirm={remove}
        failure={(reason) => t('settings.storage.deleteError', { error: reason })}
      >
        <p>{t('settings.storage.deleteSize', { size: size(chosenBytes) })}</p>
        {chosenDirty > 0 && (
          <p className="text-warning">
            {t('settings.storage.deleteDirty', { count: chosenDirty })}
          </p>
        )}
        <p>{t('settings.storage.deleteIrreversible')}</p>
      </ConfirmDialog>
    </>
  );
}
