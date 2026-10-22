// 中继的单测：真实的 socket，Host 与设备都是这里的小客户端，帧是随便的字节（中继不认识 Noise）。

import { generateKeyPairSync, sign } from 'node:crypto';
import {
  RELAY_PATHS,
  REMOTE_PATHS,
  RelayCloseCode,
  type RelayServerMessage,
  relayEndpoint,
  relayRegistrationMessage,
} from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type RawData, WebSocket } from 'ws';
import { loadConfig } from './config.js';
import type { RelayLimits } from './limits.js';
import { createLogger } from './log.js';
import { RelayServer, type RelayTapEvent } from './server.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const WAIT_MS = 3000;

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function start(
  options: { limits?: Partial<RelayLimits>; trustProxy?: boolean; logs?: string[] } = {},
) {
  const taps: RelayTapEvent[] = [];
  const relay = new RelayServer({
    ...(options.limits !== undefined && { limits: options.limits }),
    ...(options.trustProxy !== undefined && { trustProxy: options.trustProxy }),
    logger: createLogger('debug', (line) => options.logs?.push(line)),
    tap: (event) => taps.push(event),
  });
  const port = await relay.listen(0, '127.0.0.1');
  cleanups.push(() => relay.close());
  return { relay, url: `ws://127.0.0.1:${port}`, taps };
}

/** 一条 WebSocket 与它收到的东西。 */
interface Peer {
  readonly ws: WebSocket;
  readonly messages: { data: Buffer; isBinary: boolean }[];
  closed?: { code: number; reason: string };
}

function open(url: string, headers: Record<string, string> = {}): Promise<Peer> {
  const ws = new WebSocket(url, { headers });
  cleanups.push(() => ws.terminate());
  const peer: Peer = { ws, messages: [] };
  ws.on('message', (data: RawData, isBinary) =>
    peer.messages.push({ data: Buffer.from(data as Buffer), isBinary }),
  );
  ws.on('close', (code, reason) => {
    peer.closed = { code, reason: String(reason) };
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(peer));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) =>
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })),
    );
  });
}

function json(peer: Peer, index: number): RelayServerMessage | undefined {
  const message = peer.messages[index];
  return message === undefined ? undefined : JSON.parse(message.data.toString('utf8'));
}

function newRouteKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const routeId = publicKey.export({ format: 'jwk' }).x as string;
  return {
    routeId,
    sign: (nonce: string) =>
      sign(null, relayRegistrationMessage(nonce), privateKey).toString('base64url'),
  };
}

/** 连上控制连接并注册。 */
async function registerHost(url: string, key = newRouteKey()) {
  const control = await open(relayEndpoint(url, RELAY_PATHS.host));
  const challenge = await until(() => json(control, 0), 'challenge');
  if (challenge.type !== 'challenge') throw new Error('expected a challenge');
  control.ws.send(
    JSON.stringify({
      type: 'register',
      routeId: key.routeId,
      signature: key.sign(challenge.nonce),
    }),
  );
  await until(() => json(control, 1)?.type === 'registered', 'registered');
  /** 第几条 `incoming`（从 0 数）。 */
  const incoming = (n: number) =>
    until(() => {
      const list = control.messages
        .map((_, i) => json(control, i))
        .filter((m) => m?.type === 'incoming');
      return list[n] as Extract<RelayServerMessage, { type: 'incoming' }> | undefined;
    }, `incoming ${n}`);
  return { control, key, incoming };
}

function deviceUrl(url: string, routeId: string, path: string = REMOTE_PATHS.connect) {
  return relayEndpoint(url, path, { route: routeId });
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  await expect(promise).rejects.toMatchObject({ status });
}

