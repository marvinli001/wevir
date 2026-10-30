// 通知意图与在场（0.106.0）：真实的 HostRpcServer、SessionManager、InboxService、NotificationService 与 EchoAdapter。订阅了的连接收
// notification.intent；关掉的种类谁都收不到；权限；presence.update 按连接聚合，只算本机连接，连接关闭即删。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type ClientIdentity,
  ErrorCode,
  type HostId,
  type HostSettings,
  type NotificationIntent,
  type Permission,
  type SessionId,
  type WorkspaceId,
} from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { InboxService } from './inbox.js';
import { NotificationService } from './notifications.js';
import type { ConnectionGrant } from './permissions.js';
import { Presence } from './presence.js';
import { HostRpcServer } from './rpc-server.js';
import { SessionManager } from './session-manager.js';
import { TestRpcClient, useStorages, useTempDir } from './test-utils.js';

const TOKEN = 'token-0123456789abcdefghijklmnopqrstuvwxyz';
const HOST_ID: HostId = 'hst_01JA2B3C4D5E6F7G8H9JKMNPQR';
const local: ClientIdentity = { deviceId: 'dev-mac', clientId: 'desk-1', clientKind: 'desktop' };
const WINDOW_MS = 20;

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
  const inbox = new InboxService({ storage, events, windowMs: WINDOW_MS, onError });
  inbox.start();
  let settings: HostSettings = { sendWhileBusy: 'steer' };
  const notifications = new NotificationService({
    storage,
    events,
    inbox,
    settings: () => settings,
    onError,
  });
  notifications.start();
  const presence = new Presence();
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
      inbox,
    }),
    features: { inbox: true, notification_intents: true },
    notifications: {
      watch: (listener) => {
        watchers += 1;
        const stop = notifications.watch(listener);
        return () => {
          watchers -= 1;
          stop();
        };
      },
    },
    presence,
    testConnectionGrant: (client) => grants.get(client.clientId),
    onError,
  });
  const url = await server.listen();
  cleanups.push(async () => {
    await server.close({ drainTimeoutMs: 200 });
    await Promise.race([manager.dispose(), delay(200)]);
    await adapter.dispose();
    notifications.close();
    inbox.close();
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

  let workspaceId: WorkspaceId | undefined;
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

  return {
    connect,
    createSession,
    notifications,
    presence,
    watchers: () => watchers,
    setSettings: (next: HostSettings) => {
      settings = next;
    },
  };
}

const intents = (client: TestRpcClient): NotificationIntent[] =>
  client.notifications('notification.intent');

function send(client: TestRpcClient, sessionId: SessionId, text: string) {
  return client.request('session.send', { sessionId, content: [{ type: 'text', text }] });
}

describe('notification.subscribe', () => {
  it('订阅了的连接收到意图，没订阅的收不到；关掉的种类谁都收不到', async () => {
    const { connect, createSession, setSettings } = await boot();
    const writer = await connect();
    const cli = await connect();
    expect(await cli.request('notification.subscribe')).toEqual({});
    // 重复订阅不会收两份。
    await cli.request('notification.subscribe');

    const id = await createSession(writer);
    await send(writer, id, 'please approve');
    const intent = await cli.until(
      () => intents(cli).find((item) => item.kind === 'approval'),
      'approval intent',
    );
    expect(intent).toMatchObject({ sessionId: id, collapseKey: `session:${id}` });
    expect(intents(cli).filter((item) => item.id === intent.id)).toHaveLength(1);
    expect(intents(writer)).toEqual([]);

    // 关掉“需要批准”：之后的审批不再有意图，回合完成照常。
    setSettings({ sendWhileBusy: 'steer', notifications: { approval: false } });
    await writer.request('approval.respond', {
      approvalId: intent.id.slice('approval:'.length),
      optionId: 'allow-once',
    });
    await cli.until(
      () => intents(cli).find((item) => item.kind === 'completed'),
      'completed intent',
    );
    await send(writer, id, 'please approve');
    await delay(WINDOW_MS * 5);
    expect(intents(cli).filter((item) => item.kind === 'approval')).toHaveLength(1);
  });

  it('只有 session.read 的连接能订阅、能报在场；没有的都不行，也收不到意图', async () => {
    const { connect, createSession } = await boot();
    const writer = await connect();
    const phone = await connect({ permissions: ['session.read'] });
    const blind = await connect({ permissions: ['workspace.read'] });
    await phone.request('notification.subscribe');
    await phone.request('presence.update', { active: true });
    expect((await blind.call('notification.subscribe')).error?.code).toBe(
      ErrorCode.DEVICE_FORBIDDEN,
    );
    expect((await blind.call('presence.update', { active: true })).error?.code).toBe(
      ErrorCode.DEVICE_FORBIDDEN,
    );
    const id = await createSession(writer);
    await send(writer, id, 'please approve');
    await phone.until(() => intents(phone).find((item) => item.sessionId === id), 'phone');
    expect(intents(blind)).toEqual([]);
  });

  it('agent 的提醒（0.142.0）：只发给 0.142.0 起的连接，publish 数收下它的连接', async () => {
    const { connect, createSession, notifications } = await boot();
    const writer = await connect();
    const current = await connect();
    const old = await connect({ protocolVersion: '0.141.0' });
    await current.request('notification.subscribe');
    await old.request('notification.subscribe');
    const id = await createSession(writer);
    const intent = notifications.agentIntent(id, { body: 'Build finished; ready to merge?' });
    if ('refused' in intent) throw new Error(`refused: ${intent.refused}`);
    expect(notifications.publish(intent)).toBe(1);
    const received = await current.until(
      () => intents(current).find((item) => item.kind === 'agent'),
      'agent intent',
    );
    expect(received).toEqual(intent);
    await delay(20);
    expect(intents(old).filter((item) => item.kind === 'agent')).toEqual([]);
  });

  it('连接关闭即退订', async () => {
    const { connect, watchers } = await boot();
    const client = await connect();
    await client.request('notification.subscribe');
    expect(watchers()).toBe(1);
    client.ws.close();
    await client.closed;
    await delay(20);
    expect(watchers()).toBe(0);
  });
});

describe('presence.update', () => {
  it('任一本机连接在场即有人在电脑前；远程连接不算；连接关闭即删', async () => {
    const { connect, presence } = await boot();
    const changes: boolean[] = [];
    presence.watch((atComputer) => changes.push(atComputer));
    const desktop = await connect();
    const cli = await connect();
    const phone = await connect({ permissions: ['session.read'] });

    await phone.request('presence.update', { active: true });
    expect(presence.atComputer()).toBe(false);
    await desktop.request('presence.update', { active: true });
    await cli.request('presence.update', { active: true });
    expect(presence.atComputer()).toBe(true);
    await cli.request('presence.update', { active: false });
    expect(presence.atComputer()).toBe(true);
    await desktop.request('presence.update', { active: false });
    expect(presence.atComputer()).toBe(false);

    await desktop.request('presence.update', { active: true });
    desktop.ws.close();
    await desktop.closed;
    await delay(20);
    expect(presence.atComputer()).toBe(false);
    expect(changes).toEqual([true, false, true, false]);
  });
});
