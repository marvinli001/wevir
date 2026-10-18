// 真实 `opencode` 上的下载安装与接上游：不用订阅、不登录任何真实账号。opencode 的数据、配置、缓存都在临时目录里，不碰用户自己的
// 登录。平时跳过；要跑时：
//
//   WEVIR_TEST_OPENCODE=1 WEVIR_TEST_OPENCODE_INSTALL=1 WEVIR_TEST_OPENCODE_NETWORK=1 \
//     pnpm vitest run --project adapter-opencode accounts.real
//
// - `WEVIR_TEST_OPENCODE_INSTALL=1`：从 npm 下载本平台的 opencode（约 145 MB）装进临时目录，再用它做后面的事；不设时用
//   `WEVIR_TEST_OPENCODE_BIN` 指的那一个。
// - `WEVIR_TEST_OPENCODE_NETWORK=1`：设备码登录（GitHub Copilot、ChatGPT 的无头登录）会向 github.com 与 auth.openai.com 要一个
//   设备码（只带公开的 client ID，不登录、不授权，码过期作废）；不设时跳过这两项。

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountState } from '@wevir/runtime-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareVersions, MINIMUM_OPENCODE_VERSION, OPENCODE_BIN_ENV } from './executable.js';
import { OpenCodeAdapter } from './opencode-adapter.js';

const ENABLED = process.env.WEVIR_TEST_OPENCODE === '1';
const INSTALL = process.env.WEVIR_TEST_OPENCODE_INSTALL === '1';
const NETWORK = process.env.WEVIR_TEST_OPENCODE_NETWORK === '1';
const BIN = process.env.WEVIR_TEST_OPENCODE_BIN;

const root = ENABLED ? realpathSync(mkdtempSync(join(tmpdir(), 'wevir-opencode-accounts-'))) : '';
let adapter: OpenCodeAdapter | undefined;

function env(): NodeJS.ProcessEnv {
  return {
    HOME: root,
    // 装的时候不能让 PATH 里别的 opencode 抢先。
    PATH: INSTALL ? '/usr/bin:/bin' : process.env.PATH,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    XDG_DATA_HOME: `${root}/data`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_CACHE_HOME: `${root}/cache`,
    XDG_STATE_HOME: `${root}/state`,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    ...(!INSTALL && BIN !== undefined && { [OPENCODE_BIN_ENV]: BIN }),
  };
}

beforeAll(() => {
  if (!ENABLED) return;
  mkdirSync(root, { recursive: true });
  adapter = new OpenCodeAdapter({ home: join(root, 'home'), env: env(), idleTtlMs: 500 });
});

afterAll(async () => {
  if (!ENABLED) return;
  await adapter?.dispose();
  rmSync(root, { recursive: true, force: true });
});

const accounts = () => {
  if (adapter === undefined) throw new Error('adapter not created');
  return adapter.accounts;
};

describe.skipIf(!ENABLED)('OpenCodeAccounts（真实 opencode，隔离的目录）', () => {
  it.skipIf(!INSTALL)(
    '下载安装：从 npm 取平台包，核对校验和，装进 <引擎目录>/runtime，版本在支持的范围内',
    async () => {
      const before = await accounts().read('opencode', { refresh: true });
      expect(before).toMatchObject({ installed: false, canInstall: true });
      const seen: AccountState[] = [];
      accounts().onChange((state) => seen.push(state));
      await accounts().install('opencode');
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        const last = seen.at(-1);
        if (last !== undefined && last.installing === undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const state = await accounts().read('opencode');
      expect(state.lastError).toBeUndefined();
      expect(state).toMatchObject({ installed: true });
      expect(state.executablePath).toContain(join('engines', 'opencode', 'runtime', 'versions'));
      expect(
        compareVersions(state.version ?? '0.0.0', MINIMUM_OPENCODE_VERSION),
      ).toBeGreaterThanOrEqual(0);
      expect(compareVersions(state.version ?? '0.0.0', '2.0.0')).toBeLessThan(0);
      expect(state.loginCommand).toBe(`"${state.executablePath}" auth login`);
      expect(seen.some((entry) => entry.installing !== undefined)).toBe(true);
    },
    6 * 60_000,
  );

  it('上游表：OpenCode Zen 免登录算接着，OpenAI 与 GitHub Copilot 有 OAuth，要填实例地址的 GitLab 不提供', async () => {
    const upstreams = await accounts().upstreams();
    const byId = new Map(upstreams.map((entry) => [entry.id, entry]));
    expect(byId.get('opencode')).toMatchObject({ connected: true, featured: true });
    expect(byId.get('opencode-go')?.methods).toEqual([
      { type: 'api_key', label: 'API key', option: 'default' },
    ]);
    expect(byId.get('openai')?.methods.map((method) => method.type)).toContain('oauth');
    expect(byId.get('github-copilot')?.methods).toEqual([
      expect.objectContaining({ type: 'oauth', option: '0' }),
    ]);
    expect(byId.has('gitlab')).toBe(false);
    expect(upstreams[0]?.id).toBe('opencode');
  });

  it('API Key：存进 opencode 就算接上，断开就没了（假 Key，不发请求）', async () => {
    const connected = await accounts().connect({
      upstream: 'opencode-go',
      apiKey: 'sk-wevir-test',
    });
    expect(connected.status).toBe('signed_in');
    expect(connected.plan?.split(',')).toContain('opencode-go');
    expect(JSON.stringify(connected)).not.toContain('sk-wevir-test');
    const disconnected = await accounts().disconnect('opencode-go');
    expect(disconnected.plan?.split(',')).not.toContain('opencode-go');
    // Zen 的免登录模型去不掉。
    await expect(accounts().disconnect('opencode')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  }, 60_000);

  it('浏览器授权（ChatGPT）：服务器给出 auth.openai.com 的授权网址，取消后回到取消前', async () => {
    const started = await accounts().connect({ upstream: 'openai', option: '0' });
    expect(started.status).toBe('signing_in');
    expect(started.login?.method).toBe('browser');
    const url = new URL(started.login?.authUrl ?? '');
    expect(url.host).toBe('auth.openai.com');
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\//u);
    const cancelled = await accounts().cancelLogin('opencode', started.login?.loginId);
    expect(cancelled.status).toBe('signed_in');
    expect(cancelled.login).toBeUndefined();
  }, 60_000);

  it.skipIf(!NETWORK)(
    '设备码：GitHub Copilot 与 ChatGPT 无头登录给出验证网址与一次性的码，取消后什么都没留下',
    async () => {
      const copilot = await accounts().connect({ upstream: 'github-copilot' });
      expect(copilot.login).toMatchObject({
        method: 'device_code',
        verificationUrl: 'https://github.com/login/device',
        userCode: expect.stringMatching(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u),
      });
      await accounts().cancelLogin('opencode');
      const headless = await accounts().connect({ upstream: 'openai', option: '1' });
      expect(headless.login).toMatchObject({
        method: 'device_code',
        verificationUrl: expect.stringContaining('auth.openai.com'),
        userCode: expect.stringMatching(/^[A-Z0-9-]{6,}$/u),
      });
      const cancelled = await accounts().cancelLogin('opencode', headless.login?.loginId);
      expect(cancelled.status).toBe('signed_in');
      expect(cancelled.plan).toBe('opencode');
    },
    60_000,
  );
});
