import {
  DEFAULT_REMOTE_SETTINGS,
  type Device,
  type PairingOffer,
  type RemoteInterface,
} from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  formatCountdown,
  interfaceLabel,
  type PairingDialogState,
  pairingDialogReducer,
  parsePort,
  parseRelayUrl,
  remoteOf,
  setLan,
  toggleLanInterface,
  togglePermission,
  visibleDevices,
} from './devices-model';

const KEY = 'q0XrYwM1Xk1vH2C6uWqG5yQyq9b0mW0n8Sx3cG1fYQE';
const offer: PairingOffer = {
  pairingId: 'prg_1',
  uri: `wevir://pair?v=1&k=${KEY}&r=${KEY}&s=${KEY}`,
  shortCode: '7KQ2M9XD',
  expiresAt: '2026-10-22T08:05:00.000Z',
  hostPublicKey: KEY,
  routeId: KEY,
  candidates: [],
};
const request = {
  pairingId: 'prg_1',
  requestId: 'prq_1',
  name: 'iPhone',
  platform: 'ios',
  requestedAt: '2026-10-22T08:01:00.000Z',
} as const;

function device(id: string, lastSeenAt: string, status: Device['status'] = 'active'): Device {
  return {
    id: id as Device['id'],
    name: id,
    platform: 'ios',
    publicKey: KEY,
    permissions: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt,
    status,
  };
}

