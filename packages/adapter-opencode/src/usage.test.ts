import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCodeAccounts } from './accounts.js';
import { OpenCodeRuntime } from './runtime.js';
import { FAKE_OPENCODE_VERSION, FakeOpenCode } from './test-fixtures/fake-opencode.js';
import {
  OPENCODE_GO_USAGE_URL,
  openCodeAuthPath,
  openCodeGoApiKey,
  openCodeGoUsageWindows,
  readOpenCodeGoUsage,
} from './usage.js';

// 用量接口的形状照 T3 的 schema（`usage.rolling/weekly/monthly` 各是 `{ percent, resetsAt }`）；没有真实账号的录制，数是编的。
const USAGE = {
  usage: {
    rolling: { percent: 18, resetsAt: '2026-10-17T10:00:00Z' },
    weekly: { percent: 44.5, resetsAt: '2026-10-20T00:00:00Z' },
    monthly: { percent: 71, resetsAt: '2026-11-01T00:00:00Z' },
  },
};
const AUTH = JSON.stringify({
  anthropic: { type: 'oauth', access: 'not-this' },
  'opencode-go': { type: 'api', key: ' go_key ' },
});

function fakeFetch(respond: () => Response) {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return respond();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}
const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status });
// 键写成 POSIX 路径；Windows 上 path.join 出来的是反斜杠，查之前换回来。
const files = (contents: Record<string, string>) => async (file: string) => {
  const value = contents[file.replaceAll('\\', '/')];
  if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  return value;
};

describe('OpenCode Go 的 Key 与用量', () => {
  it('auth.json 在 XDG_DATA_HOME 下，默认 ~/.local/share', () => {
    expect(openCodeAuthPath({ XDG_DATA_HOME: '/xdg' })).toBe(join('/xdg', 'opencode', 'auth.json'));
    expect(openCodeAuthPath({ HOME: '/home/me' })).toBe(
      join('/home/me', '.local', 'share', 'opencode', 'auth.json'),
    );
  });

  it('Key：auth.json 的 opencode-go 优先，OPENCODE_AUTH_CONTENT 代替文件，都没有时 OPENCODE_API_KEY；没有文件不算错', async () => {
    const read = files({ '/h/.local/share/opencode/auth.json': AUTH });
    expect(await openCodeGoApiKey({ HOME: '/h', OPENCODE_API_KEY: 'env' }, read)).toBe('go_key');
    expect(
      await openCodeGoApiKey(
        { HOME: '/h', OPENCODE_AUTH_CONTENT: '{}', OPENCODE_API_KEY: 'env' },
        read,
      ),
    ).toBe('env');
    expect(await openCodeGoApiKey({ HOME: '/none' }, read)).toBeUndefined();
    const broken = async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    await expect(openCodeGoApiKey({ HOME: '/h' }, broken)).rejects.toThrow('denied');
  });

  it('三个窗口：5 小时、每周、每月；缺的不报', () => {
    expect(openCodeGoUsageWindows(USAGE)).toEqual([
      { usedPercent: 18, windowMinutes: 300, resetsAt: '2026-10-17T10:00:00.000Z' },
      { usedPercent: 44.5, windowMinutes: 10080, resetsAt: '2026-10-20T00:00:00.000Z' },
      { usedPercent: 71, period: 'monthly', resetsAt: '2026-11-01T00:00:00.000Z' },
    ]);
    expect(openCodeGoUsageWindows({ usage: { weekly: { percent: 5 } } })).toEqual([
      { usedPercent: 5, windowMinutes: 10080 },
    ]);
    expect(openCodeGoUsageWindows({})).toEqual([]);
  });

  it('readOpenCodeGoUsage：带 Go 的 Key 请求；403（没有 Go 订阅）与没有 Key 是 undefined，别的失败抛错', async () => {
    const env = { HOME: '/h' };
    const readFile = files({ '/h/.local/share/opencode/auth.json': AUTH });
    const ok = fakeFetch(json(USAGE));
    const limits = await readOpenCodeGoUsage({ env, readFile, fetch: ok.fetch });
    expect(ok.calls).toEqual([{ url: OPENCODE_GO_USAGE_URL, authorization: 'Bearer go_key' }]);
    expect(limits?.windows).toHaveLength(3);
    expect(limits?.primary?.windowMinutes).toBe(300);
    expect(limits?.secondary?.windowMinutes).toBe(10080);

    const forbidden = fakeFetch(json({}, 403));
    expect(await readOpenCodeGoUsage({ env, readFile, fetch: forbidden.fetch })).toBeUndefined();
    const none = fakeFetch(json(USAGE));
    expect(
      await readOpenCodeGoUsage({ env: { HOME: '/none' }, readFile, fetch: none.fetch }),
    ).toBeUndefined();
    expect(none.calls).toEqual([]);
    const failed = fakeFetch(json({}, 502));
    await expect(readOpenCodeGoUsage({ env, readFile, fetch: failed.fetch })).rejects.toThrow(
      'HTTP 502',
    );
  });
});

describe('OpenCodeAccounts 的用量', () => {
  const dirs: string[] = [];
  const runtimes: OpenCodeRuntime[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(respond: { current: () => Response }) {
    const fake = new FakeOpenCode();
    const engineDir = mkdtempSync(join(tmpdir(), 'wevir-opencode-usage-'));
    dirs.push(engineDir);
    const runtime = new OpenCodeRuntime({
      engineDir,
      env: {},
      sdk: async () => fake,
      findExecutable: () => '/fake/bin/opencode',
      probeVersion: async () => ({ ok: true, version: FAKE_OPENCODE_VERSION }),
      startServer: fake.start,
      idleTtlMs: 20,
    });
    runtimes.push(runtime);
    const http = fakeFetch(() => respond.current());
    const accounts = new OpenCodeAccounts({
      runtime,
      env: { HOME: '/h' },
      fetch: http.fetch,
      readFile: files({ '/h/.local/share/opencode/auth.json': AUTH }),
    });
    return { fake, accounts, http };
  }

  it('接上了 OpenCode Go 才读用量；读不到时留着上一次的', async () => {
    const respond = { current: json(USAGE) };
    const { fake, accounts, http } = setup(respond);
    expect((await accounts.read('opencode')).rateLimits).toBeUndefined();
    expect(http.calls).toEqual([]);

    fake.providerList = { ...fake.providerList, connected: ['mock', 'opencode-go'] };
    const state = await accounts.read('opencode', { refresh: true });
    expect(state.status).toBe('signed_in');
    expect(state.rateLimits?.windows?.map((window) => window.usedPercent)).toEqual([18, 44.5, 71]);

    respond.current = json({}, 500);
    expect((await accounts.read('opencode', { refresh: true })).rateLimits).toEqual(
      state.rateLimits,
    );
    respond.current = json({}, 403);
    expect((await accounts.read('opencode', { refresh: true })).rateLimits).toBeUndefined();
  });
});