describe('路由注册', () => {
  it('签名对了才注册；设备经路由 ID 接到 Host 的数据连接，消息原样转发', async () => {
    const { url, relay, taps } = await start();
    const host = await registerHost(url);
    expect(relay.stats().routes).toBe(1);

    const device = await open(deviceUrl(url, host.key.routeId));
    device.ws.send(Buffer.from([1, 2, 3]));
    const incoming = await host.incoming(0);
    expect(incoming.path).toBe(REMOTE_PATHS.connect);
    expect(incoming.source).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const data = await open(relayEndpoint(url, RELAY_PATHS.accept, { id: incoming.id }));
    // Host 接上之前排着的那条先到。
    await until(() => data.messages[0], 'queued message');
    expect([...(data.messages[0]?.data ?? [])]).toEqual([1, 2, 3]);
    expect(data.messages[0]?.isBinary).toBe(true);

    data.ws.send(Buffer.from('from host'));
    await until(() => device.messages[0], 'host message');
    expect(device.messages[0]?.data.toString()).toBe('from host');
    device.ws.send(Buffer.alloc(65_535, 7));
    await until(() => data.messages[1], 'large message');
    expect(data.messages[1]?.data.length).toBe(65_535);
    expect(relay.stats()).toMatchObject({ routes: 1, connections: 1, pending: 0 });
    expect(taps.map((t) => t.direction)).toEqual([
      'device-to-host',
      'host-to-device',
      'device-to-host',
    ]);

    // 同一个连接 ID 只能接一次。
    await expectStatus(open(relayEndpoint(url, RELAY_PATHS.accept, { id: incoming.id })), 404);
  });

  it('签名不对、签的不是这次的挑战、不注册或发别的都断开', async () => {
    const { url, relay } = await start({ limits: { registerTimeoutMs: 100 } });
    const key = newRouteKey();
    const other = newRouteKey();

    const forged = await open(relayEndpoint(url, RELAY_PATHS.host));
    const challenge = await until(() => json(forged, 0), 'challenge');
    if (challenge.type !== 'challenge') throw new Error('expected a challenge');
    forged.ws.send(
      JSON.stringify({
        type: 'register',
        routeId: key.routeId,
        signature: other.sign(challenge.nonce),
      }),
    );
    await until(() => forged.closed, 'close');
    expect(forged.closed?.code).toBe(RelayCloseCode.REGISTRATION_FAILED);

    const replayed = await open(relayEndpoint(url, RELAY_PATHS.host));
    await until(() => json(replayed, 0), 'challenge');
    replayed.ws.send(
      JSON.stringify({
        type: 'register',
        routeId: key.routeId,
        signature: key.sign(challenge.nonce),
      }),
    );
    await until(() => replayed.closed, 'close');
    expect(replayed.closed?.code).toBe(RelayCloseCode.REGISTRATION_FAILED);

    const silent = await open(relayEndpoint(url, RELAY_PATHS.host));
    await until(() => silent.closed, 'timeout');
    expect(silent.closed?.code).toBe(RelayCloseCode.REGISTRATION_FAILED);

    const garbage = await open(relayEndpoint(url, RELAY_PATHS.host));
    garbage.ws.send(Buffer.from([0, 1]));
    await until(() => garbage.closed, 'close');
    expect(garbage.closed?.code).toBe(RelayCloseCode.REGISTRATION_FAILED);
    expect(relay.stats().routes).toBe(0);
    // 没有注册的路由 ID：设备连不上。
    await expectStatus(open(deviceUrl(url, key.routeId)), 404);
  });

  it('同一路由 ID 再次注册取代旧的；旧的关掉不影响新的', async () => {
    const { url, relay } = await start();
    const first = await registerHost(url);
    const second = await registerHost(url, first.key);
    await until(() => first.control.closed, 'replaced');
    expect(first.control.closed?.code).toBe(RelayCloseCode.ROUTE_REPLACED);
    expect(relay.stats().routes).toBe(1);
    await open(deviceUrl(url, first.key.routeId));
    expect((await second.incoming(0)).path).toBe(REMOTE_PATHS.connect);
  });

  it('Host 离线后路由消失；等着的设备连接以 HOST_UNAVAILABLE 关闭', async () => {
    const { url, relay } = await start();
    const host = await registerHost(url);
    const device = await open(deviceUrl(url, host.key.routeId, REMOTE_PATHS.pair));
    expect((await host.incoming(0)).path).toBe(REMOTE_PATHS.pair);
    host.control.ws.close();
    await until(() => device.closed, 'device closed');
    expect(device.closed?.code).toBe(RelayCloseCode.HOST_UNAVAILABLE);
    await until(() => relay.stats().routes === 0, 'route removed');
    await expectStatus(open(deviceUrl(url, host.key.routeId)), 404);
  });

  it('普通 HTTP 只有健康检查；别的路径 404', async () => {
    const { url } = await start();
    const base = url.replace('ws://', 'http://');
    const health = await fetch(`${base}${RELAY_PATHS.health}`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', routes: 0, connections: 0 });
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}${RELAY_PATHS.host}`)).status).toBe(404);
    await expectStatus(open(`${url}/v1/other`), 404);
  });
});

describe('不做离线缓冲', () => {
  it('Host 没有及时接上：设备连接关闭，排着的消息丢掉', async () => {
    const { url, relay } = await start({ limits: { acceptTimeoutMs: 100 } });
    const host = await registerHost(url);
    const device = await open(deviceUrl(url, host.key.routeId));
    device.ws.send(Buffer.from([9]));
    const incoming = await host.incoming(0);
    await until(() => device.closed, 'timeout');
    expect(device.closed?.code).toBe(RelayCloseCode.HOST_UNAVAILABLE);
    expect(relay.stats()).toMatchObject({ connections: 0, pending: 0 });
    await expectStatus(open(relayEndpoint(url, RELAY_PATHS.accept, { id: incoming.id })), 404);
  });

  it('任一侧断开另一侧随之关闭，关闭码原样带过去；断开之后重连是一条新连接', async () => {
    const { url, relay } = await start();
    const host = await registerHost(url);
    const device = await open(deviceUrl(url, host.key.routeId));
    const data = await open(
      relayEndpoint(url, RELAY_PATHS.accept, { id: (await host.incoming(0)).id }),
    );
    data.ws.close(4007, 'device removed');
    await until(() => device.closed, 'device closed');
    expect(device.closed).toEqual({ code: 4007, reason: 'device removed' });

    const again = await open(deviceUrl(url, host.key.routeId));
    const second = await host.incoming(1);
    const data2 = await open(relayEndpoint(url, RELAY_PATHS.accept, { id: second.id }));
    again.ws.terminate();
    await until(() => data2.closed, 'host side closed');
    // 设备不发关闭帧就断开：Host 那侧也是直接断开。
    expect(data2.closed?.code).toBe(1006);
    await until(() => relay.stats().connections === 0, 'no connections');
  });

  it('Host 接上之前排的消息有上限', async () => {
    const { url } = await start({ limits: { maxQueuedMessages: 2 } });
    const host = await registerHost(url);
    const device = await open(deviceUrl(url, host.key.routeId));
    for (let i = 0; i < 3; i += 1) device.ws.send(Buffer.from([i]));
    await until(() => device.closed, 'closed');
    expect(device.closed?.code).toBe(RelayCloseCode.LIMIT_EXCEEDED);
  });

  it('Host 拒绝的连接以 HOST_REJECTED 关闭', async () => {
    const { url } = await start();
    const host = await registerHost(url);
    const device = await open(deviceUrl(url, host.key.routeId, REMOTE_PATHS.pairCode));
    const incoming = await host.incoming(0);
    host.control.ws.send(JSON.stringify({ type: 'reject', id: incoming.id }));
    await until(() => device.closed, 'closed');
    expect(device.closed?.code).toBe(RelayCloseCode.HOST_REJECTED);
  });

  it('数据连接上的文本消息两侧都断开', async () => {
    const { url } = await start();
    const host = await registerHost(url);
    const device = await open(deviceUrl(url, host.key.routeId));
    const data = await open(
      relayEndpoint(url, RELAY_PATHS.accept, { id: (await host.incoming(0)).id }),
    );
    device.ws.send('plain text');
    await until(() => device.closed && data.closed, 'both closed');
    expect(device.closed?.code).toBe(RelayCloseCode.PROTOCOL_ERROR);
    expect(data.closed?.code).toBe(RelayCloseCode.PROTOCOL_ERROR);
    expect(data.messages).toEqual([]);
  });
});

describe('限制', () => {
  it('每个来源的发起频率与同时的连接数', async () => {
    const { url } = await start({ limits: { connectsPerMinutePerSource: 3 } });
    const host = await registerHost(url);
    await open(deviceUrl(url, host.key.routeId));
    await open(deviceUrl(url, host.key.routeId));
    await expectStatus(open(deviceUrl(url, host.key.routeId)), 429);

    const second = await start({ limits: { maxConnectionsPerSource: 2 } });
    const a = await registerHost(second.url);
    const device = await open(deviceUrl(second.url, a.key.routeId));
    await expectStatus(open(deviceUrl(second.url, a.key.routeId)), 429);
    device.ws.close();
    await until(() => device.closed, 'closed');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await open(deviceUrl(second.url, a.key.routeId));
  });

  it('反向代理后面按 X-Forwarded-For 的最后一项限速', async () => {
    const { url } = await start({ trustProxy: true, limits: { connectsPerMinutePerSource: 1 } });
    const proxied = (client: string) => ({ 'X-Forwarded-For': `1.1.1.1, ${client}` });
    const control = await open(relayEndpoint(url, RELAY_PATHS.host), proxied('10.0.0.1'));
    await until(() => json(control, 0), 'challenge');
    await open(`${url}${RELAY_PATHS.host}`, proxied('10.0.0.2'));
    await expectStatus(open(`${url}${RELAY_PATHS.host}`, proxied('10.0.0.2')), 429);
  });

  it('路由数与每个路由的连接数', async () => {
    const { url } = await start({ limits: { maxRoutes: 1, maxConnectionsPerRoute: 1 } });
    const host = await registerHost(url);
    const second = await open(relayEndpoint(url, RELAY_PATHS.host));
    const challenge = await until(() => json(second, 0), 'challenge');
    if (challenge.type !== 'challenge') throw new Error('expected a challenge');
    const key = newRouteKey();
    second.ws.send(
      JSON.stringify({
        type: 'register',
        routeId: key.routeId,
        signature: key.sign(challenge.nonce),
      }),
    );
    await until(() => second.closed, 'closed');
    expect(second.closed?.code).toBe(RelayCloseCode.LIMIT_EXCEEDED);

    await open(deviceUrl(url, host.key.routeId));
    await expectStatus(open(deviceUrl(url, host.key.routeId)), 503);
  });

  it('超过带宽时暂停读那一侧，消息延后但一条不丢', async () => {
    const { url } = await start({ limits: { bytesPerSecond: 200_000, burstBytes: 100_000 } });
    const host = await registerHost(url);
    const device = await open(deviceUrl(url, host.key.routeId));
    const data = await open(
      relayEndpoint(url, RELAY_PATHS.accept, { id: (await host.incoming(0)).id }),
    );
    const startedAt = Date.now();
    // 一共 400 KB：桶里 100 KB，其余 300 KB 按 200 KB/s 要 1.5 s 左右。
    for (let i = 0; i < 8; i += 1) device.ws.send(Buffer.alloc(50_000, i));
    await until(() => data.messages.length === 8, 'all messages');
    expect(Date.now() - startedAt).toBeGreaterThan(1000);
    expect(data.messages.map((m) => m.data[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('日志里没有路由 ID 与来源地址', async () => {
    const logs: string[] = [];
    const { url } = await start({ logs });
    const host = await registerHost(url);
    const device = await open(deviceUrl(url, host.key.routeId));
    const data = await open(
      relayEndpoint(url, RELAY_PATHS.accept, { id: (await host.incoming(0)).id }),
    );
    device.ws.send(Buffer.from('secret-bytes'));
    await until(() => data.messages[0], 'message');
    data.ws.close(1000);
    await until(() => device.closed, 'closed');
    await until(() => logs.some((line) => line.includes('connection closed')), 'close log');
    const text = logs.join('\n');
    expect(text).toContain('host registered');
    expect(text).not.toContain(host.key.routeId);
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('secret-bytes');
  });
});

describe('loadConfig', () => {
  it('默认值与环境变量', () => {
    expect(loadConfig({})).toMatchObject({ port: 8080, host: '0.0.0.0', trustProxy: false });
    const config = loadConfig({
      WEVIR_RELAY_PORT: '9000',
      WEVIR_RELAY_TRUST_PROXY: 'true',
      WEVIR_RELAY_BYTES_PER_SECOND: '1000',
      WEVIR_RELAY_LOG_LEVEL: 'warn',
    });
    expect(config).toMatchObject({ port: 9000, trustProxy: true, logLevel: 'warn' });
    expect(config.limits.bytesPerSecond).toBe(1000);
    expect(() => loadConfig({ WEVIR_RELAY_PORT: 'x' })).toThrow(/WEVIR_RELAY_PORT/);
    expect(() => loadConfig({ WEVIR_RELAY_MAX_ROUTES: '0' })).toThrow(/WEVIR_RELAY_MAX_ROUTES/);
    expect(() => loadConfig({ WEVIR_RELAY_LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
    expect(() => loadConfig({ WEVIR_RELAY_TLS_CERT: '/x' })).toThrow(/TLS/);
  });
});
