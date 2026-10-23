import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountState } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CursorAccounts, type CursorAccountsOptions, type CursorSdkInstall } from './accounts.js';
import { CursorCredentialFile, cursorCredentialsPath } from './credentials.js';
import type { CursorSdkInstallation, CursorSdkInstallEvent } from './sdk-install.js';
import { FakeCursorSdk, sdkError } from './test-fixtures/fake-sdk.js';

const dirs: string[] = [];
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: Partial<CursorAccountsOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wevir-cursor-accounts-'));
  dirs.push(home);
  const sdk = new FakeCursorSdk();
  const secrets: string[] = [];
  const signedOut = vi.fn();
  const accounts = new CursorAccounts({
    sdk: async () => sdk,
    credentialsPath: cursorCredentialsPath(home),
    addSecret: (value) => secrets.push(value),
    onSignedOut: signedOut,
    ...options,
  });
  disposers.push(() => accounts.dispose());
  const states: AccountState[] = [];
  accounts.onChange((state) => states.push(state));
  return { home, sdk, accounts, states, secrets, signedOut, path: cursorCredentialsPath(home) };
}

const SIGNED_OUT: AccountState = {
  kind: 'cursor',
  status: 'signed_out',
  signIn: 'in_app',
  loginMethods: ['browser'],
};

