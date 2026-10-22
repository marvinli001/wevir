// 连接身份与权限执行（0.98.0，ADR-0017 §4）：真实的 HostRpcServer 与 WebSocket，测试经 `testConnectionGrant` 让某条连接以受限
// 权限完成 hello。遍历方法注册表，缺权限的方法都回 DEVICE_FORBIDDEN；参数级检查；通知按读权限过滤；本机连接照旧拥有全部权限。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type ClientIdentity,
  DEFAULT_HOST_SETTINGS,
  ErrorCode,
  type HostId,
  type HostSettings,
  METHOD_NAMES,
  MethodSchemas,
  type NotificationParams,
  PERMISSIONS,
  type Permission,
} from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from './event-store.js';
import { createHostMethods, type HostMethods } from './host-methods.js';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import type { ConnectionGrant } from './permissions.js';
import { HostRpcServer } from './rpc-server.js';
import { SessionManager } from './session-manager.js';
import { TestRpcClient, useStorages, useTempDir } from './test-utils.js';

const TOKEN = 'token-0123456789abcdefghijklmnopqrstuvwxyz';
const HOST_ID: HostId = 'hst_01JA2B3C4D5E6F7G8H9JKMNPQR';
const ULID = '01JA2B3C4D5E6F7G8H9JKMNPQR';
const local: ClientIdentity = { deviceId: 'dev-mac', clientId: 'desk-1', clientKind: 'desktop' };
/** 手机的默认权限（ADR-0017 §4，D9）。 */
const PHONE: Permission[] = ['session.read', 'session.write', 'workspace.read'];

const tempDir = useTempDir();
const storages = useStorages();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 一个最小的观察者：测试手动触发。 */
function emitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    watch(listener: (value: T) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(value: T) {
      for (const listener of listeners) listener(value);
    },
  };
}

async function boot(methods: Partial<HostMethods> = {}) {
  const dataDir = join(tempDir(), 'data');
  const storage = storages.open(dataDir);
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  const events = new EventStore({ storage, deltaWindowMs: 5, onError });
  const adapter = new EchoAdapter({ stepDelayMs: 1 });
  const manager = new SessionManager({ storage, events, adapter, onError });
  /** clientId → grant；不在表里的连接是本机身份。 */
  const grants = new Map<string, ConnectionGrant>();
  const settings = emitter<HostSettings>();
  const guardrails = emitter<NotificationParams<'guardrail.changed'>>();
  const power = emitter<boolean>();
  const server = new HostRpcServer({
    token: TOKEN,
    hostId: HOST_ID,
    hostVersion: '0.1.0',
    storage,
    events,
    methods: {
      ...createHostMethods({
        storage,
        events,
        sessions: manager,
        secrets: new FileSecretStore(dataDir),
      }),
      ...methods,
    } as HostMethods,
    settings,
    guardrails,
    power,
    testConnectionGrant: (client) => grants.get(client.clientId),
    onError,
  });
  const url = await server.listen();
  cleanups.push(async () => {
    await server.close({ drainTimeoutMs: 200 });
    await Promise.race([manager.dispose(), delay(200)]);
    await adapter.dispose();
    events.close();
    expect(errors).toEqual([]);
  });

  let count = 0;
  /** 连一个客户端；给了 `permissions` 时它以 device 身份、只有这些权限完成 hello。 */
  const connect = async (permissions?: readonly Permission[]) => {
    count += 1;
    const who: ClientIdentity = { ...local, clientId: `client-${count}` };
    if (permissions !== undefined) {
      grants.set(who.clientId, { principal: { kind: 'device', deviceId: 'phone' }, permissions });
    }
    const client = await TestRpcClient.connect(url);
    cleanups.push(() => client.ws.terminate());
    const hello = await client.hello(TOKEN, who);
    expect(hello.error).toBeUndefined();
    return { client, hello: hello.result as { permissions: string[] } };
  };
  return { connect, settings, guardrails, power };
}

function expectForbidden(
  frame: { error?: { code: number; data?: unknown } },
  missing: Permission[],
  label: string,
): void {
  expect(frame.error?.code, label).toBe(ErrorCode.DEVICE_FORBIDDEN);
  expect(frame.error?.data, label).toEqual({ missing });
}

