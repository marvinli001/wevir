// 0.63.0：同一订阅来源的多个账号（host-api.md §3.1 account.add / remove / setLabel，§10 的 subscription_accounts）。引擎同
// subscriptions.test.ts：host 的 `--adapter echo` 在 WEVIR_ECHO_SUBSCRIPTIONS 下的组合，添加的账号各是一个只有这一种的假引擎。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@wevir/protocol';
import type { AgentRuntimeAdapter } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdapter } from './cli.js';
import { EngineRouter } from './engine-router.js';
import { type RunningHost, startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const running: RunningHost[] = [];
const clients: TestRpcClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const host of running.splice(0)) await host.shutdown();
});

const FULL = { provider_kind_chatgpt: true, subscription_kinds: true, subscription_accounts: true };
/** 假引擎的应用内登录 1.5 秒后完成。 */
const LOGIN = { timeout: 5000, interval: 50 };

interface Account {
  kind: string;
  id: string;
  status: string;
  label?: string;
  email?: string;
  localLogin?: true;
  multiAccount?: true;
  signIn?: string;
}

async function start(home = join(tempDir(), 'home')) {
  const logger = createLogger({ mirror: () => {} });
  const adapter = createAdapter('echo', { home, logger, env: { WEVIR_ECHO_SUBSCRIPTIONS: '1' } });
  const host = await startHost({ adapter, engine: 'echo', home, logger });
  running.push(host);
  const token = (
    JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
  ).token;
  const connect = async (capabilities: Record<string, boolean> = FULL) => {
    const client = await TestRpcClient.connect(host.url);
    clients.push(client);
    const frame = await client.call('host.hello', {
      token,
      protocolVersion: PROTOCOL_VERSION,
      clientKind: 'desktop',
      deviceId: 'dev-aabbee',
      clientId: 'desk-ffeecc',
      capabilities,
    });
    expect(frame.error).toBeUndefined();
    return { client, hello: frame.result };
  };
  return { home, adapter, connect };
}

async function stopAll() {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const host of running.splice(0)) await host.shutdown();
}

/** 承载这个账号的假引擎（添加的账号的路由）。 */
function engineOf(adapter: AgentRuntimeAdapter, id: string) {
  if (!(adapter instanceof EngineRouter)) throw new Error('not a router');
  const route = adapter.routes.find((each) => each.providerIds?.includes(id));
  return route?.adapter as (AgentRuntimeAdapter & { sessionCount: number }) | undefined;
}

async function providerOf(client: TestRpcClient, id: string) {
  let found: { id: string; kind: string; displayName: string } | undefined;
  await vi.waitFor(async () => {
    const { providers } = await client.request('provider.list');
    found = (providers as { id: string; kind: string; displayName: string }[]).find(
      (provider) => provider.id === id,
    );
    expect(found).toBeDefined();
  }, LOGIN);
  return found as { id: string; kind: string; displayName: string };
}

/** 添加一个账号并在应用内登录，等到它的 Provider 建好。 */
async function addSignedIn(client: TestRpcClient, kind: string, label?: string) {
  const { account } = (await client.request('account.add', {
    kind,
    ...(label !== undefined && { label }),
  })) as { account: Account };
  await client.request('account.login', { kind, id: account.id, method: 'browser' });
  await client.until(
    () =>
      client
        .notifications('account.updated')
        .find(
          (params) =>
            (params.account as Account).id === account.id &&
            (params.account as Account).status === 'signed_in',
        ),
    `${account.id} 登录完成`,
    LOGIN.timeout,
  );
  await providerOf(client, account.id);
  return account;
}

