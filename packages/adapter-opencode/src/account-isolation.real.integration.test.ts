// 真实 `opencode` 上的添加账号（0.63.0 多账号）：只换 `XDG_DATA_HOME` 时登录分开、配置里的上游照旧共用。不联网、不登录，凭据都是
// 临时目录里的假 Key。平时跳过；要跑时：
//
//   WEVIR_TEST_OPENCODE=1 WEVIR_TEST_OPENCODE_BIN=/path/to/opencode \
//     pnpm vitest run --project adapter-opencode account-isolation.real

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { OPENCODE_BIN_ENV } from './executable.js';
import { OpenCodeAdapter } from './opencode-adapter.js';

const ENABLED = process.env.WEVIR_TEST_OPENCODE === '1' && !!process.env.WEVIR_TEST_OPENCODE_BIN;

const root = ENABLED ? realpathSync(mkdtempSync(join(tmpdir(), 'wevir-opencode-isolation-'))) : '';
const adapters: OpenCodeAdapter[] = [];

function env(): NodeJS.ProcessEnv {
  return {
    HOME: root,
    PATH: '/usr/bin:/bin',
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    XDG_DATA_HOME: `${root}/data`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_CACHE_HOME: `${root}/cache`,
    XDG_STATE_HOME: `${root}/state`,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    [OPENCODE_BIN_ENV]: process.env.WEVIR_TEST_OPENCODE_BIN,
  };
}

function adapter(account?: { dataHome: string }): OpenCodeAdapter {
  const created = new OpenCodeAdapter({
    home: join(root, 'wevir'),
    env: env(),
    idleTtlMs: 500,
    ...(account !== undefined && { account }),
  });
  adapters.push(created);
  return created;
}

afterAll(async () => {
  if (!ENABLED) return;
  for (const each of adapters) await each.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)('添加的 OpenCode 账号（真实 opencode）', () => {
  it('首个账号的登录看不到，配置里的上游照旧在', async () => {
    mkdirSync(`${root}/config/opencode`, { recursive: true });
    writeFileSync(
      `${root}/config/opencode/opencode.json`,
      JSON.stringify({
        provider: {
          myup: {
            npm: '@ai-sdk/openai-compatible',
            name: 'My Upstream',
            options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'fake-config-key' },
            models: { m1: { name: 'M1' } },
          },
        },
      }),
    );
    mkdirSync(`${root}/data/opencode`, { recursive: true });
    writeFileSync(
      `${root}/data/opencode/auth.json`,
      JSON.stringify({ anthropic: { type: 'api', key: 'fake-main-key' } }),
    );

    const main = await adapter().accounts.read('opencode', { refresh: true });
    const added = await adapter({
      dataHome: join(root, 'accounts', 'opencode-0001'),
    }).accounts.read('opencode', { refresh: true });
    const plan = (state: { plan?: string }) => (state.plan ?? '').split(',');
    expect(plan(main)).toEqual(expect.arrayContaining(['anthropic', 'myup']));
    expect(plan(added)).toContain('myup');
    expect(plan(added)).not.toContain('anthropic');
  }, 120_000);
});
