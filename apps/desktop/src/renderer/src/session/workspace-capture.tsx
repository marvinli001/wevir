import { hostSupports } from '@wevir/client-sdk';
import {
  isExcludedSyncMaterialPath,
  type Session,
  SYNC_WORKSPACE_UNTRACKED_LIMIT,
  SyncRelativePathSchema,
} from '@wevir/protocol';
import { Camera } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';

export function WorkspaceCaptureButton({
  session,
  untracked,
}: {
  session: Session;
  untracked: string[];
}) {
  const { client, view } = useHostConnection();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  if (
    !client ||
    view.status !== 'connected' ||
    !hostSupports(view.hello.features, 'sync_workspace') ||
    !client.can('host.manage') ||
    session.readOnly ||
    session.parentSessionId
  )
    return null;
  const capture = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.request('sync.workspaceCapture', {
        sessionId: session.id,
        untracked: selected.filter((path) => untracked.includes(path)),
      });
      setSaved(true);
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <IconButton
        size="icon-xs"
        label={t('sync.workspaceCapture')}
        onClick={() => {
          setOpen(true);
          setSaved(false);
          setSelected([]);
          setError(undefined);
        }}
      >
        <Camera />
      </IconButton>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent className="flex max-h-[80vh] flex-col">
          <DialogTitle>{t('sync.workspaceCapture')}</DialogTitle>
          {untracked.length > 0 && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <fieldset>
                <legend className="mb-2 text-sm text-muted-foreground">
                  {t('sync.workspaceUntracked')}
                  <span className="ml-2 tabular-nums">
                    {selected.length}/{SYNC_WORKSPACE_UNTRACKED_LIMIT}
                  </span>
                </legend>
                {untracked.map((path) => {
                  const allowed =
                    SyncRelativePathSchema.safeParse(path).success &&
                    !isExcludedSyncMaterialPath(path);
                  return (
                    <label key={path} className="flex min-w-0 items-center gap-2 py-1 text-sm">
                      <Checkbox
                        checked={selected.includes(path)}
                        disabled={
                          busy ||
                          saved ||
                          !allowed ||
                          (selected.length >= SYNC_WORKSPACE_UNTRACKED_LIMIT &&
                            !selected.includes(path))
                        }
                        onCheckedChange={(value) =>
                          setSelected((current) =>
                            value
                              ? !allowed ||
                                current.length >= SYNC_WORKSPACE_UNTRACKED_LIMIT ||
                                current.includes(path)
                                ? current
                                : [...current, path]
                              : current.filter((entry) => entry !== path),
                          )
                        }
                      />
                      <span className="min-w-0 break-all font-mono">{path}</span>
                      {!allowed && (
                        <span className="text-muted-foreground">{t('portable.omissions')}</span>
                      )}
                    </label>
                  );
                })}
              </fieldset>
            </div>
          )}
          {saved && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('sync.workspaceSaved')}
            </p>
          )}
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              {t('common.close')}
            </Button>
            {!saved && (
              <Button disabled={busy} onClick={() => void capture()}>
                {t('sync.workspaceCapture')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
