// 经中继的远程访问（0.110.0，ADR-0017 §1）：真实的 Host、本地起的中继（apps/relay）、扮演手机的 Noise 测试客户端。直连关着
// （没有勾选网卡），配对与重连都只能经中继。中继前面放一个 TCP 代理，抓下进出中继的全部字节；加上中继自己的 tap（解掉 WebSocket
// 掩码之后它实际转发的每条消息）与日志，确认中继从头到尾只见到密文。

import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  type ClientIdentity,
  CloseCode,
  DEFAULT_REMOTE_SETTINGS,
  parsePairingUri,
  RELAY_PATHS,
  REMOTE_PATHS,
  RelayCloseCode,
  type RemoteSettings,
  relayEndpoint,
  relayRegistrationMessage,
  type SessionId,
} from '@wevir/protocol';
import { createLogger as createRelayLogger, RelayServer, type RelayTapEvent } from '@wevir/relay';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';
import { classifyAddress, type NetworkInterfaces } from './network.js';
import { isCertificateError } from './relay-client.js';
import {
  connectRemote,
  newTestDevice,
  openRemoteSocket,
  pairRemote,
  type RemoteTestConnection,
  type TestDevice,
  withRoute,
} from './test-client.js';

const tempDir = useTempDir();
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DESKTOP: ClientIdentity = { deviceId: 'mac', clientId: 'desktop', clientKind: 'desktop' };
const PHONE: ClientIdentity = { deviceId: 'phone', clientId: 'phone-app', clientKind: 'mobile' };

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

