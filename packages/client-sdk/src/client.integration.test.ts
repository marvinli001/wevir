// T4.1 验收：对着真实 Host（startHost 组装、EchoAdapter、真实的 SQLite 事件库与 WebSocket 服务，与
// `wevir-host --adapter echo` 相同），经 Node 入口读 run/host.json 连接。覆盖：正常流程；流式输出中途
// 强制断开连接后重连，事件完整、无重复；人为丢帧制造 seq 缺口后自动补齐；Host 重启后自动重连续订；
// 浏览器同款的 WHATWG WebSocket 传输。

import { join } from 'node:path';
import type { RunningHost } from '@wevir/host';
import { PROTOCOL_VERSION, type SessionId, type WevirEvent } from '@wevir/protocol';
import type { EchoAdapterOptions } from '@wevir/runtime-adapter/echo';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ConnectionState, WevirClient } from './client.js';
import { isRpcError } from './errors.js';
import { connectLocalHost, type LocalHostOptions, readHostEndpoint } from './node.js';
import type { EventSubscription } from './subscription.js';
import {
  filterTransport,
  identity,
  type SentFrame,
  spyTransport,
  startEchoHost,
  useTempDir,
  workspaceDir,
} from './test-utils.js';
import { webSocketTransport } from './transport.js';

/** 记下客户端创建的每个 `ws` 连接，测试用 `terminate()` 模拟网络中断。 */
let sockets: WebSocket[] = [];
class TrackedWebSocket extends WebSocket {
  constructor(url: string) {
    super(url);
    sockets.push(this);
  }
}
const wsTransport = webSocketTransport(TrackedWebSocket);

const tempDir = useTempDir();
const hosts: RunningHost[] = [];
const clients: WevirClient[] = [];

beforeEach(() => {
  sockets = [];
});
// 注册在 useTempDir 之后：先关客户端、停 Host，再删临时目录。
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0)) await host.shutdown();
});

async function setup(echo: EchoAdapterOptions = {}) {
  const home = join(tempDir(), 'home');
  const host = await startEchoHost(home, echo);
  hosts.push(host);
  return { home, host };
}

async function open(home: string, options: Partial<LocalHostOptions> = {}) {
  const sent: SentFrame[] = [];
  const states: ConnectionState[] = [];
  const { transport = wsTransport, ...rest } = options;
  const client = await connectLocalHost({
    home,
    identity,
    reconnect: { initialDelayMs: 20, maxDelayMs: 200 },
    onStateChange: (state) => states.push(state),
    ...rest,
    transport: spyTransport(transport, sent),
  });
  clients.push(client);
  const statuses = () =>
    states.map((s) => (s.status === 'reconnecting' ? `reconnecting:${s.reason}` : s.status));
  return { client, sent, states, statuses };
}

