import type { Session, SessionId } from '@wevir/protocol';
import { Archive, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { archiveSession, useSessionManagement } from '@/data/session-actions';
import { useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { workspaceLabel } from '@/projects/chats';
import { EmptyList, LIST_CARD, NoticeBanner, SettingsSection } from './settings-ui';

/**
 * 设置 → 已归档（U34，照 Codex 桌面端的 Archived chats）：`session.list { archived: true }` 读出的会话按项目分组，顶上是搜索；
 * 每行标题、归档的时刻与“取消归档”。取消归档的会话回到左栏（仍是关闭的，发消息时恢复）。
 */
export function ArchivedSettings() {
  const { client } = useHostConnection();
  const manage = useSessionManagement();
  const data = useWorkbenchData();
  const store = useWorkbenchStore();
  const [sessions, setSessions] = useState<Session[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string>();

  useEffect(() => {
    if (!client || !manage.archive) return;
    let stopped = false;
    client
      .request('session.list', { archived: true })
      .then((result) => {
        if (!stopped) setSessions(result.sessions);
      })
      .catch((reason: unknown) => {
        if (!stopped) setError(t('settings.archived.failed', { error: describe(reason) }));
      });
    return () => {
      stopped = true;
    };
  }, [client, manage.archive]);

  const projectName = useMemo(() => {
    const names = new Map<string, string>();
    if (data.status === 'ready') {
      for (const entry of data.workspaces)
        names.set(entry.workspace.id, workspaceLabel(entry.workspace));
    }
    return names;
  }, [data]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = (sessions ?? []).filter(
      (session) => needle === '' || (session.title || '').toLowerCase().includes(needle),
    );
    const byProject = new Map<string, Session[]>();
    for (const session of matched) {
      const list = byProject.get(session.workspaceId) ?? [];
      list.push(session);
      byProject.set(session.workspaceId, list);
    }
    return [...byProject.entries()];
  }, [sessions, query]);

  const format = useMemo(
    () => new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }),
    [],
  );

  const unarchive = async (session: Session) => {
    if (!client) return;
    setBusy(session.id);
    setError(undefined);
    try {
      await archiveSession(client, store, session.id as SessionId, false);
      setSessions((current) => current?.filter((candidate) => candidate.id !== session.id));
    } catch (reason) {
      setError(t('settings.archived.unarchiveFailed', { error: describe(reason) }));
    } finally {
      setBusy(undefined);
    }
  };

  if (!manage.archive) {
    return <NoticeBanner notice={{ tone: 'info', text: t('settings.archived.unsupported') }} />;
  }

  return (
    <SettingsSection>
      <div className="mb-4 flex items-center gap-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full bg-muted/70 px-3 text-muted-foreground focus-within:bg-muted focus-within:focus-ring">
          <Search aria-hidden className="size-3.5 shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
            placeholder={t('settings.archived.search')}
            aria-label={t('settings.archived.search')}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button
              type="button"
              aria-label={t('settings.searchClear')}
              onClick={() => setQuery('')}
              className="flex size-5 items-center justify-center rounded-full outline-none hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </label>
      </div>
      {error && (
        <div className="mb-3">
          <NoticeBanner notice={{ tone: 'error', text: error }} />
        </div>
      )}
      {sessions === undefined ? (
        !error && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : groups.length === 0 ? (
        <EmptyList>{t('settings.archived.empty')}</EmptyList>
      ) : (
        <div className="space-y-6">
          {groups.map(([workspaceId, list]) => (
            <section key={workspaceId} data-archived-project={workspaceId}>
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                <span className="truncate">{projectName.get(workspaceId) ?? workspaceId}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {t('settings.archived.count', { count: list.length })}
                </span>
              </h3>
              <ul className={LIST_CARD}>
                {list.map((session) => (
                  <li
                    key={session.id}
                    className="flex min-h-14 items-center gap-4 px-4 py-2.5"
                    data-archived-session={session.id}
                  >
                    <Archive aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{session.title || t('session.untitled')}</p>
                      {session.archivedAt && (
                        <p className="text-xs text-muted-foreground">
                          {format.format(new Date(session.archivedAt))}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === session.id}
                      onClick={() => void unarchive(session)}
                      data-action="unarchive"
                    >
                      {t('session.unarchive')}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
