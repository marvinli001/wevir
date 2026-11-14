import type { WevirClient } from '@wevir/client-sdk';
import { useEffect, useState } from 'react';
import { currentLocale, t } from '@/i18n';

export function syncVersionLabel(
  version: { opId: string; deviceId?: string; clientTime?: string },
  devices: Readonly<Record<string, string>>,
  localRevision: string | undefined,
  index: number,
): string {
  const name =
    version.deviceId && Object.hasOwn(devices, version.deviceId)
      ? devices[version.deviceId]
      : undefined;
  const local = version.opId === localRevision;
  return [
    ...(local ? [t('sync.localVersion')] : []),
    version.clientTime
      ? new Date(version.clientTime).toLocaleString(currentLocale(), {
          dateStyle: 'short',
          timeStyle: 'short',
        })
      : t('sync.versionIndex', { index: index + 1 }),
    ...(name ? [name] : local ? [] : [t('sync.remoteVersion')]),
  ].join(' · ');
}

export function useSyncPresentation(client: WevirClient, open: boolean) {
  const [names, setNames] = useState<{
    devices: Record<string, string>;
    projects: Record<string, string>;
  }>({ devices: {}, projects: {} });
  useEffect(() => {
    if (!open) return;
    let active = true;
    setNames({ devices: {}, projects: {} });
    void Promise.all([
      client.request('sync.devices', {}).then(
        (value) => value.devices,
        () => [],
      ),
      client.request('sync.status', {}).then(
        (value) => value.projects ?? [],
        () => [],
      ),
    ]).then(([devices, projects]) => {
      if (active)
        setNames({
          devices: Object.fromEntries(devices.map((device) => [device.deviceId, device.name])),
          projects: Object.fromEntries(
            projects.map((project) => [project.projectId, project.displayName]),
          ),
        });
    });
    return () => {
      active = false;
    };
  }, [client, open]);
  return {
    versionLabel: (
      version: Parameters<typeof syncVersionLabel>[0],
      localRevision?: string,
      index = 0,
    ) => syncVersionLabel(version, names.devices, localRevision, index),
    projectLabel: (projectId: string, index = 0) =>
      (Object.hasOwn(names.projects, projectId) ? names.projects[projectId] : undefined) ||
      t('sync.projectIndex', { index: index + 1 }),
  };
}
