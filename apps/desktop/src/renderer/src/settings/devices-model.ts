import {
  DEFAULT_REMOTE_SETTINGS,
  DEVICE_ASSIGNABLE_PERMISSIONS,
  type Device,
  type PairingEndReason,
  type PairingOffer,
  type PairingRequest,
  type Permission,
  RelayUrlSchema,
  type RemoteSettings,
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

/** 自定义中继地址：空串是用官方实例（省略 `url`），不合法时返回 undefined。 */
export function parseRelayUrl(input: string): { url?: string } | undefined {
  const value = input.trim();
  if (value === '') return {};
  return RelayUrlSchema.safeParse(value).success ? { url: value } : undefined;
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
