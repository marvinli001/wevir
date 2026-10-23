import {
  DEFAULT_REMOTE_SETTINGS,
  DEVICE_ASSIGNABLE_PERMISSIONS,
  type Device,
  type PairingEndReason,
  type PairingOffer,
  type PairingRequest,
  type Permission,
  REMOTE_PORT_MIN,
  RelayUrlSchema,
  type RemoteInterface,
  type RemoteInterfaceRef,
  type RemoteSettings,
  type RemoteStatus,
  WEB_DEVICE_IDLE_DAYS_DEFAULT,
  WebClientUrlSchema,
  webDeviceIdleDays,
} from '@wevir/protocol';
import type { PlainMessageKey } from '@/i18n';

/** Host 设置里的 `remote`；省略时全关。 */
export function remoteOf(settings: { remote?: RemoteSettings }): RemoteSettings {
  return settings.remote ?? DEFAULT_REMOTE_SETTINGS;
}

/** 推送网关的状态（0.112.0 的 `remote.status.push`）的说明；正常、还没发过或旧 Host 时 undefined。 */
export function pushStatusKey(push: RemoteStatus['push']): PlainMessageKey | undefined {
  if (push?.state !== 'unavailable') return undefined;
  switch (push.error?.reason) {
    case 'rejected':
      return 'settings.devices.pushRejected';
    case 'rate_limited':
      return 'settings.devices.pushRateLimited';
    default:
      return 'settings.devices.pushUnreachable';
  }
}

/** 设置 → 设备 页面上能给设备的权限，按这个顺序列出。 */
export const DEVICE_PERMISSION_ORDER: readonly Permission[] = DEVICE_ASSIGNABLE_PERMISSIONS;

/** 权限的名称。 */
export const PERMISSION_LABEL: Record<Permission, PlainMessageKey> = {
  'host.manage': 'settings.devices.permission.hostManage',
  'session.read': 'settings.devices.permission.sessionRead',
  'session.write': 'settings.devices.permission.sessionWrite',
  'workspace.read': 'settings.devices.permission.workspaceRead',
  'workspace.write': 'settings.devices.permission.workspaceWrite',
  'provider.read': 'settings.devices.permission.providerRead',
  'provider.write': 'settings.devices.permission.providerWrite',
  'terminal.write': 'settings.devices.permission.terminalWrite',
  'policy.write': 'settings.devices.permission.policyWrite',
};

export const PLATFORM_LABEL: Record<Device['platform'], PlainMessageKey> = {
  ios: 'settings.devices.platform.ios',
  android: 'settings.devices.platform.android',
  macos: 'settings.devices.platform.macos',
  windows: 'settings.devices.platform.windows',
  linux: 'settings.devices.platform.linux',
  other: 'settings.devices.platform.other',
  web: 'settings.devices.platform.web',
};

/** 加上时要二次确认的权限：在电脑上执行命令、改审批规则与护栏、开完全访问。 */
export const RISKY_DEVICE_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'terminal.write',
  'policy.write',
]);

/** 勾上或去掉一项权限后的整组权限（按 `DEVICE_PERMISSION_ORDER` 排）。 */
export function togglePermission(
  current: readonly string[],
  permission: Permission,
  granted: boolean,
): Permission[] {
  const next = new Set(current);
  if (granted) next.add(permission);
  else next.delete(permission);
  return DEVICE_PERMISSION_ORDER.filter((p) => next.has(p));
}

