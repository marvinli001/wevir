// 收件箱与审批过期（0.103.0）：真实的 HostRpcServer、SessionManager、InboxService 与 EchoAdapter。调过 inbox.* 的连接收
// inbox.changed，版本连续；权限；收起；没声明 approval_timeout 的连接看到降级的过期。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type ApprovalId,
  type ClientIdentity,
  ErrorCode,
  type HostId,
  type InboxItem,
  type NotificationParams,
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
import type { ConnectionGrant } from './permissions.js';
import { HostRpcServer } from './rpc-server.js';
import { SessionManager } from './session-manager.js';
import { TestRpcClient, useStorages, useTempDir } from './test-utils.js';

const TOKEN = 'token-0123456789abcdefghijklmnopqrstuvwxyz';
const HOST_ID: HostId = 'hst_01JA2B3C4D5E6F7G8H9JKMNPQR';
const local: ClientIdentity = { deviceId: 'dev-mac', clientId: 'desk-1', clientKind: 'desktop' };
const WINDOW_MS = 20;

type Change = NotificationParams<'inbox.changed'>;

const tempDir = useTempDir();
const storages = useStorages();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function boot(options: { approvalTimeoutMs?: number } = {}) {
  const dataDir = join(tempDir(), 'data');
  const workspaceDir = join(tempDir(), 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  const storage = storages.open(dataDir);
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  const events = new EventStore({ storage, deltaWindowMs: 5, onError });
  const adapter = new EchoAdapter({ stepDelayMs: 1 });
  const manager = new SessionManager({
    storage,
    events,
    adapter,
    onError,
    approvalTimeoutMs: () => options.approvalTimeoutMs ?? 0,
  });
  const inbox = new InboxService({ storage, events, windowMs: WINDOW_MS, onError });
  inbox.start();
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
    features: { inbox: true, approval_timeout: true },
    inbox: {
      watch: (listener) => {
        watchers += 1;
        const stop = inbox.watch(listener);
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
    inbox.close();
    events.close();
    expect(errors).toEqual([]);
  });

  let count = 0;
  const connect = async (
    options: { permissions?: readonly Permission[]; capabilities?: Record<string, boolean> } = {},
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
    const hello = await client.hello(TOKEN, who, options.capabilities);
    expect(hello.error).toBeUndefined();
    return client;
  };

  /** 经 RPC 加工作区与 Provider（第一次），建一个会话；`openedBy` 时由 SessionManager 建无人值守的会话。 */
  let workspaceId: WorkspaceId | undefined;
  const createSession = async (client: TestRpcClient, openedBy?: SessionId): Promise<SessionId> => {
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
    if (openedBy !== undefined) {
      const session = await manager.create(
        { workspaceId: workspaceId as WorkspaceId, providerId: 'deepseek-official' },
        { openedBy },
      );
      return session.id;
    }
    const { session } = await client.request('session.create', {
      workspaceId,
      providerId: 'deepseek-official',
    });
    return session.id;
  };

  return { connect, createSession, watchers: () => watchers };
}

const changes = (client: TestRpcClient): Change[] => client.notifications('inbox.changed');

function waitFor(client: TestRpcClient, label: string, check: (change: Change) => boolean) {
  return client.until(() => changes(client).find(check), label);
}

function send(client: TestRpcClient, sessionId: SessionId, text: string) {
  return client.request('session.send', { sessionId, content: [{ type: 'text', text }] });
}

describe('inbox.*', () => {
  it('审批进收件箱，另一端处理后移除；读过收件箱的连接收到，版本连续', async () => {
    const { connect, createSession } = await boot();
    const writer = await connect();
    const watcher = await connect();
    const first = await watcher.request('inbox.list');
    expect(first).toEqual({ items: [], inboxVersion: expect.any(Number) });

    const id = await createSession(writer);
    await send(writer, id, 'please approve');
    const added = await waitFor(watcher, 'approval', (c) =>
      c.upserted.some((item) => item.kind === 'approval'),
    );
    const item = added.upserted[0] as Extract<InboxItem, { kind: 'approval' }>;
    expect(item).toMatchObject({ sessionId: id, ref: { turnId: expect.any(String) } });
    expect((await watcher.request('inbox.list')).items).toEqual([item]);

    await writer.request('approval.respond', {
      approvalId: item.ref.approvalId,
      optionId: 'allow-once',
    });
    await waitFor(watcher, 'removed', (c) => c.removed.includes(item.id));
    const versions = changes(watcher).map((c) => c.inboxVersion);
    expect(versions).toEqual(versions.map((_, i) => first.inboxVersion + 1 + i));
    expect(changes(writer)).toEqual([]);
  });

  it('审批与提问不能收起；不在收件箱的项收起时什么都不做', async () => {
    const { connect } = await boot();
    const client = await connect();
    const refused = await client.call('inbox.dismiss', { itemId: 'approval:apr_1' });
    expect(refused.error?.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(await client.request('inbox.dismiss', { itemId: 'turn_failed:trn_1' })).toEqual({});
  });

  it('只有 session.read 的连接能列、能收，不能收起；没有 session.read 的都不行', async () => {
    const { connect, createSession } = await boot();
    const writer = await connect();
    const phone = await connect({ permissions: ['session.read'] });
    const blind = await connect({ permissions: ['workspace.read'] });
    await phone.request('inbox.list');
    expect((await blind.call('inbox.list')).error?.code).toBe(ErrorCode.DEVICE_FORBIDDEN);
    expect((await phone.call('inbox.dismiss', { itemId: 'turn_failed:trn_1' })).error?.code).toBe(
      ErrorCode.DEVICE_FORBIDDEN,
    );
    const id = await createSession(writer);
    await send(writer, id, 'please approve');
    await waitFor(phone, 'phone', (c) => c.upserted.some((item) => item.sessionId === id));
    await delay(WINDOW_MS * 3);
    expect(changes(blind)).toEqual([]);
  });

  it('连接关闭即退订', async () => {
    const { connect, watchers } = await boot();
    const client = await connect();
    await client.request('inbox.list');
    await client.request('inbox.list');
    expect(watchers()).toBe(1);
    client.ws.close();
    await client.closed;
    await delay(20);
    expect(watchers()).toBe(0);
  });
});

describe('审批过期（approval_timeout）', () => {
  it('声明了能力位的连接看到 timeout 与 APPROVAL_EXPIRED；没声明的看到 host_restarted 与 ALREADY_DECIDED', async () => {
    const { connect, createSession } = await boot({ approvalTimeoutMs: 40 });
    const modern = await connect({ capabilities: { approval_timeout: true } });
    const legacy = await connect();
    await modern.request('inbox.list');
    const parent = await createSession(modern);
    const id = await createSession(modern, parent);
    const modernSub = await modern.request('events.subscribe', { sessionId: id, sinceSeq: 0 });
    const legacySub = await legacy.request('events.subscribe', { sessionId: id, sinceSeq: 0 });
    await send(modern, id, 'please approve');

    const added = await waitFor(modern, 'approval', (c) =>
      c.upserted.some((item) => item.kind === 'approval'),
    );
    const item = added.upserted[0] as Extract<InboxItem, { kind: 'approval' }>;
    expect(item.expiresAt).toEqual(expect.any(String));
    await waitFor(modern, 'expired', (c) => c.removed.includes(item.id));

    const resolvedIn = (client: TestRpcClient, subscriptionId: string) =>
      client.until(
        () =>
          client.events(subscriptionId).find((event) => event.type === 'approval.resolved')
            ?.payload,
        'approval.resolved',
      );
    expect(await resolvedIn(modern, modernSub.subscriptionId)).toMatchObject({
      status: 'expired',
      resolution: { reason: 'timeout', optionId: 'reject-once' },
    });
    expect(await resolvedIn(legacy, legacySub.subscriptionId)).toMatchObject({
      status: 'expired',
      resolution: { reason: 'host_restarted', optionId: 'reject-once' },
    });

    const approvalId: ApprovalId = item.ref.approvalId;
    const params = { approvalId, optionId: 'allow-once' };
    const expired = await modern.call('approval.respond', params);
    expect(expired.error).toMatchObject({
      code: ErrorCode.APPROVAL_EXPIRED,
      data: { approvalId, resolution: { reason: 'timeout' } },
    });
    const decided = await legacy.call('approval.respond', params);
    expect(decided.error).toMatchObject({
      code: ErrorCode.ALREADY_DECIDED,
      data: { approvalId, status: 'expired', resolution: { reason: 'host_restarted' } },
    });
  });
});
