// 0.19.0：订阅来源（host-api.md §3.1 account.list / setPath / install、provider.setEnabled，§10 的 subscription_kinds）。
// 引擎是 host 的 `--adapter echo` 在 WEVIR_ECHO_SUBSCRIPTIONS 下的组合：echo 管 API 类 Provider，另一个带假订阅账号的 echo
// 管订阅来源，两者经 EngineRouter 合在一起。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStorage } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdapter } from './cli.js';
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

const FULL = { provider_kind_chatgpt: true, subscription_kinds: true };

async function start(scenarios = '1', home = join(tempDir(), 'home')) {
  const logger = createLogger({ mirror: () => {} });
  const adapter = createAdapter('echo', {
    home,
    logger,
    env: { WEVIR_ECHO_SUBSCRIPTIONS: scenarios },
  });
  const host = await startHost({ adapter, engine: 'echo', home, logger });
  running.push(host);
  const token = (
    JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
  ).token;
  const connect = async (capabilities: Record<string, boolean> = FULL) => {
    const client = await TestRpcClient.connect(host.url);
    clients.push(client);
    const frame = await client.hello(token, undefined, capabilities);
    expect(frame.error).toBeUndefined();
    return { client, hello: frame.result };
  };
  return { home, host, connect };
}

/** 启动时后台读一遍订阅账号，已登录的种类建好 Provider；等它们出现。 */
async function providersOf(client: TestRpcClient, ids: string[]) {
  await vi.waitFor(async () => {
    const { providers } = await client.request('provider.list');
    const present = (providers as { id: string }[]).map((provider) => provider.id);
    for (const id of ids) expect(present).toContain(id);
  });
  return (await client.request('provider.list')).providers as {
    id: string;
    kind: string;
    displayName: string;
    defaultModelId: string;
    enabled?: boolean;
  }[];
}

