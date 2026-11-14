import { hostSupports } from '@wevir/client-sdk';
import type {
  InstallPlan,
  MethodResult,
  ProviderId,
  ReadinessReport,
  Session,
} from '@wevir/protocol';
import { compareProtocolVersions } from '@wevir/protocol';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { useWorkbenchStore } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { InstallDialog } from '@/layout/readiness-dialogs';
import { mergeChange } from '@/layout/readiness-model';
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
  const { client, view } = useHostConnection();
  const store = useWorkbenchStore();
  const navigate = useNavigate();
  const { providers, choose } = useModelChoice();
  const [selected, setSelected] = useState<ModelChoice>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [snapshots, setSnapshots] = useState<MethodResult<'sync.workspaceSnapshots'>['snapshots']>(
    [],
  );
  const [snapshotId, setSnapshotId] = useState('');
  const [restored, setRestored] = useState<MethodResult<'sync.workspaceRestore'>>();
  const [report, setReport] = useState<ReadinessReport>();
  const [plan, setPlan] = useState<InstallPlan>();
  const [trust, setTrust] = useState(false);
  const [installRefreshing, setInstallRefreshing] = useState(false);
  const restores = useRef(new Map<string, MethodResult<'sync.workspaceRestore'>>());
  useEffect(() => {
    if (!open) {
      setRestored(undefined);
      setSnapshotId('');
      setReport(undefined);
      setTrust(false);
      setPlan(undefined);
    }
  }, [open]);
  const workspaceSupported =
    view.status === 'connected' &&
    hostSupports(view.hello.features, 'sync_workspace') &&
    client?.can('host.manage') === true;
  useEffect(() => {
    if (!client || !open || !restored) return;
    return client.onReadinessChanged((change) => {
      if (change && change.workspaceId === session.workspaceId && change.root === restored.cwd)
        setReport((current) => mergeChange(current, change));
    });
  }, [client, open, restored, session.workspaceId]);
  const release = async () => {
    const pending = [...restores.current.entries()];
    if (
      client &&
      view.status === 'connected' &&
      compareProtocolVersions(view.hello.protocolVersion, '0.187.0') >= 0
    )
      await Promise.all(
        pending.map(([, value]) =>
          client.request('sync.workspaceDiscard', { restoreId: value.restoreId }),
        ),
      );
    for (const [key, value] of pending)
      if (restores.current.get(key) === value) restores.current.delete(key);
  };
  const close = async () => {
    setBusy(true);
    try {
      await release();
      onOpenChange(false);
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!client || !open || !workspaceSupported) return;
    let active = true;
    client.request('sync.workspaceSnapshots', { sessionId: session.id }).then(
      (result) => {
        if (active) setSnapshots(result.snapshots);
      },
      (reason: unknown) => {
        if (active) setError(describe(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [client, open, session.id, workspaceSupported]);
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
      const snapshot = snapshots.find((item) => item.opId === snapshotId);
      let prepared = restored;
      if (snapshot) {
        prepared = await client.request('sync.workspaceRestore', {
          sessionId: session.id,
          snapshot,
          ...(restored && { restoreId: restored.restoreId }),
        });
        setRestored(prepared);
        restores.current.set(snapshot.opId, prepared);
        const next = (
          await client.request('readiness.get', {
            workspaceId: session.workspaceId,
            workspaceRestoreId: prepared.restoreId,
            refresh: true,
          })
        ).report;
        setReport(next);
        if (
          prepared.requiresTrust.length &&
          (!trust ||
            restored?.restoreId !== prepared.restoreId ||
            JSON.stringify([...restored.requiresTrust].sort()) !==
              JSON.stringify([...prepared.requiresTrust].sort()))
        ) {
          setTrust(false);
          setError(t('sync.workspaceTrustRequired'));
          return;
        }
        if (next.status === 'not_ready') {
          setError(t('sync.workspaceSetup'));
          return;
        }
      }
      const result = await client.request('session.createFromHistory', {
        sessionId: session.id,
        providerId: choice.providerId as ProviderId,
        modelId: choice.modelId,
        ...(choice.reasoningEffort !== undefined && { reasoningEffort: choice.reasoningEffort }),
        ...(snapshot &&
          prepared && {
            workspaceSnapshot: {
              vaultId: snapshot.vaultId,
              entityId: snapshot.entityId,
              opId: snapshot.opId,
            },
            workspaceRestoreId: prepared.restoreId,
            trustWorkspace: trust,
            trustWorkspacePaths: trust ? prepared.requiresTrust : [],
          }),
      });
      choose(choice);
      store?.upsertSession(result.session);
      onOpenChange(false);
      void release().catch((reason: unknown) => console.warn('workspace cleanup failed', reason));
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
        if (!busy) {
          if (value) onOpenChange(true);
          else void close();
        }
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[80vh] flex-col overflow-y-auto"
      >
        <DialogTitle>{t('recovery.continue')}</DialogTitle>
        {choice && (
          <ModelPicker
            providers={providers ?? []}
            value={choice}
            onChange={setSelected}
            readOnly={busy}
          />
        )}
        {snapshots.length > 0 && (
          <Select
            aria-label={t('sync.workspace')}
            value={snapshotId}
            disabled={busy || installRefreshing}
            options={[
              { value: '', label: t('sync.workspaceCurrent') },
              ...snapshots.map((snapshot) => ({
                value: snapshot.opId,
                label: new Date(snapshot.capturedAt).toLocaleString(currentLocale()),
              })),
            ]}
            onValueChange={(value) => {
              setSnapshotId(value);
              setRestored(restores.current.get(value));
              setReport(undefined);
              setTrust(false);
              setError(undefined);
              setPlan(undefined);
            }}
          />
        )}
        {restored && restored.requiresTrust.length > 0 && (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={trust} disabled={busy} onCheckedChange={setTrust} />
            <span>{t('sync.workspaceTrust')}</span>
            <ul className="max-h-40 overflow-y-auto break-all font-mono text-xs">
              {restored.requiresTrust.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          </label>
        )}
        {report && report.status === 'not_ready' && (
          <div className="space-y-2 text-sm">
            <p>{t('sync.workspaceSetup')}</p>
            {report.plans.map((item) => (
              <Button
                key={item.id}
                variant="outline"
                disabled={busy || installRefreshing || report.install?.status === 'running'}
                onClick={() => setPlan(item)}
              >
                {t('readiness.install.title')}
              </Button>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void close()}>
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
      {plan && report && restored && (
        <InstallDialog
          workspaceId={session.workspaceId}
          workspaceRestoreId={restored.restoreId}
          root={report.root}
          plan={plan}
          onClose={(started) => {
            setPlan(undefined);
            if (!started || !client) return;
            setInstallRefreshing(true);
            void client
              .request('readiness.get', {
                workspaceId: session.workspaceId,
                workspaceRestoreId: restored.restoreId,
                refresh: true,
              })
              .then(
                (result) =>
                  setReport((current) =>
                    current?.root === result.report.root ? result.report : current,
                  ),
                (reason: unknown) => setError(describe(reason)),
              )
              .finally(() => setInstallRefreshing(false));
          }}
        />
      )}
    </Dialog>
  );
}