/** 中继前面的 TCP 代理：记下两个方向的全部字节（抓包）。`target` 可以换，中继重启后接到新端口。 */
async function startSniffer(target: { port: number }) {
  const captured: { toRelay: Buffer[]; fromRelay: Buffer[] } = { toRelay: [], fromRelay: [] };
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = createConnection({ host: '127.0.0.1', port: target.port });
    sockets.add(client).add(upstream);
    client.on('data', (data) => {
      captured.toRelay.push(Buffer.from(data));
      upstream.write(data);
    });
    upstream.on('data', (data) => {
      captured.fromRelay.push(Buffer.from(data));
      client.write(data);
    });
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on('error', end);
      socket.on('close', () => {
        sockets.delete(socket);
        end();
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as { port: number };
  return { url: `ws://127.0.0.1:${port}`, captured };
}

async function startRelay(port = 0) {
  const taps: RelayTapEvent[] = [];
  const logs: string[] = [];
  const relay = new RelayServer({
    logger: createRelayLogger('debug', (line) => logs.push(line)),
    tap: (event) => taps.push(event),
  });
  const actual = await relay.listen(port, '127.0.0.1');
  cleanups.push(() => relay.close());
  return { relay, port: actual, taps, logs };
}

async function setup(options: { lan?: boolean } = {}) {
  const first = await startRelay();
  const target = { port: first.port };
  const sniffer = await startSniffer(target);
  const home = join(realpathSync(tempDir()), 'home');
  const host = await startHost({
    adapter: new EchoAdapter({ stepDelayMs: 1 }),
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
    home,
    remoteListener: {
      networkInterfaces: () => LOOPBACK,
      classifyAddress: loopbackAsLan,
      lookupMagicDnsName: async () => undefined,
      advertiser: { update: () => {}, shutdown: async () => {} },
      pollMs: 50,
      relay: { backoffMs: 50, maxBackoffMs: 200 },
    },
  });
  cleanups.push(() => host.shutdown());
  const { token } = JSON.parse(await readFile(join(home, 'run', 'host.json'), 'utf8')) as {
    token: string;
  };
  const desktop = await TestRpcClient.connect(host.url);
  cleanups.push(() => desktop.ws.terminate());
  expect((await desktop.hello(token, DESKTOP)).error).toBeUndefined();
  const directPort = await freePort();

  const setRemote = async (remote: Partial<RemoteSettings>) => {
    const current =
      (await desktop.request('settings.get')).settings.remote ?? DEFAULT_REMOTE_SETTINGS;
    await desktop.request('settings.update', { settings: { remote: { ...current, ...remote } } });
  };
  await desktop.request('remote.status');
  /** 等到 `remote.changed` 报出中继的这个状态；`reason` 给了时还要带着这个失败原因。只看调用之后到的通知。 */
  const relayState = (state: 'connecting' | 'connected', reason?: string) => {
    const before = desktop.notifications('remote.changed').length;
    return desktop.until(
      () =>
        desktop
          .notifications('remote.changed')
          .slice(before)
          .find(
            (s) =>
              s.relay?.state === state &&
              (reason === undefined || s.relay.error?.reason === reason),
          ),
      `relay ${state}`,
    );
  };
  /** 打开远程与中继（直连默认不勾网卡），等它在中继上注册好。 */
  const enable = async () => {
    const before = desktop.notifications('remote.changed').length;
    await setRemote({
      enabled: true,
      interfaces: { lan: options.lan === true, tailscale: false },
      port: directPort,
      relay: { enabled: true, url: sniffer.url },
    });
    await desktop.until(
      () =>
        desktop
          .notifications('remote.changed')
          .slice(before)
          .find((s) => s.relay?.state === 'connected'),
      'relay connected',
    );
  };
  const keys = () => host.remote.identity.ensure();
  /** 经中继走一遍二维码配对，桌面允许，返回已经 hello 的连接。 */
  const pair = async (device: TestDevice = newTestDevice()) => {
    const offer = await desktop.request('pairing.start');
    const payload = parsePairingUri(offer.uri);
    if (payload === null || payload.relayUrl === undefined) throw new Error('no relay in the uri');
    const before = desktop.notifications('pairing.request').length;
    const remote = await pairRemote({
      base: payload.relayUrl,
      route: payload.routeId,
      host: { hostPublicKey: payload.hostPublicKey, routeId: payload.routeId },
      secret: new Uint8Array(Buffer.from(payload.secret, 'base64url')),
      device,
      name: 'Pixel-Relay',
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
    return { remote, device, deviceId: record?.id as string, offer, payload };
  };
  const reconnect = async (device: TestDevice): Promise<RemoteTestConnection> => {
    const { hostPublicKey, routeId } = await keys();
    const remote = await connectRemote({
      base: sniffer.url,
      route: routeId,
      host: { hostPublicKey, routeId },
      device,
    });
    cleanups.push(() => remote.ws.terminate());
    return remote;
  };
  return {
    host,
    desktop,
    relay: first,
    target,
    sniffer,
    directPort,
    setRemote,
    enable,
    relayState,
    keys,
    pair,
    reconnect,
  };
}

function closedWith(ws: WebSocket): Promise<number> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(-1);
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

async function createSession(client: TestRpcClient, marker: string): Promise<SessionId> {
  const dir = join(tempDir(), 'workspace');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'notes.txt'), `file contents ${marker}\n`);
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

/** `haystack` 里有没有 `needle`（原样的字节）。 */
function contains(haystack: readonly Buffer[], needle: Buffer | string): boolean {
  const bytes = typeof needle === 'string' ? Buffer.from(needle) : needle;
  // 跨 TCP 分段的也找得到：拼起来再找。
  return Buffer.concat(haystack).includes(bytes);
}

describe('经中继', () => {
  it('配对、重连、发消息、批准审批、读文件、断线补齐都经中继；中继抓到的只有密文', async () => {
    const { desktop, relay, sniffer, enable, pair, reconnect, keys } = await setup();
    await enable();
    const marker = `PLAINTEXT-${randomBytes(8).toString('hex')}`;
    const sessionId = await createSession(desktop, marker);
    const { remote, device, offer, payload } = await pair();
    // 直连关着：二维码里没有直连地址，只有中继。
    expect(offer.candidates).toEqual([]);
    expect(payload.relayUrl).toBe(sniffer.url);
    expect(offer.relayUrl).toBe(sniffer.url);
    // 握手负载里也带着中继地址。
    expect(remote.host).toMatchObject({ candidates: [], relayUrl: sniffer.url });
    expect(await desktop.request('remote.status')).toMatchObject({
      listening: false,
      connections: 1,
      relay: { state: 'connected', url: sniffer.url, connections: 1 },
    });

    const { subscriptionId } = await remote.client.request('events.subscribe', {
      sessionId,
      sinceSeq: 0,
    });
    await remote.client.request('session.send', {
      sessionId,
      content: [{ type: 'text', text: `please approve ${marker}` }],
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
    const file = await remote.client.request('files.read', { sessionId, path: 'notes.txt' });
    expect(Buffer.from(file.data, 'base64').toString()).toContain(marker);

    // 断线：中继不缓冲，重连是新的 IK 握手，按 seq 补齐断线期间的事件。
    const lastSeq = remote.client.events(subscriptionId).at(-1)?.seq ?? 0;
    remote.ws.close();
    await closedWith(remote.ws);
    await desktop.request('session.send', {
      sessionId,
      content: [{ type: 'text', text: `while away ${marker}` }],
    });
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
    expect(again.client.events(resumed.subscriptionId)[0]?.seq).toBe(lastSeq + 1);
    expect(missed.seq).toBeGreaterThan(lastSeq);
    // 本机连接上看得到明文：这个标记确实发出去了。
    const local = await desktop.request('events.subscribe', { sessionId, sinceSeq: 0 });
    await desktop.until(
      () =>
        JSON.stringify(desktop.events(local.subscriptionId)).includes(marker) ? true : undefined,
      'marker in local events',
    );
    again.ws.close();
    await closedWith(again.ws);

    // ── 中继看到了什么 ──
    const { routeId, hostPublicKey } = await keys();
    const secret = Buffer.from(payload.secret, 'base64url');
    const plaintexts: (Buffer | string)[] = [
      marker,
      'jsonrpc',
      'host.hello',
      'session.send',
      'approval.respond',
      'files.read',
      'Pixel-Relay',
      'please approve',
      offer.shortCode,
      payload.secret,
      secret,
      device.publicKey,
      Buffer.from(device.keys.secretKey),
      hostPublicKey,
    ];
    const tapped = relay.taps.map((event) => Buffer.from(event.data));
    expect(tapped.length).toBeGreaterThan(10);
    for (const event of relay.taps) {
      expect(event.route).toBe(routeId);
      expect(event.data.length).toBeLessThanOrEqual(65_535);
    }
    // 中继转发的每一条消息（已经解掉 WebSocket 的掩码）、抓包的两个方向、中继的日志：都没有任何明文。
    // 设备与 Host 发给中继的方向上 WebSocket 帧带掩码，抓包看不出内容，所以以 tap 为准；中继发出的方向不带掩码。
    for (const needle of plaintexts) {
      const label = Buffer.isBuffer(needle) ? `${needle.length} raw bytes` : needle;
      expect(contains(tapped, needle), `tap: ${label}`).toBe(false);
      expect(contains(sniffer.captured.fromRelay, needle), `capture: ${label}`).toBe(false);
      expect(contains(sniffer.captured.toRelay, needle), `capture: ${label}`).toBe(false);
      expect(contains([Buffer.from(relay.logs.join('\n'))], needle), `logs: ${label}`).toBe(false);
    }
    // 对照：抓包确实看得到中继自己的明文控制消息，看不到是因为内容是密文，不是没抓到。
    expect(contains(sniffer.captured.fromRelay, '"type":"registered"')).toBe(true);
    expect(contains(sniffer.captured.fromRelay, '"type":"incoming"')).toBe(true);
    // 日志里没有完整的路由 ID。
    expect(relay.logs.join('\n')).not.toContain(routeId);
    expect(relay.logs.some((line) => line.includes('host registered'))).toBe(true);
  });

  it('移除设备：经中继的连接以 DEVICE_REVOKED 关闭，之后握不上手', async () => {
    const { desktop, enable, pair, reconnect } = await setup();
    await enable();
    const { remote, device, deviceId } = await pair();
    const closed = closedWith(remote.ws);
    await desktop.request('device.revoke', { id: deviceId });
    expect(await closed).toBe(CloseCode.DEVICE_REVOKED);
    await expect(reconnect(device)).rejects.toThrow();
    // 不认识的设备：Host 直接断开，中继那侧也直接断开（与直连一样没有关闭帧）。
    await expect(reconnect(newTestDevice())).rejects.toThrow();
  });

  it('没开配对窗口时配对路径被 Host 拒绝（HOST_REJECTED）', async () => {
    const { enable, sniffer, keys } = await setup();
    await enable();
    const { routeId } = await keys();
    const ws = await openRemoteSocket(sniffer.url, withRoute(REMOTE_PATHS.pair, routeId));
    expect(await closedWith(ws)).toBe(RelayCloseCode.HOST_REJECTED);
  });

  it('关掉中继：经中继的连接以 REMOTE_DISABLED 关闭、路由从中继消失，只剩直连', async () => {
    const { desktop, relay, enable, pair, setRemote, sniffer, keys, directPort } = await setup({
      lan: true,
    });
    await enable();
    const { remote, device } = await pair();
    const closed = closedWith(remote.ws);
    await setRemote({ relay: { enabled: false, url: sniffer.url } });
    expect(await closed).toBe(CloseCode.REMOTE_DISABLED);
    await desktop.until(
      () => (relay.relay.stats().routes === 0 ? true : undefined),
      'unregistered',
    );
    const { routeId, hostPublicKey } = await keys();
    await expect(
      openRemoteSocket(sniffer.url, withRoute(REMOTE_PATHS.connect, routeId)),
    ).rejects.toMatchObject({ status: 404 });
    const status = await desktop.request('remote.status');
    expect(status.relay).toBeUndefined();
    expect(status.listening).toBe(true);
    // 直连照常。
    const direct = await connectRemote({
      base: `ws://127.0.0.1:${directPort}`,
      host: { hostPublicKey, routeId },
      device,
    });
    cleanups.push(() => direct.ws.terminate());
    expect((await direct.client.hello('ignored', PHONE)).error).toBeUndefined();
    // 新的配对窗口里没有中继地址了。
    expect((await desktop.request('pairing.start')).relayUrl).toBeUndefined();
  });

  it('中继断开后退避重连，重新注册；之前的设备照样连得上', async () => {
    const { desktop, relay, target, enable, pair, reconnect, relayState } = await setup();
    await enable();
    const { remote, device } = await pair();
    const closed = closedWith(remote.ws);
    const retry = relayState('connecting', 'unreachable');
    await relay.relay.close();
    // 接通的连接随中继一起断开；状态回到 connecting 并带上原因。
    expect(await closed).toBe(1001);
    const retrying = await retry;
    expect(retrying.relay?.state).toBe('connecting');
    // 控制连接与数据连接的断开谁先到不一定：连接数随后归零。
    await desktop.until(
      () => (desktop.notifications('remote.changed').at(-1)?.connections === 0 ? true : undefined),
      'no connections',
    );

    const restarted = await startRelay();
    target.port = restarted.port;
    await desktop.until(
      () =>
        restarted.relay.stats().routes === 1 &&
        desktop.notifications('remote.changed').at(-1)?.relay?.state === 'connected'
          ? true
          : undefined,
      'registered again',
    );
    const again = await reconnect(device);
    expect((await again.client.hello('ignored', PHONE)).error).toBeUndefined();
  });

  it('同一份路由密钥在别处注册时状态是 replaced，退避之后再注册回来', async () => {
    const { relay, enable, keys, relayState } = await setup();
    await enable();
    // 模拟另一台用了同一份密钥的电脑：拿 Host 的路由密钥直接向中继注册。
    const { route, routeId } = await keys();
    const replacedState = relayState('connecting', 'replaced');
    const other = new WebSocket(relayEndpoint(`ws://127.0.0.1:${relay.port}`, RELAY_PATHS.host));
    other.on('error', () => {});
    cleanups.push(() => other.terminate());
    const otherClosed = closedWith(other);
    other.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type: string; nonce?: string };
      if (message.type !== 'challenge') return;
      const signature = ed25519.sign(
        relayRegistrationMessage(message.nonce ?? ''),
        route.secretKey,
      );
      other.send(
        JSON.stringify({
          type: 'register',
          routeId,
          signature: Buffer.from(signature).toString('base64url'),
        }),
      );
    });
    const connectedAgain = relayState('connected');
    expect((await replacedState).relay?.error?.closeCode).toBe(RelayCloseCode.ROUTE_REPLACED);
    // Host 重连后把路由抢回来，冒充的那条被取代。
    expect(await otherClosed).toBe(RelayCloseCode.ROUTE_REPLACED);
    await connectedAgain;
  });

  it('开着中继但没填地址（0.110.0 存下的设置）等同于关：不连中继，配对链接里没有中继', async () => {
    const { desktop, relay, sniffer, setRemote } = await setup();
    await setRemote({
      enabled: true,
      interfaces: { lan: true, tailscale: false },
      relay: { enabled: true },
    });
    // 设置照样存下、读得回来。
    expect((await desktop.request('settings.get')).settings.remote?.relay).toEqual({
      enabled: true,
    });
    const offer = await desktop.request('pairing.start');
    expect(offer.relayUrl).toBeUndefined();
    expect(parsePairingUri(offer.uri)?.relayUrl).toBeUndefined();
    expect((await desktop.request('remote.status')).relay).toBeUndefined();
    expect(desktop.notifications('remote.changed').some((s) => s.relay !== undefined)).toBe(false);
    expect(relay.relay.stats()).toMatchObject({ routes: 0, connections: 0 });
    expect(sniffer.captured.toRelay).toHaveLength(0);
  });

  it('中继地址连不上时是 unreachable；那里不是中继时是 rejected 并带 HTTP 状态码', async () => {
    const { relay, setRemote, relayState } = await setup();
    const unreachable = relayState('connecting', 'unreachable');
    await setRemote({
      enabled: true,
      interfaces: { lan: false, tailscale: false },
      relay: { enabled: true, url: `ws://127.0.0.1:${await freePort()}` },
    });
    expect((await unreachable).relay?.error).toMatchObject({ reason: 'unreachable' });
    expect((await unreachable).relay?.error?.certificate).toBeUndefined();

    // 中继认不得的路径（地址带了错的路径前缀）回 404。
    const rejected = relayState('connecting', 'rejected');
    await setRemote({ relay: { enabled: true, url: `ws://127.0.0.1:${relay.port}/not-a-relay` } });
    expect((await rejected).relay?.error).toMatchObject({ reason: 'rejected', httpStatus: 404 });
  });
});

describe('isCertificateError', () => {
  it('认出 Node 的 TLS 证书错误码，别的网络错误不算', () => {
    for (const code of [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    ]) {
      expect(isCertificateError(Object.assign(new Error(code), { code }))).toBe(true);
    }
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', undefined]) {
      expect(isCertificateError(Object.assign(new Error('x'), { code }))).toBe(false);
    }
  });
});