describe('订阅来源（0.19.0）', () => {
  it('hello 声明 subscription_sources 与 provider_enabled，不声明 chatgpt_account；account.list 列出五种', async () => {
    const { connect } = await start();
    const { client, hello } = await connect();
    expect(hello.features).toMatchObject({ subscription_sources: true, provider_enabled: true });
    expect(hello.features.chatgpt_account).toBeUndefined();

    const { accounts } = await client.request('account.list');
    expect(accounts.map((account: { kind: string }) => account.kind)).toEqual([
      'claude',
      'cursor',
      'opencode',
      'grok',
      'antigravity',
    ]);
    expect(accounts[0]).toMatchObject({
      kind: 'claude',
      status: 'signed_in',
      signIn: 'command',
      loginCommand: 'claude auth login',
      planLabel: 'Max 20x',
      installed: true,
    });
    expect(accounts[2]).toMatchObject({ kind: 'opencode', installed: false });
    expect(accounts[4]).toMatchObject({ kind: 'antigravity', installed: false, canInstall: true });
  });

  it('已登录的种类由 Host 建 Provider（ID 与种类相同，Claude 叫 Claude），会话交给订阅引擎', async () => {
    const { connect } = await start();
    const { client } = await connect();
    const providers = await providersOf(client, ['claude', 'grok']);
    expect(providers.find((provider) => provider.id === 'claude')).toMatchObject({
      kind: 'claude',
      displayName: 'Claude',
      defaultModelId: 'claude-opus-5-5',
    });
    expect(providers.some((provider) => provider.id === 'cursor')).toBe(false);

    const workspace = (await client.request('workspace.add', { rootPath: tempDir() })).workspace;
    const { session } = await client.request('session.create', {
      workspaceId: workspace.id,
      providerId: 'claude',
    });
    expect(session).toMatchObject({ providerId: 'claude', modelId: 'claude-opus-5-5' });
    const sent = await client.request('session.send', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(sent.turnId).toMatch(/^trn_/);
  });

  it('以前建的 Claude Provider 还叫 Claude Agent 时，Host 刷新时改叫 Claude', async () => {
    const first = await start();
    await providersOf((await first.connect()).client, ['claude']);
    for (const client of clients.splice(0)) client.ws.terminate();
    for (const host of running.splice(0)) await host.shutdown();

    const storage = openStorage({ dataDir: first.home });
    const claude = storage.providers.get('claude');
    expect(claude).toBeDefined();
    if (claude !== undefined) storage.providers.update({ ...claude, displayName: 'Claude Agent' });
    storage.close();

    const { connect } = await start('1', first.home);
    const { client } = await connect();
    await vi.waitFor(async () => {
      const { providers } = await client.request('provider.list');
      expect(providers.find((provider: { id: string }) => provider.id === 'claude')).toMatchObject({
        displayName: 'Claude',
      });
    });
  });

  it('没声明 subscription_kinds 的连接看不到订阅来源，也收不到它们的 account.updated', async () => {
    const { connect } = await start();
    const full = (await connect()).client;
    await providersOf(full, ['claude']);
    const old = (await connect({ provider_kind_chatgpt: true })).client;

    expect((await old.request('provider.list')).providers).toEqual([]);
    expect((await old.request('account.list')).accounts).toEqual([]);

    await full.request('account.list');
    await full.request('account.logout', { kind: 'claude' });
    await vi.waitFor(() => expect(full.notifications('account.updated')).toHaveLength(1));
    expect(old.notifications('account.updated')).toEqual([]);
  });

  it('应用内登录：signing_in 带 authUrl，完成后 account.updated 是 signed_in，并建出 Provider', async () => {
    const { connect } = await start();
    const { client } = await connect();
    const { account } = await client.request('account.login', {
      kind: 'cursor',
      method: 'browser',
    });
    expect(account).toMatchObject({
      kind: 'cursor',
      status: 'signing_in',
      login: { method: 'browser', authUrl: 'https://example.com/echo-login/cursor' },
    });
    await vi.waitFor(
      () =>
        expect(client.notifications('account.updated').at(-1)?.account).toMatchObject({
          kind: 'cursor',
          status: 'signed_in',
        }),
      { timeout: 4000 },
    );
    await providersOf(client, ['cursor']);
    const command = await client.call('account.login', { kind: 'claude', method: 'browser' });
    expect(command.error).toMatchObject({ code: -32041 });
  });

  it('account.setPath 交给引擎并记进 engines.json，null 清掉；account.install 经 account.updated 报进度直到装好', async () => {
    const { home, connect } = await start('opencode=missing');
    const { client } = await connect();
    const { account } = await client.request('account.setPath', {
      kind: 'opencode',
      path: '/opt/homebrew/bin/opencode',
    });
    expect(account).toMatchObject({ installed: true, customPath: '/opt/homebrew/bin/opencode' });
    expect(JSON.parse(readFileSync(join(home, 'engines.json'), 'utf8'))).toEqual({
      paths: { opencode: '/opt/homebrew/bin/opencode' },
    });
    const cleared = await client.request('account.setPath', { kind: 'opencode', path: null });
    expect(cleared.account.customPath).toBeUndefined();
    expect(JSON.parse(readFileSync(join(home, 'engines.json'), 'utf8'))).toEqual({ paths: {} });

    const installing = await client.request('account.install', { kind: 'antigravity' });
    expect(installing.account.installing).toMatchObject({ completedBytes: 0 });
    await vi.waitFor(
      () =>
        expect(client.notifications('account.updated').at(-1)?.account).toMatchObject({
          kind: 'antigravity',
          installed: true,
        }),
      { timeout: 4000 },
    );
    const progress = client
      .notifications('account.updated')
      .filter((params) => params.account.installing !== undefined);
    expect(progress.length).toBeGreaterThan(1);
    const notInstallable = await client.call('account.install', { kind: 'claude' });
    expect(notInstallable.error).toMatchObject({ code: -32041 });
  });

  it('provider.setEnabled：停用写 enabled: false，模型刷新与编辑都保留它；启用去掉这个字段', async () => {
    const { connect } = await start();
    const { client } = await connect();
    await providersOf(client, ['claude']);
    const off = await client.request('provider.setEnabled', {
      providerId: 'claude',
      enabled: false,
    });
    expect(off.provider).toMatchObject({ id: 'claude', enabled: false });
    await client.request('account.get', { kind: 'claude', refresh: true });
    const listed = (await client.request('provider.list')).providers;
    expect(listed.find((p: { id: string }) => p.id === 'claude').enabled).toBe(false);

    const on = await client.request('provider.setEnabled', { providerId: 'claude', enabled: true });
    expect(on.provider.enabled).toBeUndefined();
    const missing = await client.call('provider.setEnabled', { providerId: 'nope', enabled: true });
    expect(missing.error).toMatchObject({ code: -32011 });
  });
});
