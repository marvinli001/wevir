import type { ProviderId, Session } from '@wevir/protocol';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { useWorkbenchStore } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { type ModelChoice, ModelPicker } from './model-picker';
import { resolveChoice, useModelChoice } from './start-session';

export function FromHistoryDialog({
  session,
  open,
  onOpenChange,
}: {
  session: Session;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { client } = useHostConnection();
  const store = useWorkbenchStore();
  const navigate = useNavigate();
  const { providers, choose } = useModelChoice();
  const [selected, setSelected] = useState<ModelChoice>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const choice = resolveChoice(
    providers ?? [],
    selected ?? {
      providerId: session.providerId,
      modelId: session.modelId,
      ...(session.reasoningEffort !== undefined && { reasoningEffort: session.reasoningEffort }),
    },
  );
  const start = async () => {
    if (!client || !choice) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.request('session.createFromHistory', {
        sessionId: session.id,
        providerId: choice.providerId as ProviderId,
        modelId: choice.modelId,
        ...(choice.reasoningEffort !== undefined && { reasoningEffort: choice.reasoningEffort }),
      });
      choose(choice);
      store?.upsertSession(result.session);
      onOpenChange(false);
      navigate(paths.session(result.session.workspaceId, result.session.id));
    } catch (reason) {
      setError(t('session.createFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent>
        <DialogTitle>{t('recovery.continue')}</DialogTitle>
        {choice && (
          <ModelPicker
            providers={providers ?? []}
            value={choice}
            onChange={setSelected}
            readOnly={busy}
          />
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!client || !choice || busy}
            onClick={() => void start()}
            data-action="continue-history"
          >
            {t('recovery.continue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
