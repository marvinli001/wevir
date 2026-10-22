// 远程隧道对着真实 Host 的远程监听（0.109.0）：真实的 WebSocket、真实的 Noise 握手；回环地址 127.0.0.1 被当作局域网网卡。覆盖
// 配对链接与短码（只靠 mDNS 广播的 rid 与 pk）配对、IK 重连与候选地址并行、断线后按 seq 补齐、受限权限下不重读、权限改了自动
// 重连、移除设备后不再重连。

import { join } from 'node:path';
import type { RunningHost } from '@wevir/host';
import { generateKeyPair, type KeyPair } from '@wevir/noise';
import {
  CloseCode,
  DEFAULT_DEVICE_PERMISSIONS,
  ErrorCode,
  type PairingOffer,
  parsePairingUri,
  type SessionId,
  type WevirEvent,
} from '@wevir/protocol';
import type { EchoAdapterOptions } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type ConnectionState, WevirClient } from './client.js';
import { ConnectionLostError, RemoteHandshakeError, RemoteUnreachableError } from './errors.js';
import { connectLocalHost } from './node.js';
import {
  directRoute,
  pairRemoteHost,
  REMOTE_ENDPOINT,
  type RemoteConnectedInfo,
  type RemoteHostKeys,
  type RemoteRoute,
  remoteTransport,
} from './remote.js';
import {
  enableRemote,
  freePort,
  identity,
  type RecordedAnnouncement,
  type SentFrame,
  spyTransport,
  startRemoteEchoHost,
  useTempDir,
  workspaceDir,
} from './test-utils.js';
import { webSocketTransport } from './transport.js';

/** 记下隧道建的每个 WebSocket，测试用 `terminate()` 模拟断网。 */
let sockets: WebSocket[] = [];
class TrackedWebSocket extends WebSocket {
  constructor(url: string) {
    super(url);
    sockets.push(this);
  }
}

const tempDir = useTempDir();
const hosts: RunningHost[] = [];
const clients: WevirClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0)) await host.shutdown();
  sockets = [];
});

const PHONE = { clientKind: 'cli', deviceId: 'dev-laptop', clientId: 'cli-laptop' } as const;

