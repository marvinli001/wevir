// 在 Wevir 里接上游（opencode-event-mapping.md §2.4）：上游表、API Key、浏览器授权与设备码、取消、失败、断开（假的 opencode 服务器）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountState } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_TIMEOUT_MS, OpenCodeAccounts } from './accounts.js';
import { OpenCodeRuntime } from './runtime.js';
import type { ProviderAuthMethod } from './sdk.js';
import { FAKE_OPENCODE_VERSION, FakeOpenCode } from './test-fixtures/fake-opencode.js';
import { defaultInputs, deviceCode, upstreamCatalog, upstreamMethods } from './upstreams.js';

const dirs: string[] = [];
const runtimes: OpenCodeRuntime[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 接近真实的 `provider.auth`（opencode 1.19.3 实测）。 */
const AUTH: Record<string, ProviderAuthMethod[]> = {
  openai: [
    { type: 'oauth', label: 'ChatGPT Pro/Plus (browser)' },
    { type: 'oauth', label: 'ChatGPT Pro/Plus (headless)' },
    { type: 'api', label: 'Manually enter API Key' },
  ],
  'github-copilot': [
    {
      type: 'oauth',
      label: 'Login with GitHub Copilot',
      prompts: [
        {
          type: 'select',
          key: 'deploymentType',
          message: 'Select GitHub deployment type',
          options: [
            { label: 'GitHub.com', value: 'github.com', hint: 'Public' },
            { label: 'GitHub Enterprise', value: 'enterprise' },
          ],
        },
        {
          type: 'text',
          key: 'enterpriseUrl',
          message: 'Enter your GitHub Enterprise URL or domain',
          when: { key: 'deploymentType', op: 'eq', value: 'enterprise' },
        },
      ],
    },
  ],
  gitlab: [
    {
      type: 'oauth',
      label: 'GitLab OAuth',
      prompts: [{ type: 'text', key: 'instanceUrl', message: 'GitLab instance URL' }],
    },
  ],
  azure: [
    {
      type: 'api',
      label: 'API key',
      prompts: [{ type: 'text', key: 'resourceName', message: 'Enter Azure Resource Name' }],
    },
  ],
};

function provider(id: string, name: string) {
  return { id, name, source: 'custom', env: [], options: {}, models: {} };
}

function setup(options: { connected?: string[] } = {}) {
  const fake = new FakeOpenCode();
  fake.authMethods = AUTH;
  fake.providerList = {
    all: [
      provider('zeta', 'Zeta AI'),
      provider('openai', 'OpenAI'),
      provider('opencode', 'OpenCode'),
      provider('opencode-go', 'OpenCode Go'),
      provider('github-copilot', 'GitHub Copilot'),
      provider('gitlab', 'GitLab'),
      provider('azure', 'Azure'),
      provider('abc', 'ABC Cloud'),
    ],
    default: {},
    connected: options.connected ?? ['opencode'],
  } as unknown as typeof fake.providerList;
  const engineDir = mkdtempSync(join(tmpdir(), 'wevir-opencode-connect-'));
  dirs.push(engineDir);
  const runtime = new OpenCodeRuntime({
    engineDir,
    env: {},
    sdk: async () => fake,
    findExecutable: () => '/fake/bin/opencode',
    probeVersion: async () => ({ ok: true, version: FAKE_OPENCODE_VERSION }),
    startServer: fake.start,
    idleTtlMs: 20,
    installer: null,
  });
  runtimes.push(runtime);
  const accounts = new OpenCodeAccounts({ runtime, env: {} });
  const seen: AccountState[] = [];
  accounts.onChange((state) => seen.push(state));
  return { fake, runtime, accounts, seen };
}

describe('上游表', () => {
  it('没有额外信息的方式都能在应用内用；Copilot 取 GitHub.com；要自己填实例地址、账号 ID 的不提供', () => {
    expect(defaultInputs(undefined)).toEqual({});
    expect(defaultInputs(AUTH['github-copilot']?.[0]?.prompts)).toEqual({
      deploymentType: 'github.com',
    });
    expect(defaultInputs(AUTH.gitlab?.[0]?.prompts)).toBeUndefined();
    expect(upstreamMethods(undefined)).toEqual([
      { type: 'api_key', label: 'API key', option: 'default' },
    ]);
    expect(upstreamMethods(AUTH.openai)).toEqual([
      { type: 'oauth', label: 'ChatGPT Pro/Plus (browser)', option: '0', index: 0 },
      { type: 'oauth', label: 'ChatGPT Pro/Plus (headless)', option: '1', index: 1 },
      { type: 'api_key', label: 'Manually enter API Key', option: '2', index: 2 },
    ]);
    expect(upstreamMethods(AUTH.gitlab)).toEqual([]);
    expect(upstreamMethods(AUTH.azure)).toEqual([]);
  });

  it('排序：opencode 的常用上游在前，其余按名字；有 OAuth 的算常用；已接上的带标记', () => {
    const { fake } = setup({ connected: ['opencode', 'zeta'] });
    const catalog = upstreamCatalog(fake.providerList, AUTH);
    expect(catalog.map((entry) => [entry.id, entry.connected, entry.featured])).toEqual([
      ['opencode', true, true],
      ['opencode-go', false, true],
      ['github-copilot', false, true],
      ['openai', false, true],
      ['abc', false, false],
      ['zeta', true, false],
    ]);
    // GitLab（要填实例地址）与 Azure（要填资源名）不在表里。
    expect(catalog.some((entry) => entry.id === 'gitlab' || entry.id === 'azure')).toBe(false);
  });

  it('授权说明里的设备码', () => {
    expect(deviceCode('Enter code: FE5D-F5E4')).toBe('FE5D-F5E4');
    expect(deviceCode('Enter code: 38ZD-E5MW1')).toBe('38ZD-E5MW1');
    expect(
      deviceCode('Complete authorization in your browser. This window will close automatically.'),
    ).toBeUndefined();
  });
});

describe('OpenCodeAccounts：接上游', () => {
  it('upstreams()：借服务器读两个接口，用完放回', async () => {
    const { accounts, fake } = setup();
    const upstreams = await accounts.upstreams();
    expect(upstreams.map((entry) => entry.id)).toContain('github-copilot');
    expect(fake.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining(['providers', 'providerAuth']),
    );
    await vi.waitFor(() => expect(fake.running).toBe(false));
  });

  it('API Key：经 setApiKey 交给 opencode，接上后套餐里多了这一家；Key 不进调用记录与状态', async () => {
    const { accounts, fake } = setup();
    expect(await accounts.read('opencode')).toMatchObject({ planLabel: 'OpenCode' });
    const state = await accounts.connect({ upstream: 'opencode-go', apiKey: '  sk-secret-123  ' });
    expect(fake.keys.get('opencode-go')).toBe('sk-secret-123');
    expect(state).toMatchObject({
      status: 'signed_in',
      plan: 'opencode,opencode-go',
    });
    expect(state.login).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain('sk-secret-123');
    expect(JSON.stringify(fake.calls)).not.toContain('sk-secret-123');
  });

  it('API Key：空的、带空白的、上游不存在的、方式没选的都拒绝，什么都不存', async () => {
    const { accounts, fake } = setup();
    await expect(accounts.connect({ upstream: 'opencode-go' })).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'An API key is required for OpenCode Go',
    });
    await expect(
      accounts.connect({ upstream: 'opencode-go', apiKey: 'sk a\nb' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(accounts.connect({ upstream: 'nope', apiKey: 'k' })).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('opencode auth login'),
    });
    // OpenAI 有三种方式，必须选。
    await expect(accounts.connect({ upstream: 'openai', apiKey: 'k' })).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('several sign-in methods'),
    });
    await expect(accounts.connect({ upstream: 'openai', option: '9' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(fake.keys.size).toBe(0);
  });

  it('OpenAI 的 API Key 方式：选 option 2', async () => {
    const { accounts, fake } = setup();
    const state = await accounts.connect({ upstream: 'openai', option: '2', apiKey: 'sk-1' });
    expect(fake.keys.get('openai')).toBe('sk-1');
    expect(state.plan).toBe('opencode,openai');
  });

  it('浏览器授权：signing_in 带授权网址，服务器挂着不放；同意后重新检测成 signed_in', async () => {
    const { accounts, fake, seen } = setup();
    const started = await accounts.connect({ upstream: 'openai', option: '0' });
    expect(started).toMatchObject({
      status: 'signing_in',
      login: {
        method: 'browser',
        authUrl: 'https://auth.example/authorize?state=1',
        loginId: expect.any(String),
        startedAt: expect.any(String),
      },
    });
    expect(started.login?.userCode).toBeUndefined();
    expect(fake.calls.find((call) => call.method === 'oauthAuthorize')?.args[0]).toEqual({
      providerID: 'openai',
      method: 0,
    });
    expect(fake.callbacks).toHaveLength(1);
    // 登录进行中服务器不会按空闲停掉（idleTtl 20ms）。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.running).toBe(true);
    expect(await accounts.read('opencode')).toMatchObject({ status: 'signing_in' });
    // 用户同意。
    fake.callbacks[0]?.settle(true);
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ status: 'signed_in' }));
    expect(seen.at(-1)?.plan).toBe('opencode,openai');
    expect(seen.at(-1)?.login).toBeUndefined();
    await vi.waitFor(() => expect(fake.running).toBe(false));
  });

  it('设备码（GitHub Copilot）：login 带 verificationUrl 与 userCode，Copilot 的部署类型取 GitHub.com', async () => {
    const { accounts, fake } = setup();
    fake.authorizeReply = {
      url: 'https://github.com/login/device',
      method: 'auto',
      instructions: 'Enter code: FE5D-F5E4',
    };
    const started = await accounts.connect({ upstream: 'github-copilot' });
    expect(started).toMatchObject({
      status: 'signing_in',
      login: {
        method: 'device_code',
        verificationUrl: 'https://github.com/login/device',
        userCode: 'FE5D-F5E4',
      },
    });
    expect(started.login?.authUrl).toBeUndefined();
    expect(fake.calls.find((call) => call.method === 'oauthAuthorize')?.args[0]).toEqual({
      providerID: 'github-copilot',
      method: 0,
      inputs: { deploymentType: 'github.com' },
    });
  });

  it('取消：中止挂着的请求，放掉服务器，状态回到取消前；loginId 不符时什么都不做', async () => {
    const { accounts, fake, seen } = setup();
    const started = await accounts.connect({ upstream: 'openai', option: '0' });
    expect((await accounts.cancelLogin('opencode', 'other')).status).toBe('signing_in');
    const cancelled = await accounts.cancelLogin('opencode', started.login?.loginId);
    expect(cancelled).toMatchObject({ status: 'signed_in', plan: 'opencode' });
    expect(cancelled.login).toBeUndefined();
    expect(cancelled.lastError).toBeUndefined();
    expect(fake.callbacks[0]?.aborted).toBe(true);
    expect(seen.at(-1)?.status).toBe('signed_in');
    await vi.waitFor(() => expect(fake.running).toBe(false));
    // 被取消的请求回来不留 lastError。
    expect((await accounts.read('opencode')).lastError).toBeUndefined();
  });

  it('新的登录替换旧的', async () => {
    const { accounts, fake } = setup();
    const first = await accounts.connect({ upstream: 'openai', option: '0' });
    const second = await accounts.connect({ upstream: 'github-copilot' });
    expect(fake.callbacks[0]?.aborted).toBe(true);
    expect(second.login?.loginId).not.toBe(first.login?.loginId);
    expect(fake.callbacks).toHaveLength(2);
    expect(fake.callbacks[1]?.aborted).toBe(false);
  });

  it('登录失败：原因进 lastError（服务器的 ProviderAuthError），状态不变；没完成也报', async () => {
    const { accounts, fake, seen } = setup();
    await accounts.connect({ upstream: 'openai', option: '0' });
    fake.callbacks[0]?.settle(
      Object.assign(new Error('x'), {
        name: 'ProviderAuthOauthCallbackFailed',
        data: { message: 'User denied access' },
      }) as Error,
    );
    await vi.waitFor(() => expect(seen.at(-1)?.lastError).toContain('User denied access'));
    expect(seen.at(-1)).toMatchObject({ status: 'signed_in', plan: 'opencode' });
    expect(seen.at(-1)?.login).toBeUndefined();

    await accounts.connect({ upstream: 'openai', option: '0' });
    fake.callbacks[1]?.settle(false);
    await vi.waitFor(() =>
      expect(seen.at(-1)?.lastError).toBe('The OpenAI sign-in was not completed.'),
    );
  });

  it('授权失败、要粘贴代码的方式：报错，不进入 signing_in', async () => {
    const { accounts, fake } = setup();
    fake.authorizeReply = new Error('port 1455 is busy');
    await expect(accounts.connect({ upstream: 'openai', option: '0' })).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: 'Could not start the OpenAI sign-in: port 1455 is busy',
    });
    fake.authorizeReply = {
      url: 'https://auth.example/c',
      method: 'code',
      instructions: 'Paste it',
    };
    await expect(accounts.connect({ upstream: 'openai', option: '0' })).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('pasted back'),
    });
    fake.authorizeReply = { url: 'javascript:alert(1)', method: 'auto', instructions: '' };
    await expect(accounts.connect({ upstream: 'openai', option: '0' })).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: expect.stringContaining('unusable'),
    });
    expect((await accounts.read('opencode')).status).toBe('signed_in');
    expect(fake.callbacks).toHaveLength(0);
  });

  it('十五分钟没人同意：超时，报 Sign-in timed out.', async () => {
    const { accounts, seen } = setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await accounts.connect({ upstream: 'openai', option: '0' });
    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS + 1);
    await vi.waitFor(() => expect(seen.at(-1)?.lastError).toBe('Sign-in timed out.'));
    expect(seen.at(-1)?.status).toBe('signed_in');
  });

  it('dispose 取消进行中的登录', async () => {
    const { accounts, fake } = setup();
    await accounts.connect({ upstream: 'openai', option: '0' });
    accounts.dispose();
    expect(fake.callbacks[0]?.aborted).toBe(true);
  });

  it('没装 opencode：先下载', async () => {
    const fake = new FakeOpenCode();
    const engineDir = mkdtempSync(join(tmpdir(), 'wevir-opencode-connect-'));
    dirs.push(engineDir);
    const runtime = new OpenCodeRuntime({
      engineDir,
      env: {},
      sdk: async () => fake,
      findExecutable: () => undefined,
      startServer: fake.start,
      installer: null,
    });
    runtimes.push(runtime);
    const accounts = new OpenCodeAccounts({ runtime, env: {} });
    await expect(accounts.connect({ upstream: 'openai', option: '0' })).rejects.toMatchObject({
      code: 'engine_unavailable',
    });
    await expect(accounts.upstreams()).rejects.toMatchObject({ code: 'engine_unavailable' });
  });

  it('断开：删掉 opencode 里存的登录；环境变量接着的删不掉，如实说', async () => {
    const { accounts, fake } = setup({ connected: ['opencode', 'opencode-go'] });
    fake.keys.set('opencode-go', 'sk-1');
    const state = await accounts.disconnect('opencode-go');
    expect(state).toMatchObject({ status: 'signed_in', plan: 'opencode' });
    expect(fake.keys.has('opencode-go')).toBe(false);
    // Zen 的免登录模型：removeAuth 之后仍在 connected 里。
    fake.removeAuthKeepsConnected = true;
    await expect(accounts.disconnect('opencode')).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('still connected'),
    });
  });
});

