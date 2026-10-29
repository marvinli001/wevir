// 办公文档预览引擎（0.138.0，Host 功能 `office_preview`）：LibreOffice 引擎由 Host 按需下载（`office.*`），文件窗格与设置 → 存储
// 共用这一份状态。第一个用到的组件读一次 `office.status`，之后跟着 `office.changed`；重连后重读。

import type { OfficeEngineStatus } from '@wevir/protocol';
import { useEffect, useSyncExternalStore } from 'react';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { formatFileSize } from '@/session/shared-files-model';
import { hasOfficePreview } from './files-data';

interface EngineState {
  status?: OfficeEngineStatus;
  /** 最近一次操作失败的原因。 */
  error?: string;
  busy: boolean;
}

let state: EngineState = { busy: false };
const listeners = new Set<() => void>();
function set(patch: Partial<EngineState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 正在订阅的连接与组件数：最后一个组件卸载时退订。 */
let watching: { client: object; users: number; stop: () => void } | undefined;

export interface OfficeEngine {
  /** Host 有 `office_preview`。 */
  supported: boolean;
  status?: OfficeEngineStatus;
  error?: string;
  busy: boolean;
  install(): void;
  cancel(): void;
  remove(): void;
}

export function useOfficeEngine(): OfficeEngine {
  const { client, view } = useHostConnection();
  const supported = hasOfficePreview(view);
  const current = useSyncExternalStore(subscribe, () => state);

  useEffect(() => {
    if (!client || !supported) return;
    if (watching?.client !== client) {
      watching?.stop();
      const load = () =>
        client
          .request('office.status', {})
          .then((result) => set({ status: result.status }))
          .catch((reason: unknown) => set({ error: describe(reason) }));
      void load();
      const stop = client.onOfficeChanged((change) => {
        if (change === undefined) void load();
        else set({ status: change.status });
      });
      watching = { client, users: 0, stop };
    }
    const own = watching;
    own.users += 1;
    return () => {
      own.users -= 1;
      if (own.users === 0 && watching === own) {
        own.stop();
        watching = undefined;
      }
    };
  }, [client, supported]);

  const run = (method: 'office.install' | 'office.cancelInstall' | 'office.uninstall') => {
    if (!client) return;
    set({ busy: true, error: undefined });
    client
      .request(method, {})
      .then((result) => set({ status: result.status }))
      .catch((reason: unknown) => set({ error: describe(reason) }))
      .finally(() => set({ busy: false }));
  };

  return {
    supported,
    ...(current.status !== undefined && { status: current.status }),
    ...(current.error !== undefined && { error: current.error }),
    busy: current.busy,
    install: () => run('office.install'),
    cancel: () => run('office.cancelInstall'),
    remove: () => run('office.uninstall'),
  };
}

/** 下载进度的百分比（还不知道总数时按要下载的字节数算）。 */
export function installPercent(status: OfficeEngineStatus): number {
  const total = status.progress?.totalBytes ?? status.downloadBytes;
  const completed = status.progress?.completedBytes ?? 0;
  return total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : 0;
}

/** 引擎状态的一句话（设置 → 存储）。 */
export function engineStatusText(status: OfficeEngineStatus, locale: string): string {
  const size = (bytes: number) => formatFileSize(bytes, locale);
  switch (status.state) {
    case 'unsupported':
      return t('settings.storage.officeEngine.unsupported');
    case 'missing':
      return t('settings.storage.officeEngine.missing', { size: size(status.downloadBytes) });
    case 'ready':
      return t('settings.storage.officeEngine.ready', {
        size: size(status.installedBytes ?? status.downloadBytes),
      });
    case 'failed':
      return t('settings.storage.officeEngine.failed', { error: status.error ?? '' });
    case 'installing':
      return t('files.officeEngine.downloading', { percent: installPercent(status) });
  }
}
