import { Server } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { DEFAULT_REMOTE_SETTINGS, type RemoteSettings } from '@wevir/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteListener } from './listener.js';
import { mdnsAnnouncement } from './mdns.js';
import {
  classifyAddress,
  describeInterfaces,
  isSelected,
  type NetworkInterfaces,
  remoteAddresses,
} from './network.js';
import { HANDSHAKE_BLOCK_MS, HandshakeLimiter, MAX_PENDING_HANDSHAKES } from './rate-limit.js';

function info(address: string, internal = false): NetworkInterfaceInfo {
  const v6 = address.includes(':');
  return {
    address,
    netmask: v6 ? 'ffff:ffff:ffff:ffff::' : '255.255.255.0',
    family: v6 ? 'IPv6' : 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: null,
    ...(v6 && { scopeid: 0 }),
  } as NetworkInterfaceInfo;
}

/** 一台典型的 Mac：回环、两块同网段的局域网卡、系统隧道、Tailscale、一个公网地址与 IPv6 全局地址。 */
const MAC: NetworkInterfaces = {
  lo0: [info('127.0.0.1', true), info('::1', true), info('fe80::1', true)],
  en0: [
    info('192.168.8.65'),
    info('fe80::1c2b:3a4d:5e6f:7a8b'),
    info('2001:db8::65'),
    info('fd12:3456:789a::65'),
  ],
  en1: [info('192.168.8.64'), info('169.254.10.20')],
  utun0: [info('fe80::abcd')],
  utun4: [info('100.101.102.103'), info('fd7a:115c:a1e0::1234')],
  en5: [info('8.8.4.4')],
  bridge0: [info('10.0.0.1'), info('172.20.0.1'), info('172.32.0.1')],
};

const settings = (remote: Partial<RemoteSettings>): RemoteSettings => ({
  ...DEFAULT_REMOTE_SETTINGS,
  enabled: true,
  ...remote,
});

const KEYS = { routeId: 'ROUTE_id-1', hostPublicKey: 'HOST_pk-1' };
describe('认地址', () => {
  it('局域网只认私有地址段与唯一本地 IPv6；Tailscale 按地址段；回环、链路本地、公网一律不认', () => {
    expect(classifyAddress('192.168.8.65', false)).toBe('lan');
    expect(classifyAddress('10.1.2.3', false)).toBe('lan');
    expect(classifyAddress('172.16.0.1', false)).toBe('lan');
    expect(classifyAddress('172.31.255.1', false)).toBe('lan');
    expect(classifyAddress('fd12:3456:789a::65', false)).toBe('lan');
    expect(classifyAddress('FC00::1', false)).toBe('lan');
    expect(classifyAddress('100.64.0.1', false)).toBe('tailscale');
    expect(classifyAddress('100.127.255.254', false)).toBe('tailscale');
    expect(classifyAddress('fd7a:115c:a1e0::1234', false)).toBe('tailscale');
    for (const address of [
      '127.0.0.1',
      '::1',
      'fe80::1',
      '169.254.10.20',
      '8.8.4.4',
      '2001:db8::65',
      '100.63.255.255',
      '100.128.0.1',
      '172.32.0.1',
      '172.15.0.1',
      '0.0.0.0',
      '::',
    ]) {
      expect(classifyAddress(address, false), address).toBeNull();
    }
    expect(classifyAddress('192.168.8.65', true)).toBeNull();
  });

  it('列出的网卡：按网卡名与地址族合并；勾选看开关与 lanInterfaces', () => {
    const addresses = remoteAddresses(MAC);
    expect(addresses.map((a) => `${a.name} ${a.kind} ${a.address}`)).toEqual([
      'bridge0 lan 10.0.0.1',
      'bridge0 lan 172.20.0.1',
      'en0 lan 192.168.8.65',
      'en0 lan fd12:3456:789a::65',
      'en1 lan 192.168.8.64',
      'utun4 tailscale 100.101.102.103',
      'utun4 tailscale fd7a:115c:a1e0::1234',
    ]);
    const onlyEn0 = settings({
      interfaces: { lan: true, tailscale: false, lanInterfaces: [{ name: 'en0', family: 'IPv4' }] },
    });
    const listed = describeInterfaces(addresses, onlyEn0, new Set(['192.168.8.65']));
    expect(listed.find((i) => i.name === 'en0' && i.family === 'IPv4')).toEqual({
      name: 'en0',
      family: 'IPv4',
      kind: 'lan',
      addresses: ['192.168.8.65'],
      selected: true,
      listening: ['192.168.8.65'],
    });
    expect(listed.filter((i) => i.selected).map((i) => `${i.name}/${i.family}`)).toEqual([
      'en0/IPv4',
    ]);
    // 没有 lanInterfaces：全部局域网网卡；Tailscale 不看网卡名。
    const all = settings({ interfaces: { lan: true, tailscale: true } });
    expect(addresses.filter((a) => isSelected(a, all))).toHaveLength(addresses.length);
    expect(
      addresses.filter((a) =>
        isSelected(a, settings({ interfaces: { lan: false, tailscale: true } })),
      ),
    ).toHaveLength(2);
    expect(addresses.filter((a) => isSelected(a, { ...all, enabled: false }))).toEqual([]);
  });
});

