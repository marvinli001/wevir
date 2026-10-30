import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountState } from '@wevir/runtime-adapter';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { KiroAccounts, type KiroAccountsOptions, parseKiroWhoami } from './accounts.js';
import type { KiroInstaller } from './install.js';
import { FAKE_KIRO, fakeKiroEnv, tempRoot } from './test-fixtures/harness.js';

const temp = tempRoot('accounts');
const subjects: KiroAccounts[] = [];
afterAll(() => temp.remove());
afterEach(async () => {
  await Promise.all(subjects.splice(0).map((accounts) => accounts.dispose()));
});
let seq = 0;
function setup(extra: Record<string, string> = {}, options: Partial<KiroAccountsOptions> = {}) {
  const dir = temp.dir(`case-${++seq}`);
  const state = join(dir, 'kiro-state.json');
  const argv = join(dir, 'argv.ndjson');
  const accounts = new KiroAccounts({
    workDir: join(dir, 'engine'),
    env: fakeKiroEnv({ FAKE_KIRO_STATE: state, FAKE_KIRO_ARGV_LOG: argv, ...extra }),
    installer: null,
    ...options,
  });
  subjects.push(accounts);
  return { accounts, dir, state, argv };
}
function signIn(state: string, email = 'me@example.com'): void {
  writeFileSync(state, JSON.stringify({ accountType: 'BuilderId', email }));
}
function changes(accounts: KiroAccounts): AccountState[] {
  const seen: AccountState[] = [];
  accounts.onChange((state) => seen.push(state));
  return seen;
}
const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('parseKiroWhoami', () => {
  it('没登录是 {"account":null}（2.36.0）；登录后取邮箱，其次像邮箱的字符串，再次用户名；读不懂是 undefined', () => {
    expect(parseKiroWhoami('{"account":null}\n')).toEqual({ signedIn: false });
    expect(parseKiroWhoami('{"account":{"email":" ada@example.com "}}')).toEqual({
      signedIn: true,
      label: 'ada@example.com',
    });
    expect(
      parseKiroWhoami('{"account":{"profile":{"primary":"ada@example.com"},"username":"ada"}}'),
    ).toEqual({ signedIn: true, label: 'ada@example.com' });
    expect(parseKiroWhoami('{"account":{"username":"ada"}}')).toEqual({
      signedIn: true,
      label: 'ada',
    });
    expect(parseKiroWhoami('{"account":{"accountType":"ApiKey"}}')).toEqual({ signedIn: true });
    expect(parseKiroWhoami('Logged in')).toBeUndefined();
    expect(parseKiroWhoami('{"user":null}')).toBeUndefined();
  });
});

