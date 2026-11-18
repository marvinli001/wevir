import type { WevirClient } from '@wevir/client-sdk';
import type { MethodResult } from '@wevir/protocol';
import { useId, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { useSyncPresentation } from './sync-presentation';

type Preview = MethodResult<'sync.previewMemoryMerge'>;
const MEMORY_HEADER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const body = (markdown: string) => markdown.replace(MEMORY_HEADER, '');
const metadata = (markdown: string) =>
  (markdown.match(MEMORY_HEADER)?.[0] ?? '')
    .split(/\r?\n/)
    .filter(
      (line) =>
        line !== '---' &&
        !/^(?:name|disabled|updated|updated-(?:by|session|turn|seq|proposal|imported-app|imported-path)):/.test(
          line,
        ),
    )
    .join('\n')
    .trim();
const noteDisabled = (markdown: string) =>
  /^disabled:\s*true\s*$/m.test(markdown.match(MEMORY_HEADER)?.[0] ?? '');
export function ZuvMemoryConflicts({
  client,
  disabled,
  onResolved,
}: {
  client: WevirClient;
  disabled: boolean;
  onResolved: () => Promise<void>;
}) {
  const versionLabel = useId();
  const [open, setOpen] = useState(false);
  const { versionLabel: versionText, projectLabel: projectText } = useSyncPresentation(
    client,
    open,
  );
  const [entries, setEntries] = useState<MethodResult<'sync.memoryConflicts'>['conflicts']>();
  const [next, setNext] = useState<string>();
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const [choice, setChoice] = useState('');
  const [text, setText] = useState('');
  const [template, setTemplate] = useState('');
  const [deleted, setDeleted] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const differentMetadata =
    preview &&
    new Set(
      preview.versions
        .filter((entry) => !entry.deleted)
        .map((entry) => metadata(entry.markdown ?? '')),
    ).size > 1;
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
    const page = await client.request('sync.memoryConflicts', after ? { after } : {});
    setEntries((current) => (after ? [...(current ?? []), ...page.conflicts] : page.conflicts));
    setNext(page.next);
  };
  const choose = (value: string) => {
    setChoice(value);
    const version = preview?.versions.find((entry) => entry.opId === value);
    setDeleted(version?.deleted === true);
    const markdown =
      value === 'merged'
        ? (preview?.merged ?? '')
        : value === 'manual'
          ? (preview?.versions.find((entry) => entry.opId === preview.localRevision)?.markdown ??
            preview?.base?.markdown ??
            preview?.versions.find((entry) => entry.markdown !== undefined)?.markdown ??
            '')
          : (version?.markdown ?? '');
    setTemplate(markdown);
    setText(body(markdown));
  };
  const resolve = async () => {
    if (!preview) return;
    await client.request('sync.resolveMemory', {
      entityId: preview.entityId,
      expectedHeads: preview.expectedHeads,
      localRevision: preview.localRevision,
      fileFingerprint: preview.fileFingerprint,
      ...(deleted
        ? { deleted: true }
        : { markdown: `${template.match(MEMORY_HEADER)?.[0] ?? ''}${text}` }),
    });
    setPreview(undefined);
    setSelected('');
    setChoice('');
    await load();
    await onResolved();
  };
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
        {t('sync.memoryConflicts')}
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
            <DialogTitle>{t('sync.memoryConflicts')}</DialogTitle>
          </DialogHeader>
          {error && (
            <div className="flex items-start gap-2">
              <ErrorNote className="flex-1">{error}</ErrorNote>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={busy || disabled}
                onClick={() => void run(() => load())}
              >
                {t('connection.retry')}
              </Button>
            </div>
          )}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-1">
            {entries === undefined ? (
              busy ? (
                <p>{t('common.loading')}</p>
              ) : null
            ) : entries.length === 0 ? (
              next ? null : (
                <p>{t('sync.noConflicts')}</p>
              )
            ) : (
              <Select
                value={selected}
                disabled={busy || disabled}
                aria-label={t('sync.memoryConflicts')}
                options={[
                  { value: '', label: t('sync.memory') },
                  ...entries.map((entry, index) => ({
                    value: entry.entityId,
                    label: `${entry.name} · ${entry.scope === 'global' ? t('settings.memory.global') : projectText(entry.projectId ?? '', index)}`,
                  })),
                ]}
                onValueChange={(value) => {
                  setSelected(value);
                  setPreview(undefined);
                  setChoice('');
                  if (value)
                    void run(async () =>
                      setPreview(
                        await client.request('sync.previewMemoryMerge', { entityId: value }),
                      ),
                    );
                }}
              />
            )}
            {next && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || disabled}
                onClick={() => void run(() => load(next))}
              >
                {t('sync.moreConflicts')}
              </Button>
            )}
            {preview && (
              <>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-3">
                  {preview.versions.map((version, index) => (
                    <div key={version.opId} className="min-w-0 space-y-1 text-xs">
                      <span
                        id={`${versionLabel}-${version.opId}`}
                        className="block min-w-0 max-w-full break-words"
                      >
                        {versionText(version, preview.localRevision, index)}
                      </span>
                      {noteDisabled(version.markdown ?? '') && (
                        <span className="ml-2 text-muted-foreground">
                          {t('settings.memory.disabled')}
                        </span>
                      )}
                      {differentMetadata && !version.deleted && (
                        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-2 text-muted-foreground">
                          {metadata(version.markdown ?? '')}
                        </pre>
                      )}
                      {version.deleted ? (
                        <p>{t('rail.outputs.kind.deleted')}</p>
                      ) : (
                        <Textarea
                          readOnly
                          aria-labelledby={`${versionLabel}-${version.opId}`}
                          value={body(version.markdown ?? '')}
                          className="h-32 resize-none overflow-auto font-mono text-xs [field-sizing:fixed]"
                        />
                      )}
                    </div>
                  ))}
                </div>
                <Select
                  value={choice}
                  disabled={busy || disabled}
                  aria-label={t('sync.selectVersion')}
                  options={[
                    { value: '', label: t('sync.selectVersion') },
                    ...preview.versions.map((version, index) => ({
                      value: version.opId,
                      label: `${versionText(version, preview.localRevision, index)}${version.deleted ? ` · ${t('rail.outputs.kind.deleted')}` : ''}`,
                    })),
                    ...(preview.merged !== undefined
                      ? [{ value: 'merged', label: t('sync.mergeResult') }]
                      : []),
                    ...(preview.base?.markdown !== undefined ||
                    preview.versions.some((version) => version.markdown !== undefined)
                      ? [{ value: 'manual', label: t('sync.manualMerge') }]
                      : []),
                  ]}
                  onValueChange={choose}
                />
                {choice && !deleted && noteDisabled(template) && (
                  <p className="text-xs text-muted-foreground">{t('settings.memory.disabled')}</p>
                )}
                {choice && !deleted && (
                  <Textarea
                    value={text}
                    disabled={busy || disabled}
                    onChange={(event) => setText(event.target.value)}
                    aria-label={t('sync.mergeResult')}
                    className="h-48 resize-y overflow-auto font-mono text-xs [field-sizing:fixed]"
                  />
                )}
              </>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              {t('common.close')}
            </Button>
            <Button
              variant={deleted ? 'destructive' : 'default'}
              disabled={busy || disabled || !preview || !choice}
              onClick={() => {
                if (deleted) setConfirmDelete(true);
                else void run(resolve);
              }}
            >
              {deleted ? t('settings.memory.delete') : t('sync.useVersion')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('settings.memory.delete')}
        confirmLabel={t('settings.memory.delete')}
        failure={(value) => value}
        onConfirm={async () => {
          setBusy(true);
          try {
            await resolve();
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('sync.deleteMemoryConsequence')}
      </ConfirmDialog>
    </>
  );
}
