import {
  ConnectionLostError,
  type ConnectionState,
  RemoteHandshakeError,
  RemoteUnreachableError,
  WevirRpcError,
} from '@wevir/client-sdk';
import { CloseCode, type Session } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import type { CacheProvider, SessionCache } from './cache';
import {
  ComputerLink,
  DeviceKeyMissingError,
  LINK_RETRY_DELAYS_MS,
  type LinkClient,
  type LinkConnectHooks,
  type LinkEnvironment,
  SESSIONS_CACHE_DELAY_MS,
} from './computer-link';
import type { ComputerRecord } from './records';
import type { SessionList, SessionsChangeLike } from './sessions';
import { record, session } from './test-utils';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeClient implements LinkClient {
  closed = false;
  lists: SessionList[] = [];
  listCalls = 0;
  listError: unknown;
  readonly sessionListeners = new Set<(change: SessionsChangeLike | undefined) => void>();
  constructor(readonly hooks: LinkConnectHooks) {}
  onStateChange(): () => void {
    return () => {};
  }
  onSessionsChanged(listener: (change: SessionsChangeLike | undefined) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }
  async listSessions(): Promise<SessionList> {
    this.listCalls += 1;
    if (this.listError !== undefined) throw this.listError;
    return this.lists.shift() ?? { sessions: [], listVersion: 1 };
  }
  close(): void {
    this.closed = true;
  }
  state(state: ConnectionState): void {
    this.hooks.onStateChange(state);
  }
  change(change: SessionsChangeLike | undefined): void {
    for (const listener of this.sessionListeners) listener(change);
  }
}

type Outcome = { client: (hooks: LinkConnectHooks) => FakeClient } | { error: unknown };

class FakeEnv implements LinkEnvironment {
  saved: ComputerRecord[] = [];
  timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  outcomes: Outcome[] = [];
  clients: FakeClient[] = [];
  connects = 0;
  time = new Date('2026-10-23T12:00:00.000Z');
  cache?: CacheProvider;

  async connect(hooks: LinkConnectHooks): Promise<LinkClient> {
    this.connects += 1;
    const outcome = this.outcomes.shift() ?? { client: (h) => new FakeClient(h) };
    if ('error' in outcome) throw outcome.error;
    const client = outcome.client(hooks);
    this.clients.push(client);
    hooks.onConnected({
      route: 'direct',
      address: { host: '192.168.1.5', port: 47830 },
      host: {
        protocolVersion: '0.110.0',
        candidates: [{ kind: 'lan', host: '192.168.1.5', port: 47830 }],
      },
    });
    hooks.onStateChange({ status: 'connected', hello: {} as never });
    return client;
  }
  async saveRecord(r: ComputerRecord): Promise<void> {
    this.saved.push(r);
  }
  now(): Date {
    return this.time;
  }
  setTimer(callback: () => void, ms: number): unknown {
    const timer = { callback, ms, cleared: false };
    this.timers.push(timer);
    return timer;
  }
  clearTimer(handle: unknown): void {
    (handle as { cleared: boolean }).cleared = true;
  }
  fireTimer(): void {
    const timer = this.timers.find((t) => !t.cleared);
    if (timer === undefined) throw new Error('no pending timer');
    timer.cleared = true;
    timer.callback();
  }
}

async function started(outcomes: Outcome[] = [], r = record()) {
  const env = new FakeEnv();
  env.outcomes = outcomes;
  const link = new ComputerLink(r, env);
  link.resume();
  await flush();
  return { env, link };
}

