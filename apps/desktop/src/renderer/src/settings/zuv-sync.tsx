import type { WevirClient } from '@wevir/client-sdk';
import type {
  AccountState,
  MethodResult,
  SyncConfigureParams,
  SyncStatus,
  WorkspaceId,
} from '@wevir/protocol';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import { useWorkbenchData } from '@/data/workbench-data';
import { describe } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { NoticeBanner } from './settings-ui';

const GROUPS: ReadonlyArray<{
  label: PlainMessageKey;
  categories: SyncConfigureParams['categories'];
}> = [
  { label: 'sync.sessions', categories: ['project', 'session', 'event-segment'] },
  { label: 'sync.memory', categories: ['memory'] },
  { label: 'sync.rules', categories: ['rule'] },
  { label: 'sync.skills', categories: ['skill-bundle'] },
  { label: 'sync.artifacts', categories: ['artifact'] },
  { label: 'sync.settings', categories: ['settings'] },
];
const STATES: Record<NonNullable<SyncStatus['state']>, PlainMessageKey> = {
  disabled: 'sync.disabled',
  configuring: 'sync.configuring',
  approval_required: 'sync.approvalRequired',
  pending: 'sync.pending',
  syncing: 'sync.syncing',
  idle: 'sync.saved',
  paused: 'sync.paused',
  attention: 'sync.attention',
  reset_required: 'sync.resetRequired',
  revoked: 'source.zuv.revoked',
};

