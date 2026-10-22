// 会话列表推送（0.101.0）：真实的 HostRpcServer、SessionManager 与 EchoAdapter。调过 session.list 的连接收 sessions.changed，
// 版本连续、按它列过的范围裁剪；权限、旧协议版本与连接关闭。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type ClientIdentity,
  ErrorCode,
  type HostId,
  type NotificationParams,
  type Permission,
  type SessionId,
} from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import type { ConnectionGrant } from './permissions.js';
import { HostRpcServer } from './rpc-server.js';
import { SessionListFeed } from './session-list.js';
import { SessionManager } from './session-manager.js';
import { TestRpcClient, useStorages, useTempDir } from './test-utils.js';

const TOKEN = 'token-0123456789abcdefghijklmnopqrstuvwxyz';
const HOST_ID: HostId = 'hst_01JA2B3C4D5E6F7G8H9JKMNPQR';
const local: ClientIdentity = { deviceId: 'dev-mac', clientId: 'desk-1', clientKind: 'desktop' };
const WINDOW_MS = 20;

type Change = NotificationParams<'sessions.changed'>;

const tempDir = useTempDir();
const storages = useStorages();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function boot() {
  const dataDir = join(tempDir(), 'data');
  const workspaceDir = join(tempDir(), 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  const storage = storages.open(dataDir);
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  const events = new EventStore({ storage, deltaWindowMs: 5, onError });
  const adapter = new EchoAdapter({ stepDelayMs: 1 });
  const manager = new SessionManager({ storage, events, adapter, onError });
  const feed = new SessionListFeed({ storage, events, windowMs: WINDOW_MS, onError });
  let watchers = 0;
  const grants = new Map<string, ConnectionGrant>();
  const server = new HostRpcServer({
    token: TOKEN,
    hostId: HOST_ID,
    hostVersion: '0.1.0',
    storage,
    events,
    methods: createHostMethods({
      storage,
      events,
      sessions: manager,
      secrets: new FileSecretStore(dataDir),
    }),
    features: { session_list_push: true },
    sessionList: {
      get version() {
        return feed.version;
      },
      watch: (listener) => {
        watchers += 1;
        const stop = feed.watch(listener);
        return () => {
          watchers -= 1;
          stop();
        };
      },
    },
    testConnectionGrant: (client) => grants.get(client.clientId),
    onError,
  });
  const url = await server.listen();
  cleanups.push(async () => {
    await server.close({ drainTimeoutMs: 200 });
    await Promise.race([manager.dispose(), delay(200)]);
    await adapter.dispose();
    feed.close();
    events.close();
    expect(errors).toEqual([]);
  });

  let count = 0;
  const connect = async (
    options: { permissions?: readonly Permission[]; protocolVersion?: string } = {},
  ) => {
    count += 1;
    const who: ClientIdentity = { ...local, clientId: `client-${count}` };
    if (options.permissions !== undefined) {
      grants.set(who.clientId, {
        principal: { kind: 'device', deviceId: 'phone' },
        permissions: options.permissions,
      });
    }
    const client = await TestRpcClient.connect(url);
    cleanups.push(() => client.ws.terminate());
    const hello =
      options.protocolVersion === undefined
        ? await client.hello(TOKEN, who)
        : await client.call('host.hello', {
            token: TOKEN,
            protocolVersion: options.protocolVersion,
            ...who,
            capabilities: {},
          });
    expect(hello.error).toBeUndefined();
    return client;
  };

  /** 经 RPC 加工作区与 Provider（第一次），建一个会话。 */
  let workspaceId: string | undefined;
  const createSession = async (client: TestRpcClient): Promise<SessionId> => {
    if (workspaceId === undefined) {
      ({
        workspace: { id: workspaceId },
      } = await client.request('workspace.add', { rootPath: workspaceDir }));
      await client.request('provider.upsert', {
        id: 'deepseek-official',
        kind: 'deepseek-official',
        displayName: 'DeepSeek',
        models: [],
        defaultModelId: 'deepseek-chat',
      });
    }
    const { session } = await client.request('session.create', {
      workspaceId,
      providerId: 'deepseek-official',
    });
    return session.id;
  };

  return { connect, createSession, watchers: () => watchers };
}

const changes = (client: TestRpcClient): Change[] => client.notifications('sessions.changed');

/** 等到收到满足条件的那条推送。 */
function waitFor(client: TestRpcClient, label: string, check: (change: Change) => boolean) {
  return client.until(() => changes(client).find(check), label);
}

/** 这条连接收到的版本从 `from` 起是连续的。 */
function expectConsecutive(client: TestRpcClient, from: number): void {
  const versions = changes(client).map((change) => change.listVersion);
  expect(versions).toEqual(versions.map((_, i) => from + 1 + i));
}

describe('sessions.changed', () => {
  it('另一端建、改名、归档、删除会话，读过列表的连接都收到，版本连续', async () => {
    const { connect, createSession } = await boot();
    const writer = await connect();
    const watcher = await connect();
    const archiveWatcher = await connect();
    const list = await watcher.request('session.list');
    expect(list).toEqual({ sessions: [], listVersion: expect.any(Number) });
    const archived = await archiveWatcher.request('session.list', { archived: true });

    const id = await createSession(writer);
    await waitFor(watcher, 'created', (c) => c.upserted.some((s) => s.id === id));

    await writer.request('session.rename', { sessionId: id, title: '周报' });
    await waitFor(watcher, 'renamed', (c) => c.upserted.some((s) => s.title === '周报'));

    await writer.request('session.archive', { sessionId: id, archived: true });
    await waitFor(watcher, 'archived', (c) => c.removed.includes(id));
    await waitFor(archiveWatcher, 'archived list', (c) =>
      c.upserted.some((s) => s.id === id && s.archivedAt !== undefined),
    );

    await writer.request('session.delete', { sessionId: id });
    await waitFor(archiveWatcher, 'deleted', (c) => c.removed.includes(id));

    // 写的那一端没调过 session.list，收不到。
    expect(changes(writer)).toEqual([]);
    // 默认列表的连接在归档之后不再收到这个会话（删除也不重复告诉它）。
    const removedTimes = changes(watcher).filter((c) => c.removed.includes(id)).length;
    expect(removedTimes).toBe(1);
    expectConsecutive(watcher, list.listVersion);
    expectConsecutive(archiveWatcher, archived.listVersion);
  });

  it('回合开始、结束与状态变化推，流式增量不逐条推', async () => {
    const { connect, createSession } = await boot();
    const client = await connect();
    const id = await createSession(client);
    await client.request('session.list');
    await client.request('session.send', {
      sessionId: id,
      content: [{ type: 'text', text: 'hello '.repeat(40) }],
    });
    await waitFor(client, 'idle again', (c) =>
      c.upserted.some((s) => s.id === id && s.state === 'idle' && s.lastSeq > 2),
    );
    const subscription = await client.request('events.subscribe', { sessionId: id, sinceSeq: 0 });
    await client.until(
      () => (client.events(subscription.subscriptionId).length > 0 ? true : undefined),
      'events',
    );
    const deltas = client
      .events(subscription.subscriptionId)
      .filter((event) => event.type === 'assistant.delta').length;
    const pushes = changes(client).filter((c) => c.upserted.some((s) => s.id === id)).length;
    expect(deltas).toBeGreaterThan(3);
    expect(pushes).toBeLessThanOrEqual(3);
  });

  it('只有 session.read 的连接照收；没有 session.read 的列不了，也收不到', async () => {
    const { connect, createSession } = await boot();
    const writer = await connect();
    const phone = await connect({ permissions: ['session.read'] });
    const blind = await connect({ permissions: ['workspace.read'] });
    await phone.request('session.list');
    expect((await blind.call('session.list')).error?.code).toBe(ErrorCode.DEVICE_FORBIDDEN);
    const id = await createSession(writer);
    await waitFor(phone, 'phone', (c) => c.upserted.some((s) => s.id === id));
    await delay(WINDOW_MS * 3);
    expect(changes(blind)).toEqual([]);
  });

  it('协商版本低于 0.101.0 的连接：结果带版本，但不登记推送', async () => {
    const { connect, createSession, watchers } = await boot();
    const writer = await connect();
    const old = await connect({ protocolVersion: '0.99.0' });
    expect((await old.request('session.list')).listVersion).toEqual(expect.any(Number));
    expect(watchers()).toBe(0);
    await createSession(writer);
    await delay(WINDOW_MS * 3);
    expect(changes(old)).toEqual([]);
  });

  it('连接关闭即退订', async () => {
    const { connect, watchers } = await boot();
    const client = await connect();
    await client.request('session.list');
    await client.request('session.list', { archived: true });
    expect(watchers()).toBe(1);
    client.ws.close();
    await client.closed;
    await delay(20);
    expect(watchers()).toBe(0);
  });
});
