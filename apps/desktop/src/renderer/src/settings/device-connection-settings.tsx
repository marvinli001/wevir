import {
  REMOTE_DEFAULT_PORT,
  type RemoteInterface,
  type RemoteSettings,
  type RemoteStatus,
} from '@wevir/protocol';
import { useEffect, useState } from 'react';
import { Collapse } from '@/components/collapse';
import { Switch } from '@/components/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { t } from '@/i18n';
import {
  interfaceLabel,
  parsePort,
  parseRelayUrl,
  RELAY_URL_PLACEHOLDER,
  type RelayChoice,
  type RelayStatusText,
  relayChoice,
  relayStatusText,
  setLan,
  setRelayChoice,
  setRelayUrl,
  toggleLanInterface,
} from './devices-model';
import { LIST_CARD, SettingsRow, SettingsSection } from './settings-ui';

export function ConnectionMethods({
  remote,
  status,
  listenerSupported,
  webSupported,
  saving,
  pairing,
  saveRemote,
}: {
  remote: RemoteSettings;
  status?: RemoteStatus;
  listenerSupported: boolean;
  webSupported: boolean;
  saving: boolean;
  pairing: boolean;
  saveRemote: (next: RemoteSettings) => Promise<void>;
}) {
  return (
    <>
      <SettingsSection data-devices-network className="mb-3">
        <div className={LIST_CARD}>
          {(['lan', 'tailscale'] as const).map((key) => {
            const label = t(key === 'lan' ? 'settings.devices.lan' : 'settings.devices.tailscale');
            const listed = status?.interfaces.filter((entry) => entry.kind === key) ?? [];
            if (pairing && key === 'tailscale' && !remote.interfaces.tailscale && !listed.length)
              return null;
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
                  (!pairing || remote.interfaces[key]) &&
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
          {listenerSupported && (!pairing || status?.error) && (
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

      <SettingsSection data-devices-relay className="mb-0">
        <div className={LIST_CARD}>
          <SettingsRow
            title={t('settings.devices.relay')}
            description={
              relayText(relayStatusText(status?.relay)) ?? t('settings.devices.relayNote')
            }
            data-setting="remote-relay"
            data-relay-state={status?.relay?.state}
            control={
              webSupported ? (
                <Select<RelayChoice>
                  className="w-44"
                  aria-label={t('settings.devices.relay')}
                  value={relayChoice(remote)}
                  disabled={saving}
                  onValueChange={(choice) => void saveRemote(setRelayChoice(remote, choice))}
                  options={[
                    { value: 'off', label: t('settings.devices.relayOff') },
                    { value: 'official', label: t('settings.devices.relayOfficial') },
                    { value: 'custom', label: t('settings.devices.relayCustom') },
                  ]}
                />
              ) : (
                // 旧 Host（没有 `remote_web`）不认识官方中继：只有开关与自建地址。
                <Switch
                  label={t('settings.devices.relay')}
                  checked={relayChoice(remote) === 'custom' && remote.relay.url !== undefined}
                  disabled={saving || remote.relay.url === undefined}
                  onChange={(enabled) =>
                    void saveRemote(setRelayChoice(remote, enabled ? 'custom' : 'off'))
                  }
                />
              )
            }
          />
          <Collapse open={!webSupported || relayChoice(remote) === 'custom'} motion="height">
            <RelayUrlRow
              url={remote.relay.url}
              disabled={saving}
              onSave={(url) => saveRemote(setRelayUrl(remote, url))}
            />
          </Collapse>
        </div>
      </SettingsSection>
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
      : (listenerError(error, port) ?? t('settings.devices.firewallNote'));
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

export function listenerError(
  error: RemoteStatus['error'],
  port: number | undefined,
): string | undefined {
  if (!error) return undefined;
  return error.reason === 'port_in_use'
    ? t('settings.devices.portInUse', { port: port ?? REMOTE_DEFAULT_PORT })
    : t('settings.devices.bindFailed', { error: error.message });
}

export function relayText(text: RelayStatusText | undefined): string | undefined {
  if (text === undefined) return undefined;
  return 'code' in text ? t(text.key, { code: text.code }) : t(text.key);
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
          placeholder={RELAY_URL_PLACEHOLDER}
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
