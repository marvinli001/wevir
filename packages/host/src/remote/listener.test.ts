// 直连的远程监听（0.109.0，ADR-0017 §1–§4）：真实的 Host、真实的 socket，测试客户端用 `@wevir/noise` 扮演手机。回环地址经可注入的
// 分类认作“局域网”（127.0.0.1）与“Tailscale”（::1），其余照真实规则走。

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  type ClientIdentity,
  CloseCode,
  DEFAULT_DEVICE_PERMISSIONS,
  DEFAULT_REMOTE_SETTINGS,
  ErrorCode,
  parsePairingUri,
  REMOTE_PATHS,
  type RemoteSettings,
  type SessionId,
} from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';
import type { MdnsAnnouncement } from './mdns.js';
import { classifyAddress, type NetworkInterfaces } from './network.js';
import { HandshakeLimiter } from './rate-limit.js';
import {
  connectRemote,
  newTestDevice,
  openRemoteSocket,
  pairRemote,
  type RemoteTestConnection,
  type TestDevice,
  type TestHostIdentity,
} from './test-client.js';

const tempDir = useTempDir();
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DESKTOP: ClientIdentity = { deviceId: 'mac', clientId: 'desktop', clientKind: 'desktop' };
const PHONE: ClientIdentity = { deviceId: 'phone', clientId: 'phone-app', clientKind: 'mobile' };

/** 回环地址当作可监听的地址：IPv4 回环算局域网，IPv6 回环算 Tailscale。 */
const LOOPBACK: NetworkInterfaces = {
  lo0: [
    {
      address: '127.0.0.1',
      netmask: '255.0.0.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: true,
      cidr: '127.0.0.1/8',
    },
  ],
};
const loopbackAsLan = (address: string, internal: boolean) =>
  address === '127.0.0.1' ? 'lan' : classifyAddress(address, internal);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function setup(options: { limiter?: HandshakeLimiter } = {}) {
  const home = join(realpathSync(tempDir()), 'home');
  const announcements: (MdnsAnnouncement | undefined)[] = [];
  const host = await startHost({
    adapter: new EchoAdapter({ stepDelayMs: 1 }),
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
    home,
    remoteListener: {
      networkInterfaces: () => LOOPBACK,
      classifyAddress: loopbackAsLan,
      lookupMagicDnsName: async () => undefined,
      advertiser: { update: (a) => announcements.push(a), shutdown: async () => {} },
      ...(options.limiter !== undefined && { limiter: options.limiter }),
      pollMs: 50,
    },
  });
  cleanups.push(() => host.shutdown());
  const { token } = JSON.parse(await readFile(join(home, 'run', 'host.json'), 'utf8')) as {
    token: string;
  };
  const desktop = await TestRpcClient.connect(host.url);
  cleanups.push(() => desktop.ws.terminate());
  expect((await desktop.hello(token, DESKTOP)).error).toBeUndefined();
  const port = await freePort();
  const base = `ws://127.0.0.1:${port}`;

  const setRemote = async (remote: Partial<RemoteSettings>) => {
    const current =
      (await desktop.request('settings.get')).settings.remote ?? DEFAULT_REMOTE_SETTINGS;
    await desktop.request('settings.update', { settings: { remote: { ...current, ...remote } } });
  };
  /** 打开远程与局域网监听，等它监听上。 */
  const enable = async () => {
    await setRemote({
      enabled: true,
      interfaces: { lan: true, tailscale: false },
      port,
    });
    await desktop.request('remote.status');
    await desktop.until(
      () => desktop.notifications('remote.changed').find((status) => status.listening),
      'listening',
    );
  };
  const identity = async (): Promise<TestHostIdentity> => {
    const keys = await host.remote.identity.ensure();
    return { hostPublicKey: keys.hostPublicKey, routeId: keys.routeId };
  };
  /** 走一遍二维码配对，桌面允许，返回已经 hello 的连接与设备 ID。 */
  const pair = async (device: TestDevice = newTestDevice()) => {
    const offer = await desktop.request('pairing.start');
    const payload = parsePairingUri(offer.uri);
    if (payload === null) throw new Error('bad pairing uri');
    const before = desktop.notifications('pairing.request').length;
    const remote = await pairRemote({
      base,
      host: { hostPublicKey: payload.hostPublicKey, routeId: payload.routeId },
      secret: new Uint8Array(Buffer.from(payload.secret, 'base64url')),
      device,
      name: 'Pixel',
      platform: 'android',
    });
    cleanups.push(() => remote.ws.terminate());
    const hello = remote.client.hello('ignored', PHONE);
    const request = await desktop.until(
      () => desktop.notifications('pairing.request')[before],
      'pairing.request',
    );
    const { device: record } = await desktop.request('pairing.respond', {
      requestId: request.requestId,
      allow: true,
    });
    expect((await hello).error).toBeUndefined();
    return { remote, device, deviceId: record.id as string, offer };
  };
  const reconnect = async (device: TestDevice): Promise<RemoteTestConnection> => {
    const remote = await connectRemote({ base, host: await identity(), device });
    cleanups.push(() => remote.ws.terminate());
    return remote;
  };
  return {
    host,
    home,
    desktop,
    port,
    base,
    setRemote,
    enable,
    identity,
    pair,
    reconnect,
    announcements,
  };
}

