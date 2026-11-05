import { hostSupports } from '@wevir/client-sdk';
import {
  type Episode,
  type EpisodeSummary,
  episodeMarkdown,
  type Session,
  type WorkspaceId,
} from '@wevir/protocol';
import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useHostSettings } from '@/data/host-settings';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { useRetroOpen } from '@/retro/retro-data';
import { deliveryLabel, retroTarget } from '@/retro/retro-model';
import { paths } from '@/routes/paths';
import { setDraft } from '@/session/composer';
import { newSessionDraftKey } from '@/session/draft-origin';
import { useSessions } from '@/session/suggested-tasks';
import {
  EmptyList,
  LIST_CARD,
  type Notice,
  NoticeBanner,
  SettingsRow,
  SettingsSection,
} from './settings-ui';

export function EpisodeSettings({ workspaceId }: { workspaceId: WorkspaceId | undefined }) {
  const { client, view } = useHostConnection();
  const settings = useHostSettings();
  const navigate = useNavigate();
  const supported = view.status === 'connected' && hostSupports(view.hello.features, 'episodes');
  // 读到的一页连同它属于哪个项目：换项目时先留着旧的，新的到了再换，页面高度不塌、滚动位置不跳。
  const [loaded, setLoaded] = useState<{
    workspaceId: WorkspaceId;
    episodes: EpisodeSummary[];
    next?: string;
  }>();
  const [editing, setEditing] = useState<Episode>();
  const [deleting, setDeleting] = useState<EpisodeSummary>();
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!client || !supported || workspaceId === undefined) {
      setLoaded(undefined);
      return;
    }
    let active = true;
    const read = () =>
      void client
        .request('episode.list', { workspaceId })
        .then((value) => {
          if (active)
            setLoaded({
              workspaceId,
              episodes: value.episodes,
              ...(value.next !== undefined && { next: value.next }),
            });
        })
        .catch((error: unknown) => {
          if (active) setNotice({ tone: 'error', text: describe(error) });
        });
    const stop = client.onEpisodesChanged((change) => {
      if (change === undefined || change.workspaceId === workspaceId) read();
    });
    read();
    return () => {
      active = false;
      stop();
    };
  }, [client, supported, workspaceId]);
  if (!supported || !client) return null;
  const stale = loaded !== undefined && loaded.workspaceId !== workspaceId;
  const episodes = loaded?.episodes ?? [];
  const next = stale ? undefined : loaded?.next;

  const continueFrom = async (summary: EpisodeSummary) => {
    const { episode } = await client.request('episode.get', { id: summary.id });
    setDraft(
      newSessionDraftKey(episode.workspaceId),
      `${t('episodes.continuePrefix')}\n\n${episodeMarkdown(episode)}\n\nep:${episode.id}`,
    );
    const providerId = episode.engines.at(-1)?.providerId;
    void navigate(paths.draft(episode.workspaceId), {
      state:
        providerId === undefined
          ? undefined
          : { providerId, fromTitle: episode.title, material: 'episode' },
    });
  };
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(undefined);
    try {
      await work();
    } catch (error) {
      setNotice({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t('settings.episodes.title')}>
      {notice && <NoticeBanner notice={notice} />}
      <div className={LIST_CARD}>
        <SettingsRow
          title={t('settings.episodes.auto')}
          control={
            <Switch
              label={t('settings.episodes.auto')}
              checked={settings.settings.autoEpisodes !== false}
              onChange={(autoEpisodes) => void run(() => settings.update({ autoEpisodes }))}
              disabled={busy}
            />
          }
        />
        {episodes.map((episode) => (
          <div
            key={episode.id}
            className={
              stale
                ? 'flex items-center gap-2 border-t border-border px-4 py-3 opacity-60'
                : 'flex items-center gap-2 border-t border-border px-4 py-3'
            }
            inert={stale}
          >
            <button
              type="button"
              className="outline-none focus-visible:focus-ring min-w-0 flex-1 text-left"
              onClick={() =>
                void run(async () => {
                  const value = await client.request('episode.get', { id: episode.id });
                  setEditing(value.episode);
                })
              }
            >
              <div className="truncate text-sm">{episode.title || episode.sessionId}</div>
              <div className="text-xs text-muted-foreground">
                {episode.period.end.slice(0, 10)} · {deliveryLabel(episode.outcome.checks)} ·{' '}
                {t('settings.episodes.openCount', { count: episode.outcome.open })}
                {episode.excluded ? ` · ${t('settings.episodes.excluded')}` : ''}
                {episode.pinned ? ` · ${t('settings.episodes.pinned')}` : ''}
                {episode.stale ? ` · ${t('episodes.stale')}` : ''}
                {episode.source === 'deleted' ? ` · ${t('settings.episodes.sourceDeleted')}` : ''}
              </div>
            </button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => continueFrom(episode))}
            >
              {t('episodes.continue')}
            </Button>
            {episode.source !== 'deleted' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => navigate(paths.session(episode.workspaceId, episode.sessionId))}
              >
                {t('settings.episodes.source')}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(episode)}>
              {t('settings.memory.delete')}
            </Button>
          </div>
        ))}
      </div>
      {episodes.length === 0 && <EmptyList>{t('settings.episodes.empty')}</EmptyList>}
      {next && workspaceId !== undefined && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const value = await client.request('episode.list', {
                workspaceId,
                cursor: next,
              });
              setLoaded((previous) =>
                previous?.workspaceId === workspaceId
                  ? {
                      workspaceId,
                      episodes: [...previous.episodes, ...value.episodes],
                      ...(value.next !== undefined && { next: value.next }),
                    }
                  : previous,
              );
            })
          }
        >
          {t('settings.episodes.more')}
        </Button>
      )}
      {editing && (
        <EpisodeEditor key={editing.id} initial={editing} onClose={() => setEditing(undefined)} />
      )}
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        title={t('settings.episodes.deleteTitle')}
        confirmLabel={t('settings.memory.delete')}
        failure={(error) => t('settings.memory.deleteFailed', { error })}
        onConfirm={async () => {
          if (!deleting) return;
          const result = await client.request('episode.delete', {
            id: deleting.id,
            revision: deleting.revision,
          });
          if (result.conflict)
            setNotice({ tone: 'warning', text: t('settings.episodes.conflict') });
        }}
      >
        <p>{t('settings.episodes.deleteConsequence')}</p>
      </ConfirmDialog>
    </SettingsSection>
  );
}