describe('CursorAccounts', () => {
  it('没有凭据：未登录、应用内登录、只有浏览器一种方式，不联网', async () => {
    const { accounts, sdk } = setup();
    expect(accounts.kinds).toEqual(['cursor']);
    expect(await accounts.read('cursor')).toEqual(SIGNED_OUT);
    expect(sdk.meCalls).toBe(0);
    expect(await accounts.models('cursor')).toEqual({ models: [] });
    await expect(accounts.read('chatgpt')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('登录：返回 signing_in 带浏览器网址；浏览器那边完成后经 onChange 报 signed_in；Key 只在 0600 的文件与 addSecret 里', async () => {
    const { accounts, sdk, states, secrets, path } = setup();
    const signingIn = await accounts.login('cursor', 'browser');
    expect(signingIn).toMatchObject({
      status: 'signing_in',
      login: {
        method: 'browser',
        authUrl: expect.stringContaining('https://cursor.com/loginDeepControl'),
        loginId: expect.any(String),
      },
    });
    expect(sdk.pendingLogin?.options).toMatchObject({ openBrowser: false, apiKeyName: 'Wevir' });
    // 登录先写进内存，没完成之前文件不存在。
    expect(existsSync(path)).toBe(false);
    expect(await accounts.read('cursor')).toEqual(signingIn);

    sdk.completeLogin('key_minted_123');
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe('signed_in'));
    expect(states.at(-1)).toEqual({ ...SIGNED_OUT, status: 'signed_in', email: 'me@example.com' });
    expect(await new CursorCredentialFile(path).load()).toMatchObject({ apiKey: 'key_minted_123' });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(secrets).toContain('key_minted_123');
    expect(JSON.stringify(states)).not.toContain('key_minted_123');
    expect(await accounts.requireApiKey()).toBe('key_minted_123');
    const models = await accounts.models('cursor');
    expect(models.defaultModelId).toBe('auto');
    expect(models.models.map((model) => model.id)).toEqual(['auto', 'composer-2', 'gpt-6']);
  });

  it('取消登录：回到未登录，之后浏览器那边才完成也不落盘；loginId 不对时不动', async () => {
    const { accounts, sdk, path } = setup();
    const signingIn = await accounts.login('cursor', 'browser');
    expect(await accounts.cancelLogin('cursor', 'other-login')).toEqual(signingIn);
    expect(await accounts.cancelLogin('cursor', signingIn.login?.loginId)).toEqual(SIGNED_OUT);
    sdk.completeLogin();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(path)).toBe(false);
    expect(await accounts.read('cursor')).toEqual(SIGNED_OUT);
  });

  it('再点登录替换进行中的那次；只有浏览器方式；登录超时报原因', async () => {
    const { accounts, sdk, states } = setup({ loginTimeoutMs: 30 });
    await expect(accounts.login('cursor', 'device_code')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    const first = await accounts.login('cursor', 'browser');
    const firstOptions = sdk.pendingLogin?.options;
    const second = await accounts.login('cursor', 'browser');
    expect(second.login?.loginId).not.toBe(first.login?.loginId);
    expect(firstOptions?.signal?.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({
        ...SIGNED_OUT,
        lastError: 'Cursor sign-in expired. Start sign-in again.',
      }),
    );
    // 失败原因留到下一次登录。
    expect(await accounts.read('cursor')).toMatchObject({ lastError: expect.any(String) });
  });

  it('登录本身失败（SDK 报错）：未登录带原因', async () => {
    const { accounts, sdk, states } = setup();
    sdk.login = async (options) => {
      options.onLoginUrl?.('https://cursor.com/login');
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw sdkError(
        'AuthenticationError',
        'Login succeeded, but creating an SDK API key failed: permission denied',
      );
    };
    await accounts.login('cursor', 'browser');
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe('signed_out'));
    expect(states.at(-1)?.lastError).toContain('creating an SDK API key failed');
  });

  it('登出：先停掉会话，再删凭据；之后未登录', async () => {
    const { accounts, sdk, states, signedOut, path } = setup();
    await accounts.login('cursor', 'browser');
    sdk.completeLogin('key_1');
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe('signed_in'));
    expect(await accounts.logout('cursor')).toEqual(SIGNED_OUT);
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(false);
    await expect(accounts.requireApiKey()).rejects.toMatchObject({ code: 'missing_credentials' });
  });

  it('读账号：不带 refresh 时 5 分钟内复用；Key 被拒是未登录带原因；网络失败有上次结果就沿用，没有就报错', async () => {
    let now = 1_000_000;
    const { accounts, sdk, path } = setup({ now: () => now });
    const store = new CursorCredentialFile(path);
    await store.save({ version: 1, backendUrl: 'x', apiKey: 'good', createdAtMs: 0 });
    expect(await accounts.read('cursor')).toMatchObject({
      status: 'signed_in',
      email: 'me@example.com',
    });
    await accounts.read('cursor');
    expect(sdk.meCalls).toBe(1);
    await accounts.read('cursor', { refresh: true });
    expect(sdk.meCalls).toBe(2);

    sdk.user = new Error('fetch failed');
    now += 10 * 60_000;
    expect(await accounts.read('cursor')).toMatchObject({ status: 'signed_in' });

    await store.save({ version: 1, backendUrl: 'x', apiKey: 'revoked', createdAtMs: 0 });
    expect(await accounts.read('cursor', { refresh: true })).toEqual({
      ...SIGNED_OUT,
      lastError: 'Cursor sign-in expired or was rejected. Sign in again.',
    });

    await store.save({ version: 1, backendUrl: 'x', apiKey: 'other', createdAtMs: 0 });
    await expect(accounts.read('cursor', { refresh: true })).rejects.toMatchObject({
      code: 'engine_unavailable',
    });
  });

  it('过期的 Key 当作没有', async () => {
    const { accounts, path } = setup({ now: () => 2_000 });
    await new CursorCredentialFile(path).save({
      version: 1,
      backendUrl: 'x',
      apiKey: 'old',
      apiKeyExpiresAtMs: 1_000,
      createdAtMs: 0,
    });
    expect(await accounts.read('cursor')).toEqual(SIGNED_OUT);
  });

  it('CURSOR_API_KEY 优先：用它读账号；应用里不能登录、登出', async () => {
    const { accounts, path, secrets } = setup({ env: { CURSOR_API_KEY: ' env_key ' } });
    await new CursorCredentialFile(path).save({
      version: 1,
      backendUrl: 'x',
      apiKey: 'file_key',
      createdAtMs: 0,
    });
    expect(await accounts.read('cursor')).toMatchObject({ status: 'signed_in' });
    expect(await accounts.requireApiKey()).toBe('env_key');
    expect(secrets).toContain('env_key');
    await expect(accounts.login('cursor', 'browser')).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('CURSOR_API_KEY'),
    });
    await expect(accounts.logout('cursor')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('模型列表缓存 30 分钟；认证失败报 missing_credentials', async () => {
    let now = 0;
    const { accounts, sdk, path } = setup({ now: () => now });
    const store = new CursorCredentialFile(path);
    await store.save({ version: 1, backendUrl: 'x', apiKey: 'good', createdAtMs: 0 });
    await accounts.models('cursor');
    await accounts.models('cursor');
    expect(sdk.modelCalls).toBe(1);
    now += 31 * 60_000;
    await accounts.models('cursor');
    expect(sdk.modelCalls).toBe(2);
    await store.save({ version: 1, backendUrl: 'x', apiKey: 'revoked', createdAtMs: 0 });
    await expect(accounts.models('cursor')).rejects.toMatchObject({ code: 'missing_credentials' });
  });

  it('登录确认时新 Key 被拒：删掉它，未登录带原因', async () => {
    const { accounts, sdk, states, path } = setup();
    await accounts.login('cursor', 'browser');
    sdk.completeLogin('revoked');
    await vi.waitFor(() => expect(states.at(-1)?.lastError).toBeDefined());
    expect(states.at(-1)?.status).toBe('signed_out');
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
  });
});

/** 假的 SDK 安装器：测试决定什么时候报进度、装好或失败。 */
class FakeInstaller implements CursorSdkInstall {
  supported = true;
  installing: { completedBytes: number; totalBytes?: number } | undefined;
  error: string | undefined;
  installation: CursorSdkInstallation | undefined;
  installs = 0;
  readonly #listeners = new Set<(event: CursorSdkInstallEvent) => void>();

  async active() {
    return this.installation;
  }

  install(): Promise<CursorSdkInstallation> {
    this.installs += 1;
    this.error = undefined;
    this.installing = { completedBytes: 0 };
    this.emit({ type: 'progress', completedBytes: 0 });
    return new Promise(() => {});
  }

  onChange(listener: (event: CursorSdkInstallEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  progress(completedBytes: number, totalBytes: number) {
    this.installing = { completedBytes, totalBytes };
    this.emit({ type: 'progress', completedBytes, totalBytes });
  }

  finish() {
    this.installing = undefined;
    this.installation = { root: '/sdk/versions/1.0.35', version: '1.0.35' };
    this.emit({ type: 'installed', installation: this.installation });
  }

  fail(message: string) {
    this.installing = undefined;
    this.error = message;
    this.emit({ type: 'failed', message });
  }

  emit(event: CursorSdkInstallEvent) {
    for (const listener of this.#listeners) listener(event);
  }
}

describe('CursorAccounts：安装包里按需下载 SDK', () => {
  const NOT_INSTALLED: AccountState = { ...SIGNED_OUT, installed: false, canInstall: true };

  it('SDK 没装：未安装、能装，不加载 SDK、没有模型；本平台没有构建时不能装', async () => {
    const installer = new FakeInstaller();
    const { accounts, sdk } = setup({ installer });
    expect(await accounts.read('cursor', { refresh: true })).toEqual(NOT_INSTALLED);
    expect(await accounts.models('cursor')).toEqual({ models: [] });
    expect(sdk.meCalls).toBe(0);
    installer.supported = false;
    expect(await accounts.read('cursor')).toEqual({ ...SIGNED_OUT, installed: false });
    await expect(accounts.install('cursor')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('install：立即返回安装中，进度经 onChange；装好后重新读账号，状态带 SDK 版本', async () => {
    const installer = new FakeInstaller();
    const { accounts, states } = setup({ installer });
    expect(await accounts.install('cursor')).toEqual({
      ...NOT_INSTALLED,
      installing: { completedBytes: 0 },
    });
    // 进行中再点一次不重新开始。
    await accounts.install('cursor');
    expect(installer.installs).toBe(1);
    installer.progress(512, 1024);
    expect(states.at(-1)).toEqual({
      ...NOT_INSTALLED,
      installing: { completedBytes: 512, totalBytes: 1024 },
    });
    installer.finish();
    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({ ...SIGNED_OUT, installed: true, version: '1.0.35' }),
    );
    // 已装好：install 只是重新读。
    expect(await accounts.install('cursor')).toEqual({
      ...SIGNED_OUT,
      installed: true,
      version: '1.0.35',
    });
    expect(installer.installs).toBe(1);
  });

  it('安装失败：未安装带原因，可以再装', async () => {
    const installer = new FakeInstaller();
    const { accounts, states } = setup({ installer });
    await accounts.install('cursor');
    installer.fail('Could not download @cursor/sdk@1.0.35 (registry.npmjs.org: 503).');
    expect(states.at(-1)).toEqual({
      ...NOT_INSTALLED,
      lastError: 'Could not download @cursor/sdk@1.0.35 (registry.npmjs.org: 503).',
    });
    expect(await accounts.install('cursor')).toEqual({
      ...NOT_INSTALLED,
      installing: { completedBytes: 0 },
    });
  });

  it('多账号共用一个安装器：任一账号装好，每个账号都重新读，各用各的 Key', async () => {
    const installer = new FakeInstaller();
    const first = setup({ installer });
    const second = setup({ installer });
    await new CursorCredentialFile(second.path).save({
      version: 1,
      backendUrl: 'x',
      apiKey: 'second_key',
      createdAtMs: 0,
    });
    expect(await second.accounts.read('cursor')).toEqual(NOT_INSTALLED);
    await first.accounts.install('cursor');
    expect(second.states.at(-1)).toMatchObject({ installing: { completedBytes: 0 } });
    installer.finish();
    await vi.waitFor(() => expect(second.states.at(-1)?.status).toBe('signed_in'));
    expect(second.states.at(-1)).toMatchObject({ installed: true, version: '1.0.35' });
    expect(first.states.at(-1)).toEqual({ ...SIGNED_OUT, installed: true, version: '1.0.35' });
    expect(await second.accounts.requireApiKey()).toBe('second_key');
    expect(await first.accounts.readApiKey()).toBeUndefined();
  });
});
