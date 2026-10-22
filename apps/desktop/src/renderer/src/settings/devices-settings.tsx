import { hostSupports } from '@wevir/client-sdk';
import {
  type Device,
  type Permission,
  REMOTE_DEFAULT_PORT,
  type RemoteInterface,
  type RemoteSettings,
  type RemoteStatus,
} from '@wevir/protocol';
import { Smartphone, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useHostSettings } from '@/data/host-settings';
import { describe, useHostConnection } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { formatRelativeTime } from '@/session/subagent-model';
import {
  DEVICE_PERMISSION_ORDER,
  interfaceLabel,
  PERMISSION_LABEL,
  PLATFORM_LABEL,
  parsePort,
  parseRelayUrl,
  RISKY_DEVICE_PERMISSIONS,
  remoteOf,
  setLan,
  toggleLanInterface,
  togglePermission,
  visibleDevices,
} from './devices-model';
import { PairingDialog } from './pairing-dialog';
import {
  EmptyList,
  LIST_CARD,
  type Notice,
  NoticeBanner,
  SettingsRow,
  SettingsSection,
} from './settings-ui';

/** 加上前要确认的那一项的后果。 */
const RISK_BODY: Partial<Record<Permission, PlainMessageKey>> = {
  'terminal.write': 'settings.devices.grantBody.terminal',
  'policy.write': 'settings.devices.grantBody.policy',
};

/**
 * 设置 → 设备（0.107.0，domain-model §3.49，desktop-layout.md）：远程访问的总开关、直连的网卡与端口（0.109.0，Host 功能
 * `remote_listener`；旧 Host 显示为不可用）、中继与自定义地址；“添加手机”弹窗；配对过的设备，按设备加减权限（终端与审批策略要
 * 确认）、移除。远程访问默认关。网卡逐块列出名称与地址，让用户确认（`100.64/10` 也可能是别的 VPN）。
 */