describe('方法级', () => {
  it('遍历注册表：缺哪项权限，要它的方法都回 DEVICE_FORBIDDEN，连接不关', async () => {
    const { connect } = await boot();
    for (const permission of PERMISSIONS) {
      const methods = METHOD_NAMES.filter((m) => MethodSchemas[m].permission === permission);
      expect(methods.length, permission).toBeGreaterThan(0);
      const { client, hello } = await connect(PERMISSIONS.filter((p) => p !== permission));
      expect(hello.permissions).not.toContain(permission);
      // 方法级检查在解析参数之前：参数不全也回 DEVICE_FORBIDDEN，处理函数一个都不会跑。
      const frames = await Promise.all(methods.map((method) => client.call(method, {})));
      frames.forEach((frame, i) => {
        expectForbidden(frame, [permission], methods[i] as string);
      });
      expect((await client.call('host.ping')).result).toEqual({});
    }
  });

  it('有权限时照常走到参数校验与处理函数', async () => {
    const { connect } = await boot();
    const { client } = await connect(['terminal.write']);
    expect((await client.call('terminal.input', {})).error?.code).toBe(ErrorCode.INVALID_PARAMS);
    expectForbidden(await client.call('terminal.list', {}), ['session.read'], 'terminal.list');
  });

  it('本机连接：hello 给全部权限，什么都不拒绝', async () => {
    const { connect } = await boot();
    const { client, hello } = await connect();
    expect(hello.permissions).toEqual([...PERMISSIONS]);
    expect((await client.call('workspace.list')).error).toBeUndefined();
    expect((await client.call('approvalRule.add', {})).error?.code).toBe(ErrorCode.INVALID_PARAMS);
  });
});