function closedWith(ws: WebSocket): Promise<number> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(-1);
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

async function createSession(client: TestRpcClient): Promise<SessionId> {
  const dir = join(tempDir(), 'workspace');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'big.bin'), Buffer.alloc(200_000, 7));
  const { workspace } = await client.request('workspace.add', { rootPath: dir });
  await client.request('provider.upsert', {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [],
    defaultModelId: 'deepseek-chat',
  });
  const { session } = await client.request('session.create', {
    workspaceId: workspace.id,
    providerId: 'deepseek-official',
  });
  return session.id;
}

describe('远程监听', () => {
  it('二维码配对 → 桌面允许 → hello 拿到设备的权限；之后用 IK 重连；管理方法一律 DEVICE_FORBIDDEN', async () => {
    const { desktop, enable, pair, reconnect, port, announcements, identity } = await setup();
    await enable();
    const { remote, device, deviceId, offer } = await pair();
    // 二维码里有直连地址。
    expect(offer.candidates).toEqual([{ kind: 'lan', host: '127.0.0.1', port }]);
    expect(parsePairingUri(offer.uri)?.candidates).toEqual([{ host: '127.0.0.1', port }]);
    // 握手负载里再给一份最新的。
    expect(remote.host.candidates).toEqual(offer.candidates);
    const hello = await remote.client.call('host.ping');
    expect(hello.error).toBeUndefined();
    expect(await remote.client.request('session.list', {})).toMatchObject({ sessions: [] });
    for (const method of ['settings.update', 'device.list', 'remote.status', 'pairing.start']) {
      const frame = await remote.client.call(
        method,
        method === 'settings.update' ? { settings: {} } : {},
      );
      expect(frame.error?.code, method).toBe(ErrorCode.DEVICE_FORBIDDEN);
    }
    // 桌面看到连接数与 mDNS 广播的内容。
    const status = await desktop.request('remote.status');
    expect(status).toMatchObject({ listening: true, port, connections: 1, advertising: true });
    const { routeId, hostPublicKey } = await identity();
    expect(announcements.at(-1)).toMatchObject({
      name: routeId,
      type: 'wevir',
      port,
      txt: { v: '1', rid: routeId, pk: hostPublicKey },
      restrictedAddresses: ['127.0.0.1'],
      interfaces: ['lo0'],
    });

    remote.ws.close();
    await closedWith(remote.ws);
    const again = await reconnect(device);
    const helloAgain = await again.client.hello('ignored', PHONE);
    expect(helloAgain.error).toBeUndefined();
    expect(helloAgain.result.permissions).toEqual([...DEFAULT_DEVICE_PERMISSIONS]);
    const { devices } = await desktop.request('device.list');
    expect(devices).toMatchObject([{ id: deviceId, name: 'Pixel', platform: 'android' }]);
  });

  it('短码配对只靠 mDNS 广播的 rid 与 pk；错码一次就结束窗口，之后配对路径 404', async () => {
    const { desktop, enable, base, identity, announcements } = await setup();
    await enable();
    // 只拿到短码的设备从 mDNS TXT 得到路由 ID 与 Host 公钥，不需要二维码。
    const txt = announcements.at(-1)?.txt;
    const host = { routeId: txt?.rid ?? '', hostPublicKey: txt?.pk ?? '' };
    expect(host).toEqual(await identity());
    let offer = await desktop.request('pairing.start');
    const wrong = pairRemote({
      base,
      host,
      secret: new TextEncoder().encode(offer.shortCode === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA'),
      code: true,
      device: newTestDevice(),
    });
    await expect(wrong).rejects.toThrow();
    await desktop.until(
      () => desktop.notifications('pairing.ended').find((e) => e.reason === 'failed'),
      'pairing failed',
    );
    await expect(openRemoteSocket(base, REMOTE_PATHS.pair)).rejects.toMatchObject({ status: 404 });

    offer = await desktop.request('pairing.start');
    const remote = await pairRemote({
      base,
      host,
      secret: new TextEncoder().encode(offer.shortCode),
      code: true,
      device: newTestDevice(),
    });
    cleanups.push(() => remote.ws.terminate());
    const request = await desktop.until(
      () => desktop.notifications('pairing.request')[0],
      'pairing.request',
    );
    expect(request).toMatchObject({
      pairingId: offer.pairingId,
      name: 'Test phone',
      platform: 'ios',
    });
  });

  it('一个窗口只给一次握手；桌面拒绝时以 PAIRING_DENIED 关闭；拒绝之前发的 hello 没有回应', async () => {
    const { desktop, enable, base, identity } = await setup();
    await enable();
    const host = await identity();
    const offer = await desktop.request('pairing.start');
    const secret = new Uint8Array(
      Buffer.from(parsePairingUri(offer.uri)?.secret ?? '', 'base64url'),
    );
    const first = await pairRemote({ base, host, secret, device: newTestDevice() });
    cleanups.push(() => first.ws.terminate());
    // 第二次尝试：窗口已经用掉，握手直接断开。
    await expect(pairRemote({ base, host, secret, device: newTestDevice() })).rejects.toThrow();
    const hello = first.client.call('host.hello', {});
    const request = await desktop.until(
      () => desktop.notifications('pairing.request')[0],
      'pairing.request',
    );
    await desktop.request('pairing.respond', { requestId: request.requestId, allow: false });
    expect(await closedWith(first.ws)).toBe(CloseCode.PAIRING_DENIED);
    await expect(hello).rejects.toThrow();
    expect((await desktop.request('device.list')).devices).toEqual([]);
  });

  it('取消的窗口不再接受配对；没有窗口时配对路径 404', async () => {
    const { desktop, enable, base } = await setup();
    await enable();
    await expect(openRemoteSocket(base, REMOTE_PATHS.pair)).rejects.toMatchObject({ status: 404 });
    const offer = await desktop.request('pairing.start');
    const ws = await openRemoteSocket(base, REMOTE_PATHS.pairCode);
    ws.terminate();
    await desktop.request('pairing.cancel', { pairingId: offer.pairingId });
    await expect(openRemoteSocket(base, REMOTE_PATHS.pairCode)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('未配对与已移除的设备握不上手；移除时立即断开（DEVICE_REVOKED）', async () => {
    const { desktop, enable, pair, reconnect } = await setup();
    await enable();
    await expect(reconnect(newTestDevice())).rejects.toThrow();
    const { remote, device, deviceId } = await pair();
    const closed = closedWith(remote.ws);
    await desktop.request('device.revoke', { id: deviceId });
    expect(await closed).toBe(CloseCode.DEVICE_REVOKED);
    await expect(reconnect(device)).rejects.toThrow();
  });

  it('权限改了：断开（PERMISSIONS_CHANGED），重连后按新的权限工作', async () => {
    const { desktop, enable, pair, reconnect } = await setup();
    await enable();
    const { remote, device, deviceId } = await pair();
    const closed = closedWith(remote.ws);
    await desktop.request('device.update', { id: deviceId, permissions: ['session.read'] });
    expect(await closed).toBe(CloseCode.PERMISSIONS_CHANGED);
    const again = await reconnect(device);
    const hello = await again.client.hello('ignored', PHONE);
    expect(hello.result.permissions).toEqual(['session.read']);
    const frame = await again.client.call('session.create', { workspaceId: 'wks_x' });
    expect(frame.error?.code).toBe(ErrorCode.DEVICE_FORBIDDEN);
    // 只改名不断开。
    await desktop.request('device.update', { id: deviceId, name: 'Renamed' });
    expect((await again.client.call('host.ping')).error).toBeUndefined();
  });

  it('端口上只有 Noise：普通 HTTP 404、带 Origin 的升级 403、未知路径 404、乱码与文本消息直接断开且不回任何内容', async () => {
    const { enable, port, base } = await setup();
    await enable();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(404);
    await expect(
      openRemoteSocket(base, REMOTE_PATHS.connect, { origin: 'http://192.168.1.5' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(openRemoteSocket(base, '/files/x')).rejects.toMatchObject({ status: 404 });
    for (const payload of [Buffer.alloc(96, 1), 'hello']) {
      const ws = await openRemoteSocket(base, REMOTE_PATHS.connect);
      const received: unknown[] = [];
      ws.on('message', (data) => received.push(data));
      ws.send(payload);
      expect(await closedWith(ws)).toBe(1006);
      expect(received).toEqual([]);
    }
  });

  it('按来源限速：失败五次之后这个地址的升级直接断开', async () => {
    const { enable, base, reconnect } = await setup({ limiter: new HandshakeLimiter() });
    await enable();
    for (let i = 0; i < 5; i += 1) await expect(reconnect(newTestDevice())).rejects.toThrow();
    await expect(openRemoteSocket(base, REMOTE_PATHS.connect)).rejects.toThrow(
      /socket hang up|ECONNRESET/,
    );
  });

  it('隧道里收发消息、批准审批、files.read 64 KiB 分块、断线后按 seq 补齐；连着时防休眠', async () => {
    const { desktop, enable, pair, reconnect } = await setup();
    await desktop.request('settings.update', { settings: { preventSleep: true } });
    await enable();
    const sessionId = await createSession(desktop);
    const { remote, device } = await pair();
    expect((await remote.client.request('power.get')).keepAwake).toBe(true);

    const { subscriptionId } = await remote.client.request('events.subscribe', {
      sessionId,
      sinceSeq: 0,
    });
    await remote.client.request('session.send', {
      sessionId,
      content: [{ type: 'text', text: 'please approve' }],
    });
    const requested = await remote.client.until(
      () => remote.client.events(subscriptionId).find((e) => e.type === 'approval.requested'),
      'approval.requested',
    );
    if (requested.type !== 'approval.requested') throw new Error('unexpected event');
    const option = requested.payload.approval.options.find((o) => o.category === 'allow');
    await remote.client.request('approval.respond', {
      approvalId: requested.payload.approval.id,
      optionId: option?.optionId,
    });
    await remote.client.until(
      () => remote.client.events(subscriptionId).find((e) => e.type === 'turn.finished'),
      'turn.finished',
    );

    // 64 KiB 原始数据在 JSON 里是约 87 KiB 的 base64，要分两片。
    const chunk = await remote.client.request('files.read', {
      sessionId,
      path: 'big.bin',
      length: 64 * 1024,
    });
    expect(Buffer.from(chunk.data, 'base64')).toEqual(Buffer.alloc(64 * 1024, 7));
    expect(chunk).toMatchObject({ size: 200_000, offset: 0, eof: false });

    const seen = remote.client.events(subscriptionId);
    const lastSeq = seen.at(-1)?.seq ?? 0;
    remote.ws.close();
    await closedWith(remote.ws);
    await desktop.request('session.send', { sessionId, content: [{ type: 'text', text: 'hi' }] });
    const again = await reconnect(device);
    expect((await again.client.hello('ignored', PHONE)).error).toBeUndefined();
    const resumed = await again.client.request('events.subscribe', {
      sessionId,
      sinceSeq: lastSeq,
    });
    const missed = await again.client.until(
      () =>
        again.client
          .events(resumed.subscriptionId)
          .find((e) => e.type === 'turn.finished' && e.seq > lastSeq),
      'missed turn.finished',
    );
    expect(missed.seq).toBeGreaterThan(lastSeq);
    expect(again.client.events(resumed.subscriptionId)[0]?.seq).toBe(lastSeq + 1);
  });

  it('关掉远程：断开远程连接（REMOTE_DISABLED）、不再监听、停掉广播', async () => {
    const { desktop, enable, pair, setRemote, base, announcements } = await setup();
    await enable();
    const { remote } = await pair();
    const closed = closedWith(remote.ws);
    await setRemote({ enabled: false });
    expect(await closed).toBe(CloseCode.REMOTE_DISABLED);
    await expect(openRemoteSocket(base, REMOTE_PATHS.connect)).rejects.toThrow(/ECONNREFUSED/);
    expect(announcements.at(-1)).toBeUndefined();
    expect(await desktop.request('remote.status')).toMatchObject({
      listening: false,
      connections: 0,
    });
  });

  it('取消勾选局域网网卡：关掉那个地址的监听与上面的连接', async () => {
    const { desktop, enable, pair, setRemote } = await setup();
    await enable();
    const { remote } = await pair();
    const closed = closedWith(remote.ws);
    await setRemote({ interfaces: { lan: true, tailscale: false, lanInterfaces: [] } });
    expect(await closed).toBe(CloseCode.REMOTE_DISABLED);
    const status = await desktop.request('remote.status');
    expect(status.interfaces).toEqual([
      {
        name: 'lo0',
        family: 'IPv4',
        kind: 'lan',
        addresses: ['127.0.0.1'],
        selected: false,
        listening: [],
      },
    ]);
  });
});