describe('ComputerLink', () => {
  it('connects in the foreground, records the route and reads sessions', async () => {
    const a = session('ses_a', '2026-10-23T11:00:00.000Z', { pendingApprovalCount: 1 });
    const { env, link } = await started([
      {
        client: (hooks) => {
          const client = new FakeClient(hooks);
          client.lists = [{ sessions: [a], listVersion: 3 }];
          return client;
        },
      },
    ]);
    expect(link.snapshot.status).toEqual({ kind: 'online', route: 'direct' });
    expect(link.snapshot.sessions).toEqual({ kind: 'ready', sessions: [a] });
    expect(env.saved.at(-1)).toMatchObject({
      lastRoute: 'direct',
      lastAddress: { host: '192.168.1.5', port: 47830 },
    });
  });

  it('follows sessions.changed and re-reads on a gap or after reconnecting', async () => {
    const a = session('ses_a', '2026-10-23T11:00:00.000Z');
    const b = session('ses_b', '2026-10-23T11:30:00.000Z');
    const { env, link } = await started([
      {
        client: (hooks) => {
          const client = new FakeClient(hooks);
          client.lists = [
            { sessions: [a], listVersion: 1 },
            { sessions: [a, b], listVersion: 9 },
          ];
          return client;
        },
      },
    ]);
    const client = env.clients[0] as FakeClient;
    client.change({ listVersion: 2, upserted: [b], removed: [] });
    expect(link.snapshot.sessions).toMatchObject({ kind: 'ready', sessions: [b, a] });
    client.change({ listVersion: 4, upserted: [], removed: ['ses_a'] });
    await flush();
    expect(client.listCalls).toBe(2);
    client.change(undefined);
    await flush();
    expect(client.listCalls).toBe(3);
  });

  it('re-reads sessions on pull-to-refresh, or reconnects when offline', async () => {
    const a = session('ses_a', '2026-10-23T11:00:00.000Z');
    const { env, link } = await started([
      { error: new RemoteUnreachableError(['192.168.1.5:47830']) },
      {
        client: (hooks) => {
          const client = new FakeClient(hooks);
          client.lists = [
            { sessions: [], listVersion: 1 },
            { sessions: [a], listVersion: 2 },
          ];
          return client;
        },
      },
    ]);
    expect(link.snapshot.status.kind).toBe('offline');
    await link.refresh();
    await flush();
    expect(env.connects).toBe(2);
    expect(link.snapshot.sessions).toEqual({ kind: 'ready', sessions: [] });
    await link.refresh();
    expect((env.clients[0] as FakeClient).listCalls).toBe(2);
    expect(link.snapshot.sessions).toEqual({ kind: 'ready', sessions: [a] });
  });

  it('shows offline and retries on its own when the first connect fails', async () => {
    const { env, link } = await started([
      { error: new RemoteUnreachableError(['192.168.1.5:47830']) },
    ]);
    expect(link.snapshot.status).toEqual({ kind: 'offline', reason: 'unreachable' });
    expect(env.timers.at(-1)?.ms).toBe(LINK_RETRY_DELAYS_MS[0]);
    env.fireTimer();
    await flush();
    expect(env.connects).toBe(2);
    expect(link.snapshot.status.kind).toBe('online');
  });

  it('marks the computer removed on 4007 and stops connecting', async () => {
    const { env, link } = await started();
    const client = env.clients[0] as FakeClient;
    client.state({
      status: 'closed',
      error: new ConnectionLostError(undefined, CloseCode.DEVICE_REVOKED),
    });
    expect(link.snapshot.status).toEqual({ kind: 'removed' });
    expect(env.saved.at(-1)?.removedAt).toBe('2026-10-23T12:00:00.000Z');
    expect(client.closed).toBe(true);
    link.pause();
    link.resume();
    await flush();
    expect(env.connects).toBe(1);
    expect(link.snapshot.status).toEqual({ kind: 'removed' });
  });

  it('treats a rejected IK handshake or a missing key as removed', async () => {
    const rejected = await started([
      { error: new RemoteHandshakeError('rejected', '192.168.1.5:47830') },
    ]);
    expect(rejected.link.snapshot.status).toEqual({ kind: 'removed' });
    expect(rejected.env.timers).toHaveLength(0);
    const missing = await started([{ error: new DeviceKeyMissingError() }]);
    expect(missing.link.snapshot.status).toEqual({ kind: 'removed' });
  });

  it('starts removed computers as removed', async () => {
    const { env, link } = await started([], record({ removedAt: '2026-10-22T00:00:00.000Z' }));
    expect(link.snapshot.status).toEqual({ kind: 'removed' });
    expect(env.connects).toBe(0);
  });

  it('says remote access is off on 4008 and stays quiet on 4009', async () => {
    const { env, link } = await started();
    const client = env.clients[0] as FakeClient;
    client.state({
      status: 'reconnecting',
      attempt: 1,
      delayMs: 0,
      reason: 'connection_lost',
      error: new ConnectionLostError(undefined, CloseCode.PERMISSIONS_CHANGED),
    });
    expect(link.snapshot.status).toEqual({ kind: 'online', route: 'direct' });
    client.state({
      status: 'reconnecting',
      attempt: 1,
      delayMs: 5_000,
      reason: 'connection_lost',
      error: new ConnectionLostError(undefined, CloseCode.REMOTE_DISABLED),
    });
    expect(link.snapshot.status).toEqual({ kind: 'offline', reason: 'remote_disabled' });
    expect(link.snapshot.lastOnlineAt).toBe('2026-10-23T12:00:00.000Z');
    // The port closes right after 4008: later attempts only fail to connect, and the reason stays until the next connection.
    client.state({
      status: 'reconnecting',
      attempt: 2,
      delayMs: 5_000,
      reason: 'host_unavailable',
      error: new ConnectionLostError(undefined, 1006),
    });
    expect(link.snapshot.status).toEqual({ kind: 'offline', reason: 'remote_disabled' });
    link.pause();
    env.outcomes.push({ error: new RemoteUnreachableError([]) });
    link.resume();
    await flush();
    expect(link.snapshot.status).toEqual({ kind: 'offline', reason: 'remote_disabled' });
    link.retryNow();
    await flush();
    expect(link.snapshot.status).toEqual({ kind: 'online', route: 'direct' });
  });

  it('disconnects in the background and reconnects in the foreground', async () => {
    const { env, link } = await started();
    link.pause();
    expect((env.clients[0] as FakeClient).closed).toBe(true);
    expect(link.snapshot.status).toEqual({ kind: 'paused' });
    // A late state from the closed client is ignored.
    (env.clients[0] as FakeClient).state({
      status: 'closed',
      error: new ConnectionLostError(undefined, 1006),
    });
    expect(link.snapshot.status).toEqual({ kind: 'paused' });
    link.resume();
    await flush();
    expect(env.connects).toBe(2);
    expect(link.snapshot.status.kind).toBe('online');
  });

  it('says when this device may not read sessions', async () => {
    const { link } = await started([
      {
        client: (hooks) => {
          const client = new FakeClient(hooks);
          client.listError = new WevirRpcError('session.list', {
            code: -32005,
            message: 'forbidden',
            data: { missing: ['session.read'] },
          });
          return client;
        },
      },
    ]);
    expect(link.snapshot.sessions).toEqual({ kind: 'forbidden' });
  });
});

