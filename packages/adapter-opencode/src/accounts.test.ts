// OpenCodeAccounts：找可执行文件、版本、provider.list → AccountState 与模型（假的 opencode，不起进程）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountState } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCodeAccounts, type OpenCodeAccountsOptions } from './accounts.js';
import { OPENCODE_INSTALL_COMMAND, OPENCODE_LOGIN_COMMAND } from './executable.js';
import { OpenCodeRuntime } from './runtime.js';
import { FAKE_OPENCODE_VERSION, FakeOpenCode } from './test-fixtures/fake-opencode.js';

const dirs: string[] = [];
const runtimes: OpenCodeRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(
  options: {
    executable?: string | ((customPath: string | null) => string | undefined);
    version?: string;
    probeFails?: 'missing' | 'failed';
    now?: () => number;
    accounts?: Partial<OpenCodeAccountsOptions>;
  } = {},
) {
  const fake = new FakeOpenCode();
  const engineDir = mkdtempSync(join(tmpdir(), 'wevir-opencode-accounts-'));
  dirs.push(engineDir);
  const find =
    typeof options.executable === 'function'
      ? options.executable
      : () =>
          'executable' in options
            ? (options.executable as string | undefined)
            : '/fake/bin/opencode';
  const runtime = new OpenCodeRuntime({
    engineDir,
    env: {},
    sdk: async () => fake,
    findExecutable: find,
    probeVersion: async () =>
      options.probeFails === undefined
        ? { ok: true, version: options.version ?? FAKE_OPENCODE_VERSION }
        : { ok: false, reason: options.probeFails, message: 'probe failed' },
    startServer: fake.start,
    idleTtlMs: 20,
  });
  runtimes.push(runtime);
  const accounts = new OpenCodeAccounts({
    runtime,
    env: {},
    ...(options.now !== undefined && { now: options.now }),
    ...options.accounts,
  });
  return { fake, runtime, accounts };
}

describe('OpenCodeAccounts', () => {
  it('接上了上游：已登录，套餐写上游的名字，带版本与路径', async () => {
    const { accounts } = setup();
    const changes: AccountState[] = [];
    accounts.onChange((state) => changes.push(state));
    const state = await accounts.read('opencode');
    expect(state).toEqual({
      kind: 'opencode',
      status: 'signed_in',
      signIn: 'command',
      loginCommand: OPENCODE_LOGIN_COMMAND,
      installed: true,
      executablePath: '/fake/bin/opencode',
      version: FAKE_OPENCODE_VERSION,
      plan: 'mock',
      planLabel: 'Mock',
    });
    expect(changes).toEqual([state]);
  });

  it('模型：<上游>/<模型>，显示名带上游，变体是推理档位，默认取上游的默认模型', async () => {
    const { accounts } = setup();
    expect(await accounts.models('opencode')).toEqual({
      models: [
        {
          id: 'mock/echo',
          displayName: 'Mock · Mock Echo',
          contextWindow: 128_000,
          maxTokens: 8_192,
          supportsImages: false,
          reasoningEfforts: ['low', 'high'],
        },
        {
          id: 'mock/plain',
          displayName: 'Mock · Mock Plain',
          contextWindow: 128_000,
          maxTokens: 8_192,
          supportsImages: true,
          reasoningEfforts: [],
        },
      ],
      defaultModelId: 'mock/echo',
    });
    expect(accounts.contextWindow('mock/echo')).toBe(128_000);
    expect(accounts.contextWindow('other/x')).toBeUndefined();
  });

  it('没接上游：未登录，没有 lastError，给登录命令', async () => {
    const { accounts, fake } = setup();
    fake.providerList = { ...fake.providerList, connected: [] };
    const state = await accounts.read('opencode');
    expect(state).toMatchObject({
      status: 'signed_out',
      installed: true,
      loginCommand: OPENCODE_LOGIN_COMMAND,
    });
    expect(state.lastError).toBeUndefined();
    expect(await accounts.models('opencode')).toEqual({ models: [] });
    await expect(accounts.requireReady()).rejects.toMatchObject({ code: 'missing_credentials' });
  });

  it('没装：installed false，给安装命令；会话报 engine_unavailable', async () => {
    const { accounts, fake } = setup({ executable: undefined });
    const state = await accounts.read('opencode');
    expect(state).toEqual({
      kind: 'opencode',
      status: 'signed_out',
      signIn: 'command',
      loginCommand: OPENCODE_LOGIN_COMMAND,
      installed: false,
      installCommand: OPENCODE_INSTALL_COMMAND,
    });
    expect(fake.starts).toBe(0);
    await expect(accounts.requireReady()).rejects.toMatchObject({ code: 'engine_unavailable' });
  });

  it('2.x 与太旧的版本不能用', async () => {
    const v2 = await setup({ version: '2.0.29' }).accounts.read('opencode');
    expect(v2).toMatchObject({ installed: true, status: 'signed_out', version: '2.0.29' });
    expect(v2.lastError).toMatch(/2\.x\) is not supported/);
    const old = await setup({ version: '1.14.0' }).accounts.read('opencode');
    expect(old.lastError).toMatch(/too old\. Upgrade to v1\.14\.19/);
  });

  it('跑不起来：installed true 带原因', async () => {
    const state = await setup({ probeFails: 'failed' }).accounts.read('opencode');
    expect(state).toMatchObject({
      installed: true,
      executablePath: '/fake/bin/opencode',
      lastError: 'probe failed',
    });
  });

  it('结果缓存 5 分钟，refresh 时重新检测', async () => {
    let now = 0;
    const { accounts, fake } = setup({ now: () => now });
    await accounts.read('opencode');
    await accounts.read('opencode');
    expect(fake.calls.filter((call) => call.method === 'providers')).toHaveLength(1);
    await accounts.read('opencode', { refresh: true });
    expect(fake.calls.filter((call) => call.method === 'providers')).toHaveLength(2);
    now = 5 * 60_000 + 1;
    await accounts.read('opencode');
    expect(fake.calls.filter((call) => call.method === 'providers')).toHaveLength(3);
  });

  it('指定路径：customPath 记在状态里，找不到时说明', async () => {
    const { accounts } = setup({
      executable: (customPath) =>
        customPath === '/missing/opencode' ? undefined : '/fake/bin/opencode',
    });
    const state = await accounts.setExecutablePath('opencode', '/missing/opencode');
    expect(state).toMatchObject({
      installed: false,
      customPath: '/missing/opencode',
      lastError: '/missing/opencode does not exist',
    });
    expect(await accounts.setExecutablePath('opencode', null)).toMatchObject({
      status: 'signed_in',
    });
  });

  it('登录与登出要在终端里做；别的种类报 invalid_input', async () => {
    const { accounts } = setup();
    await expect(accounts.login('opencode', 'browser')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(accounts.logout('opencode')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(accounts.read('claude')).rejects.toMatchObject({ code: 'invalid_input' });
    accounts.dispose();
    await expect(accounts.read('opencode')).rejects.toMatchObject({ code: 'disposed' });
  });

  it('读完账号还回服务器，空闲一会儿就停', async () => {
    const { accounts, fake } = setup();
    await accounts.read('opencode');
    expect(fake.running).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.running).toBe(false);
  });
});