describe('设备页', () => {
  it('Host 设置里没有 remote 时按全关', () => {
    expect(remoteOf({})).toEqual(DEFAULT_REMOTE_SETTINGS);
    const on = { ...DEFAULT_REMOTE_SETTINGS, enabled: true };
    expect(remoteOf({ remote: on })).toBe(on);
  });

  it('勾选权限：按词表顺序、不重复', () => {
    expect(togglePermission(['session.read'], 'terminal.write', true)).toEqual([
      'session.read',
      'terminal.write',
    ]);
    expect(togglePermission(['terminal.write', 'session.read'], 'session.read', true)).toEqual([
      'session.read',
      'terminal.write',
    ]);
    expect(togglePermission(['session.read', 'policy.write'], 'policy.write', false)).toEqual([
      'session.read',
    ]);
  });

  it('列表：不显示已移除的，最近在线的在前', () => {
    const list = visibleDevices([
      device('old', '2026-10-01T00:00:00.000Z'),
      device('gone', '2026-10-22T00:00:00.000Z', 'revoked'),
      device('new', '2026-10-21T00:00:00.000Z'),
    ]);
    expect(list.map((d) => d.id)).toEqual(['new', 'old']);
  });

  it('中继地址：空是官方实例，只认 wss:// 与 ws://', () => {
    expect(parseRelayUrl('  ')).toEqual({});
    expect(parseRelayUrl(' wss://relay.example.com ')).toEqual({ url: 'wss://relay.example.com' });
    expect(parseRelayUrl('ws://10.0.0.2:8080')).toEqual({ url: 'ws://10.0.0.2:8080' });
    expect(parseRelayUrl('https://relay.example.com')).toBeUndefined();
    expect(parseRelayUrl('relay')).toBeUndefined();
  });

  it('倒计时', () => {
    expect(formatCountdown(300_000)).toBe('5:00');
    expect(formatCountdown(59_001)).toBe('1:00');
    expect(formatCountdown(9_000)).toBe('0:09');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('添加手机弹窗', () => {
  const open: PairingDialogState = { phase: 'open', offer };

  it('开窗口 → 显示 → 收到请求 → 配对成功', () => {
    let state = pairingDialogReducer({ phase: 'error', error: 'x' }, { type: 'start' });
    expect(state).toEqual({ phase: 'starting' });
    state = pairingDialogReducer(state, { type: 'offer', offer });
    expect(state).toEqual(open);
    state = pairingDialogReducer(state, { type: 'request', request });
    expect(state).toEqual({ ...open, request });
    state = pairingDialogReducer(state, {
      type: 'ended',
      pairingId: 'prg_1',
      reason: 'paired',
    });
    expect(state).toEqual({ phase: 'paired' });
  });

  it('到期、失败、拒绝都进 ended，可以重新生成', () => {
    for (const reason of ['expired', 'failed', 'denied', 'replaced', 'cancelled'] as const) {
      expect(pairingDialogReducer(open, { type: 'ended', pairingId: 'prg_1', reason })).toEqual({
        phase: 'ended',
        pairingId: 'prg_1',
        reason,
      });
    }
  });

  it('别的窗口的请求与结束不影响', () => {
    expect(
      pairingDialogReducer(open, { type: 'request', request: { ...request, pairingId: 'prg_2' } }),
    ).toBe(open);
    expect(
      pairingDialogReducer(open, { type: 'ended', pairingId: 'prg_2', reason: 'expired' }),
    ).toBe(open);
    expect(pairingDialogReducer({ phase: 'starting' }, { type: 'request', request })).toEqual({
      phase: 'starting',
    });
  });

  it('开窗口失败显示错误；断线重连后窗口当作失效', () => {
    expect(pairingDialogReducer({ phase: 'starting' }, { type: 'failed', error: 'boom' })).toEqual({
      phase: 'error',
      error: 'boom',
    });
    expect(pairingDialogReducer(open, { type: 'reconnected' })).toEqual({
      phase: 'ended',
      pairingId: 'prg_1',
      reason: 'cancelled',
    });
  });
});

describe('直连的网卡', () => {
  const interfaces: RemoteInterface[] = [
    {
      name: 'en0',
      family: 'IPv4',
      kind: 'lan',
      addresses: ['192.168.8.65'],
      selected: false,
      listening: [],
    },
    {
      name: 'en1',
      family: 'IPv4',
      kind: 'lan',
      addresses: ['192.168.8.64'],
      selected: false,
      listening: [],
    },
    {
      name: 'utun4',
      family: 'IPv4',
      kind: 'tailscale',
      addresses: ['100.101.102.103'],
      selected: false,
      listening: [],
    },
  ];
  const on = { ...DEFAULT_REMOTE_SETTINGS, enabled: true };

  it('第一次打开局域网：当前的局域网网卡都勾上，Tailscale 不进名单；再关掉保留名单', () => {
    const lan = setLan(on, true, interfaces);
    expect(lan.interfaces).toEqual({
      lan: true,
      tailscale: false,
      lanInterfaces: [
        { name: 'en0', family: 'IPv4' },
        { name: 'en1', family: 'IPv4' },
      ],
    });
    expect(setLan(lan, false, []).interfaces.lanInterfaces).toEqual(lan.interfaces.lanInterfaces);
  });

  it('勾选按网卡名 + 地址族，去掉 en1 只剩 en0；没有名单时从全部局域网网卡开始', () => {
    const only = toggleLanInterface(on, { name: 'en1', family: 'IPv4' }, false, interfaces);
    expect(only.interfaces.lanInterfaces).toEqual([{ name: 'en0', family: 'IPv4' }]);
    const back = toggleLanInterface(only, { name: 'en1', family: 'IPv4' }, true, interfaces);
    expect(back.interfaces.lanInterfaces).toEqual([
      { name: 'en0', family: 'IPv4' },
      { name: 'en1', family: 'IPv4' },
    ]);
    expect(interfaceLabel(interfaces[0] as RemoteInterface)).toBe('en0 · IPv4');
  });

  it('端口：空是默认，1024–65535 的整数', () => {
    expect(parsePort('')).toEqual({});
    expect(parsePort(' 47830 ')).toEqual({ port: 47_830 });
    expect(parsePort('1024')).toEqual({ port: 1024 });
    for (const bad of ['80', '65536', '4.5', 'abc', '-1'])
      expect(parsePort(bad), bad).toBeUndefined();
  });
});
