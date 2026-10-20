// R6：Host 的 ChatGPT 账号（host-api.md §3.1 account.*、§10）。引擎换成带假账号的 EchoAdapter；真实 codex-app-server 的
// 账号流程在 packages/adapter-codex 的 codex-runtime.chatgpt.integration.test.ts。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AccountKind,
  AccountLoginMethod,
  AccountModels,
  AccountState,
  EngineAccounts,
  ProviderConfig,
  ProviderIssue,
} from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningHost, startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { loadTerminalModules } from './terminals.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

/** node-pty 装得上的平台（macOS、Windows）才有用户终端。 */
const userTerminal = loadTerminalModules(() => {}) !== undefined;

const tempDir = useTempDir();
const running: RunningHost[] = [];
const clients: TestRpcClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const host of running.splice(0)) await host.shutdown();
});

const MODELS: AccountModels = {
  models: [
    { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', reasoningEfforts: ['low', 'high'] },
    { id: 'gpt-6-astra', displayName: 'GPT-6-Astra' },
  ],
  defaultModelId: 'gpt-6.1-sol',
};

/** 假的引擎账号：状态由测试推动。 */
class FakeAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[] = ['chatgpt'];
  state: AccountState = { kind: 'chatgpt', status: 'signed_out' };
  models_: AccountModels = MODELS;
  readonly calls: string[] = [];
  readonly #listeners = new Set<(state: AccountState) => void>();

  async read(): Promise<AccountState> {
    this.calls.push('read');
    return this.state;
  }
  async login(_kind: AccountKind, method: AccountLoginMethod): Promise<AccountState> {
    this.calls.push(`login:${method}`);
    if (method === 'device_code') throw new Error('failed to request device code: offline');
    this.set({
      kind: 'chatgpt',
      status: 'signing_in',
      login: {
        loginId: 'login-1',
        method,
        authUrl: 'https://auth.openai.com/oauth/authorize?x=1',
        startedAt: '2026-10-14T08:00:00.000Z',
      },
    });
    return this.state;
  }
  async cancelLogin(_kind: AccountKind, loginId?: string): Promise<AccountState> {
    this.calls.push(`cancel:${loginId}`);
    this.set({ kind: 'chatgpt', status: 'signed_out' });
    return this.state;
  }
  async logout(): Promise<AccountState> {
    this.calls.push('logout');
    this.set({ kind: 'chatgpt', status: 'signed_out' });
    return this.state;
  }
  async models(): Promise<AccountModels> {
    return this.models_;
  }
  onChange(listener: (state: AccountState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  set(state: AccountState): void {
    this.state = state;
    for (const listener of this.#listeners) listener(state);
  }
  signIn(): void {
    this.set({ kind: 'chatgpt', status: 'signed_in', email: 'me@example.com', plan: 'plus' });
  }
}

/** 有账号的引擎：EchoAdapter 加上假账号；只接受 chatgpt 类 Provider 的检查照 Codex 的规则。 */
class AccountAdapter extends EchoAdapter {
  readonly accounts = new FakeAccounts();
  readonly applied: ProviderConfig[][] = [];
  validateProvider(provider: ProviderConfig): ProviderIssue[] {
    return provider.kind === 'chatgpt' && provider.id !== 'chatgpt'
      ? [{ path: ['id'], message: 'bad id' }]
      : [];
  }
  async configureProviders(providers: readonly ProviderConfig[]): Promise<void> {
    this.applied.push([...providers]);
  }
}

async function start(adapter: EchoAdapter = new AccountAdapter()) {
  const home = join(tempDir(), 'home');
  const host = await startHost({
    adapter,
    engine: 'echo',
    home,
    logger: createLogger({ mirror: () => {} }),
  });
  running.push(host);
  const token = (
    JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
  ).token;
  const connect = async (
    capabilities: Record<string, boolean> = { provider_kind_chatgpt: true },
  ) => {
    const client = await TestRpcClient.connect(host.url);
    clients.push(client);
    const frame = await client.hello(token, undefined, capabilities);
    expect(frame.error).toBeUndefined();
    return { client, hello: frame.result };
  };
  return { host, connect };
}

describe('ChatGPT 账号（account.*）', () => {
  it('引擎有账号时 hello 声明 chatgpt_account；echo 引擎不声明，account.* 回 ENGINE_ERROR', async () => {
    const withAccounts = await start();
    expect((await withAccounts.connect()).hello.features).toEqual({
      plugins: true,
      plugin_packages: true,
      provider_model_discovery: true,
      rule_files: true,
      pending_messages: true,
      host_settings: true,
      workspace_git: true,
      workspace_diff: true,
      workspace_files: true,
      workspace_update: true,
      workspace_folders: true,
      file_preview: true,
      session_rename: true,
      session_archive: true,
      session_delete: true,
      session_handoff: true,
      handoff_material: true,
      handoff_preview: true,
      subagent_cancel: true,
      environments: true,
      session_worktree: true,
      provider_enabled: true,
      chat_sessions: true,
      memory: true,
      chatgpt_account: true,
      session_configure: true,
      user_questions: true,
      question_timeout: true,
      verification: true,
      review_comments: true,
      git_commit: true,
      process_output: true,
      ...(userTerminal && { user_terminal: true }),
      workspace_readiness: true,
      permission_modes: true,
      suggested_tasks: true,
      side_sessions: true,
      session_branches: true,
      session_rewind: true,
      session_undo: true,
      session_compact: true,
      session_review: true,
      session_goals: true,
      usage_stats: true,
      automations: true,
      automation_conditions: true,
      user_images: true,
      plan_mode: true,
    });

    const plain = await start(new EchoAdapter());
    const { client, hello } = await plain.connect();
    expect(hello.features).toEqual({
      plugins: true,
      plugin_packages: true,
      provider_model_discovery: true,
      rule_files: true,
      pending_messages: true,
      host_settings: true,
      workspace_git: true,
      workspace_diff: true,
      workspace_files: true,
      workspace_update: true,
      workspace_folders: true,
      file_preview: true,
      session_rename: true,
      session_archive: true,
      session_delete: true,
      session_handoff: true,
      handoff_material: true,
      handoff_preview: true,
      subagent_cancel: true,
      environments: true,
      session_worktree: true,
      provider_enabled: true,
      chat_sessions: true,
      memory: true,
      session_configure: true,
      user_questions: true,
      question_timeout: true,
      verification: true,
      review_comments: true,
      git_commit: true,
      process_output: true,
      ...(userTerminal && { user_terminal: true }),
      workspace_readiness: true,
      permission_modes: true,
      suggested_tasks: true,
      side_sessions: true,
      session_branches: true,
      session_rewind: true,
      session_undo: true,
      session_compact: true,
      session_review: true,
      session_goals: true,
      usage_stats: true,
      automations: true,
      automation_conditions: true,
      user_images: true,
      plan_mode: true,
    });
    const frame = await client.call('account.get', { kind: 'chatgpt' });
    expect(frame.error).toMatchObject({ code: -32041, data: { category: 'unknown' } });
    const upsert = await client.call('provider.upsert', {
      id: 'chatgpt',
      kind: 'chatgpt',
      displayName: 'ChatGPT',
      defaultModelId: 'gpt-6.1-sol',
    });
    expect(upsert.error).toMatchObject({ code: -32602 });
  });

  it('调过 account.* 的连接收到 account.updated，别的连接收不到；连接断开后不再发', async () => {
    const adapter = new AccountAdapter();
    const { connect } = await start(adapter);
    const watcher = (await connect()).client;
    const other = (await connect()).client;
    // 0.63.0 起 Host 给每个账号盖上账号 ID（首个账号等于种类）。
    expect(await watcher.request('account.get', { kind: 'chatgpt' })).toEqual({
      account: { kind: 'chatgpt', id: 'chatgpt', status: 'signed_out' },
    });
    const { account } = await watcher.request('account.login', {
      kind: 'chatgpt',
      method: 'browser',
    });
    expect(account).toMatchObject({ status: 'signing_in', login: { method: 'browser' } });
    await watcher.until(
      () => watcher.notifications('account.updated').find((p) => p.account.status === 'signing_in'),
      'signing_in 的通知',
    );
    adapter.accounts.signIn();
    await watcher.until(
      () => watcher.notifications('account.updated').find((p) => p.account.status === 'signed_in'),
      'signed_in 的通知',
    );
    expect(other.notifications('account.updated')).toEqual([]);
    expect(
      await watcher.request('account.cancelLogin', { kind: 'chatgpt', loginId: 'login-1' }),
    ).toEqual({ account: { kind: 'chatgpt', id: 'chatgpt', status: 'signed_out' } });
    expect(adapter.accounts.calls).toContain('cancel:login-1');
    expect((await watcher.request('account.logout', { kind: 'chatgpt' })).account.status).toBe(
      'signed_out',
    );
  });

  it('引擎失败（设备码连不上登录服务）回 ENGINE_ERROR，带原文', async () => {
    const { connect } = await start();
    const { client } = await connect();
    const frame = await client.call('account.login', { kind: 'chatgpt', method: 'device_code' });
    expect(frame.error).toMatchObject({
      code: -32041,
      data: { message: 'failed to request device code: offline' },
    });
  });

  it('登录成功后 Host 建 chatgpt Provider（模型与默认模型来自引擎），交给引擎；没有 provider_kind_chatgpt 的连接看不到它', async () => {
    const adapter = new AccountAdapter();
    const { connect } = await start(adapter);
    const { client } = await connect();
    await client.request('account.get', { kind: 'chatgpt' });
    adapter.accounts.signIn();
    const listed = await waitForProviders(client, 1);
    expect(listed[0]).toMatchObject({
      id: 'chatgpt',
      kind: 'chatgpt',
      displayName: 'ChatGPT',
      models: MODELS.models,
      defaultModelId: 'gpt-6.1-sol',
      hasSecret: false,
    });
    expect(adapter.applied.at(-1)?.map((p) => p.id)).toEqual(['chatgpt']);

    const old = (await connect({})).client;
    expect((await old.request('provider.list')).providers).toEqual([]);

    // 改默认模型：只能选引擎给的模型。
    const bad = await client.call('provider.upsert', {
      id: 'chatgpt',
      kind: 'chatgpt',
      displayName: 'ChatGPT',
      defaultModelId: 'gpt-4o',
    });
    expect(bad.error).toMatchObject({ code: -32602 });
    const { provider: updated, created } = await client.request('provider.upsert', {
      id: 'chatgpt',
      kind: 'chatgpt',
      displayName: '我的 ChatGPT',
      defaultModelId: 'gpt-6-astra',
    });
    expect(created).toBe(false);
    expect(updated).toMatchObject({ displayName: '我的 ChatGPT', defaultModelId: 'gpt-6-astra' });

    // 再次登录成功时刷新模型：默认模型还在就保留，不在了换成引擎的默认。
    adapter.accounts.models_ = {
      models: [{ id: 'gpt-7' }, { id: 'gpt-6-astra' }],
      defaultModelId: 'gpt-7',
    };
    adapter.accounts.set({ kind: 'chatgpt', status: 'signed_out' });
    adapter.accounts.signIn();
    const refreshed = await waitForProviders(
      client,
      1,
      (providers) => providers[0]?.models.length === 2 && providers[0].models[0].id === 'gpt-7',
    );
    expect(refreshed[0]).toMatchObject({
      displayName: '我的 ChatGPT',
      defaultModelId: 'gpt-6-astra',
    });
  });
});

// biome-ignore lint/suspicious/noExplicitAny: 测试只读 Provider 的字段。
async function waitForProviders(client: TestRpcClient, count: number, ok?: (p: any[]) => boolean) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const { providers } = await client.request('provider.list');
    if (providers.length === count && (ok === undefined || ok(providers))) return providers;
    if (Date.now() > deadline)
      throw new Error(`provider.list 没等到：${JSON.stringify(providers)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
