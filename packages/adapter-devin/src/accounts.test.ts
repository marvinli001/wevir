import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountState } from '@wevir/runtime-adapter';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DEVIN_API_KEY_ENV, DevinAccounts, parseDevinAuthStatus } from './accounts.js';
import { FAKE_DEVIN, fakeDevinEnv, tempRoot } from './test-fixtures/harness.js';

const temp = tempRoot('accounts');
const subjects: DevinAccounts[] = [];
afterAll(() => temp.remove());
afterEach(async () => {
  await Promise.all(subjects.splice(0).map((accounts) => accounts.dispose()));
});
let seq = 0;
function setup(extra: Record<string, string> = {}, options: { installer?: null } = {}) {
  const dir = temp.dir(`case-${++seq}`);
  const auth = join(dir, 'auth-state');
  const accounts = new DevinAccounts({
    workDir: join(dir, 'engine'),
    env: fakeDevinEnv({
      FAKE_DEVIN_AUTH_STATE: auth,
      FAKE_DEVIN_SESSION_LOG: join(dir, 'sessions.ndjson'),
      ...extra,
    }),
    installer: null,
    ...options,
  });
  subjects.push(accounts);
  return { accounts, dir, auth };
}
function changes(accounts: DevinAccounts): AccountState[] {
  const seen: AccountState[] = [];
  accounts.onChange((state) => seen.push(state));
  return seen;
}
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('parseDevinAuthStatus', () => {
  it('认 3000.11.92 的两种答复，读出邮箱与套餐；别的答复 undefined', () => {
    expect(
      parseDevinAuthStatus(
        'Not logged in.\n  Credentials path: /x/credentials.toml\nRun `devin auth login` to authenticate.\n',
      ),
    ).toEqual({ signedIn: false });
    expect(
      parseDevinAuthStatus(
        'Logged in as Ada (via Devin)\n  Name:              Ada\n  Email:             ada@example.com\n  Plan:              Pro\n  Team ID:           \n',
      ),
    ).toEqual({ signedIn: true, email: 'ada@example.com', planLabel: 'Pro' });
    expect(parseDevinAuthStatus('Logged in via API key\n  Email:   \n')).toEqual({
      signedIn: true,
    });
    expect(parseDevinAuthStatus('something else')).toBeUndefined();
  });
});

