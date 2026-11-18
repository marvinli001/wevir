import { hostSupports } from '@wevir/client-sdk';
import {
  type Device,
  type MethodParams,
  type Permission,
  type RemoteSettings,
  type RemoteStatus,
  relayConfigured,
  WEB_CLIENT_DEFAULT_URL,
  webClientUrl,
  webDeviceIdleDays,
} from '@wevir/protocol';
import { cn } from 'cn';
import { Bell, ChevronRight, Globe, MonitorSmartphone, Network, Trash2 } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { AnimatedRows } from '@/components/animated-rows';
import { Collapse } from '@/components/collapse';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useHostSettings } from '@/data/host-settings';
import { describe, useHostConnection } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { formatRelativeTime } from '@/session/subagent-model';
import { ConnectionMethods, listenerError, relayText } from './device-connection-settings';
import {
  DEVICE_PERMISSION_ORDER,
  idleDayOptions,
  PERMISSION_LABEL,
  PLATFORM_LABEL,
  parseWebClientUrl,
  pushStatusKey,
  RISKY_DEVICE_PERMISSIONS,
  relayChoice,
  relayStatusText,
  remoteAccessState,
  remoteOf,
  setWebClientUrl,
  setWebIdleDays,
  togglePermission,
  visibleDevices,
} from './devices-model';
import { PairingDialog, PlatformIcon, WebRelayDialog } from './pairing-dialog';
import { RemoteAccessCard } from './remote-access-card';
import {
  LIST_CARD,
  type Notice,
  NoticeBanner,
  SettingsPlaceholder,
  SettingsRow,
  SettingsSection,
} from './settings-ui';

/** 加上前要确认的那一项的后果。 */
const RISK_BODY: Partial<Record<Permission, PlainMessageKey>> = {
  'terminal.write': 'settings.devices.grantBody.terminal',
  'policy.write': 'settings.devices.grantBody.policy',
  'git.publish': 'settings.devices.gitPublishScope',
};

type DevicePanel = 'network' | 'phoneNetwork' | 'push' | 'browser' | 'phone' | 'web' | 'relay';