describe('ComputerLink 的本地缓存', () => {
  function cacheProvider(initial?: Session[]) {
    const saved: Session[][] = [];
    const cache: SessionCache = {
      loadSessions: async () =>
        initial === undefined
          ? undefined
          : { sessions: initial, savedAt: '2026-10-23T09:00:00.000Z' },
      saveSessions: async (sessions) => {
        saved.push([...sessions]);
      },
      loadConversation: async () => undefined,
      saveConversation: async () => {},
    };
    const provider: CacheProvider = { open: () => cache, forget: async () => {} };
    return { provider, saved };
  }

  it('连不上时显示上次存下的会话列表，标出缓存时刻', async () => {
    const a = session('ses_a', '2026-10-23T08:00:00.000Z');
    const { provider } = cacheProvider([a]);
    const env = new FakeEnv();
    env.cache = provider;
    env.outcomes = [{ error: new RemoteUnreachableError([]) }];
    const link = new ComputerLink(record(), env);
    link.resume();
    await flush();
    expect(link.snapshot.status.kind).toBe('offline');
    expect(link.snapshot.sessions).toEqual({
      kind: 'ready',
      sessions: [a],
      cachedAt: '2026-10-23T09:00:00.000Z',
    });
  });

  it('读到列表后换掉缓存，合并一会儿再存', async () => {
    const old = session('ses_old', '2026-10-23T08:00:00.000Z');
    const fresh = session('ses_new', '2026-10-23T11:00:00.000Z');
    const { provider, saved } = cacheProvider([old]);
    const env = new FakeEnv();
    env.cache = provider;
    env.outcomes = [
      {
        client: (hooks) => {
          const client = new FakeClient(hooks);
          client.lists = [{ sessions: [fresh], listVersion: 1 }];
          return client;
        },
      },
    ];
    const link = new ComputerLink(record(), env);
    link.resume();
    await flush();
    expect(link.snapshot.sessions).toEqual({ kind: 'ready', sessions: [fresh] });
    expect(saved).toEqual([]);
    const timer = env.timers.find((t) => t.ms === SESSIONS_CACHE_DELAY_MS && !t.cleared);
    timer?.callback();
    expect(saved).toEqual([[fresh]]);
  });
});
