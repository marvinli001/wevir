// 中继的协议测试（`@wevir/relay/conformance`，只给测试用）：对着一个中继地址跑，只看线缆上能看到的东西（升级前的状态码、控制消息、
// 转发的字节、关闭码），不看实现内部。apps/relay（Node）与 apps/relay-worker（Cloudflare Workers）都跑这一套；各自的测试文件只管
// 怎么起一个带指定限制的中继。Host 与设备都是这里的小客户端，帧是随便的字节（中继不认识 Noise）。

import { generateKeyPairSync, sign } from 'node:crypto';
import {
  RELAY_MAX_MESSAGE_BYTES,
  RELAY_PATHS,
  REMOTE_PATHS,
  RelayCloseCode,
  type RelayServerMessage,
  relayEndpoint,
  relayRegistrationMessage,
} from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type RawData, WebSocket } from 'ws';

/** 测试要改的限制（apps/relay 的 `RelayLimits` 里两种实现都有的那几项）。省略的用默认值。 */
export interface ConformanceLimits {
  registerTimeoutMs?: number;
  acceptTimeoutMs?: number;
  maxQueuedMessages?: number;
  connectsPerMinutePerSource?: number;
  maxConnectionsPerRoute?: number;
}

export interface ConformanceRelay {
  /** `ws://…`，可以带路径前缀。 */
  readonly url: string;
  close(): Promise<void>;
}

export type StartRelay = (limits: ConformanceLimits) => Promise<ConformanceRelay>;

/**
 * 不发关闭帧的断开在对端看到的码：apps/relay 直接断开 TCP（1006）；Workers 断不了 TCP，只能发不带状态码的关闭帧（1005）。客户端
 * 对两者的处理相同（都不是中继的关闭码）。
 */
export const ABRUPT_CLOSE_CODES = [1005, 1006];

const WAIT_MS = 5000;

export async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 一条 WebSocket 与它收到的东西。 */
export interface Peer {
  readonly ws: WebSocket;
  readonly messages: { data: Buffer; isBinary: boolean }[];
  pongs: number;
  closed?: { code: number; reason: string };
}

export function json(peer: Peer, index: number): RelayServerMessage | undefined {
  const message = peer.messages[index];
  return message === undefined ? undefined : JSON.parse(message.data.toString('utf8'));
}

export function newRouteKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const routeId = publicKey.export({ format: 'jwk' }).x as string;
  return {
    routeId,
    sign: (nonce: string) =>
      sign(null, relayRegistrationMessage(nonce), privateKey).toString('base64url'),
  };
}

export function deviceUrl(url: string, routeId: string, path: string = REMOTE_PATHS.connect) {
  return relayEndpoint(url, path, { route: routeId });
}

export function acceptUrl(url: string, id: string) {
  return relayEndpoint(url, RELAY_PATHS.accept, { id });
}

export async function expectStatus(promise: Promise<unknown>, status: number) {
  await expect(promise).rejects.toMatchObject({ status });
}