describe('KiroAccounts', () => {
  it('找不到 kiro-cli：没装，给官方安装命令', async () => {
    const accounts = new KiroAccounts({
      workDir: temp.dir('missing'),
      env: { PATH: temp.dir('empty-path'), HOME: temp.dir('empty-home') },
      installer: null,
    });
    subjects.push(accounts);
    const state = await accounts.read('kiro');
    expect(state).toMatchObject({ kind: 'kiro', installed: false, status: 'signed_out' });
    expect(state.installCommand).toMatch(/cli\.kiro\.dev\/install/);
    expect(state.canInstall).toBeUndefined();
  });

  it('没登录：whoami 报 null，应用内设备码登录（三种方式），也给终端命令，模型是“默认”', async () => {
    const { accounts, argv } = setup();
    const state = await accounts.read('kiro');
    expect(state).toMatchObject({
      kind: 'kiro',
      status: 'signed_out',
      signIn: 'in_app',
      loginMethods: ['device_code'],
      loginOptions: [
        { id: 'builder-id', label: 'AWS Builder ID' },
        { id: 'google', label: 'Google' },
        { id: 'github', label: 'GitHub' },
      ],
      loginCommand: 'kiro-cli login',
      installed: true,
      version: '2.36.0',
      executablePath: FAKE_KIRO,
    });
    expect(state.lastError).toBeUndefined();
    expect(await accounts.models('kiro')).toEqual({
      models: [{ id: 'kiro-default', displayName: 'Default' }],
      defaultModelId: 'kiro-default',
    });
    // 检测不起 ACP 进程。
    expect(lines(argv).map((entry) => entry.args)).toEqual([
      ['--version'],
      ['whoami', '--format', 'json'],
    ]);
    await expect(accounts.executable()).rejects.toMatchObject({ code: 'missing_credentials' });
  });

  it('已登录：账号名来自 whoami，不再列登录方式', async () => {
    const { accounts, state: file } = setup();
    signIn(file, 'ada@example.com');
    const state = await accounts.read('kiro');
    expect(state).toMatchObject({ status: 'signed_in', email: 'ada@example.com' });
    expect(state.loginOptions).toBeUndefined();
    expect((await accounts.executable()).path).toBe(FAKE_KIRO);
  });

  it('会话报来的模型换掉“默认”；检测到没登录时换回', async () => {
    const { accounts, state: file } = setup();
    signIn(file);
    await accounts.read('kiro');
    accounts.noteSessionModels(undefined, {
      currentModelId: 'b',
      availableModels: [
        { modelId: 'a', name: 'A' },
        { modelId: 'b', name: 'B' },
      ],
    });
    expect(await accounts.models('kiro')).toEqual({
      models: [
        { id: 'a', displayName: 'A' },
        { id: 'b', displayName: 'B' },
      ],
      defaultModelId: 'b',
    });
    accounts.noteSessionModels(undefined, undefined);
    expect((await accounts.models('kiro')).defaultModelId).toBe('b');
    rmSync(file);
    await accounts.read('kiro', { refresh: true });
    expect((await accounts.models('kiro')).defaultModelId).toBe('kiro-default');
  });

  it('KIRO_API_KEY 登录：已登录，但不能在 Wevir 里登出', async () => {
    const { accounts } = setup();
    const keyed = new KiroAccounts({
      workDir: temp.dir('keyed'),
      env: { ...fakeKiroEnv(), KIRO_API_KEY: 'test-key' },
      installer: null,
    });
    subjects.push(keyed);
    expect((await keyed.read('kiro')).status).toBe('signed_in');
    await expect(keyed.logout('kiro')).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('KIRO_API_KEY'),
    });
    expect((await accounts.read('kiro')).status).toBe('signed_out');
  });

  it('Wevir 下载的那份：--version 与 whoami 都带 KIRO_NO_AUTO_UPDATE=1，用户自己装的不带', async () => {
    const installer = {
      active: async () => ({ path: FAKE_KIRO, version: '2.36.0' }),
      cancel: () => {},
    } as unknown as KiroInstaller;
    const managed = setup({}, { installer, findExecutable: (_custom, path) => path ?? FAKE_KIRO });
    expect(await managed.accounts.read('kiro')).toMatchObject({
      installed: true,
      loginCommand: `"${FAKE_KIRO}" login`,
    });
    expect(lines(managed.argv).length).toBeGreaterThan(0);
    for (const entry of lines(managed.argv)) expect(entry).toMatchObject({ autoUpdate: '1' });
    const own = setup();
    await own.accounts.read('kiro');
    for (const entry of lines(own.argv)) expect(entry).toMatchObject({ autoUpdate: null });
  });

  it('应用内登录：给出 CLI 打印的网址与设备码，按选的方式传参数，授权后变成已登录', async () => {
    const done = join(temp.dir('login-flags'), 'done');
    const {
      accounts,
      argv,
      state: file,
    } = setup({
      FAKE_KIRO_AUTH_DONE: done,
      FAKE_KIRO_EMAIL: 'gh@example.com',
    });
    const seen = changes(accounts);
    await expect(accounts.login('kiro', 'browser')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(accounts.login('kiro', 'device_code', { option: 'okta' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    const state = await accounts.login('kiro', 'device_code', { option: 'github' });
    expect(state.status).toBe('signing_in');
    expect(state.loginOptions).toBeUndefined();
    expect(state.login).toMatchObject({
      method: 'device_code',
      verificationUrl: 'https://view.awsapps.com/start/#/device?user_code=FAKE-1234',
      userCode: 'FAKE-1234',
    });
    expect(lines(argv).map((entry) => entry.args)).toContainEqual([
      'login',
      '--social',
      'github',
      '--use-device-flow',
    ]);
    writeFileSync(done, '');
    await until(() => seen.some((change) => change.status === 'signed_in'));
    expect(seen.at(-1)).toMatchObject({ status: 'signed_in', email: 'gh@example.com' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ provider: 'github' });
    await expect(accounts.login('kiro', 'device_code')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('不选方式时用 AWS Builder ID（--license free）', async () => {
    const { accounts, argv } = setup({ FAKE_KIRO_AUTH_DONE: join(temp.dir('never-1'), 'done') });
    await accounts.login('kiro', 'device_code');
    expect(lines(argv).map((entry) => entry.args)).toContainEqual([
      'login',
      '--license',
      'free',
      '--use-device-flow',
    ]);
  });

  it('登录失败带上 CLI 的说明；取消的不算失败', async () => {
    const failing = setup({ FAKE_KIRO_AUTH_FAIL: '1' });
    const seen = changes(failing.accounts);
    await failing.accounts.login('kiro', 'device_code');
    await until(() => seen.some((change) => change.lastError !== undefined));
    expect(seen.at(-1)).toMatchObject({
      status: 'signed_out',
      lastError: 'error: Device authorization expired',
    });

    const waiting = setup({ FAKE_KIRO_AUTH_DONE: join(temp.dir('never-2'), 'done') });
    const started = await waiting.accounts.login('kiro', 'device_code');
    const cancelled = await waiting.accounts.cancelLogin('kiro', started.login?.loginId);
    expect(cancelled.status).toBe('signed_out');
    expect(cancelled.lastError).toBeUndefined();
  });

  it('登出用 kiro-cli logout，之后重新检测', async () => {
    const { accounts, state: file, argv } = setup();
    signIn(file);
    expect((await accounts.read('kiro')).status).toBe('signed_in');
    const state = await accounts.logout('kiro');
    expect(state.status).toBe('signed_out');
    expect(existsSync(file)).toBe(false);
    expect(lines(argv).map((entry) => entry.args)).toContainEqual(['logout']);
  });

  it('别的种类与销毁后的调用被拒绝', async () => {
    const { accounts } = setup();
    expect(() => accounts.read('copilot')).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    );
    await accounts.dispose();
    expect(() => accounts.read('kiro')).toThrow(expect.objectContaining({ code: 'disposed' }));
  });
});
