// WevirClient 对着可编程的假 Host（test-utils.ts 的 FakeHost）：握手、类型化的请求与错误、三种超时、
// 心跳、重连与订阅的边界情况。对着真实 Host 的验收在 client.integration.test.ts。

import { CLIENT_CAPABILITIES, ErrorCode, PROTOCOL_VERSION } from '@wevir/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIENT_CAPABILITIES } from './capabilities.js';
import { type ConnectionState, WevirClient, type WevirClientOptions } from './client.js';
import {
  ClientClosedError,
  ConnectionLostError,
  ConnectTimeoutError,
  FeatureUnavailableError,
  isRpcError,
  ProtocolError,
  RequestTimeoutError,
  WevirRpcError,
} from './errors.js';
import type { SubscriptionItem } from './subscription.js';
import { event, FakeHost, HELLO, identity, SES } from './test-utils.js';

const ENDPOINT = { url: 'ws://127.0.0.1:43123/', token: 'secret-token' };
const clients: WevirClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

async function connect(host: FakeHost, options: Partial<WevirClientOptions> = {}) {
  const states: ConnectionState[] = [];
  const warnings: string[] = [];
  const client = await WevirClient.connect({
    endpoint: ENDPOINT,
    transport: host.transport,
    identity,
    timeouts: { requestMs: 1000, connectMs: 300 },
    reconnect: { initialDelayMs: 5, maxDelayMs: 20, authInitialDelayMs: 40, authMaxDelayMs: 80 },
    onStateChange: (state) => states.push(state),
    onWarning: (message) => warnings.push(message),
    ...options,
  });
  clients.push(client);
  const statuses = () =>
    states.map((s) => (s.status === 'reconnecting' ? `reconnecting:${s.reason}` : s.status));
  return { client, states, statuses, warnings };
}

/** 迭代订阅，收集到 `count` 项为止。 */
async function take(
  iterator: AsyncIterator<SubscriptionItem>,
  count: number,
): Promise<SubscriptionItem[]> {
  const items: SubscriptionItem[] = [];
  while (items.length < count) {
    const next = await iterator.next();
    if (next.done) break;
    items.push(next.value);
  }
  return items;
}

function seqs(items: SubscriptionItem[]): Array<number | string> {
  return items.map((item) =>
    item.type === 'event'
      ? item.event.seq
      : item.type === 'caught_up'
        ? `caught_up@${item.seq}`
        : 'reset',
  );
}

/** 等假 Host 用 setTimeout(0) 发出的回复到达。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/** 按顺序分配 subscriptionId、`replayedThroughSeq` 取 `through()` 的订阅处理函数。 */
function subscribeHandler(host: FakeHost, through: () => number) {
  let next = 1;
  host.on('events.subscribe', () => ({
    result: { subscriptionId: `sub_${next++}`, replayedThroughSeq: through() },
  }));
  host.on('events.unsubscribe', () => ({ result: {} }));
}