export function DevicesSettings() {
  const { client, view } = useHostConnection();
  const [notice, setNotice] = useState<Notice>();
  const fail = useCallback(
    (reason: unknown) =>
      setNotice({ tone: 'error', text: t('settings.devices.failed', { error: describe(reason) }) }),
    [],
  );
  const {
    supported: settingsSupported,
    loaded,
    editable,
    settings,
    update,
  } = useHostSettings(fail);
  const supported =
    settingsSupported &&
    view.status === 'connected' &&
    hostSupports(view.hello.features, 'remote_devices');
  const remote = remoteOf(settings);
  const listenerSupported = supported && hostSupports(view.hello.features, 'remote_listener');
  const pushSupported = supported && hostSupports(view.hello.features, 'remote_push');
  const channelPushSupported = supported && hostSupports(view.hello.features, 'channel_push');
  const webSupported = supported && hostSupports(view.hello.features, 'remote_web');
  const [devices, setDevices] = useState<Device[]>();
  const [status, setStatus] = useState<RemoteStatus>();
  const [saving, setSaving] = useState(false);
  const [updatingDevice, setUpdatingDevice] = useState(false);
  const [panel, setPanel] = useState<DevicePanel>();
  const [expanded, setExpanded] = useState<Device['id']>();
  const [removing, setRemoving] = useState<Device>();
  const [granting, setGranting] = useState<{ device: Device; permission: Permission }>();

  const load = useCallback(async () => {
    if (!client || !supported || !editable) return;
    try {
      await Promise.all([
        client.request('device.list', {}).then(({ devices }) => setDevices(devices)),
        listenerSupported && client.request('remote.status', {}).then(setStatus),
      ]);
    } catch (reason) {
      fail(reason);
    }
  }, [client, supported, editable, listenerSupported, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!client || !supported || !editable) return;
    return client.onRemoteDevicesChanged((change) => {
      if (change === undefined) void load();
      else if (change.kind === 'devices') setDevices(change.devices);
      else if (change.kind === 'listener') setStatus(change.status);
    });
  }, [client, supported, editable, load]);

  if (!supported) {
    return <NoticeBanner notice={{ tone: 'info', text: t('settings.devices.unsupported') }} />;
  }

  if (!editable)
    return <NoticeBanner notice={{ tone: 'info', text: t('rpcError.DEVICE_FORBIDDEN') }} />;
  if (!loaded)
    return notice ? <NoticeBanner notice={notice} /> : <SettingsPlaceholder className="min-h-40" />;

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

  const updateDevice = async (patch: MethodParams<'device.update'>) => {
    if (!client) return;
    setUpdatingDevice(true);
    setNotice(undefined);
    try {
      await client.request('device.update', patch);
    } catch (reason) {
      fail(reason);
    } finally {
      setUpdatingDevice(false);
    }
  };

  const toggle = (device: Device, permission: Permission, granted: boolean) => {
    if (granted && RISKY_DEVICE_PERMISSIONS.has(permission)) {
      setGranting({ device, permission });
      return;
    }
    void updateDevice({
      id: device.id,
      permissions: togglePermission(device.permissions, permission, granted),
    });
  };

  const listed = devices && visibleDevices(devices);
  const pushStatus = remote.push.enabled ? pushStatusKey(status?.push) : undefined;

  const access = remoteAccessState(remote.enabled, listenerSupported, status);
  const canPairPhone = access === 'enabled' || access === 'ready' || access === 'connected';
  const networkOpen = panel === 'network' || panel === 'phoneNetwork';
  const optionsOpen = networkOpen || panel === 'push' || panel === 'browser';
  const optionsTitle = t(
    panel === 'push'
      ? 'settings.pairing.push'
      : panel === 'browser'
        ? 'settings.devices.web'
        : 'settings.devices.network',
  );
  const networkSummary = [
    remote.interfaces.lan && t('settings.devices.lan'),
    remote.interfaces.tailscale && t('settings.devices.tailscale'),
    relayConfigured(remote) &&
      t(
        relayChoice(remote) === 'official'
          ? 'settings.devices.relayOfficial'
          : 'settings.devices.relay',
      ),
  ]
    .filter(Boolean)
    .join(' · ');
  const networkError =
    remote.enabled &&
    (listenerError(status?.error, remote.port) ??
      (status?.relay?.error && relayText(relayStatusText(status.relay))));

  return (
    <>
      <NoticeBanner notice={optionsOpen ? undefined : notice} className="mb-3" />
      <RemoteAccessCard
        state={access}
        connections={status?.connections ?? 0}
        saving={saving}
        onEnable={(enabled) => void saveRemote({ ...remote, enabled })}
        onPhone={() => setPanel(canPairPhone ? 'phone' : 'phoneNetwork')}
        onWeb={webSupported ? () => setPanel(relayConfigured(remote) ? 'web' : 'relay') : undefined}
      />

      <SettingsSection
        title={listed?.length === 0 ? undefined : t('settings.devices.list')}
        data-devices-list
        className="mb-7"
      >
        <AnimatedRows
          items={listed}
          keyOf={(device) => device.id}
          className={LIST_CARD}
          empty={
            listed === undefined ? (
              <SettingsPlaceholder className="min-h-[5.375rem]" />
            ) : (
              <p className="flex items-center gap-2.5 px-1 text-sm text-muted-foreground">
                <MonitorSmartphone aria-hidden className="size-4" />
                {t('settings.devices.empty')}
              </p>
            )
          }
        >
          {(device) => (
            <DeviceRow
              device={device}
              busy={updatingDevice}
              expanded={expanded === device.id}
              onExpand={() => setExpanded(expanded === device.id ? undefined : device.id)}
              pushSupported={pushSupported}
              gitWorkflow={
                view.status === 'connected' && hostSupports(view.hello.features, 'git_workflow')
              }
              onPush={(enabled) => void updateDevice({ id: device.id, push: { enabled } })}
              onToggle={(permission, granted) => toggle(device, permission, granted)}
              onRemove={() => setRemoving(device)}
            />
          )}
        </AnimatedRows>
      </SettingsSection>

      <SettingsSection title={t('settings.devices.preferences')}>
        <div className={LIST_CARD}>
          <OptionRow
            icon={<Network />}
            label={t('settings.devices.network')}
            value={networkError || networkSummary || t('settings.devices.unconfigured')}
            warning={!!networkError}
            onClick={() => setPanel('network')}
          />
          {pushSupported && (
            <OptionRow
              icon={<Bell />}
              label={t('settings.pairing.push')}
              value={
                pushStatus
                  ? t(pushStatus)
                  : t(remote.push.enabled ? 'settings.devices.on' : 'settings.devices.off')
              }
              warning={!!pushStatus}
              onClick={() => setPanel('push')}
            />
          )}
          {webSupported && (
            <OptionRow
              icon={<Globe />}
              label={t('settings.devices.web')}
              value={webClientUrl(remote)}
              onClick={() => setPanel('browser')}
            />
          )}
        </div>
      </SettingsSection>

      <Dialog open={optionsOpen} onOpenChange={(open) => !open && setPanel(undefined)}>
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-lg"
          data-device-options={panel}
        >
          <DialogHeader className="pr-7">
            <DialogTitle>{optionsTitle}</DialogTitle>
            {panel === 'phoneNetwork' && (
              <DialogDescription>{t('settings.devices.phoneNetwork')}</DialogDescription>
            )}
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto">
            <NoticeBanner notice={notice?.tone === 'error' ? notice : undefined} className="mb-2" />
            {networkOpen && (
              <ConnectionMethods
                remote={remote}
                status={status}
                listenerSupported={listenerSupported}
                webSupported={webSupported}
                saving={saving}
                pairing={panel === 'phoneNetwork'}
                saveRemote={saveRemote}
              />
            )}
            {panel === 'push' && pushSupported && (
              <SettingsSection data-devices-push>
                <div className={LIST_CARD}>
                  <SettingsRow
                    title={t('settings.devices.push')}
                    description={pushStatus && t(pushStatus)}
                    data-setting="remote-push"
                    data-push-state={status?.push?.state}
                    control={
                      <Switch
                        label={t('settings.devices.push')}
                        checked={remote.push.enabled}
                        disabled={saving}
                        onChange={(enabled) =>
                          void saveRemote({ ...remote, push: { ...remote.push, enabled } })
                        }
                      />
                    }
                  />
                  <Collapse open={remote.push.enabled} motion="height">
                    <div className="divide-y divide-border">
                      {(
                        [
                          ['needsAction', 'settings.devices.pushNeedsAction'],
                          ['completion', 'settings.devices.pushCompletion'],
                        ] as const
                      ).map(([key, label]) => (
                        <SettingsRow
                          key={key}
                          title={t(label)}
                          data-setting={`remote-push-${key}`}
                          control={
                            <Switch
                              label={t(label)}
                              checked={remote.push[key] !== false}
                              disabled={saving}
                              onChange={(enabled) =>
                                void saveRemote({
                                  ...remote,
                                  push: { ...remote.push, [key]: enabled },
                                })
                              }
                            />
                          }
                        />
                      ))}
                      {channelPushSupported && (
                        <SettingsRow
                          title={t('settings.devices.pushChannel')}
                          control={
                            <Switch
                              label={t('settings.devices.pushChannel')}
                              checked={remote.push.channel !== false}
                              disabled={saving}
                              onChange={(channel) =>
                                void saveRemote({ ...remote, push: { ...remote.push, channel } })
                              }
                            />
                          }
                        />
                      )}
                    </div>
                  </Collapse>
                </div>
              </SettingsSection>
            )}

            {panel === 'browser' && webSupported && (
              <SettingsSection data-devices-web>
                <div className={LIST_CARD}>
                  <WebUrlRow
                    url={remote.web?.url}
                    disabled={saving}
                    onSave={(url) => saveRemote(setWebClientUrl(remote, url))}
                  />
                  <SettingsRow
                    title={t('settings.devices.idle')}
                    data-setting="remote-web-idle"
                    control={
                      <Select
                        className="w-32"
                        aria-label={t('settings.devices.idle')}
                        value={String(webDeviceIdleDays(remote))}
                        disabled={saving}
                        onValueChange={(value) =>
                          void saveRemote(setWebIdleDays(remote, Number(value)))
                        }
                        options={idleDayOptions(remote).map((days) => ({
                          value: String(days),
                          label:
                            days === 0
                              ? t('settings.devices.idleNever')
                              : t('settings.devices.idleDays', { count: days }),
                        }))}
                      />
                    }
                  />
                </div>
              </SettingsSection>
            )}
          </div>
          {panel === 'phoneNetwork' && (
            <DialogFooter>
              <Button
                disabled={saving || !canPairPhone}
                onClick={() => setPanel('phone')}
                data-action="continue-phone-pairing"
              >
                {t('settings.pairing.continue')}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {panel === 'relay' && (
        <WebRelayDialog
          remote={remote}
          onCancel={() => setPanel(undefined)}
          onContinue={async (next) => {
            await update({ remote: next });
            setPanel((current) => (current === 'relay' ? 'web' : current));
          }}
        />
      )}
      {(panel === 'phone' || panel === 'web') && (
        <PairingDialog
          web={panel === 'web'}
          askPush={pushSupported && panel === 'phone'}
          onClose={(paired) => {
            setPanel(undefined);
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

function WebUrlRow({
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
  const parsed = parseWebClientUrl(draft);
  const commit = () => {
    if (parsed === undefined || parsed.url === url) return;
    void onSave(parsed.url);
  };
  return (
    <SettingsRow
      title={t('settings.devices.webUrl')}
      description={parsed === undefined ? t('settings.devices.webUrlInvalid') : undefined}
      data-setting="remote-web-url"
      control={
        <Input
          className="w-64"
          value={draft}
          disabled={disabled}
          placeholder={WEB_CLIENT_DEFAULT_URL}
          aria-label={t('settings.devices.webUrl')}
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

function OptionRow({
  icon,
  label,
  value,
  warning,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  warning?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onClick}
      className="flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-muted/50 focus-visible:focus-field"
    >
      <span aria-hidden className="shrink-0 text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-sm font-medium">{label}</span>
      <span
        className={cn(
          'max-w-[50%] truncate text-xs',
          warning ? 'text-foreground' : 'text-muted-foreground',
        )}
        title={value}
      >
        {value}
      </span>
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

function DeviceRow({
  device,
  busy,
  expanded,
  onExpand,
  pushSupported,
  gitWorkflow,
  onPush,
  onToggle,
  onRemove,
}: {
  device: Device;
  busy: boolean;
  expanded: boolean;
  onExpand: () => void;
  pushSupported: boolean;
  gitWorkflow: boolean;
  onPush: (enabled: boolean) => void;
  onToggle: (permission: Permission, granted: boolean) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const granted = new Set(device.permissions);
  const showPush = pushSupported && device.push !== undefined && device.platform !== 'web';
  return (
    <div data-device={device.id} className="@container">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={onExpand}
        data-action="device-permissions"
        className="flex min-h-16 w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:focus-field"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-foreground">
          <PlatformIcon platform={device.platform} className="size-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{device.name}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t(PLATFORM_LABEL[device.platform])} ·{' '}
            {t('settings.devices.lastSeen', {
              time: formatRelativeTime(device.lastSeenAt, Date.now()),
            })}
            {showPush && device.push?.enabled && !device.push.registered && (
              <> · {t('settings.devices.pushUnregistered')}</>
            )}
          </span>
        </span>
        <span className="hidden shrink-0 text-xs text-muted-foreground @xs:inline">
          {t('settings.devices.permissions', { count: device.permissions.length })}
        </span>
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
      </button>
      <Collapse open={expanded} id={id} motion="height">
        <div className="flex flex-col gap-3 border-t border-border bg-muted/25 p-4">
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-muted-foreground">
              {t('settings.section.permissions')}
            </legend>
            <div className="grid gap-x-3 @xs:grid-cols-2">
              {DEVICE_PERMISSION_ORDER.filter(
                (permission) => permission !== 'git.publish' || gitWorkflow,
              ).map((permission) => (
                <label
                  key={permission}
                  className="flex min-h-8 items-center gap-2 rounded-md px-1 text-sm hover:bg-muted"
                  data-permission={permission}
                >
                  <Checkbox
                    size="sm"
                    disabled={busy}
                    checked={granted.has(permission)}
                    onCheckedChange={(checked) => onToggle(permission, checked)}
                  />
                  {t(PERMISSION_LABEL[permission])}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            {showPush && device.push && (
              <div className="inline-flex items-center gap-2 text-sm">
                <Switch
                  label={t('settings.devices.devicePush', { name: device.name })}
                  disabled={busy}
                  checked={device.push.enabled}
                  onChange={onPush}
                  data-action="device-push"
                />
                {t('settings.pairing.push')}
              </div>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              disabled={busy}
              onClick={onRemove}
              data-action="remove-device"
            >
              <Trash2 data-icon="inline-start" />
              {t('settings.devices.remove')}
            </Button>
          </div>
        </div>
      </Collapse>
    </div>
  );
}
