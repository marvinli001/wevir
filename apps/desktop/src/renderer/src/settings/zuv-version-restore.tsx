import type { WevirClient } from '@wevir/client-sdk';
import type { MethodResult } from '@wevir/protocol';
import { useEffect, useRef, useState } from 'react';
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
import { describe } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';

type Preview = MethodResult<'sync.importRestorePreview'>;
const CONSEQUENCES: Partial<Record<Preview['kind'], PlainMessageKey>> = {
  memory: 'portable.restoreMemoryConsequence',
  settings: 'portable.restoreSettingsConsequence',
  bundle: 'portable.restoreBundleConsequence',
  project: 'portable.restoreProjectConsequence',
  session: 'portable.restoreSessionConsequence',
};
export function ZuvVersionRestore({
  client,
  importId,
  entryId,
  disabled = false,
}: {
  client: WevirClient;
  importId: string;
  entryId: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview>(),
    [error, setError] = useState<string>(),
    [done, setDone] = useState(false),
    [confirming, setConfirming] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const changeOpen = (value: boolean) => {
    if (busy) return;
    generation.current++;
    setOpen(value);
  };
  const run = async (fn: () => Promise<void>) => {
    const own = generation.current;
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (error) {
      if (own === generation.current) setError(describe(error));
    } finally {
      if (own === generation.current) setBusy(false);
    }
  };
  const load = async (targetId?: string, own = generation.current) => {
    const value = await client.request('sync.importRestorePreview', {
      importId,
      entryId,
      ...(targetId && { targetId }),
    });
    if (own === generation.current) setPreview(value);
  };
  const restore = async () => {
    if (!preview) return;
    const own = generation.current;
    await client.request('sync.importRestore', preview);
    if (own !== generation.current) return;
    setDone(true);
    setConfirming(false);
    void load(preview.targetId, own).catch((reason: unknown) => {
      if (own === generation.current) setError(describe(reason));
    });
  };
  const consequence = preview && CONSEQUENCES[preview.kind];
  if (!client.supports('sync_version_restore')) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          generation.current++;
          setOpen(true);
          setPreview(undefined);
          setDone(false);
          void run(() => load());
        }}
      >
        {t('portable.restoreVersion')}
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl"
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{t('portable.restoreVersion')}</DialogTitle>
          </DialogHeader>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-1">
            {!preview ? (
              busy && <p>{t('common.loading')}</p>
            ) : (
              <>
                {preview.sourceVerified === false && (
                  <p role="status">{t('verification.acceptance.unverified')}</p>
                )}
                {preview.reason && <p role="status">{t(`portable.restore.${preview.reason}`)}</p>}
                {preview.truncated && <p>{t('sync.truncatedFile')}</p>}
                {preview.targets && (
                  <Select
                    value={preview.targetId ?? ''}
                    disabled={busy || done}
                    aria-label={t('sync.packageTarget')}
                    options={preview.targets.map((target) => ({
                      value: target.targetId,
                      label: target.managed ? t('sync.managedCopy') : target.name,
                    }))}
                    onValueChange={(value) => {
                      void run(() => load(value));
                    }}
                  />
                )}
                {preview.targetPath && (
                  <p className="break-all text-xs text-muted-foreground">{preview.targetPath}</p>
                )}
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  {[
                    {
                      label: 'portable.selectedVersion' as const,
                      text: preview.selectedText,
                      deleted: preview.selectedDeleted,
                    },
                    {
                      label:
                        preview.kind === 'workspace'
                          ? ('sync.sessions' as const)
                          : ('sync.localVersion' as const),
                      text: preview.currentText,
                      deleted: preview.currentDeleted,
                    },
                  ].map((value) => (
                    <section
                      key={value.label}
                      className="min-w-0 space-y-2 rounded-md border border-border p-3"
                    >
                      <h3 className="text-sm font-medium">{t(value.label)}</h3>
                      <pre className="whitespace-pre-wrap break-words text-sm">
                        {value.deleted
                          ? t('changes.status.deleted')
                          : value.text || t('retro.empty')}
                      </pre>
                    </section>
                  ))}
                </div>
                {done && (
                  <p role="status">
                    {t(
                      preview.kind === 'workspace'
                        ? 'portable.restoredSnapshot'
                        : 'portable.restored',
                    )}
                  </p>
                )}
              </>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" disabled={busy} onClick={() => changeOpen(false)}>
              {t('common.close')}
            </Button>
            <Button
              disabled={busy || !preview?.canRestore || done}
              onClick={() => {
                if (!preview) return;
                if (consequence) setConfirming(true);
                else void run(restore);
              }}
            >
              {t('portable.restoreVersion')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={open && confirming}
        onOpenChange={setConfirming}
        title={t('portable.restoreVersion')}
        confirmLabel={t('portable.restoreVersion')}
        onConfirm={restore}
        failure={(message) => message}
      >
        {consequence &&
          t(preview?.selectedDeleted ? 'portable.restoreDeletedConsequence' : consequence)}
      </ConfirmDialog>
    </>
  );
}
