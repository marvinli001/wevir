// 远程隧道经中继（0.110.0）：真实 Host、本地起的中继（apps/relay 的 RelayServer）、真实 WebSocket 与 Noise 握手。直连关着（没有
// 勾选网卡），配对与重连只能经中继：配对链接里的中继地址、直连都失败后的回退、IK 重连、断线后按 seq 补齐。中继的拒绝与关闭码
// 用一台只注册路由 ID 的假 Host 与调小的中继限制逐一触发：404 / 429 / 503 与 4100 / 4103 / 4104 / 4105 落到
// `RemoteUnreachableError.relay`。

import { generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import type { RunningHost } from '@wevir/host';
import { generateKeyPair, type KeyPair } from '@wevir/noise';
import {
  DEFAULT_REMOTE_SETTINGS,
  type PairingOffer,
  parsePairingUri,
  RELAY_ACCEPT_PARAM,
  RELAY_PATHS,
  type RelayServerMessage,
  relayEndpoint,
  relayRegistrationMessage,
  type SessionId,
  type WevirEvent,
} from '@wevir/protocol';
import { type RelayLimits, RelayServer } from '@wevir/relay';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type ConnectionState, WevirClient } from './client.js';
import {
  ConnectionLostError,
  RemoteHandshakeError,
  type RemoteRelayFailure,
  RemoteUnreachableError,
} from './errors.js';
import { connectLocalHost } from './node.js';
import {
  bytesToBase64url,
  directRoute,
  pairRemoteHost,
  REMOTE_ENDPOINT,
  type RemoteConnectedInfo,
  type RemoteHostKeys,
  type RemoteRoute,
  relayRoute,
  remoteTransport,
} from './remote.js';
import { freePort, identity, startRemoteEchoHost, useTempDir, workspaceDir } from './test-utils.js';
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
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sockets = [];
});

const PHONE = { clientKind: 'cli', deviceId: 'dev-laptop', clientId: 'cli-laptop' } as const;

async function startRelay(limits: Partial<RelayLimits> = {}) {
  const relay = new RelayServer({ limits });
  const port = await relay.listen(0, '127.0.0.1');
  cleanups.push(() => relay.close());
  return { relay, url: `ws://127.0.0.1:${port}` };
}

