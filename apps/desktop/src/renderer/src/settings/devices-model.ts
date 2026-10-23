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
  relayConfigured,
} from '@wevir/protocol';
import type { PlainMessageKey } from '@/i18n';

/** Host 设置里的 `remote`；省略时全关。 */
export function remoteOf(settings: { remote?: RemoteSettings }): RemoteSettings {
  return settings.remote ?? DEFAULT_REMOTE_SETTINGS;
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

// ── 中继（0.110.0；0.111.0 起必须填自建的地址）──────────────────────────

/** 中继地址框的占位：只是示例，没有官方中继。 */
export const RELAY_URL_PLACEHOLDER = 'wss://relay.example.com';

/** 中继地址框里的内容：空串是没填（省略 `url`），不合法时返回 undefined。 */
export function parseRelayUrl(input: string): { url?: string } | undefined {
  const value = input.trim();
  if (value === '') return {};
  return RelayUrlSchema.safeParse(value).success ? { url: value } : undefined;
}

/** 中继开关显示为开：开着且填了地址。旧设置“开着、没填地址”Host 当作关，这里也显示为关。 */
export function relayOn(remote: RemoteSettings): boolean {
  return relayConfigured(remote) !== undefined;
}

/** 打开或关掉中继；没填地址时打不开（开关不可用）。 */
export function setRelayEnabled(remote: RemoteSettings, enabled: boolean): RemoteSettings {
  if (enabled && remote.relay.url === undefined) return remote;
  return { ...remote, relay: { ...remote.relay, enabled } };
}

/**
 * 改中继地址。清空地址时中继随之关掉；开着的换了地址仍开着；关着的（包括旧设置“开着、没填地址”）填上地址后仍是关，要用户自己
 * 打开。
 */
export function setRelayUrl(remote: RemoteSettings, url: string | undefined): RemoteSettings {
  const enabled = url !== undefined && relayOn(remote);
  return { ...remote, relay: { enabled, ...(url !== undefined && { url }) } };
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