describe('参数级', () => {
  const sessionId = `ses_${ULID}`;
  const automationId = `aut_${ULID}`;
  const approvalId = `apr_${ULID}`;
  const automation = {
    title: 'Daily',
    prompt: 'Check',
    schedule: { kind: 'manual' },
    providerId: 'deepseek-official',
  };

  it('full_access 与 remember 要 policy.write，别的取值照常', async () => {
    const { connect } = await boot();
    const { client } = await connect(PHONE);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['session.create', { providerId: 'deepseek-official', permissionMode: 'full_access' }],
      ['session.configure', { sessionId, permissionMode: 'full_access' }],
      ['automation.create', { ...automation, permissionMode: 'full_access' }],
      ['automation.update', { automationId, permissionMode: 'full_access' }],
      ['approval.respond', { approvalId, optionId: 'allow', remember: 'project' }],
    ];
    for (const [method, params] of cases) {
      expectForbidden(await client.call(method, params), ['policy.write'], method);
    }
    // 不涉及这些参数时走到处理函数（这个 Host 上对象不存在，或没有自动化服务）。
    const allowed: Array<[string, Record<string, unknown>]> = [
      ['session.configure', { sessionId, permissionMode: 'on_request' }],
      ['automation.update', { automationId, title: 'x' }],
      ['approval.respond', { approvalId, optionId: 'allow' }],
    ];
    for (const [method, params] of allowed) {
      const code = (await client.call(method, params)).error?.code;
      expect(code, method).toBeDefined();
      expect(code, method).not.toBe(ErrorCode.DEVICE_FORBIDDEN);
    }
  });

  it('参数不合 schema 时先回 INVALID_PARAMS（参数级检查在解析之后）', async () => {
    const { connect } = await boot();
    const { client } = await connect(PHONE);
    const frame = await client.call('session.configure', { permissionMode: 'full_access' });
    expect(frame.error?.code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it('有 policy.write 时放行', async () => {
    const { connect } = await boot();
    const { client } = await connect([...PHONE, 'policy.write']);
    const frame = await client.call('approval.respond', {
      approvalId,
      optionId: 'allow',
      remember: 'project',
    });
    expect(frame.error?.code).toBe(ErrorCode.APPROVAL_NOT_FOUND);
  });
});

describe('files.read（0.102.0）', () => {
  it('手机的默认权限（workspace.read）走到处理函数；没有 workspace.read 时 DEVICE_FORBIDDEN', async () => {
    const { connect } = await boot();
    const phone = (await connect(PHONE)).client;
    const params = { workspaceId: `ws_${ULID}`, path: 'a.txt' };
    expect((await phone.call('files.read', params)).error?.code).toBe(
      ErrorCode.WORKSPACE_NOT_FOUND,
    );
    const writer = (await connect(['session.read', 'session.write'])).client;
    expectForbidden(await writer.call('files.read', params), ['workspace.read'], 'files.read');
  });
});

describe('通知', () => {
  it('没有读权限的连接收不到，即使调过登记它的方法', async () => {
    const { connect, settings, guardrails } = await boot({
      'settings.update': async () => ({ settings: { ...DEFAULT_HOST_SETTINGS } }),
      'repoHook.list': async () => ({ hooks: [], warnings: [] }),
    });
    // settings.update（host.manage）登记 settings.updated（session.read）；repoHook.list（workspace.read）登记 guardrail.changed
    //（session.read）。
    const admin = (await connect(['host.manage'])).client;
    const reader = (await connect(['workspace.read'])).client;
    const desktop = (await connect()).client;
    for (const client of [admin, desktop])
      await client.request('settings.update', { settings: {} });
    const repoHookList = { workspaceId: `ws_${ULID}` };
    for (const client of [reader, desktop]) await client.request('repoHook.list', repoHookList);

    settings.emit({ ...DEFAULT_HOST_SETTINGS });
    guardrails.emit({});
    await desktop.until(
      () =>
        desktop.notifications('settings.updated').length > 0 &&
        desktop.notifications('guardrail.changed').length > 0
          ? true
          : undefined,
      'desktop notifications',
    );
    // 两条受限连接上再走一个来回，确认通知没有排在后面。
    await admin.request('host.ping');
    await reader.request('host.ping');
    expect(admin.notifications('settings.updated')).toEqual([]);
    expect(reader.notifications('guardrail.changed')).toEqual([]);
  });

  it('power.get 与 power.changed（0.102.0）：手机的默认权限可用；没有 session.read 的连接调不了、也收不到', async () => {
    const { connect, power } = await boot();
    const phone = (await connect(PHONE)).client;
    const reader = (await connect(['workspace.read'])).client;
    expect(await phone.request('power.get')).toEqual({ keepAwake: false });
    expectForbidden(await reader.call('power.get'), ['session.read'], 'power.get');
    power.emit(true);
    await phone.until(
      () => (phone.notifications('power.changed').length > 0 ? true : undefined),
      'power.changed',
    );
    expect(phone.notifications('power.changed')).toEqual([{ keepAwake: true }]);
    await reader.request('host.ping');
    expect(reader.notifications('power.changed')).toEqual([]);
  });

  it('events.subscribe 要 session.read', async () => {
    const { connect } = await boot();
    const { client } = await connect(['workspace.read']);
    const frame = await client.call('events.subscribe', { sessionId: `ses_${ULID}`, sinceSeq: 0 });
    expectForbidden(frame, ['session.read'], 'events.subscribe');
  });
});

describe('startHost', () => {
  it('testConnectionGrant 只对它认出的连接生效；本机连接全部权限、声明 permission_enforcement', async () => {
    const home = join(tempDir(), 'home');
    const host = await startHost({
      adapter: new EchoAdapter({ stepDelayMs: 1 }),
      engine: 'echo',
      logger: createLogger({ level: 'error', mirror: () => {} }),
      home,
      testConnectionGrant: (client) =>
        client.clientId === 'phone-1'
          ? { principal: { kind: 'device', deviceId: client.deviceId }, permissions: PHONE }
          : undefined,
    });
    cleanups.push(() => host.shutdown());
    const token = (
      JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
    ).token;

    const desktop = await TestRpcClient.connect(host.url);
    cleanups.push(() => desktop.ws.terminate());
    const desktopHello = (await desktop.hello(token, local)).result;
    expect(desktopHello.permissions).toEqual([...PERMISSIONS]);
    expect(desktopHello.features.permission_enforcement).toBe(true);

    const phone = await TestRpcClient.connect(host.url);
    cleanups.push(() => phone.ws.terminate());
    const phoneHello = (
      await phone.hello(token, { deviceId: 'dev-phone', clientId: 'phone-1', clientKind: 'cli' })
    ).result;
    expect(phoneHello.permissions).toEqual(PHONE);
    expect((await phone.call('session.list')).error).toBeUndefined();
    expectForbidden(await phone.call('settings.update', { settings: {} }), ['host.manage'], 'x');
  });
});