/** 列表里显示的设备：已移除的不显示，最近在线的在前。 */
export function visibleDevices(devices: readonly Device[]): Device[] {
  return devices
    .filter((device) => device.status === 'active')
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

// ── 中继（0.110.0；0.117.0 起三态：关 / Wevir 官方中继 / 自建地址）────────────

/** 中继地址框的占位：只是示例。 */
export const RELAY_URL_PLACEHOLDER = 'wss://relay.example.com';

/** 中继地址框里的内容：空串是没填（省略 `url`），不合法时返回 undefined。 */
export function parseRelayUrl(input: string): { url?: string } | undefined {
  const value = input.trim();
  if (value === '') return {};
  return RelayUrlSchema.safeParse(value).success ? { url: value } : undefined;
}

/** 中继下拉里的选项。 */
export type RelayChoice = 'off' | 'official' | 'custom';

/**
 * 下拉显示的选项：关着是关；选了官方是官方；选了自建（`mode: 'custom'`）或旧设置开着且填了地址是自建，自建还没填地址时 Host 当作关、
 * 这里仍显示自建与空的地址框；旧设置“开着、没填地址”（没有 `mode`）显示为关。
 */
export function relayChoice(remote: RemoteSettings): RelayChoice {
  const { relay } = remote;
  if (!relay.enabled) return 'off';
  if (relay.mode === 'official') return 'official';
  if (relay.mode === 'custom' || relay.url !== undefined) return 'custom';
  return 'off';
}

/** 换中继的选项。自建的地址一直留着，换回自建时接着用。 */
export function setRelayChoice(remote: RemoteSettings, choice: RelayChoice): RemoteSettings {
  const { relay } = remote;
  if (choice === 'off') return { ...remote, relay: { ...relay, enabled: false } };
  return { ...remote, relay: { ...relay, enabled: true, mode: choice } };
}

/**
 * 改自建中继的地址；选项不变（自建时清空地址等于暂时不连）。显示为关的（包括旧设置“开着、没填地址”）填上地址后仍是关，要用户
 * 自己选自建。
 */
export function setRelayUrl(remote: RemoteSettings, url: string | undefined): RemoteSettings {
  const { url: _previous, ...relay } = remote.relay;
  const enabled = relayChoice(remote) !== 'off' && relay.enabled;
  return { ...remote, relay: { ...relay, enabled, ...(url !== undefined && { url }) } };
}

// ── 网页设备（0.117.0）───────────────────────────────────────────────

/** 网页客户端地址框的内容：空串是官方地址（省略 `web.url`），不合法时返回 undefined。末尾的 `/` 去掉。 */
export function parseWebClientUrl(input: string): { url?: string } | undefined {
  const value = input.trim().replace(/\/+$/, '');
  if (value === '') return {};
  return WebClientUrlSchema.safeParse(value).success ? { url: value } : undefined;
}

export function setWebClientUrl(remote: RemoteSettings, url: string | undefined): RemoteSettings {
  const { url: _previous, ...web } = remote.web ?? {};
  return { ...remote, web: { ...web, ...(url !== undefined && { url }) } };
}

/** 闲置自动移除的选项（天；0 是从不）。设置里存着别的天数（经 API 改的）时也列出来。 */
export function idleDayOptions(remote: RemoteSettings): number[] {
  const presets = [7, WEB_DEVICE_IDLE_DAYS_DEFAULT, 90, 365, 0];
  const current = webDeviceIdleDays(remote);
  return presets.includes(current) ? presets : [...presets.slice(0, -1), current, 0];
}

export function setWebIdleDays(remote: RemoteSettings, idleDays: number): RemoteSettings {
  return { ...remote, web: { ...remote.web, idleDays } };
}

/**
 * “添加网页设备”前的中继：网页只能经中继连，中继关着时先让用户选官方中继或填自建地址。`custom` 的地址不合法或没填时返回
 * undefined（继续按钮不可用）。
 */
export function relayForWeb(
  remote: RemoteSettings,
  choice: Exclude<RelayChoice, 'off'>,
  urlInput: string,
): RemoteSettings | undefined {
  if (choice === 'official') return setRelayChoice(remote, 'official');
  const parsed = parseRelayUrl(urlInput);
  if (parsed?.url === undefined) return undefined;
  return setRelayChoice(setRelayUrl(remote, parsed.url), 'custom');
}

/** 中继一行的说明：连接状态与上次失败的原因（0.111.0 起分得清地址连不上、证书不对、那里不是中继、被中继拒绝）。 */
export type RelayStatusText =
  | { key: PlainMessageKey }
  | { key: 'settings.devices.relayRejectedCode'; code: string };

/** 中继开着时的连接状态（`remote.status.relay`）；关着或旧 Host 时 undefined。 */
export function relayStatusText(relay: RemoteStatus['relay']): RelayStatusText | undefined {
  if (relay === undefined) return undefined;
  if (relay.state === 'connected') return { key: 'settings.devices.relayConnected' };
  const error = relay.error;
  switch (error?.reason) {
    case 'unreachable':
      return {
        key: error.certificate
          ? 'settings.devices.relayCertificate'
          : 'settings.devices.relayUnreachable',
      };
    case 'rejected':
      // 429 与 503 是中继在限速或满了；别的状态码说明那个地址上不是中继（路径不对、普通网站）。
      if (error.httpStatus !== undefined && error.httpStatus !== 429 && error.httpStatus !== 503)
        return { key: 'settings.devices.relayNotRelay' };
      if (error.httpStatus !== undefined)
        return { key: 'settings.devices.relayRejectedCode', code: `HTTP ${error.httpStatus}` };
      if (error.closeCode !== undefined)
        return { key: 'settings.devices.relayRejectedCode', code: String(error.closeCode) };
      return { key: 'settings.devices.relayRejected' };
    case 'replaced':
      return { key: 'settings.devices.relayReplaced' };
    default:
      return { key: 'settings.devices.relayConnecting' };
  }
}

// ── 直连的网卡（0.109.0）────────────────────────────────────────────

/** 设置页列出的一块网卡：`en0 · IPv4`。 */
export function interfaceLabel(entry: Pick<RemoteInterface, 'name' | 'family'>): string {
  return `${entry.name} · ${entry.family}`;
}

/** 打开或关掉局域网监听。第一次打开时把当前认出的局域网网卡都记成勾选，之后新出现的网卡要手动勾。 */
export function setLan(
  remote: RemoteSettings,
  enabled: boolean,
  interfaces: readonly RemoteInterface[],
): RemoteSettings {
  const lanInterfaces =
    remote.interfaces.lanInterfaces ??
    interfaces
      .filter((entry) => entry.kind === 'lan')
      .map(({ name, family }) => ({ name, family }));
  return { ...remote, interfaces: { ...remote.interfaces, lan: enabled, lanInterfaces } };
}

/** 勾上或去掉一块局域网网卡（按网卡名 + 地址族记）。没有 `lanInterfaces` 时从当前认出的全部局域网网卡开始。 */
export function toggleLanInterface(
  remote: RemoteSettings,
  target: RemoteInterfaceRef,
  checked: boolean,
  interfaces: readonly RemoteInterface[],
): RemoteSettings {
  const current: RemoteInterfaceRef[] =
    remote.interfaces.lanInterfaces ??
    interfaces
      .filter((entry) => entry.kind === 'lan')
      .map(({ name, family }) => ({ name, family }));
  const rest = current.filter((ref) => ref.name !== target.name || ref.family !== target.family);
  const lanInterfaces = checked ? [...rest, { name: target.name, family: target.family }] : rest;
  return { ...remote, interfaces: { ...remote.interfaces, lanInterfaces } };
}

/** 端口输入：空串是默认端口（省略 `port`），不合法时返回 undefined。 */
export function parsePort(input: string): { port?: number } | undefined {
  const value = input.trim();
  if (value === '') return {};
  if (!/^\d{1,5}$/.test(value)) return undefined;
  const port = Number(value);
  return port >= REMOTE_PORT_MIN && port <= 65_535 ? { port } : undefined;
}

/** 倒计时 `m:ss`，不到 0 按 0。 */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// ── “添加手机”弹窗 ─────────────────────────────────────────────────

/**
 * 弹窗的状态：`starting` 正在开窗口；`open` 显示二维码与短码（有请求时带上它，等用户允许或拒绝）；`ended` 窗口结束了（到期、失败、
 * 拒绝等），可以重新生成；`error` 开窗口失败。配对成功时弹窗直接关掉。
 */
export type PairingDialogState =
  | { phase: 'starting' }
  | { phase: 'open'; offer: PairingOffer; request?: PairingRequest }
  | { phase: 'ended'; pairingId: string; reason: Exclude<PairingEndReason, 'paired'> }
  | { phase: 'paired' }
  | { phase: 'error'; error: string };

export type PairingDialogAction =
  | { type: 'start' }
  | { type: 'offer'; offer: PairingOffer }
  | { type: 'failed'; error: string }
  | { type: 'request'; request: PairingRequest }
  | { type: 'ended'; pairingId: string; reason: PairingEndReason }
  /** 断线重连：期间的请求与结束都可能错过，当作窗口已失效。 */
  | { type: 'reconnected' };

/** 别的窗口的请求与结束（比如另一个客户端开的）不影响这个弹窗。 */
export function pairingDialogReducer(
  state: PairingDialogState,
  action: PairingDialogAction,
): PairingDialogState {
  switch (action.type) {
    case 'start':
      return { phase: 'starting' };
    case 'offer':
      return state.phase === 'starting' ? { phase: 'open', offer: action.offer } : state;
    case 'failed':
      return state.phase === 'starting' ? { phase: 'error', error: action.error } : state;
    case 'request':
      return state.phase === 'open' && state.offer.pairingId === action.request.pairingId
        ? { ...state, request: action.request }
        : state;
    case 'ended':
      if (state.phase !== 'open' || state.offer.pairingId !== action.pairingId) return state;
      return action.reason === 'paired'
        ? { phase: 'paired' }
        : { phase: 'ended', pairingId: action.pairingId, reason: action.reason };
    case 'reconnected':
      return state.phase === 'open'
        ? { phase: 'ended', pairingId: state.offer.pairingId, reason: 'cancelled' }
        : state;
  }
}
