// Antigravity 的账号（accounts.ts）跑在假运行体上（test-fixtures/fake-agent.mjs）：安装字段、应用内登录（BROWSER 钩子与
// 1.1.1 写在 stdout 上的网址）、取消、失败、刷新、登出、交给运行体的环境，以及 account.install 的进度与失败。

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { AccountState } from '@wevir/runtime-adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AntigravityAdapter, type AntigravityAdapterOptions } from './antigravity-adapter.js';
import { antigravityTokenPath } from './profile.js';
import { ANTIGRAVITY_RELEASE_VERSION } from './release.js';
import {
  buildZip,
  collectingLogger,
  completeBrowserSignIn,
  fakeRuntimeFiles,
  installFakeRuntime,
  removeDir,
  tempDir,
  waitFor,
  writeFakeToken,
} from './test-fixtures/runtime.js';

let home: string;
let bin: string;
let adapters: AntigravityAdapter[];
let server: Server | undefined;

beforeEach(() => {
  home = tempDir();
  bin = path.join(home, 'bin');
  installFakeRuntime(bin);
  adapters = [];
});

afterEach(async () => {
  for (const adapter of adapters) await adapter.dispose();
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  removeDir(home);
});

function create(options: Partial<AntigravityAdapterOptions> & { env?: NodeJS.ProcessEnv } = {}) {
  const adapter = new AntigravityAdapter({
    home,
    logger: collectingLogger(),
    ...options,
    env: { PATH: process.env.PATH, HOME: home, ...options.env },
  });
  adapters.push(adapter);
  const states: AccountState[] = [];
  adapter.accounts.onChange((state) => states.push(state));
  return { adapter, accounts: adapter.accounts, states };
}

const executable = () => path.join(bin, 'agy_acp_server.par');
const root = () => path.join(home, 'engines', 'antigravity');

function leftovers(): string[] {
  const names = existsSync(root()) ? readdirSync(root()) : [];
  const tmp = path.join(root(), 'tmp');
  const runs = existsSync(tmp) ? readdirSync(tmp) : [];
  return [...names.filter((name) => name.startsWith('.')), ...runs];
}

const posix = process.platform !== 'win32';

