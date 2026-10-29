import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountState } from '@wevir/runtime-adapter';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  CopilotAccounts,
  type CopilotAccountsOptions,
  copilotUserLabel,
  readCopilotUser,
} from './accounts.js';
import type { CopilotInstaller } from './install.js';
import { FAKE_COPILOT, fakeCopilotEnv, tempRoot } from './test-fixtures/harness.js';

const temp = tempRoot('accounts');
const subjects: CopilotAccounts[] = [];
afterAll(() => temp.remove());
afterEach(async () => {
  await Promise.all(subjects.splice(0).map((accounts) => accounts.dispose()));
});
let seq = 0;
function setup(extra: Record<string, string> = {}, options: Partial<CopilotAccountsOptions> = {}) {
  const dir = temp.dir(`case-${++seq}`);
  const home = join(dir, 'copilot-home');
  const argv = join(dir, 'argv.ndjson');
  const accounts = new CopilotAccounts({
    workDir: join(dir, 'engine'),
    env: fakeCopilotEnv({
      COPILOT_HOME: home,
      FAKE_COPILOT_SESSION_LOG: join(dir, 'sessions.ndjson'),
      FAKE_COPILOT_ARGV_LOG: argv,
      ...extra,
    }),
    installer: null,
    ...options,
  });
  subjects.push(accounts);
  return { accounts, dir, home, argv };
}
function signIn(home: string, login = 'octocat', host = 'https://github.com'): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'config.json'),
    `// User settings belong in settings.json.\n// This file is managed automatically.\n${JSON.stringify({ firstLaunchAt: 'x', lastLoggedInUser: { host, login } })}\n`,
  );
}
function changes(accounts: CopilotAccounts): AccountState[] {
  const seen: AccountState[] = [];
  accounts.onChange((state) => seen.push(state));
  return seen;
}
const lines = (file: string) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('readCopilotUser', () => {
  it('读带注释的 config.json 里的 lastLoggedInUser；没有或坏了是 undefined', () => {
    const dir = temp.dir('user');
    expect(readCopilotUser(dir)).toBeUndefined();
    signIn(dir, 'ada', 'https://example.ghe.com');
    expect(readCopilotUser(dir)).toEqual({ host: 'https://example.ghe.com', login: 'ada' });
    writeFileSync(join(dir, 'config.json'), '{ not json');
    expect(readCopilotUser(dir)).toBeUndefined();
  });
  it('github.com 只写登录名，Enterprise 写上主机', () => {
    expect(copilotUserLabel({ host: 'https://github.com', login: 'ada' })).toBe('ada');
    expect(copilotUserLabel({ host: 'github.com', login: 'ada' })).toBe('ada');
    expect(copilotUserLabel({ host: 'https://example.ghe.com/', login: 'ada' })).toBe(
      'ada@example.ghe.com',
    );
  });
});