function EpisodeEditor({ initial, onClose }: { initial: Episode; onClose: () => void }) {
  const { client } = useHostConnection();
  const fieldId = useId();
  const [episode, setEpisode] = useState(initial);
  const [title, setTitle] = useState(initial.title);
  const [goal, setGoal] = useState(initial.goal?.text ?? '');
  const [open, setOpen] = useState(initial.open.map((item) => item.text).join('\n'));
  const [lessons, setLessons] = useState(initial.lessons.map((item) => item.text).join('\n'));
  const [decisions, setDecisions] = useState(initial.decisions.map((item) => item.text).join('\n'));
  const [pinned, setPinned] = useState(initial.pinned);
  const [excluded, setExcluded] = useState(initial.excluded);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const lines = (value: string) => value.split('\n').filter((line) => line.trim() !== '');
  const save = async () => {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.request('episode.update', {
        id: episode.id,
        revision: episode.revision,
        pinned,
        excluded,
        patch: {
          ...(title !== initial.title && { title }),
          ...(goal !== (initial.goal?.text ?? '') && {
            goal: { ...(initial.goal ?? { id: 'user' }), text: goal },
          }),
          ...(open !== initial.open.map((item) => item.text).join('\n') && {
            open: lines(open).map((text, index) => ({
              ...(initial.open[index] ?? {
                id: `user:${index}`,
                origin: 'todo' as const,
                status: 'pending',
              }),
              text,
            })),
          }),
          ...(lessons !== initial.lessons.map((item) => item.text).join('\n') && {
            lessons: lines(lessons).map((text, index) => ({
              ...(initial.lessons[index] ?? { kind: 'correction' as const, sources: [] }),
              text,
              verified: false,
            })),
          }),
          ...(decisions !== initial.decisions.map((item) => item.text).join('\n') && {
            decisions: lines(decisions).map((text, index) => ({
              ...(initial.decisions[index] ?? { id: `user:${index}`, kind: 'instruction' }),
              text,
            })),
          }),
        },
      });
      if (result.conflict) {
        setEpisode(result.episode);
        setError(t('settings.episodes.conflict'));
      } else onClose();
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('settings.episodes.title')}</DialogTitle>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {Object.keys(initial.overrides).length > 0 && (
          <p className="text-xs text-muted-foreground">{t('settings.episodes.edited')}</p>
        )}
        {initial.stale && <p className="text-xs text-warning">{t('episodes.stale')}</p>}
        <label className="grid gap-1 text-sm" htmlFor={`${fieldId}-name`}>
          {t('settings.episodes.name')}
          <Input
            id={`${fieldId}-name`}
            value={title}
            maxLength={300}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm" htmlFor={`${fieldId}-goal`}>
          {t('settings.episodes.goal')}
          <Textarea
            id={`${fieldId}-goal`}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm" htmlFor={`${fieldId}-open`}>
          {t('settings.episodes.open')}
          <Textarea
            id={`${fieldId}-open`}
            value={open}
            onChange={(event) => setOpen(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm" htmlFor={`${fieldId}-lessons`}>
          {t('settings.episodes.lessons')}
          <Textarea
            id={`${fieldId}-lessons`}
            value={lessons}
            onChange={(event) => setLessons(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm" htmlFor={`${fieldId}-decisions`}>
          {t('settings.episodes.decisions')}
          <Textarea
            id={`${fieldId}-decisions`}
            value={decisions}
            onChange={(event) => setDecisions(event.target.value)}
          />
        </label>
        <div>
          <SettingsRow
            title={t('settings.episodes.pinned')}
            control={
              <Switch label={t('settings.episodes.pinned')} checked={pinned} onChange={setPinned} />
            }
          />
          <SettingsRow
            title={t('settings.episodes.excluded')}
            control={
              <Switch
                label={t('settings.episodes.excluded')}
                checked={excluded}
                onChange={setExcluded}
              />
            }
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {initial.engines.map((engine) => engine.modelId).join(' → ')} ·{' '}
          {deliveryLabel(initial.outcome.checks)} · {deliveryLabel(initial.outcome.commit)} ·{' '}
          {deliveryLabel(initial.outcome.push)}
        </p>
        <EpisodeSources episode={initial} />
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>{initial.files.map((file) => file.path).join(' · ')}</p>
          <p>{initial.commits.map((commit) => commit.sha.slice(0, 7)).join(' · ')}</p>
        </div>
        <DialogFooter>
          {initial.source !== 'deleted' && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (!client) return;
                setBusy(true);
                void client
                  .request('episode.refresh', { sessionId: initial.sessionId })
                  .then((result) => {
                    if (result.episode) setEpisode(result.episode);
                  })
                  .catch((reason: unknown) => setError(describe(reason)))
                  .finally(() => setBusy(false));
              }}
            >
              {t('settings.episodes.refresh')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={busy || title.trim() === ''} onClick={() => void save()}>
            {t('settings.memory.editor.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EpisodeSources({ episode }: { episode: Episode }) {
  const session = useSessions().get(episode.sessionId);
  return session === undefined ? null : <LiveEpisodeSources episode={episode} session={session} />;
}

function LiveEpisodeSources({ episode, session }: { episode: Episode; session: Session }) {
  const { open } = useRetroOpen(session);
  const items = [
    ...(episode.goal ? [episode.goal] : []),
    ...episode.done,
    ...episode.open,
    ...episode.decisions,
    ...episode.files.map((file) => ({
      id: file.id,
      text: file.path,
      ref: {
        kind: 'turn_diff' as const,
        turnId: file.turnIds.at(-1) as NonNullable<(typeof file.turnIds)[0]>,
        path: file.path,
      },
    })),
    ...episode.commits.map((commit) => ({
      id: commit.id,
      text: commit.subject,
      ref: { kind: 'commit' as const, sha: commit.sha },
    })),
    ...episode.memories,
  ];
  return (
    <details className="text-xs">
      <summary className="outline-none focus-visible:focus-ring cursor-pointer text-muted-foreground">
        {t('episodes.sources')}
      </summary>
      <div className="mt-2 grid gap-1">
        {items.map((item) => {
          const target = retroTarget(item.ref);
          return (
            <button
              type="button"
              key={item.id}
              disabled={!target}
              className="outline-none focus-visible:focus-ring text-left text-muted-foreground enabled:hover:text-foreground"
              onClick={() => target && open(target)}
            >
              {item.text}
            </button>
          );
        })}
      </div>
    </details>
  );
}
