import { hostSupports } from '@wevir/client-sdk';
import { DEFAULT_HOST_SETTINGS, type HostSettings } from '@wevir/protocol';
import { useCallback, useEffect, useState } from 'react';
import { useHostConnection } from '@/host/host-connection';

export interface HostSettingsState {
  /** Host 声明了 `host_settings` 功能（R11）；没有时 `settings` 是默认值，不能修改。 */
  supported: boolean;
  /** 能改：Host 支持，且这条连接有 `host.manage`（远程设备一般没有，这时只读）。 */
  editable: boolean;
  /** 还没读到时是默认值。 */
  settings: HostSettings;
  update(patch: Partial<HostSettings>): Promise<void>;
}

/**
 * Host 设置（R11，domain-model §3.7）：连上之后 `settings.get`，之后跟着 `settings.updated`（别的客户端改了也会跟上）。
 * CLI 与桌面共用一份，存在 Host。
 */
export function useHostSettings(): HostSettingsState {
  const { client, view } = useHostConnection();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'host_settings');
  const editable = supported && view.hello.permissions.includes('host.manage');
  const [settings, setSettings] = useState<HostSettings>(DEFAULT_HOST_SETTINGS);

  useEffect(() => {
    if (!client) return;
    return client.watchSettings(setSettings);
  }, [client]);

  const update = useCallback(
    async (patch: Partial<HostSettings>) => {
      if (!client) return;
      const result = await client.request('settings.update', { settings: patch });
      setSettings(result.settings);
    },
    [client],
  );

  return { supported, editable, settings, update };
}
