import type { WevirClient } from '@wevir/client-sdk';
import type { MethodResult } from '@wevir/protocol';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
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
}: {
  client: WevirClient;
  importId: string;
  entryId: string;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview>(),
    [error, setError] = useState<string>(),
    [done, setDone] = useState(false),
    [confirming, setConfirming] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (error) {
      setError(describe(error));
    } finally {
      setBusy(false);
    }
  };
  const load = async (targetId?: string) =>
    setPreview(
      await client.request('sync.importRestorePreview', {
        importId,
        entryId,
        ...(targetId && { targetId }),
      }),
    );
  const restore = async () => {
    if (!preview) return;
    await client.request('sync.importRestore', preview);
    await load(preview.targetId);
    setDone(true);
  };
  const consequence = preview && CONSEQUENCES[preview.kind];
  if (!client.supports('sync_version_restore')) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setOpen(true);
          setPreview(undefined);
          setDone(false);
          void run(() => load());
        }}
      >
        {t('portable.restoreVersion')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl"
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{t('portable.restoreVersion')}</DialogTitle>
          </DialogHeader>
          {error && (
            <p role="alert" className="break-words text-destructive">
              {error}
            </p>
          )}
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
                {done ? (
                  <p role="status">
                    {t(
                      preview.kind === 'workspace'
                        ? 'portable.restoredSnapshot'
                        : 'portable.restored',
                    )}
                  </p>
                ) : (
                  preview.canRestore &&
                  preview.kind === 'workspace' && (
                    <p className="text-sm text-muted-foreground">
                      {t('portable.restoreConsequence')}
                    </p>
                  )
                )}
              </>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
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