export function DevicesSettings() {
  const { client, view } = useHostConnection();
  const { supported: settingsSupported, settings, update } = useHostSettings();
  const supported =
    settingsSupported &&
    view.status === 'connected' &&
    hostSupports(view.hello.features, 'remote_devices');
  const remote = remoteOf(settings);
  const listenerSupported = supported && hostSupports(view.hello.features, 'remote_listener');
  const [devices, setDevices] = useState<Device[]>();
  const [status, setStatus] = useState<RemoteStatus>();
  const [notice, setNotice] = useState<Notice>();
  const [saving, setSaving] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [removing, setRemoving] = useState<Device>();
  const [granting, setGranting] = useState<{ device: Device; permission: Permission }>();

  const fail = (reason: unknown) =>
    setNotice({ tone: 'error', text: t('settings.devices.failed', { error: describe(reason) }) });

  const load = useCallback(async () => {
    if (!client || !supported) return;
    try {
      setDevices((await client.request('device.list', {})).devices);
      if (listenerSupported) setStatus(await client.request('remote.status', {}));
    } catch (reason) {
      setNotice({ tone: 'error', text: t('settings.devices.failed', { error: describe(reason) }) });
    }
  }, [client, supported, listenerSupported]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!client || !supported) return;
    return client.onRemoteDevicesChanged((change) => {
      if (change === undefined) void load();
      else if (change.kind === 'devices') setDevices(change.devices);
      else if (change.kind === 'listener') setStatus(change.status);
    });
  }, [client, supported, load]);

  if (!supported) {
    return <NoticeBanner notice={{ tone: 'info', text: t('settings.devices.unsupported') }} />;
  }

  const saveRemote = async (next: RemoteSettings) => {
    setSaving(true);
    setNotice(undefined);
    try {
      await update({ remote: next });
    } catch (reason) {
      fail(reason);
    } finally {
      setSaving(false);
    }
  };

  const setPermissions = async (device: Device, permissions: Permission[]) => {
    if (!client) return;
    setNotice(undefined);
    try {
      await client.request('device.update', { id: device.id, permissions });
    } catch (reason) {
      fail(reason);
    }
  };

  const toggle = (device: Device, permission: Permission, granted: boolean) => {
    if (granted && RISKY_DEVICE_PERMISSIONS.has(permission)) {
      setGranting({ device, permission });
      return;
    }
    void setPermissions(device, togglePermission(device.permissions, permission, granted));
  };

  const listed = devices && visibleDevices(devices);

  return (
    <>
      {notice && (
        <div className="mb-3">
          <NoticeBanner notice={notice} />
        </div>
      )}
      <SettingsSection title={t('settings.devices.remote')} data-devices-remote>
        <div className={LIST_CARD}>
          <SettingsRow
            title={t('settings.devices.remote')}
            data-setting="remote-enabled"
            control={
              <Switch
                label={t('settings.devices.remote')}
                checked={remote.enabled}
                disabled={saving}
                onChange={(enabled) => void saveRemote({ ...remote, enabled })}
              />
            }
          />
          {(['lan', 'tailscale'] as const).map((key) => {
            const label = t(key === 'lan' ? 'settings.devices.lan' : 'settings.devices.tailscale');
            const listed = status?.interfaces.filter((entry) => entry.kind === key) ?? [];
            return (
              <div key={key}>
                <SettingsRow
                  title={label}
                  description={
                    !listenerSupported
                      ? t('settings.devices.unavailable')
                      : listed.length === 0
                        ? t(
                            key === 'lan'
                              ? 'settings.devices.noLan'
                              : 'settings.devices.noTailscale',
                          )
                        : undefined
                  }
                  data-setting={`remote-${key}`}
                  control={
                    <Switch
                      label={label}
                      checked={remote.interfaces[key]}
                      disabled={!listenerSupported || saving}
                      onChange={(enabled) =>
                        void saveRemote(
                          key === 'lan'
                            ? setLan(remote, enabled, status?.interfaces ?? [])
                            : {
                                ...remote,
                                interfaces: { ...remote.interfaces, tailscale: enabled },
                              },
                        )
                      }
                    />
                  }
                />
                {listenerSupported &&
                  listed.map((entry) => (
                    <InterfaceRow
                      key={`${entry.name}/${entry.family}`}
                      entry={entry}
                      magicDnsName={key === 'tailscale' ? status?.magicDnsName : undefined}
                      checkable={key === 'lan' && remote.interfaces.lan}
                      disabled={saving}
                      onToggle={(checked) =>
                        void saveRemote(
                          toggleLanInterface(remote, entry, checked, status?.interfaces ?? []),
                        )
                      }
                    />
                  ))}
              </div>
            );
          })}
          {listenerSupported && (
            <PortRow
              port={remote.port}
              error={status?.error}
              disabled={saving}
              onSave={(port) => {
                const { port: _previous, ...rest } = remote;
                return saveRemote({ ...rest, ...(port !== undefined && { port }) });
              }}
            />
          )}
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.devices.relay')} data-devices-relay>
        <div className={LIST_CARD}>
          <SettingsRow
            title={t('settings.devices.relay')}
            description={t('settings.devices.relayNote')}
            data-setting="remote-relay"
            control={
              <Switch
                label={t('settings.devices.relay')}
                checked={remote.relay.enabled}
                disabled={saving}
                onChange={(enabled) =>
                  void saveRemote({ ...remote, relay: { ...remote.relay, enabled } })
                }
              />
            }
          />
          <RelayUrlRow
            url={remote.relay.url}
            disabled={saving}
            onSave={(url) =>
              saveRemote({
                ...remote,
                relay: { enabled: remote.relay.enabled, ...(url !== undefined && { url }) },
              })
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.devices.list')}
        data-devices-list
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={!remote.enabled}
            onClick={() => setPairing(true)}
            data-action="add-device"
          >
            <Smartphone />
            {t('settings.devices.add')}
          </Button>
        }
      >
        {listed === undefined ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : listed.length === 0 ? (
          <EmptyList>{t('settings.devices.empty')}</EmptyList>
        ) : (
          <ul className={LIST_CARD}>
            {listed.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                onToggle={(permission, granted) => toggle(device, permission, granted)}
                onRemove={() => setRemoving(device)}
              />
            ))}
          </ul>
        )}
      </SettingsSection>

      {pairing && (
        <PairingDialog
          onClose={(paired) => {
            setPairing(false);
            if (paired) {
              setNotice({
                tone: 'success',
                text: t('settings.devices.paired', { name: paired.name }),
              });
            }
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={t('settings.devices.removeTitle', { name: removing?.name ?? '' })}
        confirmLabel={t('settings.devices.remove')}
        onConfirm={async () => {
          if (!client || !removing) return;
          await client.request('device.revoke', { id: removing.id });
        }}
        failure={(error) => t('settings.devices.failed', { error })}
      >
        {t('settings.devices.removeBody')}
      </ConfirmDialog>
      <ConfirmDialog
        open={granting !== undefined}
        onOpenChange={(open) => !open && setGranting(undefined)}
        title={t('settings.devices.grantTitle', {
          permission: granting ? t(PERMISSION_LABEL[granting.permission]) : '',
          name: granting?.device.name ?? '',
        })}
        confirmLabel={t('settings.devices.grant')}
        onConfirm={async () => {
          if (!client || !granting) return;
          const { device, permission } = granting;
          await client.request('device.update', {
            id: device.id,
            permissions: togglePermission(device.permissions, permission, true),
          });
        }}
        failure={(error) => t('settings.devices.failed', { error })}
      >
        {granting && t(RISK_BODY[granting.permission] ?? 'settings.devices.grantBody.policy')}
      </ConfirmDialog>
    </>
  );
}

/** 一块网卡：名称与地址族、地址（在监听的标出来）；局域网网卡可以勾选，Tailscale 的只列出来确认。 */
function InterfaceRow({
  entry,
  magicDnsName,
  checkable,
  disabled,
  onToggle,
}: {
  entry: RemoteInterface;
  magicDnsName: string | undefined;
  checkable: boolean;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const addresses = [...entry.addresses, ...(magicDnsName !== undefined ? [magicDnsName] : [])];
  return (
    <div
      className="flex min-h-10 items-center gap-2.5 py-2 pr-4 pl-8 text-sm"
      data-interface={`${entry.name}/${entry.family}`}
    >
      {checkable && (
        <Checkbox
          size="sm"
          aria-label={interfaceLabel(entry)}
          checked={entry.selected}
          disabled={disabled}
          onCheckedChange={(checked) => onToggle(checked)}
        />
      )}
      <span className="shrink-0 font-medium">{interfaceLabel(entry)}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {addresses.join(', ')}
      </span>
      {entry.listening.length > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground" data-listening>
          {t('settings.devices.listening')}
        </span>
      )}
    </div>
  );
}

function PortRow({
  port,
  error,
  disabled,
  onSave,
}: {
  port: number | undefined;
  error: RemoteStatus['error'];
  disabled: boolean;
  onSave: (port: number | undefined) => Promise<void>;
}) {
  const [draft, setDraft] = useState(port === undefined ? '' : String(port));
  useEffect(() => setDraft(port === undefined ? '' : String(port)), [port]);
  const parsed = parsePort(draft);
  const commit = () => {
    if (parsed === undefined || parsed.port === port) return;
    void onSave(parsed.port);
  };
  const description =
    parsed === undefined
      ? t('settings.devices.portInvalid')
      : error?.reason === 'port_in_use'
        ? t('settings.devices.portInUse', { port: port ?? REMOTE_DEFAULT_PORT })
        : error !== undefined
          ? t('settings.devices.bindFailed', { error: error.message })
          : t('settings.devices.firewallNote');
  return (
    <SettingsRow
      title={t('settings.devices.port')}
      description={description}
      data-setting="remote-port"
      control={
        <Input
          className="w-28"
          value={draft}
          disabled={disabled}
          inputMode="numeric"
          placeholder={String(REMOTE_DEFAULT_PORT)}
          aria-label={t('settings.devices.port')}
          aria-invalid={parsed === undefined}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === 'Enter' && commit()}
        />
      }
    />
  );
}

function RelayUrlRow({
  url,
  disabled,
  onSave,
}: {
  url: string | undefined;
  disabled: boolean;
  onSave: (url: string | undefined) => Promise<void>;
}) {
  const [draft, setDraft] = useState(url ?? '');
  useEffect(() => setDraft(url ?? ''), [url]);
  const parsed = parseRelayUrl(draft);
  const commit = () => {
    if (parsed === undefined || parsed.url === url) return;
    void onSave(parsed.url);
  };
  return (
    <SettingsRow
      title={t('settings.devices.relayUrl')}
      description={parsed === undefined ? t('settings.devices.relayUrlInvalid') : undefined}
      data-setting="remote-relay-url"
      control={
        <Input
          className="w-64"
          value={draft}
          disabled={disabled}
          placeholder={t('settings.devices.relayDefault')}
          aria-label={t('settings.devices.relayUrl')}
          aria-invalid={parsed === undefined}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === 'Enter' && commit()}
        />
      }
    />
  );
}