describe('EngineAccounts 入口（account.login / account.logout / account.upstreams）', () => {
  it('upstreams：协议形状（方式只有 type、label、option）', async () => {
    const { accounts } = setup();
    const upstreams = await accounts.upstreams('opencode');
    const openai = upstreams.find((entry) => entry.id === 'openai');
    expect(openai?.methods[0]).toEqual({
      type: 'oauth',
      label: 'ChatGPT Pro/Plus (browser)',
      option: '0',
    });
  });

  it('login 带 upstream：接上这一家；不带：给终端命令', async () => {
    const { accounts, fake } = setup();
    const state = await accounts.login('opencode', 'browser', {
      upstream: 'openai',
      option: '2',
      apiKey: 'sk-9',
    });
    expect(fake.keys.get('openai')).toBe('sk-9');
    expect(state.plan).toBe('opencode,openai');
    await expect(accounts.login('opencode', 'browser')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('logout 带 upstream：去掉这一家；不带：给终端命令', async () => {
    const { accounts, fake } = setup({ connected: ['opencode', 'openai'] });
    fake.keys.set('openai', 'sk-1');
    const state = await accounts.logout('opencode', { upstream: 'openai' });
    expect(fake.keys.has('openai')).toBe(false);
    expect(state.plan).toBe('opencode');
    await expect(accounts.logout('opencode')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
