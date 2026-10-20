import { hostSupports, isRpcError } from '@wevir/client-sdk';
import type {
  MemoryNote,
  MemoryScope,
  MemorySource,
  MemorySummary,
  MethodResult,
  Session,
  SessionId,
  WorkspaceId,
} from '@wevir/protocol';
import { MEMORY_DESCRIPTION_MAX, MEMORY_MAX_PER_SCOPE } from '@wevir/protocol';
import { Pencil, Trash2 } from 'lucide-react';
import { type FormEvent, Fragment, useEffect, useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useHostSettings } from '@/data/host-settings';
import { useWorkbenchData } from '@/data/workbench-data';
import { chatsOf, projectsOf } from '@/data/workbench-model';
import { describe, useHostConnection } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { workspaceLabel } from '@/projects/chats';
import { useLastLocation } from '@/routes/last-location';
import {
  autoMemoryOn,
  defaultMemoryWorkspace,
  draftChanged,
  draftOf,
  draftValid,
  MEMORY_TYPE_LABELS,
  type MemoryDraft,
  memorySourceRows,
  sourceSessionPath,
  sourceSessions,
  splitMemory,
  updatePatch,
} from './memory-model';
import {
  EmptyList,
  LIST_CARD,
  type Notice,
  NoticeBanner,
  SettingsRow,
  SettingsSection,
} from './settings-ui';

/** 一条笔记的位置：范围、项目（范围是 `project` 时）与名字。 */
interface MemoryTarget {
  scope: MemoryScope;
  workspaceId?: WorkspaceId;
  name: string;
}

/**
 * 设置 → 记忆（0.57.0，domain-model §3.21）：自动记忆的开关（Host 设置的 `autoMemory`，所有项目共用），所有项目通用的笔记与所选
 * 项目的笔记。每条可以查看与编辑、停用、删除；列表跟着 `memory.changed`（Agent 存了、别的窗口改了都会跟上）。编辑带着读到的
 * 版本保存，期间被改过时留着草稿让用户决定。
 */