describe('CopilotAccounts', () => {
  it('找不到 copilot：没装，给官方安装命令', async () => {
    const accounts = new CopilotAccounts({
      workDir: temp.dir('missing'),
      env: { PATH: temp.dir('empty-path'), HOME: temp.dir('empty-home') },
      installer: null,
    });
    subjects.push(accounts);
    const state = await accounts.read('copilot');
    expect(state).toMatchObject({ kind: 'copilot', installed: false, status: 'signed_out' });
    expect(state.installCommand).toMatch(/gh\.io\/copilot-install|winget install GitHub\.Copilot/);
    expect(state.canInstall).toBeUndefined();
  });

  it('没登录：探测会话报“Authentication required”，应用内设备码登录，也给终端命令，模型是“默认”', async () => {
    const { accounts } = setup();
    const state = await accounts.read('copilot');
    expect(state).toMatchObject({
      kind: 'copilot',
      status: 'signed_out',
      signIn: 'in_app',
      loginMethods: ['device_code'],
      loginCommand: 'copilot login',
      installed: true,
      version: '1.0.103',
      executablePath: FAKE_COPILOT,
    });
    expect(state.lastError).toBeUndefined();
    expect(await accounts.models('copilot')).toEqual({
      models: [{ id: 'copilot-default', displayName: 'Default' }],
      defaultModelId: 'copilot-default',
    });
  });

  it('已登录：账号名来自 config.json，模型来自一次建了就关的探测会话（不起内置 MCP）', async () => {
    const { accounts, dir, home, argv } = setup();
    signIn(home);
    const state = await accounts.read('copilot');
    expect(state).toMatchObject({ status: 'signed_in', email: 'octocat' });
    expect(await accounts.models('copilot')).toEqual({
      models: [
        { id: 'auto', displayName: 'Auto' },
        { id: 'fixture-model-a', displayName: 'Fixture A' },
        { id: 'fixture-model-b', displayName: 'Fixture B' },
      ],
      defaultModelId: 'auto',
    });
    const log = lines(join(dir, 'sessions.ndjson'));
    expect(log).toHaveLength(2);
    expect(log[1]).toEqual({ closed: log[0].new });
    expect(lines(argv).map((entry) => entry.args)).toContainEqual([
      '--acp',
      '--stdio',
      '--disable-builtin-mcps',
    ]);
  });

  it('令牌环境变量登录的首个账号：已登录，但不能在 Wevir 里登出', async () => {
    const { accounts } = setup({ FAKE_COPILOT_SIGNED_IN: '1', GH_TOKEN: 'gho_test' });
    expect((await accounts.read('copilot')).status).toBe('signed_in');
    await expect(accounts.logout('copilot')).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('GH_TOKEN'),
    });
  });

  it('Wevir 下载的那份：--version、探测与登录都带 COPILOT_AUTO_UPDATE=false，用户自己装的不带', async () => {
    const installer = {
      active: async () => ({ path: FAKE_COPILOT, version: '1.0.105' }),
      cancel: () => {},
    } as unknown as CopilotInstaller;
    const managed = setup(
      {},
      { installer, findExecutable: (_custom, path) => path ?? FAKE_COPILOT },
    );
    expect(await managed.accounts.read('copilot')).toMatchObject({ installed: true });
    expect(lines(managed.argv).length).toBeGreaterThan(0);
    for (const entry of lines(managed.argv)) expect(entry).toMatchObject({ autoUpdate: 'false' });
    const own = setup();
    await own.accounts.read('copilot');
    for (const entry of lines(own.argv)) expect(entry).toMatchObject({ autoUpdate: null });
  });

  it('添加的账号：自己的 COPILOT_HOME 与空的 GitHub CLI 配置目录，不带首个账号的令牌环境变量', async () => {
    const dir = temp.dir('added');
    const { accounts, argv } = setup(
      { GH_TOKEN: 'gho_first_account' },
      {
        account: { copilotHome: join(dir, 'copilot'), ghConfigDir: join(dir, 'gh') },
      },
    );
    const state = await accounts.read('copilot');
    expect(state.status).toBe('signed_out');
    expect(state.loginCommand).toBe(`COPILOT_HOME="${join(dir, 'copilot')}" copilot login`);
    for (const entry of lines(argv)) {
      expect(entry).toMatchObject({ home: join(dir, 'copilot'), gh: join(dir, 'gh'), token: null });
    }
    signIn(join(dir, 'copilot'), 'second');
    expect(await accounts.read('copilot', { refresh: true })).toMatchObject({
      status: 'signed_in',
      email: 'second',
    });
  });

  it('应用内登录：给出 CLI 打印的网址与设备码，授权后变成已登录', async () => {
    const done = join(temp.dir('login-flags'), 'done');
    const { accounts, home, argv } = setup({ FAKE_COPILOT_AUTH_DONE: done });
    const seen = changes(accounts);
    await expect(accounts.login('copilot', 'browser')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    const state = await accounts.login('copilot', 'device_code');
    expect(state.status).toBe('signing_in');
    expect(state.login).toMatchObject({
      method: 'device_code',
      verificationUrl: 'https://github.com/login/device',
      userCode: 'FAKE-1234',
    });
    expect(lines(argv).map((entry) => entry.args)).toContainEqual(['login', '--device-code']);
    writeFileSync(done, '');
    await until(() => seen.some((change) => change.status === 'signed_in'));
    expect(readCopilotUser(home)?.login).toBe('octocat');
    await expect(accounts.login('copilot', 'device_code')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('登录失败带上 CLI 的说明；取消的不算失败', async () => {
    const failing = setup({ FAKE_COPILOT_AUTH_FAIL: '1' });
    const seen = changes(failing.accounts);
    await failing.accounts.login('copilot', 'device_code');
    await until(() => seen.some((change) => change.lastError !== undefined));
    expect(seen.at(-1)).toMatchObject({
      status: 'signed_out',
      lastError: 'Login failed: Error: the device code expired',
    });

    const waiting = setup({ FAKE_COPILOT_AUTH_DONE: join(temp.dir('never'), 'done') });
    const started = await waiting.accounts.login('copilot', 'device_code');
    const cancelled = await waiting.accounts.cancelLogin('copilot', started.login?.loginId);
    expect(cancelled.status).toBe('signed_out');
    expect(cancelled.lastError).toBeUndefined();
  });

  it('登出用 ACP 的 logout，之后重新检测', async () => {
    const { accounts, home } = setup();
    signIn(home);
    expect((await accounts.read('copilot')).status).toBe('signed_in');
    const state = await accounts.logout('copilot');
    expect(state.status).toBe('signed_out');
    expect(state.email).toBeUndefined();
    expect(readCopilotUser(home)).toBeUndefined();
    expect(existsSync(join(home, 'config.json'))).toBe(true);
  });

  it('设置里的路径必须有效，不悄悄换成 PATH 上的', async () => {
    const { accounts } = setup({ WEVIR_COPILOT_BIN: '' });
    const state = await accounts.setExecutablePath('copilot', join(temp.dir('nowhere'), 'copilot'));
    expect(state).toMatchObject({
      installed: false,
      lastError: 'GitHub Copilot CLI executable path is unavailable',
    });
  });
});