async function createSession(client: WevirClient): Promise<SessionId> {
  const { workspace } = await client.request('workspace.add', {
    rootPath: workspaceDir(tempDir()),
  });
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

function send(client: WevirClient, sessionId: SessionId, text: string) {
  return client.request('session.send', { sessionId, content: [{ type: 'text', text }] });
}

/** 回合结束：回到 idle 是一个回合的最后一条事件。 */
function turnEnded(event: WevirEvent): boolean {
  return (
    event.type === 'session.state_changed' &&
    event.payload.to === 'idle' &&
    event.payload.reason === 'turn_finished'
  );
}

/** 逐项读订阅（不用 for await，读完不退订），事件追加到 `sink`，直到 `stop` 为真。 */
async function readUntil(
  subscription: EventSubscription,
  sink: WevirEvent[],
  stop: (event: WevirEvent) => boolean,
  onEvent?: (event: WevirEvent) => void,
): Promise<void> {
  for (;;) {
    const next = await subscription.next();
    if (next.done) throw new Error('订阅意外结束');
    if (next.value.type !== 'event') continue;
    sink.push(next.value.event);
    onEvent?.(next.value.event);
    if (stop(next.value.event)) return;
  }
}

/** 用一个新客户端从头回放，作为“完整历史”的参照。 */
async function history(home: string, sessionId: SessionId): Promise<WevirEvent[]> {
  const client = await connectLocalHost({ home, identity, transport: wsTransport });
  clients.push(client);
  const events: WevirEvent[] = [];
  for await (const item of client.subscribe(sessionId)) {
    if (item.type === 'event') events.push(item.event);
    if (item.type === 'caught_up') break;
  }
  return events;
}

function expectContiguous(events: WevirEvent[]): void {
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
}

function subscribes(sent: SentFrame[]): number[] {
  return sent.filter((f) => f.method === 'events.subscribe').map((f) => f.params.sinceSeq);
}

describe('client-sdk 对着真实 Host', () => {
  it('正常流程：读 host.json 连接与握手，类型安全的请求，回放 + 实时事件按 seq 连续，类型化错误', async () => {
    const { home, host } = await setup();
    expect(await readHostEndpoint(home)).toEqual({ url: host.url, token: expect.any(String) });
    const { client, statuses } = await open(home);
    expect(client.hello).toMatchObject({ hostId: host.hostId, protocolVersion: PROTOCOL_VERSION });

    const sessionId = await createSession(client);
    const subscription = client.subscribe(sessionId);
    const events: WevirEvent[] = [];
    await readUntil(subscription, events, (e) => e.type === 'session.created');
    expect(events.map((e) => e.seq)).toEqual([1]);
    expect((await subscription.next()).value).toEqual({ type: 'caught_up', seq: 1 });
    expect(subscription.caughtUp).toBe(true);

    const { turnId } = await send(client, sessionId, 'tool please');
    await readUntil(subscription, events, turnEnded);
    expectContiguous(events);
    expect(events).toEqual(await history(home, sessionId));
    const user = events.find((e) => e.type === 'user.message');
    expect(user?.payload).toMatchObject({ turnId, sentBy: identity });
    expect(events.some((e) => e.type === 'tool.started')).toBe(true);
    expect(events.find((e) => e.type === 'assistant.message')?.payload).toMatchObject({
      text: 'Echo: tool please',
    });

    const snapshot = await client.request('session.get', { sessionId });
    expect(snapshot.session).toMatchObject({ state: 'idle', lastSeq: subscription.lastSeq });

    const missing = await client
      .request('session.get', { sessionId: 'ses_0000000000000000000000000Z' })
      .catch((e: unknown) => e);
    expect(isRpcError(missing, 'SESSION_NOT_FOUND')).toBe(true);
    const invalid = await client
      .request('workspace.add', { rootPath: 'relative/path' })
      .catch((e: unknown) => e);
    if (!isRpcError(invalid, 'WORKSPACE_PATH_INVALID'))
      throw new Error('expected WORKSPACE_PATH_INVALID');
    expect(invalid.data?.reason).toBe('not_absolute');

    expect(statuses()).toEqual(['connecting', 'connected']);
  });

  it('流式输出中途强制断开连接：自动重连，以最大 seq 续订，事件完整、无重复', async () => {
    // 回复约 250 字，2 字一片、8 ms 一片：增量持续约 1 s。
    const { home } = await setup({ chunkSize: 2, stepDelayMs: 8 });
    const { client, sent, statuses } = await open(home);
    const sessionId = await createSession(client);
    const subscription = client.subscribe(sessionId);

    await send(client, sessionId, `stream ${'x'.repeat(240)}`);
    const events: WevirEvent[] = [];
    let killedAfter: number | undefined;
    await readUntil(subscription, events, turnEnded, (event) => {
      if (killedAfter === undefined && event.type === 'assistant.delta') {
        killedAfter = event.seq;
        // 不经关闭握手直接断开 TCP，与网络中断相同（客户端收到 1006）。
        sockets.at(-1)?.terminate();
      }
    });

    expectContiguous(events);
    expect(events).toEqual(await history(home, sessionId));
    expect(statuses()).toEqual([
      'connecting',
      'connected',
      'reconnecting:connection_lost',
      'connected',
    ]);
    // 第二条连接上的订阅从断开时已应用的最大 seq 续上；之后仍有增量，说明断开发生在流式输出中途。
    const [first, resumedFrom] = subscribes(sent);
    expect(first).toBe(0);
    expect(resumedFrom).toBeGreaterThanOrEqual(killedAfter as number);
    expect(
      events.some((e) => e.type === 'assistant.delta' && e.seq > (resumedFrom as number)),
    ).toBe(true);
    expect(events.filter((e) => e.type === 'assistant.message')).toHaveLength(1);
  }, 15_000);

  it('人为制造 seq 缺口（回放与实时阶段各丢一帧）：退订后以 sinceSeq = lastSeq 重新订阅，自动补齐', async () => {
    const { home } = await setup({ chunkSize: 4, stepDelayMs: 2 });
    // 先有一段历史。
    const seed = await open(home);
    const sessionId = await createSession(seed.client);
    await send(seed.client, sessionId, 'first turn');
    await vi.waitFor(async () =>
      expect((await seed.client.request('session.get', { sessionId })).session.state).toBe('idle'),
    );
    const historyLastSeq = (await seed.client.request('session.get', { sessionId })).session
      .lastSeq;

    const dropOnce = new Set([4, historyLastSeq + 3]);
    const lossy = filterTransport(
      wsTransport,
      // biome-ignore lint/suspicious/noExplicitAny: 只看 events.event 帧里的 seq。
      (frame: any) => frame.method === 'events.event' && dropOnce.delete(frame.params.event.seq),
    );
    const { client, sent } = await open(home, { transport: lossy });
    const subscription = client.subscribe(sessionId);
    const events: WevirEvent[] = [];
    await readUntil(subscription, events, (e) => e.seq === historyLastSeq);
    await send(client, sessionId, 'second turn');
    await readUntil(subscription, events, turnEnded);

    expect(dropOnce.size).toBe(0);
    expectContiguous(events);
    expect(events).toEqual(await history(home, sessionId));
    expect(subscribes(sent)).toEqual([0, 3, historyLastSeq + 2]);
    expect(sent.filter((f) => f.method === 'events.unsubscribe')).toHaveLength(2);
  }, 15_000);

  it('Host 重启（换了端口与令牌）：每次尝试重读 host.json，自动重连并续订', async () => {
    const { home, host } = await setup();
    const { client, statuses } = await open(home);
    const sessionId = await createSession(client);
    const subscription = client.subscribe(sessionId);
    await send(client, sessionId, 'before restart');
    const events: WevirEvent[] = [];
    await readUntil(subscription, events, turnEnded);

    await host.shutdown();
    // 新 Host 起来之前，重试读到的是“没有 host.json”。
    await vi.waitFor(() => expect(statuses()).toContain('reconnecting:host_unavailable'));
    const restarted = await startEchoHost(home);
    hosts.push(restarted);
    expect(restarted.url).not.toBe(host.url);
    await vi.waitFor(() => expect(client.state.status).toBe('connected'), { timeout: 5000 });

    // 新的 EchoAdapter 不认识上一个进程的引擎会话（resume 会失败），所以重启后用 session.close 产生事件。
    await client.request('session.close', { sessionId });
    await readUntil(
      subscription,
      events,
      (e) => e.type === 'session.state_changed' && e.payload.to === 'closed',
    );
    expectContiguous(events);
    expect(events).toEqual(await history(home, sessionId));
    expect(statuses()[2]).toBe('reconnecting:connection_lost');
    expect(statuses().at(-1)).toBe('connected');
  }, 15_000);

  it('浏览器同款的 WHATWG WebSocket（Node 的全局 WebSocket）也能用', async () => {
    const { home } = await setup();
    const { client } = await open(home, { transport: webSocketTransport(globalThis.WebSocket) });
    expect(await client.request('host.ping')).toEqual({});
    const sessionId = await createSession(client);
    const subscription = client.subscribe(sessionId);
    await send(client, sessionId, 'hello');
    const events: WevirEvent[] = [];
    await readUntil(subscription, events, turnEnded);
    expectContiguous(events);
    expect(sockets).toHaveLength(0);
  });
});