describe('DevinAccounts', () => {
  it('找不到 devin：没装，给官方安装命令', async () => {
    const accounts = new DevinAccounts({
      workDir: temp.dir('missing'),
      env: { PATH: temp.dir('empty-path'), HOME: temp.dir('empty-home') },
      installer: null,
    });
    subjects.push(accounts);
    const state = await accounts.read('devin');
    expect(state).toMatchObject({ kind: 'devin', installed: false, status: 'signed_out' });
    expect(state.installCommand).toMatch(/cli\.devin\.ai|static\.devin\.ai/);
    expect(state.canInstall).toBeUndefined();
  });

  it('没登录：应用内浏览器登录，也给终端命令，模型是“默认”', async () => {
    const { accounts } = setup();
    const state = await accounts.read('devin');
    expect(state).toMatchObject({
      kind: 'devin',
      status: 'signed_out',
      signIn: 'in_app',
      loginMethods: ['browser'],
      loginCommand: 'devin auth login',
      installed: true,
      version: '3000.11.92',
      executablePath: FAKE_DEVIN,
    });
    expect(state.lastError).toBeUndefined();
    expect(await accounts.models('devin')).toEqual({
      models: [{ id: 'devin-default', displayName: 'Default' }],
      defaultModelId: 'devin-default',
    });
  });

  it('已登录：邮箱、套餐来自 `devin auth status`，模型来自一次建了就删的探测会话', async () => {
    const { accounts, dir, auth } = setup();
    writeFileSync(auth, 'signed-in');
    const state = await accounts.read('devin');
    expect(state).toMatchObject({
      status: 'signed_in',
      email: 'me@example.com',
      planLabel: 'Pro',
    });
    expect(await accounts.models('devin')).toEqual({
      models: [
        { id: 'fixture-model-a', displayName: 'Fixture A' },
        { id: 'fixture-model-b', displayName: 'Fixture B' },
      ],
      defaultModelId: 'fixture-model-a',
    });
    const log = readFileSync(join(dir, 'sessions.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(log).toHaveLength(2);
    expect(log[1]).toEqual({ deleted: log[0].new });
  });

  it('设了 WINDSURF_API_KEY 就算已登录；这时不能在 Wevir 里登出', async () => {
    const { accounts } = setup({ [DEVIN_API_KEY_ENV]: 'test-key' });
    expect((await accounts.read('devin')).status).toBe('signed_in');
    await expect(accounts.logout('devin')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('`devin auth status` 答得认不出：未登录并带上原文', async () => {
    const { accounts } = setup({ FAKE_DEVIN_STATUS_OUTPUT: 'Error: keychain locked\n' });
    expect(await accounts.read('devin')).toMatchObject({
      status: 'signed_out',
      lastError: expect.stringContaining('keychain locked'),
    });
  });

  it('应用内登录：立即 signing_in（Devin 自己开浏览器，没有 authUrl），浏览器里登录后变成已登录', async () => {
    const flags = temp.dir('login-flags');
    const done = join(flags, 'done');
    const authLog = join(flags, 'auth.ndjson');
    const { accounts, auth } = setup({
      FAKE_DEVIN_ALLOW_AUTH: '1',
      FAKE_DEVIN_AUTH_DONE: done,
      FAKE_DEVIN_AUTH_LOG: authLog,
    });
    const seen = changes(accounts);
    const state = await accounts.login('devin', 'browser');
    expect(state.status).toBe('signing_in');
    expect(state.login).toMatchObject({ method: 'browser' });
    expect(state.login?.authUrl).toBeUndefined();
    await until(() => existsSync(authLog));
    expect(JSON.parse(readFileSync(authLog, 'utf8'))).toEqual({ methodId: 'devin-browser' });
    writeFileSync(done, '');
    await until(() => seen.some((change) => change.status === 'signed_in'));
    expect(existsSync(auth)).toBe(true);
    await expect(accounts.login('devin', 'browser')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('登录失败带上 Devin 的说明；取消的不算失败', async () => {
    const failing = setup({ FAKE_DEVIN_ALLOW_AUTH: '1', FAKE_DEVIN_AUTH_FAIL: '1' });
    const seen = changes(failing.accounts);
    await failing.accounts.login('devin', 'browser');
    await until(() => seen.some((change) => change.lastError !== undefined));
    expect(seen.at(-1)).toMatchObject({
      status: 'signed_out',
      lastError: 'Failed to receive authorization code',
    });

    const waiting = setup({
      FAKE_DEVIN_ALLOW_AUTH: '1',
      FAKE_DEVIN_AUTH_DONE: join(temp.dir('never'), 'done'),
    });
    const started = await waiting.accounts.login('devin', 'browser');
    const cancelled = await waiting.accounts.cancelLogin('devin', started.login?.loginId);
    expect(cancelled.status).toBe('signed_out');
    expect(cancelled.lastError).toBeUndefined();
  });

  it('登出用 `devin auth logout`，之后重新检测', async () => {
    const { accounts, auth } = setup();
    writeFileSync(auth, 'signed-in');
    expect((await accounts.read('devin')).status).toBe('signed_in');
    const state = await accounts.logout('devin');
    expect(state.status).toBe('signed_out');
    expect(existsSync(auth)).toBe(false);
  });

  it('设置里的路径必须有效，不悄悄换成 PATH 上的', async () => {
    const { accounts } = setup({ WEVIR_DEVIN_BIN: '' });
    const state = await accounts.setExecutablePath('devin', join(temp.dir('nowhere'), 'devin'));
    expect(state).toMatchObject({
      installed: false,
      lastError: 'Devin CLI executable path is unavailable',
    });
  });
});
