// 中继的单测：线路协议的部分是共用的协议测试（conformance.ts，apps/relay-worker 也跑），这里另外测只有 Node 实现才有的：计数、tap、
// 路由总数、反向代理后的来源地址、每个来源同时的连接数、带宽、日志与环境变量。

import { RELAY_PATHS, RelayCloseCode, relayEndpoint } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import {
  acceptUrl,
  type ConformanceLimits,
  describeRelayConformance,
  deviceUrl,
  expectStatus,
  json,
  newRouteKey,
  relayTestKit,
  until,
} from './conformance.js';
import type { RelayLimits } from './limits.js';
import { createLogger } from './log.js';
import { RelayServer, type RelayTapEvent } from './server.js';

describe('协议测试', () => {
  describeRelayConformance(async (limits: ConformanceLimits) => {
    const relay = new RelayServer({ limits });
    const port = await relay.listen(0, '127.0.0.1');
    return { url: `ws://127.0.0.1:${port}`, close: () => relay.close() };
  });
});

const { cleanups, open, registerHost } = relayTestKit();

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

describe('只有 Node 实现才有的', () => {
  it('计数与 tap：中继转发的就是收到的字节', async () => {
    const { url, relay, taps } = await start();
    const host = await registerHost(url);
    expect(relay.stats().routes).toBe(1);
    const device = await open(deviceUrl(url, host.key.routeId));
    device.ws.send(Buffer.from([1, 2, 3]));
    const data = await open(acceptUrl(url, (await host.incoming(0)).id));
    await until(() => data.messages[0], 'queued message');
    data.ws.send(Buffer.from('from host'));
    await until(() => device.messages[0], 'host message');
    expect(relay.stats()).toMatchObject({ routes: 1, connections: 1, pending: 0 });
    expect(taps.map((t) => [t.direction, [...t.data]])).toEqual([
      ['device-to-host', [1, 2, 3]],
      ['host-to-device', [...Buffer.from('from host')]],
    ]);
    data.ws.close(1000);
    await until(() => relay.stats().connections === 0, 'no connections');
    host.control.ws.close();
    await until(() => relay.stats().routes === 0, 'route removed');
  });

  it('健康检查带计数', async () => {
    const { url } = await start();
    const health = await fetch(`${url.replace('ws://', 'http://')}${RELAY_PATHS.health}`);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      routes: 0,
      connections: 0,
      pending: 0,
    });
  });

  it('每个来源同时的连接数', async () => {
    const { url } = await start({ limits: { maxConnectionsPerSource: 2 } });
    const a = await registerHost(url);
    const device = await open(deviceUrl(url, a.key.routeId));
    await expectStatus(open(deviceUrl(url, a.key.routeId)), 429);
    device.ws.close();
    await until(() => device.closed, 'closed');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await open(deviceUrl(url, a.key.routeId));
  });

  it('反向代理后面按 X-Forwarded-For 的最后一项限速', async () => {
    const { url } = await start({ trustProxy: true, limits: { connectsPerMinutePerSource: 1 } });
    const proxied = (client: string) => ({ 'X-Forwarded-For': `1.1.1.1, ${client}` });
    const control = await open(relayEndpoint(url, RELAY_PATHS.host), proxied('10.0.0.1'));
    await until(() => json(control, 0), 'challenge');
    await open(`${url}${RELAY_PATHS.host}`, proxied('10.0.0.2'));
    await expectStatus(open(`${url}${RELAY_PATHS.host}`, proxied('10.0.0.2')), 429);
  });

  it('路由数', async () => {
    const { url } = await start({ limits: { maxRoutes: 1 } });
    await registerHost(url);
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
  });

  it('超过带宽时暂停读那一侧，消息延后但一条不丢', async () => {
    const { url } = await start({ limits: { bytesPerSecond: 200_000, burstBytes: 100_000 } });
    const host = await registerHost(url);
    const device = await open(deviceUrl(url, host.key.routeId));
    const data = await open(acceptUrl(url, (await host.incoming(0)).id));
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
    const data = await open(acceptUrl(url, (await host.incoming(0)).id));
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