describe('远程监听只绑勾选的地址', () => {
  const listening: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    listening.length = 0;
  });

  it('从不绑 0.0.0.0、公网、回环或没勾的网卡；地址不在时下一轮重试', async () => {
    // 只记下 listen 的地址，不真的绑（这些地址本机没有）。
    vi.spyOn(Server.prototype, 'listen').mockImplementation(function (
      this: Server,
      ...args: unknown[]
    ) {
      const options = args[0] as { host: string; port: number };
      listening.push(`${options.host}:${options.port}`);
      return this;
    });
    let remote = settings({
      interfaces: { lan: true, tailscale: true, lanInterfaces: [{ name: 'en0', family: 'IPv4' }] },
      port: 47_999,
    });
    const listener = new RemoteListener({
      settings: () => remote,
      identity: { ensure: async () => ({ routeId: 'route' }) as never },
      devices: {
        findActive: () => undefined,
        get: () => undefined,
        touch: () => {},
        onRevoked: () => () => {},
        onPermissionsChanged: () => () => {},
      },
      pairing: {
        pairingId: undefined,
        beginAttempt: () => undefined,
        requestApproval: async () => undefined,
        failAttempt: () => {},
      },
      attach: () => undefined,
      networkInterfaces: () => MAC,
      pollMs: 60_000,
    });
    listener.refresh();
    await vi.waitFor(() => expect(listening.length).toBeGreaterThan(0));
    expect(listening.sort()).toEqual([
      '100.101.102.103:47999',
      '192.168.8.65:47999',
      'fd7a:115c:a1e0::1234:47999',
    ]);
    // 关掉 Tailscale、换端口：只剩 en0。
    listening.length = 0;
    remote = { ...remote, interfaces: { ...remote.interfaces, tailscale: false }, port: 48_000 };
    listener.refresh();
    expect(listening).toEqual(['192.168.8.65:48000']);
    await listener.close();
  });
});

describe('mDNS 广播的内容', () => {
  it('只广播勾选的局域网地址与路由 ID，主机名不含电脑名；只有 Tailscale 时不广播', () => {
    const lan = {
      name: 'en0',
      family: 'IPv4' as const,
      kind: 'lan' as const,
      address: '192.168.8.65',
    };
    const tailscale = {
      name: 'utun4',
      family: 'IPv4' as const,
      kind: 'tailscale' as const,
      address: '100.101.102.103',
    };
    const announcement = mdnsAnnouncement(KEYS, 47_830, [lan, tailscale]);
    expect(announcement).toEqual({
      name: 'ROUTE_id-1',
      type: 'wevir',
      port: 47_830,
      hostname: expect.stringMatching(/^wevir-[0-9a-f]{16}$/),
      txt: { v: '1', rid: 'ROUTE_id-1', pk: 'HOST_pk-1' },
      restrictedAddresses: ['192.168.8.65'],
      interfaces: ['en0'],
      ipv6: false,
    });
    expect(mdnsAnnouncement(KEYS, 47_830, [tailscale])).toBeUndefined();
    expect(mdnsAnnouncement(KEYS, 47_830, [])).toBeUndefined();
  });
});

describe('握手限速', () => {
  it('每分钟 20 次、十分钟内失败 5 次封十分钟；同时握手的连接有上限', () => {
    let now = 0;
    const limiter = new HandshakeLimiter({ now: () => now });
    for (let i = 0; i < 20; i += 1) limiter.begin('a')?.();
    expect(limiter.begin('a')).toBeUndefined();
    expect(limiter.begin('b')).toBeDefined();
    now += 60_000;
    expect(limiter.begin('a')).toBeDefined();
    for (let i = 0; i < 5; i += 1) limiter.fail('c');
    expect(limiter.begin('c')).toBeUndefined();
    now += HANDSHAKE_BLOCK_MS;
    expect(limiter.begin('c')).toBeDefined();
    const fresh = new HandshakeLimiter({ now: () => now });
    for (let i = 0; i < MAX_PENDING_HANDSHAKES; i += 1) fresh.begin(`p${i}`);
    expect(fresh.begin('q')).toBeUndefined();
  });
});