/** 测试里开 WebSocket 与注册 Host 的工具；开的连接在每个测试结束时断开。 */
export function relayTestKit() {
  const cleanups: (() => unknown)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function open(url: string, headers: Record<string, string> = {}): Promise<Peer> {
    const ws = new WebSocket(url, { headers });
    cleanups.push(() => ws.terminate());
    const peer: Peer = { ws, messages: [], pongs: 0 };
    ws.on('message', (data: RawData, isBinary) =>
      peer.messages.push({ data: Buffer.from(data as Buffer), isBinary }),
    );
    ws.on('pong', () => {
      peer.pongs += 1;
    });
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

  /** 等到这个路由 ID 上没有 Host：设备连过去是 404。 */
  async function untilOffline(url: string, routeId: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      try {
        const device = await open(deviceUrl(url, routeId));
        device.ws.terminate();
      } catch (error) {
        if ((error as { status?: number }).status === 404) return;
        throw error;
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for the route to go away');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  return { cleanups, open, registerHost, untilOffline };
}

/** 线路协议的测试：两种中继实现都要通过。 */
export function describeRelayConformance(start: StartRelay): void {
  const { cleanups, open, registerHost, untilOffline } = relayTestKit();

  async function relay(limits: ConformanceLimits = {}): Promise<string> {
    const started = await start(limits);
    cleanups.push(() => started.close());
    return started.url;
  }

  describe('路由注册', () => {
    it('签名对了才注册；设备经路由 ID 接到 Host 的数据连接，消息原样转发', async () => {
      const url = await relay();
      const host = await registerHost(url);
      const device = await open(deviceUrl(url, host.key.routeId));
      device.ws.send(Buffer.from([1, 2, 3]));
      const incoming = await host.incoming(0);
      expect(incoming.path).toBe(REMOTE_PATHS.connect);
      expect(incoming.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(incoming.source).toMatch(/^[A-Za-z0-9_-]{16}$/);
      const data = await open(acceptUrl(url, incoming.id));
      // Host 接上之前排着的那条先到。
      await until(() => data.messages[0], 'queued message');
      expect([...(data.messages[0]?.data ?? [])]).toEqual([1, 2, 3]);
      expect(data.messages[0]?.isBinary).toBe(true);

      data.ws.send(Buffer.from('from host'));
      await until(() => device.messages[0], 'host message');
      expect(device.messages[0]?.data.toString()).toBe('from host');
      expect(device.messages[0]?.isBinary).toBe(true);
      device.ws.send(Buffer.alloc(RELAY_MAX_MESSAGE_BYTES, 7));
      await until(() => data.messages[1], 'large message');
      expect(data.messages[1]?.data.length).toBe(RELAY_MAX_MESSAGE_BYTES);

      // 同一个连接 ID 只能接一次。
      await expectStatus(open(acceptUrl(url, incoming.id)), 404);
    });

    it('三个设备路径都通知 Host 设备连的是哪个；同一来源的标记相同', async () => {
      const url = await relay();
      const host = await registerHost(url);
      const paths = [REMOTE_PATHS.pair, REMOTE_PATHS.pairCode, REMOTE_PATHS.connect];
      for (const path of paths) await open(deviceUrl(url, host.key.routeId, path));
      const seen = await Promise.all(paths.map((_, i) => host.incoming(i)));
      expect(seen.map((m) => m.path).sort()).toEqual([...paths].sort());
      expect(new Set(seen.map((m) => m.source)).size).toBe(1);
      expect(new Set(seen.map((m) => m.id)).size).toBe(3);
    });

    it('签名不对、签的不是这次的挑战、不注册或发别的都断开', async () => {
      const url = await relay({ registerTimeoutMs: 300 });
      const key = newRouteKey();
      const other = newRouteKey();

      const forged = await open(relayEndpoint(url, RELAY_PATHS.host));
      const challenge = await until(() => json(forged, 0), 'challenge');
      if (challenge.type !== 'challenge') throw new Error('expected a challenge');
      expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
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
      // 没有注册的路由 ID：设备连不上。
      await expectStatus(open(deviceUrl(url, key.routeId)), 404);
    });

    it('注册之后的控制连接上发别的以 PROTOCOL_ERROR 断开', async () => {
      const url = await relay();
      const host = await registerHost(url);
      host.control.ws.send(JSON.stringify({ type: 'hello' }));
      await until(() => host.control.closed, 'close');
      expect(host.control.closed?.code).toBe(RelayCloseCode.PROTOCOL_ERROR);
    });

    it('同一路由 ID 再次注册取代旧的；旧的关掉不影响新的', async () => {
      const url = await relay();
      const first = await registerHost(url);
      const second = await registerHost(url, first.key);
      await until(() => first.control.closed, 'replaced');
      expect(first.control.closed?.code).toBe(RelayCloseCode.ROUTE_REPLACED);
      await open(deviceUrl(url, first.key.routeId));
      expect((await second.incoming(0)).path).toBe(REMOTE_PATHS.connect);
      expect(first.control.messages.map((_, i) => json(first.control, i)?.type)).not.toContain(
        'incoming',
      );
    });

    it('Host 离线后路由消失；等着的设备连接以 HOST_UNAVAILABLE 关闭', async () => {
      const url = await relay();
      const host = await registerHost(url);
      const device = await open(deviceUrl(url, host.key.routeId, REMOTE_PATHS.pair));
      expect((await host.incoming(0)).path).toBe(REMOTE_PATHS.pair);
      host.control.ws.close();
      await until(() => device.closed, 'device closed');
      expect(device.closed?.code).toBe(RelayCloseCode.HOST_UNAVAILABLE);
      await untilOffline(url, host.key.routeId);
    });

    it('普通 HTTP 只有健康检查；别的路径 404', async () => {
      const url = await relay();
      const base = url.replace('ws://', 'http://');
      const health = await fetch(`${base}${RELAY_PATHS.health}`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: 'ok' });
      expect((await fetch(`${base}${RELAY_PATHS.health}`, { method: 'HEAD' })).status).toBe(200);
      expect((await fetch(`${base}/`)).status).toBe(404);
      expect((await fetch(`${base}${RELAY_PATHS.host}`)).status).toBe(404);
      expect((await fetch(`${base}${REMOTE_PATHS.connect}`)).status).toBe(404);
      await expectStatus(open(`${url}/v1/other`), 404);
      // 参数不对的设备连接与数据连接。
      await expectStatus(open(deviceUrl(url, 'not-a-key')), 404);
      await expectStatus(open(`${url}${REMOTE_PATHS.connect}`), 404);
      await expectStatus(open(acceptUrl(url, 'AAAAAAAAAAAAAAAAAAAAAA')), 404);
      await expectStatus(open(acceptUrl(url, 'short')), 404);
    });

    it('带 Origin 的升级照常（网页客户端只能经中继）', async () => {
      const url = await relay();
      const origin = { Origin: 'https://web.wevir.si' };
      const host = await registerHost(url);
      const device = await open(deviceUrl(url, host.key.routeId), origin);
      const data = await open(acceptUrl(url, (await host.incoming(0)).id), origin);
      device.ws.send(Buffer.from([5]));
      await until(() => data.messages[0], 'message');
      expect([...(data.messages[0]?.data ?? [])]).toEqual([5]);
    });

    it('回应 WebSocket 的 ping', async () => {
      const url = await relay();
      const host = await registerHost(url);
      host.control.ws.ping();
      await until(() => host.control.pongs > 0, 'pong on the control connection');
      const device = await open(deviceUrl(url, host.key.routeId));
      const data = await open(acceptUrl(url, (await host.incoming(0)).id));
      device.ws.ping();
      data.ws.ping();
      await until(() => device.pongs > 0 && data.pongs > 0, 'pongs on the data connections');
    });
  });

  describe('不做离线缓冲', () => {
    it('Host 没有及时接上：设备连接关闭，排着的消息丢掉', async () => {
      const url = await relay({ acceptTimeoutMs: 300 });
      const host = await registerHost(url);
      const device = await open(deviceUrl(url, host.key.routeId));
      device.ws.send(Buffer.from([9]));
      const incoming = await host.incoming(0);
      await until(() => device.closed, 'timeout');
      expect(device.closed?.code).toBe(RelayCloseCode.HOST_UNAVAILABLE);
      await expectStatus(open(acceptUrl(url, incoming.id)), 404);
    });

    it('任一侧断开另一侧随之关闭，关闭码原样带过去；断开之后重连是一条新连接', async () => {
      const url = await relay();
      const host = await registerHost(url);
      const device = await open(deviceUrl(url, host.key.routeId));
      const data = await open(acceptUrl(url, (await host.incoming(0)).id));
      data.ws.close(4007, 'device removed');
      await until(() => device.closed, 'device closed');
      expect(device.closed).toEqual({ code: 4007, reason: 'device removed' });

      const again = await open(deviceUrl(url, host.key.routeId));
      const second = await host.incoming(1);
      const data2 = await open(acceptUrl(url, second.id));
      again.ws.close(1000, 'bye');
      await until(() => data2.closed, 'host side closed');
      expect(data2.closed).toEqual({ code: 1000, reason: 'bye' });

      const third = await open(deviceUrl(url, host.key.routeId));
      const data3 = await open(acceptUrl(url, (await host.incoming(2)).id));
      third.ws.terminate();
      await until(() => data3.closed, 'host side closed');
      // 设备不发关闭帧就断开：Host 那侧也不带关闭码。
      expect(ABRUPT_CLOSE_CODES).toContain(data3.closed?.code);
    });

    it('Host 的数据连接不发关闭帧就断开：设备那侧也不带关闭码', async () => {
      const url = await relay();
      const host = await registerHost(url);
      const device = await open(deviceUrl(url, host.key.routeId));
      const data = await open(acceptUrl(url, (await host.incoming(0)).id));
      data.ws.terminate();
      await until(() => device.closed, 'device closed');
      expect(ABRUPT_CLOSE_CODES).toContain(device.closed?.code);
    });

    it('Host 接上之前排的消息有上限', async () => {
      const url = await relay({ maxQueuedMessages: 2 });
      const host = await registerHost(url);
      const device = await open(deviceUrl(url, host.key.routeId));
      for (let i = 0; i < 3; i += 1) device.ws.send(Buffer.from([i]));
      await until(() => device.closed, 'closed');
      expect(device.closed?.code).toBe(RelayCloseCode.LIMIT_EXCEEDED);
    });

    it('Host 拒绝的连接以 HOST_REJECTED 关闭', async () => {
      const url = await relay();
      const host = await registerHost(url);
      const device = await open(deviceUrl(url, host.key.routeId, REMOTE_PATHS.pairCode));
      const incoming = await host.incoming(0);
      host.control.ws.send(JSON.stringify({ type: 'reject', id: incoming.id }));
      await until(() => device.closed, 'closed');
      expect(device.closed?.code).toBe(RelayCloseCode.HOST_REJECTED);
      await expectStatus(open(acceptUrl(url, incoming.id)), 404);
    });

    it('数据连接上的文本消息两侧都断开', async () => {
      const url = await relay();
      const host = await registerHost(url);
      const device = await open(deviceUrl(url, host.key.routeId));
      const data = await open(acceptUrl(url, (await host.incoming(0)).id));
      device.ws.send('plain text');
      await until(() => device.closed && data.closed, 'both closed');
      expect(device.closed?.code).toBe(RelayCloseCode.PROTOCOL_ERROR);
      expect(data.closed?.code).toBe(RelayCloseCode.PROTOCOL_ERROR);
      expect(data.messages).toEqual([]);
    });

    it('超过一条 Noise 消息长度的消息断开连接，不转发', async () => {
      const url = await relay();
      const host = await registerHost(url);
      const device = await open(deviceUrl(url, host.key.routeId));
      const data = await open(acceptUrl(url, (await host.incoming(0)).id));
      device.ws.send(Buffer.alloc(RELAY_MAX_MESSAGE_BYTES + 1));
      await until(() => device.closed && data.closed, 'both closed');
      // apps/relay 是 `ws` 的 1009；Workers 不能设单条消息的上限，由中继以 PROTOCOL_ERROR 关闭。
      expect([1009, RelayCloseCode.PROTOCOL_ERROR]).toContain(device.closed?.code);
      expect(data.messages).toEqual([]);
    });
  });

  describe('限制', () => {
    it('每个来源的发起频率', async () => {
      const url = await relay({ connectsPerMinutePerSource: 3 });
      const host = await registerHost(url);
      await open(deviceUrl(url, host.key.routeId));
      await open(deviceUrl(url, host.key.routeId));
      await expectStatus(open(deviceUrl(url, host.key.routeId)), 429);
      await expectStatus(open(relayEndpoint(url, RELAY_PATHS.host)), 429);
    });

    it('每个路由的连接数（等着的与接通的合计）', async () => {
      const url = await relay({ maxConnectionsPerRoute: 2 });
      const host = await registerHost(url);
      const first = await open(deviceUrl(url, host.key.routeId));
      await open(acceptUrl(url, (await host.incoming(0)).id));
      await open(deviceUrl(url, host.key.routeId));
      await expectStatus(open(deviceUrl(url, host.key.routeId)), 503);
      // 一条结束了就空出一个名额。
      first.ws.close(1000);
      await until(() => first.closed, 'closed');
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        try {
          await open(deviceUrl(url, host.key.routeId));
          break;
        } catch (error) {
          if ((error as { status?: number }).status !== 503 || Date.now() > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    });
  });
}