describe('订阅多账号（0.63.0）', () => {
  it('hello 声明 subscription_accounts；每个账号带 ID，能添加的种类带 multiAccount，本机登录的首个账号带 localLogin', async () => {
    const { connect } = await start();
    const { client, hello } = await connect();
    expect(hello.features).toMatchObject({ subscription_accounts: true });
    const { accounts } = (await client.request('account.list')) as { accounts: Account[] };
    expect(accounts.map((account) => account.id)).toEqual([
      'claude',
      'cursor',
      'opencode',
      'grok',
      'antigravity',
      'workbuddy',
      'devin',
    ]);
    const byId = new Map(accounts.map((account) => [account.id, account]));
    expect(byId.get('claude')).toMatchObject({ localLogin: true, multiAccount: true });
    expect(byId.get('cursor')).toMatchObject({ multiAccount: true });
    expect(byId.get('cursor')?.localLogin).toBeUndefined();
    expect(byId.get('opencode')).toMatchObject({ localLogin: true, multiAccount: true });
    expect(byId.get('workbuddy')?.multiAccount).toBeUndefined();
    expect(byId.get('devin')).toMatchObject({ localLogin: true });
    expect(byId.get('devin')?.multiAccount).toBeUndefined();
  });

  it('OpenCode 添加的账号（0.100.0）：上游按账号读、接、断，首个账号不受影响', async () => {
    const { connect } = await start();
    const { client } = await connect();
    const { account } = (await client.request('account.add', { kind: 'opencode' })) as {
      account: Account;
    };
    const ref = { kind: 'opencode', id: account.id };
    const connected = async (params: { kind: string; id?: string }) =>
      (
        (await client.request('account.upstreams', params)) as {
          upstreams: { id: string; connected: boolean }[];
        }
      ).upstreams.find((entry) => entry.id === 'anthropic')?.connected;
    expect(await connected(ref)).toBe(false);

    await client.request('account.login', {
      ...ref,
      method: 'browser',
      upstream: 'anthropic',
      apiKey: 'sk-ant-added-account',
    });
    expect(await connected(ref)).toBe(true);
    expect(await connected({ kind: 'opencode' })).toBe(false);

    await client.request('account.logout', { ...ref, upstream: 'anthropic' });
    expect(await connected(ref)).toBe(false);

    const mismatch = await client.call('account.upstreams', { kind: 'claude', id: account.id });
    expect(mismatch.error).toMatchObject({ code: -32602 });
  });

  it('添加的账号未登录、在应用内登录；登录后有自己的 Provider，会话交给它自己的引擎', async () => {
    const { connect, adapter, home } = await start();
    const { client } = await connect();
    const { account } = (await client.request('account.add', {
      kind: 'claude',
      label: '工作',
    })) as { account: Account };
    expect(account).toMatchObject({
      kind: 'claude',
      status: 'signed_out',
      label: '工作',
      signIn: 'in_app',
      multiAccount: true,
    });
    expect(account.id).toMatch(/^claude-[0-9a-f]{4}$/);
    expect(account.localLogin).toBeUndefined();
    expect(existsSync(join(home, 'accounts', account.id))).toBe(true);

    await client.request('account.login', { kind: 'claude', id: account.id, method: 'browser' });
    await client.until(
      () =>
        client
          .notifications('account.updated')
          .find(
            (params) =>
              (params.account as Account).id === account.id &&
              (params.account as Account).status === 'signed_in',
          ),
      '登录完成',
      LOGIN.timeout,
    );
    const { account: read } = (await client.request('account.get', {
      kind: 'claude',
      id: account.id,
    })) as { account: Account };
    expect(read).toMatchObject({ status: 'signed_in', email: `${account.id}@example.com` });
    // 首个账号不受影响。
    const { account: first } = (await client.request('account.get', { kind: 'claude' })) as {
      account: Account;
    };
    expect(first).toMatchObject({ id: 'claude', email: 'me@example.com' });

    const provider = await providerOf(client, account.id);
    expect(provider).toMatchObject({ kind: 'claude', displayName: 'Claude · 工作' });

    const workspace = (await client.request('workspace.add', { rootPath: tempDir() })).workspace;
    const engine = engineOf(adapter, account.id);
    expect(engine?.sessionCount).toBe(0);
    const { session } = await client.request('session.create', {
      workspaceId: workspace.id,
      providerId: account.id,
    });
    expect(session).toMatchObject({ providerId: account.id, modelId: 'claude-opus-5-5' });
    await client.request('session.send', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(engine?.sessionCount).toBe(1);

    // ID 与种类对不上、不认识的 ID：INVALID_PARAMS。
    expect(
      (await client.call('account.get', { kind: 'cursor', id: account.id })).error,
    ).toMatchObject({ code: -32602 });
    expect(
      (await client.call('account.get', { kind: 'claude', id: 'claude-ffff' })).error,
    ).toMatchObject({ code: -32602 });
  });

  it('标签：改显示名、清掉后添加的账号叫“名字 2”；首个账号也能设；不能添加的种类 INVALID_PARAMS', async () => {
    const { connect } = await start();
    const { client } = await connect();
    const added = await addSignedIn(client, 'grok');
    expect((await providerOf(client, added.id)).displayName).toBe('Grok 2');

    const { account } = (await client.request('account.setLabel', {
      id: added.id,
      label: '副号',
    })) as { account: Account };
    expect(account).toMatchObject({ id: added.id, label: '副号', status: 'signed_in' });
    expect((await providerOf(client, added.id)).displayName).toBe('Grok · 副号');

    await client.request('account.setLabel', { id: 'grok', label: '主号' });
    expect((await providerOf(client, 'grok')).displayName).toBe('Grok · 主号');
    await client.request('account.setLabel', { id: added.id, label: null });
    expect((await providerOf(client, added.id)).displayName).toBe('Grok 2');
    const { accounts } = (await client.request('account.list')) as { accounts: Account[] };
    expect(accounts.find((each) => each.id === 'grok')?.label).toBe('主号');
    expect(accounts.find((each) => each.id === added.id)?.label).toBeUndefined();

    expect((await client.call('account.add', { kind: 'workbuddy' })).error).toMatchObject({
      code: -32602,
    });
    expect((await client.call('account.setLabel', { id: 'nope', label: 'x' })).error).toMatchObject(
      { code: -32602 },
    );
  });

  it('没声明 subscription_accounts 的客户端只看到每种的首个账号', async () => {
    const { connect } = await start();
    const { client } = await connect();
    const added = await addSignedIn(client, 'cursor');
    const old = (await connect({ provider_kind_chatgpt: true, subscription_kinds: true })).client;
    const { accounts } = (await old.request('account.list')) as { accounts: Account[] };
    expect(accounts.map((account) => account.id)).not.toContain(added.id);
    expect(accounts.find((account) => account.kind === 'cursor')?.id).toBe('cursor');
    await client.request('account.logout', { kind: 'cursor', id: added.id });
    await client.until(
      () =>
        client
          .notifications('account.updated')
          .find(
            (params) =>
              (params.account as Account).id === added.id &&
              (params.account as Account).status === 'signed_out',
          ),
      '登出的通知',
    );
    expect(
      old
        .notifications('account.updated')
        .some((params) => (params.account as Account).id === added.id),
    ).toBe(false);
  });

  it('删账号：有没关闭的会话时 RESOURCE_IN_USE；关掉后删掉 Provider、登记与目录；首个账号不能删', async () => {
    const { connect, home } = await start();
    const { client } = await connect();
    const added = await addSignedIn(client, 'antigravity');
    const workspace = (await client.request('workspace.add', { rootPath: tempDir() })).workspace;
    const { session } = await client.request('session.create', {
      workspaceId: workspace.id,
      providerId: added.id,
    });
    expect((await client.call('account.remove', { id: added.id })).error).toMatchObject({
      code: -32024,
      data: { sessionIds: [session.id] },
    });
    await client.request('session.close', { sessionId: session.id });
    expect(await client.request('account.remove', { id: added.id })).toEqual({});
    const { providers } = await client.request('provider.list');
    expect((providers as { id: string }[]).map((provider) => provider.id)).not.toContain(added.id);
    const { accounts } = (await client.request('account.list')) as { accounts: Account[] };
    expect(accounts.map((account) => account.id)).not.toContain(added.id);
    expect(existsSync(join(home, 'accounts', added.id))).toBe(false);

    expect((await client.call('account.remove', { id: 'antigravity' })).error).toMatchObject({
      code: -32602,
    });
    expect((await client.call('account.remove', { id: added.id })).error).toMatchObject({
      code: -32602,
    });
  });

  it('Host 重启后添加的账号还在，它的会话仍交给它自己的引擎', async () => {
    const home = join(tempDir(), 'home');
    const first = await start(home);
    const { client } = await first.connect();
    const added = await addSignedIn(client, 'claude', '工作');
    const workspace = (await client.request('workspace.add', { rootPath: tempDir() })).workspace;
    const { session } = await client.request('session.create', {
      workspaceId: workspace.id,
      providerId: added.id,
    });
    await stopAll();

    const second = await start(home);
    const next = (await second.connect()).client;
    const { accounts } = (await next.request('account.list')) as { accounts: Account[] };
    expect(accounts.find((account) => account.id === added.id)).toMatchObject({
      kind: 'claude',
      label: '工作',
    });
    const engine = engineOf(second.adapter, added.id);
    expect(engine).toBeDefined();
    // 恢复会话交给这个账号的引擎（假引擎的会话在内存里，恢复不了，报错是它报的）。
    const resume = vi.spyOn(engine as AgentRuntimeAdapter, 'resumeSession');
    await next.call('session.send', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'again' }],
    });
    expect(resume).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ providerId: added.id }),
    );
  });
});