function DeviceRow({
  device,
  onToggle,
  onRemove,
}: {
  device: Device;
  onToggle: (permission: Permission, granted: boolean) => void;
  onRemove: () => void;
}) {
  const granted = new Set(device.permissions);
  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-2.5" data-device={device.id}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{device.name}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {t(PLATFORM_LABEL[device.platform])} ·{' '}
          {t('settings.devices.lastSeen', {
            time: formatRelativeTime(device.lastSeenAt, Date.now()),
          })}
        </div>
      </div>
      <Popover>
        <PopoverTrigger
          render={<Button size="sm" variant="ghost" data-action="device-permissions" />}
        >
          {t('settings.devices.permissions', { count: device.permissions.length })}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 gap-1 p-1.5">
          {DEVICE_PERMISSION_ORDER.map((permission) => (
            <label
              key={permission}
              className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 text-sm hover:bg-muted"
              data-permission={permission}
            >
              <Checkbox
                size="sm"
                checked={granted.has(permission)}
                onCheckedChange={(checked) => onToggle(permission, checked)}
              />
              {t(PERMISSION_LABEL[permission])}
            </label>
          ))}
        </PopoverContent>
      </Popover>
      <IconButton
        label={t('settings.devices.remove')}
        onClick={onRemove}
        data-action="remove-device"
      >
        <Trash2 />
      </IconButton>
    </li>
  );
}