describe('连接与握手', () => {
  it('照用端点的 url，hello 带令牌、协议版本、身份与默认能力表；状态 connecting → connected', async () => {
    const host = new FakeHost();
    const { client, statuses } = await connect(host);
    expect(host.last.url).toBe(ENDPOINT.url);
    expect(host.last.requests('host.hello')[0]?.params).toEqual({
      token: ENDPOINT.token,
      protocolVersion: PROTOCOL_VERSION,
      ...identity,
      capabilities: DEFAULT_CLIENT_CAPABILITIES,
    });
    expect(client.hello).toEqual(HELLO);
    expect(client.state).toEqual({ status: 'connected', hello: HELLO });
    expect(statuses()).toEqual(['connecting', 'connected']);
  });

  it('默认能力表穷举 protocol 的全部能力位', () => {
    expect(Object.keys(DEFAULT_CLIENT_CAPABILITIES).sort()).toEqual(
      Object.values(CLIENT_CAPABILITIES).sort(),
    );
  });

  it('功能只在一处判断：Host 声明了才算支持，requireFeature 不支持时报 FeatureUnavailableError', async () => {
    const host = new FakeHost().on('host.hello', () => ({
      result: { ...HELLO, features: { 'session.fork': true, 'session.share': false } },
    }));
    const { client } = await connect(host);
    // v0 的 HostFeature 是空集，这里用将来的功能名演示。
    expect(client.supports('session.fork' as never)).toBe(true);
    expect(client.supports('session.share' as never)).toBe(false);
    expect(() => client.requireFeature('session.share' as never)).toThrow(FeatureUnavailableError);
  });

  it('首次连接失败直接 reject：连不上、连接超时、令牌错误、协议不兼容、hello 结果不合 schema', async () => {
    const refused = new FakeHost();
    refused.autoOpen = false;
    const refusing = WevirClient.connect({
      endpoint: ENDPOINT,
      transport: refused.transport,
      identity,
    });
    await vi.waitFor(() => expect(refused.sockets).toHaveLength(1));
    refused.last.drop(1006);
    await expect(refusing).rejects.toBeInstanceOf(ConnectionLostError);

    const silent = new FakeHost();
    silent.autoOpen = false;
    await expect(connect(silent, { timeouts: { connectMs: 30 } })).rejects.toBeInstanceOf(
      ConnectTimeoutError,
    );
    expect(silent.last.closedByClient).toBeDefined();

    const unauthorized = new FakeHost().on('host.hello', () => ({
      error: { code: ErrorCode.UNAUTHORIZED, message: 'unauthorized' },
    }));
    const error = await connect(unauthorized).catch((e: unknown) => e);
    expect(isRpcError(error, 'UNAUTHORIZED')).toBe(true);

    const incompatible = new FakeHost().on('host.hello', () => ({
      error: {
        code: ErrorCode.INCOMPATIBLE_PROTOCOL,
        message: 'incompatible protocol version',
        data: { hostVersion: '9.0.0', protocolVersion: '9.0.0', minProtocolVersion: '9.0.0' },
      },
    }));
    const rejected = await connect(incompatible).catch((e: unknown) => e);
    expect(isRpcError(rejected, 'INCOMPATIBLE_PROTOCOL')).toBe(true);
    expect((rejected as WevirRpcError).data).toEqual({
      hostVersion: '9.0.0',
      protocolVersion: '9.0.0',
      minProtocolVersion: '9.0.0',
    });

    const malformed = new FakeHost().on('host.hello', () => ({ result: { hostId: 'nope' } }));
    await expect(connect(malformed)).rejects.toBeInstanceOf(ProtocolError);
  });

  it('传输层在构造期间同步报告连不上：首次连接以 ConnectionLostError 失败', async () => {
    const error = await WevirClient.connect({
      endpoint: ENDPOINT,
      identity,
      transport: (_url, handlers) => {
        handlers.onClose({ code: 1006, reason: 'refused' });
        return { send: () => {}, close: () => {} };
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect(error).toMatchObject({ closeCode: 1006 });
  });

  it('端点解析函数在每次连接尝试前调用（Host 重启换了端口和令牌也能连上）', async () => {
    const host = new FakeHost();
    let n = 0;
    const endpoint = vi.fn(() => ({ url: `ws://127.0.0.1:${4000 + ++n}/`, token: `t${n}` }));
    await connect(host, { endpoint });
    host.last.drop();
    await vi.waitFor(() => expect(host.sockets).toHaveLength(2));
    await vi.waitFor(() => expect(host.last.requests('host.hello')).toHaveLength(1));
    expect(endpoint).toHaveBeenCalledTimes(2);
    expect(host.last.url).toBe('ws://127.0.0.1:4002/');
    expect(host.last.requests('host.hello')[0]?.params.token).toBe('t2');
  });
});

describe('请求', () => {
  it('结果按 schema 解析（剥离未知字段）；没有必填参数的方法可以省略 params', async () => {
    const host = new FakeHost().on('workspace.list', () => ({
      result: { workspaces: [], addedInAFutureVersion: true },
    }));
    const { client } = await connect(host);
    expect(await client.request('workspace.list')).toEqual({ workspaces: [] });
    expect(host.last.requests('workspace.list')[0]?.params).toEqual({});
  });

  it('Host 回的错误映射为 WevirRpcError：按错误码名收窄并解析 data；不认识的错误码与不合 schema 的 data 原样保留', async () => {
    const busy = {
      code: ErrorCode.SESSION_BUSY,
      message: 'session is busy',
      data: {
        state: 'running',
        activeTurn: { turnId: 'trn_1', startedAt: '2026-10-13T00:00:00.000Z' },
      },
    };
    const host = new FakeHost()
      .on('session.send', () => ({ error: busy }))
      .on('session.cancel', () => ({
        error: { code: -32099, message: 'from the future', data: 1 },
      }))
      .on('session.close', () => ({
        error: { code: ErrorCode.SESSION_BUSY, message: 'busy', data: { state: 'dancing' } },
      }));
    const { client } = await connect(host);
    const error = await client
      .request('session.send', { sessionId: SES, content: [{ type: 'text', text: 'hi' }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WevirRpcError);
    if (!isRpcError(error, 'SESSION_BUSY')) throw new Error('expected SESSION_BUSY');
    expect(error).toMatchObject({
      method: 'session.send',
      code: -32021,
      message: 'session is busy',
    });
    expect(error.data?.state).toBe('running');
    expect(error.data?.activeTurn?.turnId).toBe('trn_1');
    expect(error.is('ALREADY_DECIDED')).toBe(false);

    const unknown = (await client
      .request('session.cancel', { sessionId: SES })
      .catch((e) => e)) as WevirRpcError;
    expect(unknown).toMatchObject({
      code: -32099,
      codeName: undefined,
      data: undefined,
      rawData: 1,
    });

    const odd = (await client
      .request('session.close', { sessionId: SES })
      .catch((e) => e)) as WevirRpcError;
    expect(odd).toMatchObject({
      codeName: 'SESSION_BUSY',
      data: undefined,
      rawData: { state: 'dancing' },
    });
  });

  it('结果不合 schema 报 ProtocolError', async () => {
    const host = new FakeHost().on('workspace.list', () => ({ result: { workspaces: 'nope' } }));
    const { client } = await connect(host);
    await expect(client.request('workspace.list')).rejects.toBeInstanceOf(ProtocolError);
  });

  it('请求超时报 RequestTimeoutError（sent: true），迟到的响应被忽略', async () => {
    const host = new FakeHost().on('workspace.list', () => 'no-reply');
    const { client } = await connect(host);
    const error = await client.request('workspace.list', {}, { timeoutMs: 20 }).catch((e) => e);
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(error).toMatchObject({ method: 'workspace.list', timeoutMs: 20, sent: true });
    const id = host.last.requests('workspace.list')[0]?.id as number;
    host.last.reply(id, { result: { workspaces: [] } });
    expect(await client.request('host.ping')).toEqual({});
  });

  it('已发出的请求遇到断线报 ConnectionLostError，不重发；断线期间的请求排队，重连后发出', async () => {
    const host = new FakeHost().on('workspace.list', () => 'no-reply');
    const { client } = await connect(host, { reconnect: { initialDelayMs: 50 } });
    const first = host.last;
    const inflight = client.request('workspace.list');
    await vi.waitFor(() => expect(first.requests('workspace.list')).toHaveLength(1));
    first.drop(1001, 'host is shutting down');
    const lost = await inflight.catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(ConnectionLostError);
    expect(lost).toMatchObject({ method: 'workspace.list', closeCode: 1001 });

    expect(client.state.status).toBe('reconnecting');
    host.on('workspace.list', () => ({ result: { workspaces: [] } }));
    const queued = client.request('workspace.list');
    expect(await queued).toEqual({ workspaces: [] });
    expect(host.sockets).toHaveLength(2);
    expect(first.requests('workspace.list')).toHaveLength(1);
  });

  it('排队等连接超过请求时限报 RequestTimeoutError（sent: false）', async () => {
    const host = new FakeHost();
    const { client } = await connect(host, { reconnect: { initialDelayMs: 10_000 } });
    host.last.drop();
    const error = await client.request('host.ping', {}, { timeoutMs: 20 }).catch((e) => e);
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(error).toMatchObject({ sent: false, timeoutMs: 20 });
  });

  it('close()：在途与排队的请求报 ClientClosedError，之后的请求立即失败；以 1000 关闭连接', async () => {
    const host = new FakeHost().on('workspace.list', () => 'no-reply');
    const { client, statuses } = await connect(host);
    const inflight = client.request('workspace.list');
    await vi.waitFor(() => expect(host.last.requests('workspace.list')).toHaveLength(1));
    client.close();
    await expect(inflight).rejects.toBeInstanceOf(ClientClosedError);
    await expect(client.request('host.ping')).rejects.toBeInstanceOf(ClientClosedError);
    expect(host.last.closedByClient?.code).toBe(1000);
    expect(statuses()).toEqual(['connecting', 'connected', 'closed']);
    client.close();
  });
});

describe('连接健康与重连', () => {
  it('每隔 pingIntervalMs 发一次 host.ping', async () => {
    const host = new FakeHost();
    await connect(host, { timeouts: { pingIntervalMs: 20, heartbeatMs: 1000 } });
    await vi.waitFor(() =>
      expect(host.last.requests('host.ping').length).toBeGreaterThanOrEqual(3),
    );
  });

  it('心跳超时（ping 没有回音、也没有任何帧）：放弃连接，以 heartbeat_timeout 重连', async () => {
    const host = new FakeHost();
    const { client, statuses } = await connect(host, {
      timeouts: { pingIntervalMs: 20, heartbeatMs: 70 },
    });
    const dead = host.last;
    host.on('host.ping', () => 'no-reply');
    await vi.waitFor(() => expect(statuses()).toContain('reconnecting:heartbeat_timeout'));
    expect(dead.closedByClient).toBeDefined();
    host.on('host.ping', () => ({ result: {} }));
    await vi.waitFor(() => expect(client.state.status).toBe('connected'));
    expect(host.sockets).toHaveLength(2);
  });

  it('只要有帧到达就不算静默：ping 不回但事件不断时连接保持', async () => {
    const host = new FakeHost().on('host.ping', () => 'no-reply');
    const { client } = await connect(host, { timeouts: { pingIntervalMs: 10, heartbeatMs: 60 } });
    const timer = setInterval(
      () => host.last.notify('events.event', { subscriptionId: 'sub_x', event: event(1) }),
      15,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    clearInterval(timer);
    expect(client.state.status).toBe('connected');
    expect(host.sockets).toHaveLength(1);
  });

  it('令牌被拒：端点固定时不再重试（closed）；给了解析函数则按慢速退避重试', async () => {
    const reject = () => ({ error: { code: ErrorCode.UNAUTHORIZED, message: 'unauthorized' } });

    const fixed = new FakeHost();
    const a = await connect(fixed);
    fixed.on('host.hello', reject);
    fixed.last.drop();
    await vi.waitFor(() => expect(a.client.state.status).toBe('closed'));
    expect(isRpcError((a.client.state as { error?: unknown }).error, 'UNAUTHORIZED')).toBe(true);

    const resolved = new FakeHost();
    const b = await connect(resolved, { endpoint: () => ENDPOINT });
    resolved.on('host.hello', reject);
    resolved.last.drop();
    const delays = () => b.states.flatMap((s) => (s.status === 'reconnecting' ? [s.delayMs] : []));
    await vi.waitFor(() => expect(delays().length).toBeGreaterThanOrEqual(3));
    expect(delays().slice(0, 3)).toEqual([5, 40, 80]);
    expect(b.statuses().slice(-1)).toEqual(['reconnecting:unauthorized']);
    resolved.on('host.hello', () => ({ result: HELLO }));
    b.client.reconnectNow();
    await vi.waitFor(() => expect(b.client.state.status).toBe('connected'));
  });

  it('重连时协议不兼容：closed，订阅的迭代以该错误结束', async () => {
    const host = new FakeHost();
    subscribeHandler(host, () => 0);
    const { client } = await connect(host);
    const subscription = client.subscribe(SES);
    await take(subscription, 1);
    host.on('host.hello', () => ({
      error: { code: ErrorCode.INCOMPATIBLE_PROTOCOL, message: 'incompatible protocol version' },
    }));
    host.last.drop();
    await expect(subscription.next()).rejects.toSatisfy((e) =>
      isRpcError(e, 'INCOMPATIBLE_PROTOCOL'),
    );
    expect(client.state.status).toBe('closed');
    expect(await subscription.next()).toEqual({ done: true, value: undefined });
  });

  it('状态监听器抛错只告警，不影响连接', async () => {
    const host = new FakeHost();
    const { client, warnings } = await connect(host);
    client.onStateChange(() => {
      throw new Error('listener bug');
    });
    host.last.drop();
    await vi.waitFor(() => expect(client.state.status).toBe('connected'));
    expect(warnings).toContain('a connection state listener threw');
  });
});

describe('订阅', () => {
  it('订阅结果与紧随其后的事件在同一轮里到达：路由已同步登记，不误判缺口', async () => {
    const host = new FakeHost().on('events.subscribe', (_params, socket) => {
      queueMicrotask(() => {
        const id = socket.requests('events.subscribe')[0]?.id as number;
        socket.reply(id, { result: { subscriptionId: 'sub_1', replayedThroughSeq: 2 } });
        socket.notify('events.event', { subscriptionId: 'sub_1', event: event(1) });
        socket.notify('events.event', { subscriptionId: 'sub_1', event: event(2) });
      });
      return 'no-reply';
    });
    const { client } = await connect(host);
    const subscription = client.subscribe(SES);
    expect(seqs(await take(subscription, 3))).toEqual([1, 2, 'caught_up@2']);
    expect(host.last.requests('events.subscribe')).toHaveLength(1);
    expect(subscription.caughtUp).toBe(true);
  });

  it('缺口：退订旧订阅、以 sinceSeq = lastSeq 重新订阅；旧订阅后来的事件被丢弃', async () => {
    const host = new FakeHost();
    let through = 0;
    subscribeHandler(host, () => through);
    const { client } = await connect(host);
    const subscription = client.subscribe(SES);
    await take(subscription, 1);
    const socket = host.last;
    through = 3;
    socket.notify('events.event', { subscriptionId: 'sub_1', event: event(1) });
    socket.notify('events.event', { subscriptionId: 'sub_1', event: event(3) });
    socket.notify('events.event', { subscriptionId: 'sub_1', event: event(4) });
    await vi.waitFor(() => expect(socket.requests('events.subscribe')).toHaveLength(2));
    expect(socket.requests('events.unsubscribe')[0]?.params).toEqual({ subscriptionId: 'sub_1' });
    expect(socket.requests('events.subscribe')[1]?.params).toEqual({ sessionId: SES, sinceSeq: 1 });
    await tick();
    for (const seq of [2, 3])
      socket.notify('events.event', { subscriptionId: 'sub_2', event: event(seq) });
    expect(seqs(await take(subscription, 3))).toEqual([1, 2, 3]);
    expect(subscription.lastSeq).toBe(3);
  });

  it('断线重连后自动以最大 seq 续订（新的 subscriptionId），对上层透明', async () => {
    const host = new FakeHost();
    let through = 2;
    subscribeHandler(host, () => through);
    const { client } = await connect(host);
    const subscription = client.subscribe(SES);
    await tick();
    host.last.notify('events.event', { subscriptionId: 'sub_1', event: event(1) });
    host.last.notify('events.event', { subscriptionId: 'sub_1', event: event(2) });
    expect(seqs(await take(subscription, 3))).toEqual([1, 2, 'caught_up@2']);
    through = 4;
    host.last.drop();
    await vi.waitFor(() => expect(host.sockets).toHaveLength(2));
    await vi.waitFor(() => expect(host.last.requests('events.subscribe')).toHaveLength(1));
    expect(host.last.requests('events.subscribe')[0]?.params).toEqual({
      sessionId: SES,
      sinceSeq: 2,
    });
    await tick();
    for (const seq of [3, 4, 5])
      host.last.notify('events.event', { subscriptionId: 'sub_2', event: event(seq) });
    expect(seqs(await take(subscription, 3))).toEqual([3, 4, 5]);
  });

  it('本地 lastSeq 比 Host 新：产出 reset，从 0 重新订阅', async () => {
    const host = new FakeHost();
    subscribeHandler(host, () => 2);
    const { client } = await connect(host);
    const subscription = client.subscribe(SES, { sinceSeq: 9 });
    await vi.waitFor(() => expect(host.last.requests('events.subscribe')).toHaveLength(2));
    expect(host.last.requests('events.subscribe').map((r) => r.params.sinceSeq)).toEqual([9, 0]);
    expect(host.last.requests('events.unsubscribe')[0]?.params).toEqual({
      subscriptionId: 'sub_1',
    });
    await tick();
    for (const seq of [1, 2])
      host.last.notify('events.event', { subscriptionId: 'sub_2', event: event(seq) });
    expect(seqs(await take(subscription, 4))).toEqual(['reset', 1, 2, 'caught_up@2']);
  });

  it('重新订阅时 Host 正在退出（HOST_SHUTTING_DOWN）：订阅不结束，重连后续订', async () => {
    const host = new FakeHost();
    let through = 0;
    subscribeHandler(host, () => through);
    const { client } = await connect(host);
    const subscription = client.subscribe(SES);
    await take(subscription, 1);
    through = 2;
    host.on('events.subscribe', () => ({
      error: { code: ErrorCode.HOST_SHUTTING_DOWN, message: 'host is shutting down' },
    }));
    // 制造缺口，触发重新订阅。
    host.last.notify('events.event', { subscriptionId: 'sub_1', event: event(2) });
    await vi.waitFor(() => expect(host.last.requests('events.subscribe')).toHaveLength(2));
    await tick();
    subscribeHandler(host, () => through);
    host.last.drop(1001, 'host is shutting down');
    await vi.waitFor(() => expect(host.sockets).toHaveLength(2));
    await vi.waitFor(() => expect(host.last.requests('events.subscribe')).toHaveLength(1));
    await tick();
    for (const seq of [1, 2])
      host.last.notify('events.event', { subscriptionId: 'sub_1', event: event(seq) });
    expect(seqs(await take(subscription, 2))).toEqual([1, 2]);
  });

  it('订阅请求超时：放弃这条连接，重连后续订', async () => {
    const host = new FakeHost().on('events.subscribe', () => 'no-reply');
    const { client, statuses } = await connect(host, { timeouts: { requestMs: 30 } });
    const subscription = client.subscribe(SES);
    await vi.waitFor(() => expect(statuses()).toContain('reconnecting:connection_lost'));
    expect(host.sockets[0]?.closedByClient?.reason).toBe('events.subscribe timed out');
    subscribeHandler(host, () => 0);
    expect(seqs(await take(subscription, 1))).toEqual(['caught_up@0']);
  });

  it('Host 每次都在同一位置发不合协议的事件：重新订阅几次没有进展后，迭代以 ProtocolError 结束', async () => {
    const host = new FakeHost();
    let next = 1;
    host.on('events.subscribe', (_params, socket) => {
      const subscriptionId = `sub_${next++}`;
      setTimeout(() => {
        socket.notify('events.event', { subscriptionId, event: event(1) });
        socket.notify('events.event', { subscriptionId, event: { seq: 2, broken: true } });
      }, 5);
      return { result: { subscriptionId, replayedThroughSeq: 3 } };
    });
    host.on('events.unsubscribe', () => ({ result: {} }));
    const { client } = await connect(host);
    const subscription = client.subscribe(SES);
    const items: SubscriptionItem[] = [];
    const error = await (async () => {
      for await (const item of subscription) items.push(item);
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolError);
    expect(seqs(items)).toEqual([1]);
    // 首次订阅 + 3 次重新订阅。
    expect(host.last.requests('events.subscribe')).toHaveLength(4);
  });

  it('会话不存在：迭代以 SESSION_NOT_FOUND 结束', async () => {
    const host = new FakeHost().on('events.subscribe', () => ({
      error: { code: ErrorCode.SESSION_NOT_FOUND, message: 'session not found' },
    }));
    const { client } = await connect(host);
    await expect(client.subscribe(SES).next()).rejects.toSatisfy((e) =>
      isRpcError(e, 'SESSION_NOT_FOUND'),
    );
  });

  it('close() 退订；client.close() 让其他订阅的迭代正常结束', async () => {
    const host = new FakeHost();
    subscribeHandler(host, () => 0);
    const { client } = await connect(host);
    const a = client.subscribe(SES);
    const b = client.subscribe(SES);
    await take(a, 1);
    await take(b, 1);
    a.close();
    expect(host.last.requests('events.unsubscribe')[0]?.params).toEqual({
      subscriptionId: 'sub_1',
    });
    host.last.notify('events.event', { subscriptionId: 'sub_1', event: event(1) });
    expect(await a.next()).toEqual({ done: true, value: undefined });
    client.close();
    expect(await b.next()).toEqual({ done: true, value: undefined });
    await expect(client.subscribe(SES).next()).rejects.toBeInstanceOf(ClientClosedError);
  });
});

describe('账号（R6）', () => {
  const signedOut = { kind: 'chatgpt', status: 'signed_out' };
  const signedIn = { kind: 'chatgpt', status: 'signed_in', email: 'me@example.com', plan: 'plus' };

  it('watchAccount：先 account.get，之后的 account.updated 照收；重连后再 account.get；Host 没有功能时不调', async () => {
    const host = new FakeHost();
    host.on('host.hello', () => ({ result: { ...HELLO, features: { chatgpt_account: true } } }));
    let current: unknown = signedOut;
    host.on('account.get', () => ({ result: { account: current } }));
    const { client, warnings } = await connect(host);
    const seen: unknown[] = [];
    const stop = client.watchAccount('chatgpt', (account) => seen.push(account));
    await vi.waitFor(() => expect(seen).toEqual([signedOut]));
    host.last.notify('account.updated', { account: signedIn });
    host.last.notify('account.updated', { account: { kind: 'chatgpt', status: 'gone' } });
    expect(seen).toEqual([signedOut, signedIn]);
    expect(warnings).toContain('ignored a malformed account.updated notification');
    current = signedIn;
    host.last.drop();
    await vi.waitFor(() => expect(host.sockets).toHaveLength(2));
    await vi.waitFor(() => expect(seen).toEqual([signedOut, signedIn, signedIn]));
    expect(host.last.requests('account.get')).toHaveLength(1);
    stop();
    host.last.notify('account.updated', { account: signedOut });
    expect(seen).toHaveLength(3);

    const plain = new FakeHost();
    const { client: old } = await connect(plain);
    old.watchAccount('chatgpt', (account) => seen.push(account));
    await tick();
    expect(plain.last.requests('account.get')).toEqual([]);
  });
});

describe('全部账号（0.19.0）', () => {
  const claudeIn = { kind: 'claude', status: 'signed_in', signIn: 'command' };
  const claudeOut = { kind: 'claude', status: 'signed_out', signIn: 'command' };
  const cursorOut = { kind: 'cursor', status: 'signed_out', signIn: 'in_app' };

  it('watchAccounts：有 subscription_sources 时读 account.list，通知按种类替换；重连后再读；只有 ChatGPT 时读 account.get；都没有时给空表', async () => {
    const host = new FakeHost();
    host.on('host.hello', () => ({
      result: { ...HELLO, features: { subscription_sources: true } },
    }));
    let accounts: unknown[] = [claudeIn, cursorOut];
    host.on('account.list', () => ({ result: { accounts } }));
    const { client } = await connect(host);
    const seen: unknown[][] = [];
    const stop = client.watchAccounts((list) => seen.push(list));
    await vi.waitFor(() => expect(seen).toEqual([[claudeIn, cursorOut]]));
    host.last.notify('account.updated', { account: claudeOut });
    host.last.notify('account.updated', { account: { kind: 'grok', status: 'signed_in' } });
    expect(seen.at(-1)).toEqual([claudeOut, cursorOut, { kind: 'grok', status: 'signed_in' }]);
    accounts = [claudeOut];
    host.last.drop();
    await vi.waitFor(() => expect(seen.at(-1)).toEqual([claudeOut]));
    stop();

    const chatgptOnly = new FakeHost();
    chatgptOnly.on('host.hello', () => ({
      result: { ...HELLO, features: { chatgpt_account: true } },
    }));
    chatgptOnly.on('account.get', () => ({
      result: { account: { kind: 'chatgpt', status: 'signed_out' } },
    }));
    const { client: second } = await connect(chatgptOnly);
    const lists: unknown[][] = [];
    second.watchAccounts((list) => lists.push(list));
    await vi.waitFor(() => expect(lists).toEqual([[{ kind: 'chatgpt', status: 'signed_out' }]]));

    const plain = new FakeHost();
    const { client: old } = await connect(plain);
    const empty: unknown[][] = [];
    old.watchAccounts((list) => empty.push(list));
    await vi.waitFor(() => expect(empty).toEqual([[]]));
    expect(plain.last.requests('account.list')).toEqual([]);
  });
});

describe('Host 设置（R11）', () => {
  it('watchSettings：先 settings.get，之后的 settings.updated 照收；重连后再 settings.get；Host 没有功能时不调', async () => {
    const host = new FakeHost();
    host.on('host.hello', () => ({ result: { ...HELLO, features: { host_settings: true } } }));
    let current = { sendWhileBusy: 'steer' };
    host.on('settings.get', () => ({ result: { settings: current } }));
    const { client, warnings } = await connect(host);
    const seen: unknown[] = [];
    const stop = client.watchSettings((settings) => seen.push(settings));
    await vi.waitFor(() => expect(seen).toEqual([{ sendWhileBusy: 'steer' }]));
    host.last.notify('settings.updated', { settings: { sendWhileBusy: 'queue' } });
    host.last.notify('settings.updated', { settings: { sendWhileBusy: 'later' } });
    expect(seen).toEqual([{ sendWhileBusy: 'steer' }, { sendWhileBusy: 'queue' }]);
    expect(warnings).toContain('ignored a malformed settings.updated notification');
    current = { sendWhileBusy: 'queue' };
    host.last.drop();
    await vi.waitFor(() => expect(host.sockets).toHaveLength(2));
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(seen[2]).toEqual({ sendWhileBusy: 'queue' });
    stop();
    host.last.notify('settings.updated', { settings: { sendWhileBusy: 'steer' } });
    expect(seen).toHaveLength(3);

    const plain = new FakeHost();
    const { client: old } = await connect(plain);
    old.watchSettings((settings) => seen.push(settings));
    await tick();
    expect(plain.last.requests('settings.get')).toEqual([]);
  });
});

describe('全局插件（0.41.0）', () => {
  it('watchPlugins：首次 / 变化 / 重连重读，旧响应不覆盖新列表，退订与旧 Host 不再读取', async () => {
    const host = new FakeHost();
    host.on('host.hello', () => ({ result: { ...HELLO, features: { plugins: true } } }));
    const current = { connectors: [], skills: [] };
    host.on('plugins.list', () => ({ result: current }));
    const { client } = await connect(host);
    const seen: unknown[] = [];
    const stop = client.watchPlugins((value) => seen.push(value));
    await vi.waitFor(() => expect(seen).toEqual([{ connectors: [], skills: [] }]));
    host.last.notify('plugins.changed', {});
    await vi.waitFor(() => expect(host.last.requests('plugins.list')).toHaveLength(2));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    host.on('plugins.list', () => 'no-reply');
    host.last.notify('plugins.changed', {});
    host.last.notify('plugins.changed', {});
    await vi.waitFor(() => expect(host.last.requests('plugins.list')).toHaveLength(4));
    const requests = host.last.requests('plugins.list');
    host.last.reply(requests[3]?.id as number, {
      result: {
        connectors: [],
        skills: [
          {
            id: 'skl_1',
            name: 'new',
            description: 'new',
            source: 'wevir',
            path: '/tmp/new/SKILL.md',
            enabled: true,
          },
        ],
      },
    });
    host.last.reply(requests[2]?.id as number, { result: current });
    await tick();
    expect(seen).toHaveLength(3);
    expect(seen.at(-1)).toMatchObject({ skills: [{ name: 'new' }] });
    host.on('plugins.list', () => ({ result: current }));
    host.last.drop();
    await vi.waitFor(() => expect(host.sockets).toHaveLength(2));
    await vi.waitFor(() => expect(seen).toHaveLength(4));
    stop();
    host.last.notify('plugins.changed', {});
    await tick();
    expect(seen).toHaveLength(4);
    const plain = new FakeHost();
    const { client: old } = await connect(plain);
    old.watchPlugins((value) => seen.push(value));
    await tick();
    expect(plain.last.requests('plugins.list')).toEqual([]);
  });
});

describe('跨会话记忆（0.57.0）', () => {
  it('watchMemory：首次与重连读一次；全局的与这个项目的 memory.changed 重读，别的项目的不读；退订与旧 Host 不再读取', async () => {
    const host = new FakeHost();
    host.on('host.hello', () => ({ result: { ...HELLO, features: { memory: true } } }));
    const workspaceId = 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR';
    host.on('memory.list', () => ({ result: { notes: [], unreadable: [] } }));
    const { client, warnings } = await connect(host);
    const seen: unknown[] = [];
    const stop = client.watchMemory(workspaceId, (value) => seen.push(value));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(host.last.requests('memory.list')[0]?.params).toEqual({ workspaceId });
    host.last.notify('memory.changed', { scope: 'project', workspaceId, name: 'a' });
    host.last.notify('memory.changed', { scope: 'global', name: 'b' });
    host.last.notify('memory.changed', {
      scope: 'project',
      workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQS',
      name: 'c',
    });
    host.last.notify('memory.changed', { scope: 'team' });
    await vi.waitFor(() => expect(host.last.requests('memory.list')).toHaveLength(3));
    await tick();
    expect(host.last.requests('memory.list')).toHaveLength(3);
    expect(warnings).toContain('ignored a malformed memory.changed notification');
    host.last.drop();
    await vi.waitFor(() => expect(host.sockets).toHaveLength(2));
    await vi.waitFor(() => expect(host.last.requests('memory.list')).toHaveLength(1));
    stop();
    host.last.notify('memory.changed', { scope: 'global' });
    await tick();
    expect(host.last.requests('memory.list')).toHaveLength(1);

    const plain = new FakeHost();
    const { client: old } = await connect(plain);
    old.watchMemory(undefined, (value) => seen.push(value));
    await tick();
    expect(plain.last.requests('memory.list')).toEqual([]);
  });
});

describe('用量统计（0.62.0）', () => {
  it('onUsageChanged：usage.changed 与重连后都通知；退订后不再通知', async () => {
    const host = new FakeHost();
    host.on('host.hello', () => ({ result: { ...HELLO, features: { usage_stats: true } } }));
    const { client } = await connect(host);
    let calls = 0;
    const stop = client.onUsageChanged(() => {
      calls += 1;
    });
    host.last.notify('usage.changed', {});
    await vi.waitFor(() => expect(calls).toBe(1));
    host.last.drop();
    await vi.waitFor(() => expect(calls).toBe(2));
    stop();
    host.last.notify('usage.changed', {});
    await tick();
    expect(calls).toBe(2);
  });
});

describe('自动化（0.66.0）', () => {
  it('onAutomationsChanged：带上通知的内容，重连后以 undefined 通知；格式不对的忽略', async () => {
    const host = new FakeHost();
    host.on('host.hello', () => ({ result: { ...HELLO, features: { automations: true } } }));
    const { client, warnings } = await connect(host);
    const changes: unknown[] = [];
    const stop = client.onAutomationsChanged((change) => changes.push(change));
    host.last.notify('automation.changed', { automationId: 'aut_1', deleted: true });
    await vi.waitFor(() => expect(changes).toEqual([{ automationId: 'aut_1', deleted: true }]));
    host.last.notify('automation.changed', { automationId: 'nope' });
    await tick();
    expect(changes).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/malformed automation.changed/);
    host.last.drop();
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(changes[1]).toBeUndefined();
    stop();
    host.last.notify('automation.changed', { automationId: 'aut_1' });
    await tick();
    expect(changes).toHaveLength(2);
  });
});

describe('进程输出（0.69.0）', () => {
  it('onProcessesChanged：带上通知的内容，重连后以 undefined 通知；格式不对的忽略', async () => {
    const host = new FakeHost();
    host.on('host.hello', () => ({ result: { ...HELLO, features: { process_output: true } } }));
    const { client, warnings } = await connect(host);
    const changes: unknown[] = [];
    const stop = client.onProcessesChanged((change) => changes.push(change));
    const removed = { removed: { id: 'p1', startedAt: '2026-10-20T08:00:00.000Z' } };
    host.last.notify('process.changed', removed);
    await vi.waitFor(() => expect(changes).toEqual([removed]));
    host.last.notify('process.changed', { removed: { id: 'nope' } });
    await tick();
    expect(changes).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/malformed process.changed/);
    host.last.drop();
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(changes[1]).toBeUndefined();
    stop();
    host.last.notify('process.changed', removed);
    await tick();
    expect(changes).toHaveLength(2);
  });
});

describe('项目环境就绪（0.70.0）', () => {
  it('onReadinessChanged：带上通知的内容，重连后以 undefined 通知；格式不对的忽略', async () => {
    const host = new FakeHost();
    host.on('host.hello', () => ({
      result: { ...HELLO, features: { workspace_readiness: true } },
    }));
    const { client, warnings } = await connect(host);
    const changes: unknown[] = [];
    const stop = client.onReadinessChanged((change) => changes.push(change));
    const change = { workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR', root: '/p' };
    host.last.notify('readiness.changed', change);
    await vi.waitFor(() => expect(changes).toEqual([change]));
    host.last.notify('readiness.changed', { root: '/p' });
    await tick();
    expect(changes).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/malformed readiness.changed/);
    host.last.drop();
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(changes[1]).toBeUndefined();
    stop();
    host.last.notify('readiness.changed', change);
    await tick();
    expect(changes).toHaveLength(2);
  });
});

describe('语言服务器（0.71.0）', () => {
  it('onLspChanged：带上通知的内容，重连后以 undefined 通知；格式不对的忽略', async () => {
    const host = new FakeHost();
    host.on('host.hello', () => ({ result: { ...HELLO, features: { lsp_status: true } } }));
    const { client, warnings } = await connect(host);
    const changes: unknown[] = [];
    const stop = client.onLspChanged((change) => changes.push(change));
    const change = { serverId: 'typescript', root: '/x' };
    host.last.notify('lsp.changed', change);
    await vi.waitFor(() => expect(changes).toEqual([change]));
    host.last.notify('lsp.changed', { serverId: '' });
    await tick();
    expect(changes).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/malformed lsp.changed/);
    host.last.drop();
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(changes[1]).toBeUndefined();
    stop();
    host.last.notify('lsp.changed', change);
    await tick();
    expect(changes).toHaveLength(2);
  });
});

describe('用户终端（0.69.0）', () => {
  it('onTerminalOutput / onTerminalsChanged：带上通知的内容，重连后 changed 以 undefined 通知；格式不对的忽略', async () => {
    const host = new FakeHost();
    host.on('host.hello', () => ({ result: { ...HELLO, features: { user_terminal: true } } }));
    const { client, warnings } = await connect(host);
    const outputs: unknown[] = [];
    const changes: unknown[] = [];
    const stopOutput = client.onTerminalOutput((output) => outputs.push(output));
    const stopChanges = client.onTerminalsChanged((change) => changes.push(change));
    const id = 'trm_01JA2B3C4D5E6F7G8H9JKMNPQR';
    host.last.notify('terminal.output', { terminalId: id, offset: 0, data: '$ ' });
    host.last.notify('terminal.output', { terminalId: id, data: 'no offset' });
    host.last.notify('terminal.changed', { removed: { id } });
    await vi.waitFor(() => expect(changes).toEqual([{ removed: { id } }]));
    expect(outputs).toEqual([{ terminalId: id, offset: 0, data: '$ ' }]);
    expect(warnings.join('\n')).toMatch(/malformed terminal.output/);
    host.last.drop();
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(changes[1]).toBeUndefined();
    stopOutput();
    stopChanges();
  });
});

describe('浏览器提供方（0.33.0）', () => {
  const request = {
    requestId: 'brq_01JA2B3C4D5E6F7G8H9JKMNPQR',
    sessionId: SES,
    cwd: '/work',
    command: { command: 'reload', args: { browserId: 'tab_1' } },
  };

  it('provideBrowser：连上时登记、重连后再登记；请求交给处理函数、回答带上 requestId；抛错回 browser_unknown_error', async () => {
    const host = new FakeHost();
    host.on('host.hello', () => ({ result: { ...HELLO, features: { browser_tools: true } } }));
    host.on('browser.register', () => ({ result: {} }));
    host.on('browser.unregister', () => ({ result: {} }));
    host.on('browser.respond', () => ({ result: { accepted: true } }));
    const { client, warnings } = await connect(host);
    let fail = false;
    const stop = client.provideBrowser(['reload'], async (incoming) => {
      if (fail) throw new Error('tab is gone');
      return {
        ok: true,
        result: {
          command: 'reload',
          browserId: (incoming.command.args as { browserId: string }).browserId,
        },
      };
    });
    await vi.waitFor(() =>
      expect(host.last.requests('browser.register').map((frame) => frame.params)).toEqual([
        { commands: ['reload'] },
      ]),
    );
    host.last.notify('browser.request', request);
    await vi.waitFor(() =>
      expect(host.last.requests('browser.respond').map((frame) => frame.params)).toEqual([
        {
          requestId: request.requestId,
          ok: true,
          result: { command: 'reload', browserId: 'tab_1' },
        },
      ]),
    );
    fail = true;
    host.last.notify('browser.request', request);
    await vi.waitFor(() =>
      expect(host.last.requests('browser.respond').at(-1)?.params).toEqual({
        requestId: request.requestId,
        ok: false,
        error: { code: 'browser_unknown_error', message: 'tab is gone' },
      }),
    );
    host.last.notify('browser.request', { ...request, command: { command: 'evaluate', args: {} } });
    expect(warnings).toContain('ignored a malformed browser.request notification');
    host.last.drop();
    await vi.waitFor(() => expect(host.sockets).toHaveLength(2));
    await vi.waitFor(() => expect(host.last.requests('browser.register')).toHaveLength(1));
    stop();
    await vi.waitFor(() => expect(host.last.requests('browser.unregister')).toHaveLength(1));
  });

  it('Host 没有 browser_tools 时不登记', async () => {
    const host = new FakeHost();
    const { client } = await connect(host);
    client.provideBrowser(['reload'], async () => ({
      ok: false,
      error: { code: 'browser_denied', message: 'no' },
    }));
    await tick();
    expect(host.last.requests('browser.register')).toEqual([]);
  });
});
