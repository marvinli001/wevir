import type { HandoffConfigure, MethodResult, SessionId } from '@wevir/protocol';
import { useEffect, useState } from 'react';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';

export function HandoffPreviewDialog({
  sessionId,
  providerId,
  target,
  records,
  onConfirm,
  onClose,
}: {
  sessionId: SessionId;
  providerId: string;
  target: string;
  records: boolean;
  onConfirm: (handoff: HandoffConfigure) => Promise<void>;
  onClose: () => void;
}) {
  const { client } = useHostConnection();
  const [episode, setEpisode] = useState(false);
  const [result, setResult] = useState<MethodResult<'session.handoffPreview'>>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!client) return;
    let active = true;
    setResult(undefined);
    setError(undefined);
    void client
      .request('session.handoffPreview', {
        sessionId,
        providerId,
        ...(episode && { handoff: { episode } }),
      })
      .then(
        (value) => {
          if (active) setResult(value);
        },
        (reason: unknown) => {
          if (active) setError(describe(reason));
        },
      );
    return () => {
      active = false;
    };
  }, [client, sessionId, providerId, episode]);
  const confirm = async () => {
    if (!result) return;
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm({
        ...(episode && { episode }),
        ...(result.binding && { binding: result.binding }),
      });
      onClose();
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(value) => !value && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="handoff-preview">
        <DialogHeader>
          <DialogTitle>{t('handoff.preview.title')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t('handoff.detail.target')} · {target}
        </p>
        {records && (
          <div className="flex items-center justify-between gap-4 text-sm">
            <span>{t('handoff.preview.episode')}</span>
            <Switch
              label={t('handoff.preview.episode')}
              checked={episode}
              onChange={setEpisode}
              disabled={busy}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!result && !error && (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        )}
        {result && (
          <>
            <p className="text-xs text-muted-foreground">
              {result.preview.bytes ?? result.preview.overBudget?.bytes ?? 0} /{' '}
              {result.preview.budgetBytes} B
            </p>
            {result.preview.overBudget && (
              <p role="alert" className="text-sm text-destructive">
                {t('handoff.preview.overBudget')}
              </p>
            )}
            <pre
              // biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动的正文需要键盘访问。
              tabIndex={0}
              className="max-h-[50vh] overflow-auto rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap outline-none focus-visible:focus-field"
            >
              {result.preview.context ?? t('handoff.preview.empty')}
            </pre>
          </>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={busy || !result || result.preview.overBudget !== undefined}
          >
            {t('handoff.preview.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