async function setup(echo: EchoAdapterOptions = {}) {
  const home = join(tempDir(), 'home');
  const announcements: (RecordedAnnouncement | undefined)[] = [];
  const host = await startRemoteEchoHost(home, announcements, echo);
  hosts.push(host);
  const desktop = await connectLocalHost({
    home,
    identity,
    transport: webSocketTransport(WebSocket),
  });
  clients.push(desktop);
  const port = await freePort();
  await enableRemote(desktop, port);
  const route = directRoute(TrackedWebSocket, { host: '127.0.0.1', port });
  /** 桌面上对下一个配对请求作答。 */
  const respond = (allow: boolean) =>
    new Promise<void>((resolve) => {
      const stop = desktop.onRemoteDevicesChanged((change) => {
        if (change?.kind !== 'pairing_request') return;
        stop();
        void desktop
          .request('pairing.respond', { requestId: change.request.requestId, allow })
          .then(() => resolve());
      });
    });
  return { home, host, desktop, port, route, announcements, respond };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function pairByUri(t: Setup, device: KeyPair = generateKeyPair()) {
  const offer: PairingOffer = await t.desktop.request('pairing.start');
  const payload = parsePairingUri(offer.uri);
  if (payload === null) throw new Error('bad pairing uri');
  const host: RemoteHostKeys = { hostPublicKey: payload.hostPublicKey, routeId: payload.routeId };
  const allowed = t.respond(true);
  const result = await pairRemoteHost({
    host,
    device,
    secret: { kind: 'uri', secret: payload.secret },
    routes: payload.candidates.map((c) => directRoute(TrackedWebSocket, c)),
    name: 'Laptop',
    platform: 'macos',
    identity: PHONE,
  });
  await allowed;
  return { host, device, result, offer };
}

async function connectRemote(
  t: Setup,
  host: RemoteHostKeys,
  device: KeyPair,
  options: { routes?: RemoteRoute[]; sent?: SentFrame[]; states?: ConnectionState[] } = {},
) {
  const connected: RemoteConnectedInfo[] = [];
  const client = await WevirClient.connect({
    endpoint: REMOTE_ENDPOINT,
    transport: spyTransport(
      remoteTransport({
        host,
        device,
        routes: () => options.routes ?? [t.route],
        onConnected: (info) => connected.push(info),
      }),
      options.sent ?? [],
    ),
    identity: PHONE,
    reconnect: { initialDelayMs: 20, maxDelayMs: 200 },
    ...(options.states && { onStateChange: (state) => options.states?.push(state) }),
  });
  clients.push(client);
  return { client, connected };
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

function until<T>(read: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<T>((resolve, reject) => {
    const tick = () => {
      const value = read();
      if (value !== undefined) resolve(value);
      else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${what}`));
      else setTimeout(tick, 20);
    };
    tick();
  });
}

describe('远程隧道', () => {
  it('配对链接配对 → 电脑允许 → IK 重连；不通的候选地址不影响，胜出的路与最新候选地址交给 onConnected', async () => {
    const t = await setup();
    const { host, device, result, offer } = await pairByUri(t);
    expect(result.hello.permissions).toEqual([...DEFAULT_DEVICE_PERMISSIONS]);
    expect(result.host.candidates).toEqual(offer.candidates);
    expect(result.route.key).toBe(`127.0.0.1:${t.port}`);

    const dead = directRoute(TrackedWebSocket, { host: '127.0.0.1', port: await freePort() });
    const { client, connected } = await connectRemote(t, host, device, {
      routes: [dead, t.route, t.route],
    });
    expect(client.hello.permissions).toEqual([...DEFAULT_DEVICE_PERMISSIONS]);
    expect(client.can('host.manage')).toBe(false);
    expect(connected).toMatchObject([
      { route: { key: `127.0.0.1:${t.port}` }, host: { candidates: offer.candidates } },
    ]);
    await expect(client.request('session.list', {})).resolves.toMatchObject({ sessions: [] });
    await expect(client.request('remote.status')).rejects.toMatchObject({
      code: ErrorCode.DEVICE_FORBIDDEN,
    });
    const { devices } = await t.desktop.request('device.list');
    expect(devices).toMatchObject([{ name: 'Laptop', platform: 'macos', status: 'active' }]);
  });

  it('短码配对只靠 mDNS 广播的 rid 与 pk；错码报 wrong_secret 且窗口结束', async () => {
    const t = await setup();
    const txt = (t.announcements.at(-1) as RecordedAnnouncement).txt;
    const host: RemoteHostKeys = { hostPublicKey: txt.pk ?? '', routeId: txt.rid ?? '' };
    // 发现是异步给的路（CLI 用 mDNS）。
    const discover = async (add: (route: RemoteRoute) => void) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      add(t.route);
    };
    let offer = await t.desktop.request('pairing.start');
    const wrong = offer.shortCode === 'AAAAAAAA' ? 'BBBB-BBBB' : 'aaaa-aaaa';
    await expect(
      pairRemoteHost({
        host,
        device: generateKeyPair(),
        secret: { kind: 'code', code: wrong },
        routes: [],
        discover,
        name: 'Laptop',
        platform: 'macos',
        identity: PHONE,
      }),
    ).rejects.toMatchObject({ name: 'RemoteHandshakeError', reason: 'wrong_secret' });

    offer = await t.desktop.request('pairing.start');
    const allowed = t.respond(true);
    const device = generateKeyPair();
    const result = await pairRemoteHost({
      host,
      device,
      secret: { kind: 'code', code: `${offer.shortCode.slice(0, 4)}-${offer.shortCode.slice(4)}` },
      routes: [],
      discover,
      name: 'Laptop',
      platform: 'linux',
      identity: PHONE,
    });
    await allowed;
    expect(result.hello.permissions).toEqual([...DEFAULT_DEVICE_PERMISSIONS]);
    const { client } = await connectRemote(t, host, device);
    expect(client.state.status).toBe('connected');
  });

  it('电脑上拒绝：配对以关闭码 4010 失败', async () => {
    const t = await setup();
    const offer = await t.desktop.request('pairing.start');
    const payload = parsePairingUri(offer.uri);
    if (payload === null) throw new Error('bad pairing uri');
    const denied = t.respond(false);
    const error = await pairRemoteHost({
      host: { hostPublicKey: payload.hostPublicKey, routeId: payload.routeId },
      device: generateKeyPair(),
      secret: { kind: 'uri', secret: payload.secret },
      routes: [t.route],
      name: 'Laptop',
      platform: 'macos',
      identity: PHONE,
    }).catch((e: unknown) => e);
    await denied;
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect((error as ConnectionLostError).closeCode).toBe(CloseCode.PAIRING_DENIED);
  });

  it('断网再连：订阅按 seq 补齐，无重复无缺口', async () => {
    // 回复约 250 字，2 字一片、8 ms 一片：增量持续约 1 s。
    const t = await setup({ chunkSize: 2, stepDelayMs: 8 });
    const { host, device } = await pairByUri(t);
    const sessionId = await createSession(t.desktop);
    const states: ConnectionState[] = [];
    const { client } = await connectRemote(t, host, device, { states });
    const events: WevirEvent[] = [];
    const subscription = client.subscribe(sessionId);
    const reading = (async () => {
      for await (const item of subscription) {
        if (item.type === 'event') events.push(item.event);
      }
    })();
    const ended = () =>
      events.find(
        (e) =>
          e.type === 'session.state_changed' &&
          e.payload.to === 'idle' &&
          e.payload.reason === 'turn_finished',
      );
    await client.request('session.send', {
      sessionId,
      content: [{ type: 'text', text: `stream ${'x'.repeat(240)}` }],
    });
    // 流式输出途中掐断全部隧道连接。
    await until(
      () => (events.some((e) => e.type === 'assistant.delta') ? true : undefined),
      'streaming',
    );
    for (const ws of sockets) ws.terminate();
    await until(ended, 'turn end', 10_000);
    expect(states.some((s) => s.status === 'reconnecting')).toBe(true);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => (seqs[0] as number) + i));
    // 断开发生在流式输出中途：之后还有增量。
    const after = events.findIndex((e) => e.type === 'assistant.delta');
    expect(events.slice(after + 1).some((e) => e.type === 'assistant.delta')).toBe(true);
    subscription.close();
    await reading;
  }, 15_000);

  it('受限权限：重连上之后不重读做不了的；权限改了 4009 后自动重连，按新权限工作', async () => {
    const t = await setup();
    const { host, device } = await pairByUri(t);
    const sent: SentFrame[] = [];
    const { client } = await connectRemote(t, host, device, { sent });
    const errors: unknown[] = [];
    // 设备没有 host.manage：plugins.list 不该发出去。settings.get 要 session.read，照读。
    expect(client.supports('plugins')).toBe(true);
    client.watchPlugins(
      () => {},
      (error) => errors.push(error),
    );
    client.watchSettings(
      () => {},
      (error) => errors.push(error),
    );
    const { devices } = await t.desktop.request('device.list');
    const id = (devices[0] as (typeof devices)[number]).id;
    const reconnected = new Promise<void>((resolve) => {
      let lost = false;
      client.onStateChange((state) => {
        if (state.status !== 'connected') lost = true;
        else if (lost) resolve();
      });
    });
    await t.desktop.request('device.update', { id, permissions: ['session.read'] });
    await reconnected;
    expect(client.hello.permissions).toEqual(['session.read']);
    await expect(client.request('session.list', {})).resolves.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(errors).toEqual([]);
    expect(sent.filter((f) => f.method.startsWith('plugins.'))).toEqual([]);
    // 两条连接上各读了一次设置。
    expect(sent.filter((f) => f.method === 'settings.get')).toHaveLength(2);
  });

  it('电脑上移除设备：连接以 4007 关闭、不再重连；之后的连接握手被拒', async () => {
    const t = await setup();
    const { host, device } = await pairByUri(t);
    const states: ConnectionState[] = [];
    await connectRemote(t, host, device, { states });
    const { devices } = await t.desktop.request('device.list');
    await t.desktop.request('device.revoke', {
      id: (devices[0] as (typeof devices)[number]).id,
    });
    const closed = await until(() => states.find((s) => s.status === 'closed'), 'closed');
    expect(states.some((s) => s.status === 'reconnecting')).toBe(false);
    expect((closed as { error?: unknown }).error).toMatchObject({
      closeCode: CloseCode.DEVICE_REVOKED,
    });
    const again = await connectRemote(t, host, device).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ConnectionLostError);
    expect((again as ConnectionLostError).cause).toBeInstanceOf(RemoteHandshakeError);
    expect(((again as ConnectionLostError).cause as RemoteHandshakeError).reason).toBe('rejected');
  });

  it('全都连不上：RemoteUnreachableError 列出试过的地址', async () => {
    const t = await setup();
    const { host, device } = await pairByUri(t);
    const port = await freePort();
    const error = await connectRemote(t, host, device, {
      routes: [directRoute(TrackedWebSocket, { host: '127.0.0.1', port })],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionLostError);
    const cause = (error as ConnectionLostError).cause as RemoteUnreachableError;
    expect(cause).toBeInstanceOf(RemoteUnreachableError);
    expect(cause.tried).toEqual([`127.0.0.1:${port}`]);
  });
});