function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  return new Promise<T>((resolve, reject) => {
    const tick = async () => {
      const value = await read();
      if (value !== undefined) resolve(value);
      else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${what}`));
      else setTimeout(tick, 20);
    };
    void tick();
  });
}

/** 真实 Host：远程访问与中继开着、局域网不勾，等它在中继上注册好。 */
async function setup(relayLimits: Partial<RelayLimits> = {}) {
  const relay = await startRelay(relayLimits);
  const home = join(tempDir(), 'home');
  const host: RunningHost = await startRemoteEchoHost(
    home,
    [],
    { chunkSize: 2, stepDelayMs: 8 },
    { backoffMs: 50, maxBackoffMs: 200 },
  );
  cleanups.push(() => host.shutdown());
  const desktop = await connectLocalHost({
    home,
    identity,
    transport: webSocketTransport(WebSocket),
  });
  cleanups.push(() => desktop.close());
  const { settings } = await desktop.request('settings.get');
  await desktop.request('settings.update', {
    settings: {
      remote: {
        ...(settings.remote ?? DEFAULT_REMOTE_SETTINGS),
        enabled: true,
        interfaces: { lan: false, tailscale: false },
        port: await freePort(),
        relay: { enabled: true, url: relay.url },
      },
    },
  });
  await until(async () => {
    const status = await desktop.request('remote.status');
    return status.relay?.state === 'connected' ? true : undefined;
  }, 'relay connected');
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
  return { relay, host, desktop, respond };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** 配对链接配对：只给链接里的中继地址与一个连不上的直连地址。 */
async function pairViaRelay(t: Setup, device: KeyPair = generateKeyPair()) {
  const offer: PairingOffer = await t.desktop.request('pairing.start');
  const payload = parsePairingUri(offer.uri);
  if (payload === null || payload.relayUrl === undefined) throw new Error('no relay in the uri');
  const host: RemoteHostKeys = { hostPublicKey: payload.hostPublicKey, routeId: payload.routeId };
  const allowed = t.respond(true);
  const result = await pairRemoteHost({
    host,
    device,
    secret: { kind: 'uri', secret: payload.secret },
    routes: [
      directRoute(TrackedWebSocket, { host: '127.0.0.1', port: await freePort() }),
      relayRoute(TrackedWebSocket, payload.relayUrl, payload.routeId),
    ],
    name: 'Laptop',
    platform: 'macos',
    identity: PHONE,
  });
  await allowed;
  return { host, device, result, relayUrl: payload.relayUrl };
}

async function connectRemote(
  host: RemoteHostKeys,
  device: KeyPair,
  routes: RemoteRoute[],
  options: { states?: ConnectionState[] } = {},
) {
  const connected: RemoteConnectedInfo[] = [];
  const client = await WevirClient.connect({
    endpoint: REMOTE_ENDPOINT,
    transport: remoteTransport({
      host,
      device,
      routes: () => routes,
      onConnected: (info) => connected.push(info),
    }),
    identity: PHONE,
    reconnect: { initialDelayMs: 20, maxDelayMs: 200, authInitialDelayMs: 700 },
    ...(options.states && { onStateChange: (state) => options.states?.push(state) }),
  });
  cleanups.push(() => client.close());
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

/**
 * 只在中继上注册路由 ID 的假 Host（Ed25519 签挑战）。`onIncoming` 给出设备连接，`accept` 为它接上数据连接；不接就一直挂着，
 * 由中继到时关掉。
 */
async function fakeRelayHost(
  relayUrl: string,
  onIncoming: (accept: () => WebSocket) => void = () => {},
) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const routeId = publicKey.export({ format: 'jwk' }).x as string;
  const control = new WebSocket(relayEndpoint(relayUrl, RELAY_PATHS.host));
  const data: WebSocket[] = [];
  cleanups.push(() => {
    control.terminate();
    for (const ws of data) ws.terminate();
  });
  await new Promise<void>((resolve, reject) => {
    control.on('error', reject);
    control.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as RelayServerMessage;
      if (message.type === 'challenge') {
        const signature = sign(null, relayRegistrationMessage(message.nonce), privateKey);
        control.send(
          JSON.stringify({ type: 'register', routeId, signature: signature.toString('base64url') }),
        );
      } else if (message.type === 'registered') resolve();
      else if (message.type === 'incoming') {
        onIncoming(() => {
          const ws = new WebSocket(
            relayEndpoint(relayUrl, RELAY_PATHS.accept, { [RELAY_ACCEPT_PARAM]: message.id }),
          );
          data.push(ws);
          ws.on('error', () => {});
          return ws;
        });
      }
    });
  });
  const host: RemoteHostKeys = {
    hostPublicKey: bytesToBase64url(generateKeyPair().publicKey),
    routeId,
  };
  return { host, routeId };
}

/** 经中继连 `host` 的第一次连接以什么原因失败。 */
async function relayFailure(relayUrl: string, host: RemoteHostKeys) {
  const error = await connectRemote(host, generateKeyPair(), [
    relayRoute(TrackedWebSocket, relayUrl, host.routeId),
  ]).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConnectionLostError);
  const cause = (error as ConnectionLostError).cause;
  expect(cause).toBeInstanceOf(RemoteUnreachableError);
  return (cause as RemoteUnreachableError).relay;
}

describe('远程隧道经中继', () => {
  it('直连关着：配对链接经中继配对 → IK 经中继重连，onConnected 报中继的路与 relayUrl', async () => {
    const t = await setup();
    const { host, device, result, relayUrl } = await pairViaRelay(t);
    expect(result.route.kind).toBe('relay');
    expect(result.host.relayUrl).toBe(relayUrl);
    expect(result.hello.permissions.length).toBeGreaterThan(0);

    const dead = directRoute(TrackedWebSocket, { host: '127.0.0.1', port: await freePort() });
    const relay = relayRoute(TrackedWebSocket, relayUrl, host.routeId);
    // 同一条中继的路给两次：只试一次。
    const { client, connected } = await connectRemote(host, device, [dead, relay, relay]);
    await expect(client.request('session.list', {})).resolves.toBeDefined();
    expect(connected).toHaveLength(1);
    expect(connected[0]?.route.kind).toBe('relay');
    expect(connected[0]?.route.key).toBe(new URL(relayUrl).host);
    expect(connected[0]?.host.relayUrl).toBe(relayUrl);
    // 直连一条 + 中继一条；中继 WebSocket 只建了一个。
    expect(sockets.filter((ws) => ws.url.startsWith(relayUrl))).toHaveLength(2);
  });

  it('经中继断网再连：订阅按 seq 补齐，无重复无缺口', async () => {
    const t = await setup();
    const { host, device, relayUrl } = await pairViaRelay(t);
    const sessionId = await createSession(t.desktop);
    const states: ConnectionState[] = [];
    const { client, connected } = await connectRemote(
      host,
      device,
      [relayRoute(TrackedWebSocket, relayUrl, host.routeId)],
      { states },
    );
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
    await until(
      () => (events.some((e) => e.type === 'assistant.delta') ? true : undefined),
      'streaming',
    );
    // 掐断设备到中继的连接：中继不缓冲，重连后靠 sinceSeq 补齐。
    for (const ws of sockets) ws.terminate();
    await until(ended, 'turn end', 10_000);
    expect(states.some((s) => s.status === 'reconnecting')).toBe(true);
    expect(connected.length).toBeGreaterThanOrEqual(2);
    expect(connected.every((c) => c.route.kind === 'relay')).toBe(true);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => (seqs[0] as number) + i));
    const after = events.findIndex((e) => e.type === 'assistant.delta');
    expect(events.slice(after + 1).some((e) => e.type === 'assistant.delta')).toBe(true);
    subscription.close();
    await reading;
  }, 20_000);

  it('设备离线时在电脑上被移除：回来后经中继的握手被拒，只试一次、不再重连', async () => {
    const t = await setup();
    const { host, device, relayUrl } = await pairViaRelay(t);
    const states: ConnectionState[] = [];
    const relay = relayRoute(TrackedWebSocket, relayUrl, host.routeId);
    const routes: RemoteRoute[] = [relay];
    await connectRemote(host, device, routes, { states });
    // 断网：之后的重连只有一条连不上的路，收不到 4007。
    routes[0] = directRoute(TrackedWebSocket, { host: '127.0.0.1', port: await freePort() });
    for (const ws of sockets) ws.terminate();
    await until(() => states.find((s) => s.status === 'reconnecting'), 'offline');
    const { devices } = await t.desktop.request('device.list');
    await t.desktop.request('device.revoke', {
      id: (devices[0] as (typeof devices)[number]).id,
    });
    const before = sockets.length;
    routes[0] = relay;
    const closed = await until(() => states.find((s) => s.status === 'closed'), 'gave up', 5_000);
    const error = (closed as { error?: unknown }).error as ConnectionLostError;
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect(error.cause).toBeInstanceOf(RemoteHandshakeError);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(sockets.length - before).toBe(1);
  });

  it('电脑关掉中继：连接断开，之后中继报 404（电脑不在），按慢速退避重试', async () => {
    const t = await setup();
    const { host, device, relayUrl } = await pairViaRelay(t);
    const states: ConnectionState[] = [];
    await connectRemote(host, device, [relayRoute(TrackedWebSocket, relayUrl, host.routeId)], {
      states,
    });
    const { settings } = await t.desktop.request('settings.get');
    await t.desktop.request('settings.update', {
      settings: {
        remote: {
          ...(settings.remote ?? DEFAULT_REMOTE_SETTINGS),
          relay: { enabled: false, url: relayUrl },
        },
      },
    });
    const slow = await until(
      () =>
        states.find(
          (s) =>
            s.status === 'reconnecting' &&
            (s.error as ConnectionLostError | undefined)?.cause instanceof RemoteUnreachableError,
        ),
      'reconnecting after 404',
    );
    expect(slow).toMatchObject({ status: 'reconnecting', delayMs: 700 });
    const cause = (slow as { error: ConnectionLostError }).error.cause as RemoteUnreachableError;
    expect(cause.relay).toBe<RemoteRelayFailure>('offline');
  });

  it('电脑没开配对窗口：经中继配对被 4105 拒绝', async () => {
    const t = await setup();
    const offer: PairingOffer = await t.desktop.request('pairing.start');
    const payload = parsePairingUri(offer.uri);
    if (payload === null || payload.relayUrl === undefined) throw new Error('no relay in the uri');
    await t.desktop.request('pairing.cancel', { pairingId: offer.pairingId });
    const error = await pairRemoteHost({
      host: { hostPublicKey: payload.hostPublicKey, routeId: payload.routeId },
      device: generateKeyPair(),
      secret: { kind: 'uri', secret: payload.secret },
      routes: [relayRoute(TrackedWebSocket, payload.relayUrl, payload.routeId)],
      name: 'Laptop',
      platform: 'macos',
      identity: PHONE,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteUnreachableError);
    expect((error as RemoteUnreachableError).relay).toBe<RemoteRelayFailure>('host_rejected');
  });

  it('中继升级前的拒绝：没有这个路由 404、来源限速 429、满了 503', async () => {
    const limited = await startRelay({ connectsPerMinutePerSource: 1 });
    const nobody: RemoteHostKeys = {
      hostPublicKey: bytesToBase64url(generateKeyPair().publicKey),
      routeId: bytesToBase64url(generateKeyPair().publicKey),
    };
    expect(await relayFailure(limited.url, nobody)).toBe('offline');
    expect(await relayFailure(limited.url, nobody)).toBe('rate_limited');
    const full = await startRelay({ maxConnections: 0 });
    expect(await relayFailure(full.url, nobody)).toBe('busy');
  });

  it('中继本身连不上（没在运行）：unreachable，而不只是直连连不上', async () => {
    const nobody: RemoteHostKeys = {
      hostPublicKey: bytesToBase64url(generateKeyPair().publicKey),
      routeId: bytesToBase64url(generateKeyPair().publicKey),
    };
    expect(await relayFailure(`ws://127.0.0.1:${await freePort()}`, nobody)).toBe('unreachable');
  });

  it('中继的关闭码：电脑没接上 4100、排队超限 4103、电脑发了文本 4104', async () => {
    const slow = await startRelay({ acceptTimeoutMs: 200 });
    const silent = await fakeRelayHost(slow.url);
    expect(await relayFailure(slow.url, silent.host)).toBe('host_unavailable');

    const tight = await startRelay({ maxQueuedMessages: 0 });
    const queued = await fakeRelayHost(tight.url);
    expect(await relayFailure(tight.url, queued.host)).toBe('limit_exceeded');

    const plain = await startRelay();
    const texting = await fakeRelayHost(plain.url, (accept) => {
      const ws = accept();
      ws.on('open', () => ws.send('not a noise message'));
    });
    expect(await relayFailure(plain.url, texting.host)).toBe('protocol_error');
  });
});