export function MemorySettings() {
  const { client, view } = useHostConnection();
  const supported = view.status === 'connected' && hostSupports(view.hello.features, 'memory');
  const host = useHostSettings();
  const data = useWorkbenchData();
  const last = useLastLocation();
  const [picked, setPicked] = useState<string>();
  const [listing, setListing] = useState<MethodResult<'memory.list'>>();
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState<string>();
  const [editing, setEditing] = useState<MemoryTarget>();
  const [deleting, setDeleting] = useState<MemoryTarget & { revision?: string }>();

  // 可选的项目：项目在前，“对话”工作区（也算一个项目）在最后。
  const workspaces = useMemo(() => {
    if (data.status !== 'ready') return [];
    const chats = chatsOf(data.workspaces);
    return [...projectsOf(data.workspaces), ...(chats === undefined ? [] : [chats])];
  }, [data]);
  const workspaceId = (
    workspaces.some((entry) => entry.workspace.id === picked)
      ? picked
      : defaultMemoryWorkspace(workspaces, last?.workspaceId)
  ) as WorkspaceId | undefined;

  useEffect(() => {
    if (!client || !supported) return;
    setListing(undefined);
    return client.watchMemory(
      workspaceId,
      (value) => setListing(value),
      (reason) =>
        setNotice({
          tone: 'error',
          text: t('settings.memory.loadFailed', { error: describe(reason) }),
        }),
    );
  }, [client, supported, workspaceId]);

  if (!supported) {
    return <NoticeBanner notice={{ tone: 'info', text: t('settings.memory.unsupported') }} />;
  }

  const sections = splitMemory(listing);
  const target = (note: MemorySummary): MemoryTarget => ({
    scope: note.scope,
    name: note.name,
    ...(note.scope === 'project' && workspaceId !== undefined && { workspaceId }),
  });
  const key = (note: Pick<MemoryTarget, 'scope' | 'name'>) => `${note.scope}/${note.name}`;

  const toggle = async (note: MemorySummary, enabled: boolean) => {
    if (!client) return;
    setBusy(key(note));
    setNotice(undefined);
    try {
      await client.request('memory.setEnabled', { ...target(note), enabled });
    } catch (reason) {
      setNotice({ tone: 'error', text: t('settings.memory.failed', { error: describe(reason) }) });
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async () => {
    if (!client || !deleting) return;
    const result = await client.request('memory.delete', deleting);
    if (result.conflict) setNotice({ tone: 'warning', text: t('settings.memory.deleteConflict') });
  };

  const list = (scope: MemoryScope, notes: MemorySummary[], unreadable: string[]) => (
    <div className="space-y-3">
      {unreadable.length > 0 && (
        <div
          className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning"
          data-memory-unreadable={scope}
        >
          <p>
            {t('settings.memory.unreadable', {
              count: unreadable.length,
              names: unreadable.join(t('common.listSeparator')),
            })}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {unreadable.map((name) => (
              <Button
                key={name}
                size="sm"
                variant="outline"
                onClick={() =>
                  setDeleting({
                    scope,
                    name,
                    ...(scope === 'project' && workspaceId !== undefined && { workspaceId }),
                  })
                }
                data-action="delete-unreadable"
              >
                <Trash2 data-icon="inline-start" />
                {name}
              </Button>
            ))}
          </div>
        </div>
      )}
      {listing === undefined ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : notes.length === 0 ? (
        <EmptyList>{t('settings.memory.empty')}</EmptyList>
      ) : (
        <ul className={LIST_CARD}>
          {notes.map((note) => (
            <MemoryRow
              key={key(note)}
              note={note}
              busy={busy === key(note) || !client}
              onToggle={(enabled) => void toggle(note, enabled)}
              onEdit={() => setEditing(target(note))}
              onDelete={() => setDeleting({ ...target(note), revision: note.revision })}
            />
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <>
      {notice && (
        <div className="mb-3">
          <NoticeBanner notice={notice} />
        </div>
      )}
      <SettingsSection>
        <div className={LIST_CARD}>
          <SettingsRow
            title={t('settings.memory.auto')}
            data-setting="auto-memory"
            control={
              <Switch
                checked={autoMemoryOn(host.settings)}
                label={t('settings.memory.auto')}
                disabled={!host.supported || !client}
                onChange={(autoMemory) =>
                  void host.update({ autoMemory }).catch((reason: unknown) =>
                    setNotice({
                      tone: 'error',
                      text: t('settings.memory.failed', { error: describe(reason) }),
                    }),
                  )
                }
              />
            }
          />
        </div>
      </SettingsSection>
      <SettingsSection
        title={t('settings.memory.global')}
        description={t('settings.memory.count', {
          count: sections.global.length,
          max: MEMORY_MAX_PER_SCOPE,
        })}
        data-memory-scope="global"
      >
        {list('global', sections.global, sections.unreadable.global)}
      </SettingsSection>
      <SettingsSection
        title={t('settings.memory.project')}
        description={
          workspaceId === undefined
            ? undefined
            : t('settings.memory.count', {
                count: sections.project.length,
                max: MEMORY_MAX_PER_SCOPE,
              })
        }
        action={
          workspaces.length > 0 &&
          workspaceId !== undefined && (
            <Select
              className="w-52"
              aria-label={t('settings.memory.projectPicker')}
              value={workspaceId}
              onValueChange={setPicked}
              options={workspaces.map((entry) => ({
                value: entry.workspace.id,
                label: workspaceLabel(entry.workspace),
              }))}
              data-action="memory-project"
            />
          )
        }
        data-memory-scope="project"
      >
        {workspaceId === undefined ? (
          <EmptyList>{t('settings.memory.noProjects')}</EmptyList>
        ) : (
          list('project', sections.project, sections.unreadable.project)
        )}
      </SettingsSection>
      {editing && <MemoryEditor target={editing} onClose={() => setEditing(undefined)} />}
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        title={t('settings.memory.deleteTitle', { name: deleting?.name ?? '' })}
        confirmLabel={t('settings.memory.delete')}
        onConfirm={remove}
        failure={(error) => t('settings.memory.deleteFailed', { error })}
      >
        <p>{t('settings.memory.deleteBody')}</p>
      </ConfirmDialog>
    </>
  );
}

function MemoryRow({
  note,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  note: MemorySummary;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className="flex min-h-14 items-center gap-3 px-4 py-2.5"
      data-memory-note={`${note.scope}/${note.name}`}
      data-enabled={note.enabled}
    >
      <button
        type="button"
        onClick={onEdit}
        className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <p className={note.enabled ? 'truncate text-sm' : 'truncate text-sm text-muted-foreground'}>
          {note.description}
        </p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 rounded bg-muted px-1.5 py-px">
            {t(MEMORY_TYPE_LABELS[note.type])}
          </span>
          {!note.enabled && (
            <span className="shrink-0 rounded bg-warning/10 px-1.5 py-px text-warning">
              {t('settings.memory.disabled')}
            </span>
          )}
          <span className="truncate font-mono">{note.name}</span>
          <span className="shrink-0">· {updatedText(note.updatedAt)}</span>
        </p>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        <Switch
          checked={note.enabled}
          label={t('settings.memory.toggle', { name: note.name })}
          disabled={busy}
          onChange={onToggle}
          data-action="toggle-memory"
        />
        <IconButton label={t('settings.memory.edit')} onClick={onEdit} data-action="edit-memory">
          <Pencil />
        </IconButton>
        <IconButton
          label={t('settings.memory.delete')}
          disabled={busy}
          onClick={onDelete}
          data-action="delete-memory"
        >
          <Trash2 />
        </IconButton>
      </div>
    </li>
  );
}

/** 时刻按当前语言显示；不是合法时刻时 `undefined`。 */
function formatTime(at: string): string | undefined {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return undefined;
  const format = new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return format.format(new Date(time));
}

function updatedText(updatedAt: string): string {
  const time = formatTime(updatedAt);
  return time === undefined
    ? t('settings.memory.updatedUnknown')
    : t('settings.memory.updated', { time });
}

/**
 * 查看与编辑一条笔记：打开时读正文与版本；保存带着这个版本，期间被改过（Agent 存了、别的窗口改了）时不写，草稿留着，下面
 * 列出现在的版本，由用户选“用草稿覆盖”或“放弃草稿”。笔记已被删掉时只说明这一点。
 */
function MemoryEditor({ target, onClose }: { target: MemoryTarget; onClose: () => void }) {
  const { client } = useHostConnection();
  const [note, setNote] = useState<MemoryNote>();
  const [draft, setDraft] = useState<MemoryDraft>();
  const [conflict, setConflict] = useState<MemoryNote>();
  const [error, setError] = useState<string>();
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = { description: useId(), content: useId(), type: useId() };

  useEffect(() => {
    if (!client) return;
    let stopped = false;
    client
      .request('memory.read', target)
      .then(({ note: read }) => {
        if (stopped) return;
        setNote(read);
        setDraft(draftOf(read));
      })
      .catch((reason: unknown) => {
        if (stopped) return;
        if (isRpcError(reason, 'MEMORY_NOT_FOUND')) setGone(true);
        else setError(t('settings.memory.loadFailed', { error: describe(reason) }));
      });
    return () => {
      stopped = true;
    };
  }, [client, target]);

  const save = async (base: MemoryNote) => {
    if (!client || !draft) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.request('memory.update', {
        ...target,
        revision: base.revision,
        ...updatePatch(draft, draftOf(base)),
      });
      if (result.conflict) {
        setNote(result.note);
        setConflict(result.note);
        return;
      }
      onClose();
    } catch (reason) {
      if (isRpcError(reason, 'MEMORY_NOT_FOUND')) setGone(true);
      else setError(t('settings.memory.saveFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (note && draft && draftValid(draft) && draftChanged(draft, draftOf(note))) void save(note);
  };

  const discard = () => {
    if (!conflict) return;
    setDraft(draftOf(conflict));
    setConflict(undefined);
  };

  const scopeLabel =
    target.scope === 'global' ? t('settings.memory.global') : t('settings.memory.project');

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-xl" showCloseButton={false}>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>{t('settings.memory.editor.title')}</DialogTitle>
            <DialogDescription>
              {scopeLabel} · <span className="font-mono">{target.name}</span>
              {note && ` · ${updatedText(note.updatedAt)}`}
            </DialogDescription>
          </DialogHeader>
          {gone ? (
            <NoticeBanner notice={{ tone: 'warning', text: t('settings.memory.gone') }} />
          ) : !draft ? (
            !error && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : (
            <div className="space-y-3">
              {conflict && (
                <div
                  className="space-y-2 rounded-lg bg-warning/10 px-3 py-2 text-sm"
                  data-memory-conflict
                >
                  <p className="text-warning">{t('settings.memory.conflict')}</p>
                  <p className="text-xs font-medium">{t('settings.memory.conflict.current')}</p>
                  <p className="text-xs">{conflict.description}</p>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-card p-2 font-mono text-xs">
                    {conflict.content}
                  </pre>
                </div>
              )}
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-3">
                <label htmlFor={ids.type} className="text-sm font-medium">
                  {t('settings.memory.editor.type')}
                </label>
                <Select
                  id={ids.type}
                  className="w-40"
                  value={draft.type}
                  onValueChange={(type) => setDraft({ ...draft, type })}
                  options={Object.entries(MEMORY_TYPE_LABELS).map(([value, label]) => ({
                    value: value as MemoryDraft['type'],
                    label: t(label),
                  }))}
                />
                <label htmlFor={ids.description} className="text-sm font-medium">
                  {t('settings.memory.editor.description')}
                </label>
                <Input
                  id={ids.description}
                  value={draft.description}
                  maxLength={MEMORY_DESCRIPTION_MAX}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  data-testid="memory-description"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor={ids.content} className="text-sm font-medium">
                  {t('settings.memory.editor.content')}
                </label>
                <Textarea
                  id={ids.content}
                  value={draft.content}
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                  className="max-h-80 min-h-40 font-mono text-xs md:text-xs"
                  data-testid="memory-content"
                />
              </div>
              {note && <MemorySources note={note} onOpened={onClose} />}
            </div>
          )}
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {conflict || gone ? t('common.close') : t('common.cancel')}
            </Button>
            {conflict ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={discard}
                  disabled={busy}
                  data-action="discard-draft"
                >
                  {t('settings.memory.conflict.discard')}
                </Button>
                <Button
                  type="button"
                  onClick={() => void save(conflict)}
                  disabled={busy || !draft || !draftValid(draft)}
                  data-action="overwrite-memory"
                >
                  {t('settings.memory.conflict.overwrite')}
                </Button>
              </>
            ) : (
              !gone && (
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    !note ||
                    !draft ||
                    !draftValid(draft) ||
                    !draftChanged(draft, draftOf(note))
                  }
                  data-confirm
                >
                  {t('settings.memory.editor.save')}
                </Button>
              )
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 详情里的来源（0.58.0）：首次保存与最近修改各是谁、在哪个会话。Agent 写的可以打开那个会话；会话删了、写下它的回合撤回了都标出来，
 * 打开时发现会话已经不在也说明。旧笔记显示未记录。
 */
function MemorySources({ note, onOpened }: { note: MemoryNote; onOpened: () => void }) {
  const { client } = useHostConnection();
  const navigate = useNavigate();
  const rows = memorySourceRows(note);
  const wanted = sourceSessions(rows).join(',');
  const [sessions, setSessions] = useState<Record<string, Session | 'missing'>>({});
  const [error, setError] = useState<string>();
  const markMissing = (sessionId: SessionId) =>
    setSessions((previous) => ({ ...previous, [sessionId]: 'missing' }));

  useEffect(() => {
    if (!client || wanted === '') return;
    let stopped = false;
    for (const sessionId of wanted.split(',') as SessionId[]) {
      client.request('session.get', { sessionId }).then(
        ({ session }) => {
          if (!stopped) setSessions((previous) => ({ ...previous, [sessionId]: session }));
        },
        (reason: unknown) => {
          if (!stopped && isRpcError(reason, 'SESSION_NOT_FOUND')) {
            setSessions((previous) => ({ ...previous, [sessionId]: 'missing' }));
          }
        },
      );
    }
    return () => {
      stopped = true;
    };
  }, [client, wanted]);

  const open = async (sessionId: SessionId) => {
    if (!client) return;
    setError(undefined);
    try {
      const { session } = await client.request('session.get', { sessionId });
      onOpened();
      navigate(sourceSessionPath(session));
    } catch (reason) {
      if (isRpcError(reason, 'SESSION_NOT_FOUND')) markMissing(sessionId);
      setError(t('settings.memory.source.openFailed', { error: describe(reason) }));
    }
  };

  const line = (source: MemorySource | undefined) => {
    if (source === undefined) {
      return (
        <span className="text-muted-foreground">{t('settings.memory.source.unrecorded')}</span>
      );
    }
    const time = formatTime(source.at) ?? t('settings.memory.source.timeUnknown');
    if (source.by === 'user') return `${t('settings.memory.source.user')} · ${time}`;
    if (source.sessionId === undefined)
      return `${t('settings.memory.source.agentPlain')} · ${time}`;
    const sessionId = source.sessionId;
    const loaded = sessions[sessionId];
    const deleted = source.status === 'deleted' || loaded === 'missing';
    const title =
      typeof loaded === 'object' ? loaded.title || t('settings.memory.source.untitled') : '…';
    return (
      <span className="flex flex-wrap items-center gap-1.5" data-memory-source={sessionId}>
        <span>
          {deleted
            ? t('settings.memory.source.agentPlain')
            : t('settings.memory.source.agent', { title })}{' '}
          · {time}
        </span>
        {deleted ? (
          <span
            className="rounded bg-warning/10 px-1.5 py-px text-warning"
            data-source-status="deleted"
          >
            {t('settings.memory.source.deleted')}
          </span>
        ) : (
          <>
            {source.status === 'withdrawn' && (
              <span
                className="rounded bg-warning/10 px-1.5 py-px text-warning"
                data-source-status="withdrawn"
              >
                {t('settings.memory.source.withdrawn')}
              </span>
            )}
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => void open(sessionId)}
              data-action="open-memory-source"
            >
              {t('settings.memory.source.open')}
            </Button>
          </>
        )}
      </span>
    );
  };

  return (
    <div className="space-y-1.5 rounded-lg bg-muted/50 px-3 py-2 text-xs" data-memory-sources>
      <p className="text-sm font-medium">{t('settings.memory.source.title')}</p>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <dt className="text-muted-foreground">{t(row.label)}</dt>
            <dd className="min-w-0">{line(row.source)}</dd>
          </Fragment>
        ))}
      </dl>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