describe.skipIf(!posix)('AntigravityAccounts', () => {
  it('没装：installed false、可下载、应用内登录；本平台没有发布时写明原因', async () => {
    const { accounts } = create();
    const state = await accounts.read('antigravity');
    expect(state).toMatchObject({
      kind: 'antigravity',
      status: 'signed_out',
      signIn: 'in_app',
      loginMethods: ['browser'],
      installed: false,
    });
    expect(state.lastError).toBeUndefined();
    await expect(accounts.login('antigravity', 'browser')).rejects.toMatchObject({
      code: 'invalid_input',
    });

    const unsupported = create({ installation: { releaseAsset: null } }).accounts;
    const other = await unsupported.read('antigravity');
    expect(other.canInstall).toBeUndefined();
    expect(other.lastError).toMatch(/does not publish an Antigravity runtime/);
    await expect(unsupported.install('antigravity')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('指定路径之后找得到运行体；路径不对时写明原因', async () => {
    const { accounts } = create();
    const found = await accounts.setExecutablePath('antigravity', executable());
    expect(found).toMatchObject({
      installed: true,
      customPath: executable(),
      status: 'signed_out',
    });
    expect(found.executablePath).toContain('agy_acp_server.par');
    const wrong = await accounts.setExecutablePath('antigravity', path.join(home, 'nope'));
    expect(wrong).toMatchObject({ installed: false });
    expect(wrong.lastError).toMatch(/custom Antigravity executable/);
    expect((await accounts.setExecutablePath('antigravity', null)).customPath).toBeUndefined();
  });

  it('在应用里登录：BROWSER 钩子给出登录网址，浏览器回调之后已登录，模型列表存下，临时文件清掉', async () => {
    const dump = path.join(home, 'env.json');
    const clientDump = path.join(home, 'client.json');
    const { accounts, states } = create({
      env: { FAKE_AGY_ENV_DUMP: dump, FAKE_AGY_CLIENT_DUMP: clientDump, GEMINI_API_KEY: 'leak' },
    });
    await accounts.setExecutablePath('antigravity', executable());
    const started = await accounts.login('antigravity', 'browser');
    expect(started.status).toBe('signing_in');
    const authUrl = started.login?.authUrl as string;
    expect(new URL(authUrl).origin).toBe('https://accounts.google.com');

    await completeBrowserSignIn(authUrl);
    await waitFor(() => states.at(-1)?.status === 'signed_in', '已登录');
    expect(states.at(-1)).toMatchObject({ status: 'signed_in', installed: true });
    // 报成 Zed（运行体只给名单上的客户端列非 Gemini 模型）；各模型的档位是逐个选一遍读到的。
    expect(JSON.parse(readFileSync(clientDump, 'utf8'))).toEqual({ name: 'zed', version: '0.0.0' });
    const models = {
      models: [
        {
          id: 'gemini-3.8-flash',
          displayName: 'Gemini 3.8 Flash',
          reasoningEfforts: ['minimal', 'low', 'high'],
        },
        {
          id: 'gemini-3.1-pro',
          displayName: 'Gemini 3.1 Pro',
          reasoningEfforts: ['low', 'high', 'xhigh'],
        },
        { id: 'gemini-pro-agent', displayName: 'Gemini Pro Agent' },
        {
          id: 'claude-sonnet-4-6',
          displayName: 'Claude Sonnet 4.6',
          reasoningEfforts: ['low', 'high'],
        },
        { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' },
      ],
      defaultModelId: 'gemini-3.8-flash',
    };
    expect(await accounts.models('antigravity')).toEqual(models);
    expect(JSON.parse(readFileSync(path.join(root(), 'models.json'), 'utf8'))).toEqual(models);
    // 一次性会话的对话文件、登录进程的临时目录与解包目录都不留下。
    expect(readdirSync(path.join(root(), 'profile', 'antigravity-acp', 'conversations'))).toEqual(
      [],
    );
    expect(leftovers()).toEqual([]);

    const seen = JSON.parse(readFileSync(dump, 'utf8')) as { env: Record<string, string> };
    expect(seen.env.GEMINI_HOME).toBe(path.join(root(), 'profile'));
    expect(seen.env.AGY_ACP_FORCE_FILE_STORAGE).toBe('1');
    expect(seen.env.GEMINI_API_KEY).toBeUndefined();
    expect(seen.env.TMPDIR?.startsWith(path.join(root(), 'tmp', 'run-'))).toBe(true);
    expect(seen.env.ANTIGRAVITY_HARNESS_PATH).toBe(
      path.join(realpathSync(bin), 'localharness_external'),
    );
    expect(seen.env.BROWSER).toContain('__WEVIR_ANTIGRAVITY_AUTH_URL__');

    // 新的适配器（Host 重启）不启动运行体也读得到已登录与模型列表。
    const restarted = create().accounts;
    await restarted.setExecutablePath('antigravity', executable());
    expect((await restarted.read('antigravity')).status).toBe('signed_in');
    expect(await restarted.models('antigravity')).toEqual(models);
  });

  it('1.1.1 把登录网址写在 stdout 上：照样认出，ACP 连接不受影响', async () => {
    const { accounts, states } = create({ env: { FAKE_AGY_NATIVE_URL: '1' } });
    await accounts.setExecutablePath('antigravity', executable());
    const started = await accounts.login('antigravity', 'browser');
    await completeBrowserSignIn(started.login?.authUrl as string);
    await waitFor(() => states.at(-1)?.status === 'signed_in', '已登录');
  });

  it('用户在浏览器里拒绝：未登录，lastError 说明；取消登录不留错误', async () => {
    const { accounts, states } = create();
    await accounts.setExecutablePath('antigravity', executable());
    const started = await accounts.login('antigravity', 'browser');
    await completeBrowserSignIn(started.login?.authUrl as string, 'access_denied');
    await waitFor(() => states.at(-1)?.lastError !== undefined, '登录失败');
    expect(states.at(-1)).toMatchObject({
      status: 'signed_out',
      lastError: 'Google sign-in was not approved. Start sign-in again.',
    });

    const again = await accounts.login('antigravity', 'browser');
    const cancelled = await accounts.cancelLogin('antigravity', again.login?.loginId);
    expect(cancelled.status).toBe('signed_out');
    expect(cancelled.lastError).toBeUndefined();
    expect(cancelled.login).toBeUndefined();
    await waitFor(() => leftovers().length === 0 || undefined, '登录进程的临时目录清掉');
  });

  it('刷新：启动运行体确认登录并重读模型；运行体说要登录时改为未登录', async () => {
    writeFakeToken(home);
    const { accounts } = create();
    await accounts.setExecutablePath('antigravity', executable());
    const refreshed = await accounts.read('antigravity', { refresh: true });
    expect(refreshed.status).toBe('signed_in');
    expect((await accounts.models('antigravity')).models.map((model) => model.id)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.1-pro',
      'gemini-pro-agent',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
    ]);
    expect(leftovers()).toEqual([]);

    accounts.markSignInRequired();
    const rejected = await accounts.read('antigravity');
    expect(rejected).toMatchObject({ status: 'signed_out' });
    expect(rejected.lastError).toMatch(/expired or was revoked/);
  });

  it('登出：运行体清掉自己的登录（ACP logout），模型列表一并清掉', async () => {
    writeFakeToken(home);
    const { accounts } = create();
    await accounts.setExecutablePath('antigravity', executable());
    await accounts.read('antigravity', { refresh: true });
    const state = await accounts.logout('antigravity');
    expect(state.status).toBe('signed_out');
    expect(existsSync(antigravityTokenPath(path.join(root(), 'profile')))).toBe(false);
    expect(existsSync(path.join(root(), 'models.json'))).toBe(false);
    expect(await accounts.models('antigravity')).toEqual({ models: [] });
  });

  it('account.install：报 installing 进度，完成后 installed；失败写进 lastError', async () => {
    const files = fakeRuntimeFiles();
    const zip = buildZip([
      { name: 'agy_acp_server.par', data: files.executable },
      { name: 'localharness_external', data: files.harness },
    ]);
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(zip.length) });
      res.end(zip);
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const asset = {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: `http://127.0.0.1:${port}/runtime.zip`,
      sha256: createHash('sha256').update(zip).digest('hex'),
      archiveBytes: zip.length,
      executable: { name: 'agy_acp_server.par', bytes: files.executable.length },
      harness: { name: 'localharness_external', bytes: files.harness.length },
    };
    const { accounts, states } = create({
      installation: { releaseAsset: asset, progressIntervalMs: 0 },
    });
    expect(await accounts.read('antigravity')).toMatchObject({
      installed: false,
      canInstall: true,
    });
    const started = await accounts.install('antigravity');
    expect(started.installing).toEqual({ completedBytes: 0, totalBytes: zip.length });
    expect((await accounts.install('antigravity')).installing).toBeDefined();
    await waitFor(() => states.at(-1)?.installed === true, '装好');
    expect(states.some((state) => state.installing !== undefined)).toBe(true);
    expect(states.at(-1)).toMatchObject({ installed: true, version: ANTIGRAVITY_RELEASE_VERSION });
    expect(states.at(-1)?.installing).toBeUndefined();
    expect(states.at(-1)?.canInstall).toBeUndefined();

    const failing = create({
      installation: {
        releaseAsset: { ...asset, url: 'https://dl.google.com/agy-extensions/releases/x.zip' },
        fetch: async () => {
          throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } });
        },
      },
    });
    // 换一个数据目录，免得看到上面装好的版本。
    removeDir(path.join(home, 'engines'));
    await failing.accounts.install('antigravity');
    await waitFor(() => failing.states.at(-1)?.lastError, '安装失败');
    expect(failing.states.at(-1)?.lastError).toMatch(
      /Could not reach dl\.google\.com \(ETIMEDOUT\)/,
    );
    expect(failing.states.at(-1)?.installing).toBeUndefined();
  });
});