export function ZuvSyncSection({
  client,
  account,
}: {
  client: WevirClient;
  account: AccountState;
}) {
  const data = useWorkbenchData();
  const [status, setStatus] = useState<SyncStatus>();
  const [editing, setEditing] = useState(false);
  const [categories, setCategories] = useState<SyncConfigureParams['categories']>([]);
  const [projects, setProjects] = useState<WorkspaceId[]>([]);
  const [history, setHistory] = useState(false);
  const [clouds, setClouds] = useState<MethodResult<'sync.projectCatalog'>['projects']>();
  const [projectChoices, setProjectChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [devices, setDevices] = useState<MethodResult<'sync.devices'>['devices']>();
  const [approving, setApproving] = useState<MethodResult<'sync.devices'>['devices'][number]>();
  const supported = client.supports('cloud_sync');
  useEffect(() => {
    if (account.status !== 'signed_in') {
      setClouds(undefined);
      setProjectChoices({});
      setEditing(false);
      setStatus(undefined);
    }
  }, [account.status]);
  const refresh = useCallback(
    async () => setStatus(await client.request('sync.status', {})),
    [client],
  );
  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    const read = () =>
      client
        .request('sync.status', {})
        .then((value) => {
          if (!disposed) setStatus(value);
        })
        .catch((reason) => {
          if (!disposed) setError(describe(reason));
        });
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client, supported]);
  if (!supported) return null;
  const active = account.zuv?.subscriptionState === 'active';
  const workspaces = data.status === 'ready' ? data.workspaces.map((entry) => entry.workspace) : [];
  const edit = () => {
    setCategories(status?.binding?.categories ?? []);
    setProjects(
      (status?.projects ?? [])
        .filter(
          (value) => value.workspaceId && status?.binding?.projectIds.includes(value.projectId),
        )
        .map((value) => value.workspaceId as WorkspaceId),
    );
    setProjectChoices(
      Object.fromEntries(
        (status?.projects ?? []).flatMap((value) =>
          value.workspaceId ? [[value.workspaceId, value.projectId]] : [],
        ),
      ),
    );
    setHistory(status?.includeHistory ?? false);
    setEditing(true);
  };
  const run = async (op: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await op();
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      const selected = [...new Set(categories)];
      if (projects.length && !selected.includes('project')) selected.push('project');
      if (selected.includes('rule') || selected.includes('skill-bundle'))
        if (!selected.includes('artifact')) selected.push('artifact');
      setStatus(
        await client.request('sync.configure', {
          enabled: true,
          categories: selected,
          includeHistory: history,
          ...(status?.binding && { expectedRevision: status.binding.revision }),
          projects: projects.map((workspaceId) => ({
            workspaceId,
            ...(projectChoices[workspaceId] && { projectId: projectChoices[workspaceId] }),
          })),
        }),
      );
      setEditing(false);
    });
  const readClouds = () =>
    run(async () => {
      try {
        setClouds((await client.request('sync.projectCatalog', { enable: true })).projects);
      } finally {
        await refresh();
      }
    });
  const projectScope = status?.binding?.enabled && status.binding.categories.includes('project');
  return (
    <div className="space-y-3 border-t border-border pt-3" data-zuv-sync>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{t('sync.title')}</span>
        <span className="text-xs text-muted-foreground" role="status">
          {status && t(STATES[status.state ?? 'disabled'])}
        </span>
      </div>
      {status?.pending ? (
        <p className="text-xs text-muted-foreground">
          {t('sync.pendingCount', { count: status.pending })}
        </p>
      ) : null}
      {error && <NoticeBanner notice={{ tone: 'error', text: error }} />}
      {status?.errorCode && !error && (
        <NoticeBanner notice={{ tone: 'error', text: status.errorCode }} />
      )}
      {editing ? (
        <div className="space-y-3">
          <fieldset disabled={busy} className="space-y-2">
            <legend className="mb-2 text-xs text-muted-foreground">{t('sync.categories')}</legend>
            {GROUPS.map((group) => (
              <label key={group.label} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={group.categories.every((value) => categories.includes(value))}
                  onCheckedChange={(checked) =>
                    setCategories((current) =>
                      checked
                        ? [...new Set([...current, ...group.categories])]
                        : current.filter((value) => !group.categories.includes(value)),
                    )
                  }
                />
                {t(group.label)}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{t('sync.projects')}</span>
            {client.supports('sync_project_catalog') && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !active}
                onClick={() => void readClouds()}
              >
                {t(projectScope ? 'sync.cloudProjects' : 'sync.enableCatalog')}
              </Button>
            )}
          </div>
          <fieldset
            disabled={busy}
            className="max-h-48 space-y-3 overflow-y-auto"
            aria-label={t('sync.projects')}
          >
            {workspaces.map((workspace) => {
              const bound = status?.projects?.find((value) => value.workspaceId === workspace.id);
              const choice = projectChoices[workspace.id] ?? '';
              const options = [
                { value: '', label: t('sync.newProject') },
                ...(clouds ?? [])
                  .filter(
                    (project) =>
                      project.projectId === choice ||
                      (!Object.entries(projectChoices).some(
                        ([key, value]) => key !== workspace.id && value === project.projectId,
                      ) &&
                        !status?.projects?.some(
                          (value) =>
                            value.workspaceId &&
                            value.workspaceId !== workspace.id &&
                            value.projectId === project.projectId,
                        )),
                  )
                  .map((project) => ({
                    value: project.projectId,
                    label:
                      project.versions.length === 1
                        ? project.versions[0]?.displayName || project.projectId
                        : `${project.projectId.slice(-8)} · ${t('sync.projectVersions', { count: project.versions.length })}`,
                  })),
              ];
              if (bound && !options.some((value) => value.value === bound.projectId))
                options.push({ value: bound.projectId, label: bound.displayName });
              return (
                <div key={workspace.id} className="space-y-1.5">
                  <label className="flex min-w-0 items-center gap-2 text-sm">
                    <Checkbox
                      checked={projects.includes(workspace.id)}
                      onCheckedChange={(checked) =>
                        setProjects((current) =>
                          checked
                            ? [...current, workspace.id]
                            : current.filter((value) => value !== workspace.id),
                        )
                      }
                    />
                    <span className="truncate">{workspace.displayName}</span>
                  </label>
                  {projects.includes(workspace.id) && (clouds || bound) && (
                    <Select
                      value={choice}
                      options={options}
                      disabled={busy || bound !== undefined}
                      aria-label={`${workspace.displayName} · ${t('sync.cloudProjects')}`}
                      className="w-full min-w-0"
                      onValueChange={(value) =>
                        setProjectChoices((current) => ({ ...current, [workspace.id]: value }))
                      }
                    />
                  )}
                </div>
              );
            })}
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={history} disabled={busy} onCheckedChange={setHistory} />
            {t('sync.includeHistory')}
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || !active || (!categories.length && !projects.length)}
              onClick={() => void save()}
            >
              {t('sync.saveScope')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || !active || !status} onClick={edit}>
            {t('sync.scope')}
          </Button>
          {status?.binding?.enabled && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setStatus(
                    await client.request('sync.configure', {
                      enabled: false,
                      categories: [],
                      projects: [],
                    }),
                  );
                })
              }
            >
              {t('sync.disable')}
            </Button>
          )}
          {status?.binding && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setStatus(await client.request('sync.retry', {}));
                  })
                }
              >
                {t('source.recheck')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setDevices((await client.request('sync.devices', {})).devices);
                  })
                }
              >
                {t('sync.devices')}
              </Button>
            </>
          )}
        </div>
      )}
      {devices && (
        <ul className="space-y-2 border-t border-border pt-2">
          {devices.map((device) => (
            <li
              key={device.deviceId}
              className="flex min-w-0 items-center justify-between gap-2 text-sm"
            >
              <span className="min-w-0">
                <span className="block truncate">{device.name}</span>
                <span className="block break-all font-mono text-xs text-muted-foreground">
                  {device.thumbprint}
                </span>
              </span>
              {device.revokedAt ? (
                <span className="text-xs">{t('source.zuv.revoked')}</span>
              ) : device.keyThroughEpoch === '0' &&
                device.deviceId !== status?.binding?.deviceId ? (
                <Button size="sm" variant="outline" onClick={() => setApproving(device)}>
                  {t('sync.approve')}
                </Button>
              ) : (
                <span className="text-xs">{t('sync.trusted')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {approving && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setApproving(undefined);
          }}
          title={t('sync.approve')}
          confirmLabel={t('sync.approve')}
          failure={(value) => value}
          onConfirm={async () => {
            await client.request('sync.approveDevice', { deviceId: approving.deviceId });
            setDevices((await client.request('sync.devices', {})).devices);
            await refresh();
          }}
        >
          <p>{approving.name}</p>
          <p className="break-all font-mono text-xs">{approving.thumbprint}</p>
          <p>{t('sync.approveAccess')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
