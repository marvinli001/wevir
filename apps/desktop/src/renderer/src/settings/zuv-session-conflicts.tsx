import type { WevirClient } from '@wevir/client-sdk';
import type { MethodResult } from '@wevir/protocol';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';

type Preview = MethodResult<'sync.previewSessionMerge'>;
function contentText(content: Preview['versions'][number]['content']): string {
  if (content.schema === 'wevir-session-deleted/1') return t('changes.status.deleted');
  if (content.schema === 'wevir-session/1' || content.schema === 'wevir-session-state/1')
    return `${content.title}\n${t(content.archivedAt ? 'settings.tab.archived' : 'sync.unarchived')}`;
  if (content.schema === 'wevir-retro-summary/1')
    return content.summary.points.map((point) => point.text).join('\n\n');
  const episode = content.episode;
  if (content.deleted || !episode) return t('changes.status.deleted');
  return [
    episode.overrides.title ?? episode.title,
    (episode.overrides.goal ?? episode.goal)?.text,
    `${t('retro.section.done')}\n${episode.done.map((item) => item.text).join('\n')}`,
    `${t('retro.section.open')}\n${(episode.overrides.open ?? episode.open).map((item) => item.text).join('\n')}`,
    `${t('retro.section.decisions')}\n${(episode.overrides.decisions ?? episode.decisions).map((item) => item.text).join('\n')}`,
    ...(episode.overrides.lessons ?? episode.lessons).map((item) => item.text),
    episode.pinned && t('settings.episodes.pinned'),
    episode.excluded && t('settings.episodes.excluded'),
    ...episode.files.map((file) => file.path),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function ZuvSessionConflicts({
  client,
  disabled,
  onResolved,
}: {
  client: WevirClient;
  disabled: boolean;
  onResolved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [entries, setEntries] = useState<MethodResult<'sync.sessionConflicts'>['conflicts']>();
  const [next, setNext] = useState<string>();
  const [preview, setPreview] = useState<Preview>();
  const [selected, setSelected] = useState('');
  const [choice, setChoice] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setBusy(false);
    }
  };
  const load = async (after?: string) => {
    const page = await client.request('sync.sessionConflicts', after ? { after } : {});
    setEntries((current) => (after ? [...(current ?? []), ...page.conflicts] : page.conflicts));
    setNext(page.next);
  };
  const chosen =
    choice === 'merged'
      ? preview?.merged
      : preview?.versions.find((version) => version.opId === choice)?.content;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          setPreview(undefined);
          setSelected('');
          setChoice('');
          void run(() => load());
        }}
      >
        {t('sync.sessionConflicts')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          showCloseButton={false}
          className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl"
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{t('sync.sessionConflicts')}</DialogTitle>
          </DialogHeader>
          {error && (
            <p role="alert" className="break-words text-destructive">
              {error}
            </p>
          )}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-1">
            {entries === undefined ? (
              busy && <p>{t('common.loading')}</p>
            ) : entries.length === 0 ? (
              <p>{t('sync.noConflicts')}</p>
            ) : (
              <Select
                value={selected}
                disabled={busy || disabled}
                aria-label={t('sync.sessionConflicts')}
                options={[
                  { value: '', label: t('sync.sessions') },
                  ...entries.map((entry) => ({
                    value: entry.entityId,
                    label: `${entry.title || entry.sessionId} · ${entry.kind === 'session' ? t('sync.sessions') : entry.kind === 'episode' ? t('settings.episodes.title') : t('retro.section.summary')}`,
                  })),
                ]}
                onValueChange={(value) => {
                  setSelected(value);
                  setPreview(undefined);
                  setChoice('');
                  if (value)
                    void run(async () => {
                      setPreview(
                        await client.request('sync.previewSessionMerge', { entityId: value }),
                      );
                    });
                }}
              />
            )}
            {next && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void run(() => load(next));
                }}
              >
                {t('sync.moreConflicts')}
              </Button>
            )}
            {preview && (
              <>
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  {preview.versions.map((version) => (
                    <div
                      key={version.opId}
                      className="min-w-0 space-y-2 rounded-md border border-border p-3"
                    >
                      <p className="break-all font-mono text-xs text-muted-foreground">
                        {version.opId === preview.localRevision
                          ? t('sync.localVersion')
                          : version.opId}
                      </p>
                      <pre className="whitespace-pre-wrap break-words text-sm">
                        {contentText(version.content)}
                      </pre>
                    </div>
                  ))}
                </div>
                <Select
                  value={choice}
                  disabled={busy || disabled}
                  aria-label={t('sync.selectVersion')}
                  options={[
                    { value: '', label: t('sync.selectVersion') },
                    ...(preview.merged ? [{ value: 'merged', label: t('sync.mergeResult') }] : []),
                    ...preview.versions.map((version) => ({
                      value: version.opId,
                      label:
                        version.opId === preview.localRevision
                          ? t('sync.localVersion')
                          : version.opId,
                    })),
                  ]}
                  onValueChange={setChoice}
                />
                {chosen && (
                  <pre className="whitespace-pre-wrap break-words rounded-md border border-border p-3 text-sm">
                    {contentText(chosen)}
                  </pre>
                )}
              </>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              {t('common.close')}
            </Button>
            <Button
              disabled={busy || disabled || !preview || !chosen}
              onClick={() => {
                if (!preview || !choice) return;
                void run(async () => {
                  await client.request('sync.resolveSession', {
                    ...preview,
                    selection:
                      choice === 'merged' ? { kind: 'merged' } : { kind: 'version', opId: choice },
                  });
                  setPreview(undefined);
                  setChoice('');
                  setSelected('');
                  await load();
                  await onResolved();
                });
              }}
            >
              {t('sync.useVersion')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
