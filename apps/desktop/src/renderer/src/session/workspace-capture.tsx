import { hostSupports } from '@wevir/client-sdk';
import type { Session } from '@wevir/protocol';
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
    session.readOnly ||
    session.parentSessionId
  )
    return null;
  const capture = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.request('sync.workspaceCapture', { sessionId: session.id, untracked: selected });
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
            <fieldset className="min-h-0 overflow-y-auto">
              <legend className="mb-2 text-sm text-muted-foreground">
                {t('sync.workspaceUntracked')}
              </legend>
              {untracked.map((path) => (
                <label key={path} className="flex min-w-0 items-center gap-2 py-1 text-sm">
                  <Checkbox
                    checked={selected.includes(path)}
                    disabled={busy || saved}
                    onCheckedChange={(value) =>
                      setSelected((current) =>
                        value ? [...current, path] : current.filter((entry) => entry !== path),
                      )
                    }
                  />
                  <span className="min-w-0 break-all font-mono">{path}</span>
                </label>
              ))}
            </fieldset>
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
