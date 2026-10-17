import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GrokAccounts } from './accounts.js';
import { fakeGrokEnv, tempRoot } from './test-fixtures/harness.js';
import { GROK_BILLING_URL, grokUsageWindows, readGrokCredential, readGrokUsage } from './usage.js';

// 计费接口的形状照 T3 的 schema（`config.creditUsagePercent`、`config.currentPeriod.type/end`）；没有真实账号的录制，数是编的。
const BILLING = {
  config: {
    creditUsagePercent: 37.5,
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-20T00:00:00Z' },
  },
};
const LOGIN_KEY = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const AUTH = JSON.stringify({
  'https://other.example::client': { key: 'other-token', email: 'other@example.com' },
  [LOGIN_KEY]: { key: 'grok-token', email: 'me@example.com', auth_mode: 'oauth' },
});

// 键写成 POSIX 路径；Windows 上 path.join 出来的是反斜杠，查之前换回来。
const files = (contents: Record<string, string>) => async (file: string) => {
  const value = contents[file.replaceAll('\\', '/')];
  if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  return value;
};

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

describe('readGrokCredential', () => {
  const read = files({ '/h/.grok/auth.json': AUTH });

  it('读 ~/.grok/auth.json 里默认 grok.com 登录的令牌与邮箱；GROK_HOME 与 GROK_AUTH 可以换', async () => {
    expect(await readGrokCredential({ HOME: '/h' }, read)).toEqual({
      token: 'grok-token',
      email: 'me@example.com',
    });
    expect(
      await readGrokCredential({ GROK_HOME: '/g' }, files({ '/g/auth.json': AUTH })),
    ).toMatchObject({ email: 'me@example.com' });
    expect(
      await readGrokCredential(
        {
          HOME: '/h',
          GROK_AUTH: JSON.stringify({ 'https://accounts.x.ai/sign-in': { key: 't' } }),
        },
        read,
      ),
    ).toEqual({ token: 't' });
  });

  it('XAI_API_KEY、别的登录方式的环境变量、config.toml 的 auth 段、API Key 登录、没有文件：undefined', async () => {
    expect(await readGrokCredential({ HOME: '/h', XAI_API_KEY: 'k' }, read)).toBeUndefined();
    expect(await readGrokCredential({ HOME: '/h', GROK_OIDC_ISSUER: 'x' }, read)).toBeUndefined();
    const withConfig = files({
      '/h/.grok/auth.json': AUTH,
      '/h/.grok/config.toml': 'model = "grok-4"\n[auth]\nprovider = "corp"\n',
    });
    expect(await readGrokCredential({ HOME: '/h' }, withConfig)).toBeUndefined();
    const apiKeyLogin = files({
      '/h/.grok/auth.json': JSON.stringify({ [LOGIN_KEY]: { key: 'k', auth_mode: 'api_key' } }),
    });
    expect(await readGrokCredential({ HOME: '/h' }, apiKeyLogin)).toBeUndefined();
    expect(await readGrokCredential({ HOME: '/none' }, read)).toBeUndefined();
  });
});

describe('grokUsageWindows', () => {
  it('每周的周期报 10080 分钟，每月的按月，别的长度不明；没有百分比时是空的', () => {
    expect(grokUsageWindows(BILLING)).toEqual([
      { usedPercent: 37.5, windowMinutes: 10080, resetsAt: '2026-10-20T00:00:00.000Z' },
    ]);
    expect(
      grokUsageWindows({
        config: { creditUsagePercent: 5, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY' } },
      }),
    ).toEqual([{ usedPercent: 5, period: 'monthly' }]);
    expect(grokUsageWindows({ config: { creditUsagePercent: 5 } })).toEqual([{ usedPercent: 5 }]);
    expect(grokUsageWindows({ config: {} })).toEqual([]);
    expect(grokUsageWindows(null)).toEqual([]);
  });
});

describe('readGrokUsage', () => {
  it('用登录的令牌读计费接口，带上邮箱；失败时 ok: false，邮箱照给；不用默认登录时 undefined', async () => {
    const readFile = files({ '/h/.grok/auth.json': AUTH });
    const ok = fakeFetch(json(BILLING));
    expect(await readGrokUsage({ env: { HOME: '/h' }, readFile, fetch: ok.fetch })).toEqual({
      email: 'me@example.com',
      usage: { ok: true, rateLimits: grokUsageWindows(BILLING) },
    });
    expect(ok.calls).toEqual([{ url: GROK_BILLING_URL, authorization: 'Bearer grok-token' }]);
    const failed = fakeFetch(json({}, 401));
    expect(await readGrokUsage({ env: { HOME: '/h' }, readFile, fetch: failed.fetch })).toEqual({
      email: 'me@example.com',
      usage: { ok: false },
    });
    expect(
      await readGrokUsage({ env: { HOME: '/h', XAI_API_KEY: 'k' }, readFile, fetch: ok.fetch }),
    ).toBeUndefined();
    const unreadable = async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    expect(
      await readGrokUsage({ env: { HOME: '/h' }, readFile: unreadable, fetch: ok.fetch }),
    ).toEqual({ usage: { ok: false } });
  });
});

describe('GrokAccounts 的邮箱与用量', () => {
  const temp = tempRoot('usage');
  afterAll(() => temp.remove());

  it('已登录时带上邮箱与用量；读失败时同一个账号留着上一次的', async () => {
    const respond = { current: json(BILLING) };
    const http = fakeFetch(() => respond.current());
    const dir = temp.dir('signed-in');
    const subject = new GrokAccounts({
      workDir: join(dir, 'engines', 'grok'),
      env: fakeGrokEnv({ FAKE_GROK_LOG: join(dir, 'grok.log'), GROK_HOME: '/g' }),
      fetch: http.fetch,
      readFile: files({ '/g/auth.json': AUTH }),
    });
    try {
      const state = await subject.read('grok');
      expect(state).toMatchObject({ status: 'signed_in', email: 'me@example.com' });
      expect(state.rateLimits).toEqual({
        primary: { usedPercent: 37.5, windowMinutes: 10080, resetsAt: '2026-10-20T00:00:00.000Z' },
        windows: [
          { usedPercent: 37.5, windowMinutes: 10080, resetsAt: '2026-10-20T00:00:00.000Z' },
        ],
      });
      respond.current = json({}, 500);
      expect((await subject.read('grok', { refresh: true })).rateLimits).toEqual(state.rateLimits);
      respond.current = json({ config: {} });
      const unused = await subject.read('grok', { refresh: true });
      expect(unused.email).toBe('me@example.com');
      expect(unused.rateLimits).toBeUndefined();
    } finally {
      subject.dispose();
    }
  });
});
