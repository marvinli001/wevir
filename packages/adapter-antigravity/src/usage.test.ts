import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AccountState } from '@wevir/runtime-adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AntigravityAdapter } from './antigravity-adapter.js';
import { antigravityTokenPath } from './profile.js';
import {
  collectingLogger,
  installFakeRuntime,
  removeDir,
  tempDir,
  waitFor,
} from './test-fixtures/runtime.js';
import {
  ANTIGRAVITY_HUB_VERSION,
  AntigravityUsage,
  GOOGLE_TOKEN_URL,
  modelWindows,
  summaryWindows,
} from './usage.js';

// 两个 Cloud Code 接口的形状照 T3 的 schema（groups[].buckets[] 的 remainingFraction / resetTime / window，models 的
// quotaInfo / weeklyQuotaInfo）；没有真实账号的录制，数是编的。
const SUMMARY = {
  groups: [
    {
      displayName: 'Gemini',
      buckets: [
        {
          bucketId: 'gemini-5h',
          window: '5h',
          remainingFraction: 0.75,
          resetTime: '2026-10-17T12:00:00Z',
        },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4 },
      ],
    },
    {
      displayName: 'Third party',
      buckets: [
        { bucketId: '3p-5h', window: '5h', remainingFraction: 1 },
        {
          bucketId: '3p-weekly',
          window: 'weekly',
          remainingFraction: 0.1,
          resetTime: '2026-10-20T00:00:00Z',
        },
        { bucketId: '3p-old', window: 'daily', remainingFraction: 0.5, disabled: true },
      ],
    },
  ],
};
const TOKEN = JSON.stringify({
  client_id: 'client',
  client_secret: 'secret',
  refresh_token: 'refresh',
  project_id: 'proj-1',
});

interface Call {
  url: string;
  body: string;
  authorization: string | null;
}

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: String(init?.body ?? ''),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    const route = Object.keys(routes).find((key) => url.endsWith(key));
    return route === undefined
      ? new Response('{}', { status: 404 })
      : (routes[route] as () => Response)();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}
const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status });
const TOKEN_OK = { [GOOGLE_TOKEN_URL]: json({ access_token: 'access-1', expires_in: 3600 }) };

describe('summaryWindows / modelWindows', () => {
  it('按额度分组：Gemini 一份、Claude 与 GPT 共用一份，5 小时与每周给长度；停用的不报', () => {
    expect(summaryWindows(SUMMARY)).toEqual([
      {
        usedPercent: 25,
        scope: 'Gemini',
        windowMinutes: 300,
        resetsAt: '2026-10-17T12:00:00.000Z',
      },
      { usedPercent: 60, scope: 'Gemini', windowMinutes: 10080 },
      { usedPercent: 0, scope: 'Claude & GPT', windowMinutes: 300 },
      {
        usedPercent: 90,
        scope: 'Claude & GPT',
        windowMinutes: 10080,
        resetsAt: '2026-10-20T00:00:00.000Z',
      },
    ]);
  });

  it('Gemini 4 Argon 单独一份（gemini-argon 桶或组名带 Argon），同名同长度的桶只留用得最多的', () => {
    // 形状照第三方额度工具报告的 Argon 分组（openusage #1397），数是编的。
    const windows = summaryWindows({
      groups: [
        ...SUMMARY.groups,
        {
          displayName: 'Gemini 4 Argon',
          buckets: [
            {
              bucketId: 'gemini-argon-wtu-weekly',
              displayName: 'Gemini 4 Argon Weekly Limit',
              window: 'weekly',
              remainingFraction: 0.75,
              resetTime: '2026-10-22T23:24:33Z',
            },
            { bucketId: 'gemini-argon-weekly', window: 'weekly', remainingFraction: 0.9 },
          ],
        },
        {
          displayName: 'Argon preview',
          buckets: [{ bucketId: 'x-5h', window: '5h', remainingFraction: 1 }],
        },
      ],
    });
    expect(windows.filter((window) => window.scope === 'Gemini 4 Argon')).toEqual([
      {
        usedPercent: 25,
        scope: 'Gemini 4 Argon',
        windowMinutes: 10080,
        resetsAt: '2026-10-22T23:24:33.000Z',
      },
      { usedPercent: 0, scope: 'Gemini 4 Argon', windowMinutes: 300 },
    ]);
    // Gemini 那份不受影响。
    expect(windows.filter((window) => window.scope === 'Gemini')).toHaveLength(2);
  });

  it('没有分组时读顶层的 buckets；别的窗口把桶名接在额度名后面', () => {
    expect(
      summaryWindows({
        buckets: [{ bucketId: 'x-daily', displayName: 'Daily', remainingFraction: 0.5 }],
      }),
    ).toEqual([{ usedPercent: 50, scope: 'x-daily · Daily' }]);
    expect(summaryWindows({})).toEqual([]);
  });

  it('按模型的额度：同一家族取用得最多的，每周的给长度，认不出的模型不报', () => {
    expect(
      modelWindows({
        models: {
          'gemini-3-pro': { quotaInfo: { remainingFraction: 0.9 } },
          'gemini-3-flash': { quotaInfo: { remainingFraction: 0.2 } },
          'claude-sonnet': {
            modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
            weeklyQuotaInfo: { remainingFraction: 0.5, resetTime: '2026-10-20T00:00:00Z' },
          },
          'mystery-1': { quotaInfo: { remainingFraction: 0 } },
          'gemini-4-argon-high': {
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            quotaInfo: { remainingFraction: 0.6 },
          },
        },
      }),
    ).toEqual([
      { usedPercent: 80, scope: 'Gemini' },
      {
        usedPercent: 50,
        scope: 'Claude',
        windowMinutes: 10080,
        resetsAt: '2026-10-20T00:00:00.000Z',
      },
      { usedPercent: 40, scope: 'Gemini 4 Argon' },
    ]);
  });
});

describe('AntigravityUsage', () => {
  const read = (text: string | undefined) => async () => {
    if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return text;
  };

  it('用 refresh token 换 access token（缓存到快过期），再读额度汇总，带上项目', async () => {
    let now = 0;
    const http = fakeFetch({ ...TOKEN_OK, ':retrieveUserQuotaSummary': json(SUMMARY) });
    const usage = new AntigravityUsage({
      tokenPath: '/p/acp_token.json',
      readFile: read(TOKEN),
      fetch: http.fetch,
      now: () => now,
    });
    const first = await usage.read();
    expect(first.ok && first.rateLimits?.windows?.map((window) => window.usedPercent)).toEqual([
      25, 0, 60, 90,
    ]);
    expect(http.calls[0]).toMatchObject({ url: GOOGLE_TOKEN_URL, authorization: null });
    expect(new URLSearchParams(http.calls[0]?.body).get('grant_type')).toBe('refresh_token');
    expect(http.calls[1]).toMatchObject({
      url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      body: '{"project":"proj-1"}',
      authorization: 'Bearer access-1',
    });
    await usage.read();
    expect(http.calls.filter((call) => call.url === GOOGLE_TOKEN_URL)).toHaveLength(1);
    now += 3600_000;
    await usage.read();
    expect(http.calls.filter((call) => call.url === GOOGLE_TOKEN_URL)).toHaveLength(2);
    usage.clear();
    await usage.read();
    expect(http.calls.filter((call) => call.url === GOOGLE_TOKEN_URL)).toHaveLength(3);
  });

  it('User-Agent 报的版本够新（低于 2.16 时 Cloud Code 不给 Argon 那组）', async () => {
    const agents: string[] = [];
    const usage = new AntigravityUsage({
      tokenPath: '/profile/token.json',
      readFile: read(TOKEN),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === GOOGLE_TOKEN_URL) return json({ access_token: 'a', expires_in: 3600 })();
        agents.push(new Headers(init?.headers).get('user-agent') ?? '');
        return json(SUMMARY)();
      }) as typeof fetch,
    });
    expect((await usage.read()).ok).toBe(true);
    expect(agents[0]).toMatch(
      new RegExp(`^antigravity/hub/${ANTIGRAVITY_HUB_VERSION.replaceAll('.', '\\.')} `),
    );
    const [major = 0, minor = 0] = ANTIGRAVITY_HUB_VERSION.split('.').map(Number);
    expect(major > 2 || (major === 2 && minor >= 16)).toBe(true);
  });

  it('第一个端点失败换第二个；汇总没有窗口时退回按模型的额度', async () => {
    const http = fakeFetch({
      ...TOKEN_OK,
      'daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary': json({}, 503),
      '//cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary': json({ groups: [] }),
      '//cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels': json({
        models: { 'gemini-3-pro': { quotaInfo: { remainingFraction: 0.5 } } },
      }),
    });
    const usage = new AntigravityUsage({
      tokenPath: '/p',
      readFile: read(TOKEN),
      fetch: http.fetch,
    });
    expect(await usage.read()).toEqual({
      ok: true,
      rateLimits: {
        primary: { usedPercent: 50, scope: 'Gemini' },
        windows: [{ usedPercent: 50, scope: 'Gemini' }],
      },
    });
  });

  it('没有登录文件：ok 但没有用量，不联网；文件坏了、换令牌失败、都没有额度：ok false', async () => {
    const http = fakeFetch({ ...TOKEN_OK });
    expect(
      await new AntigravityUsage({
        tokenPath: '/p',
        readFile: read(undefined),
        fetch: http.fetch,
      }).read(),
    ).toEqual({ ok: true });
    expect(http.calls).toEqual([]);
    expect(
      await new AntigravityUsage({
        tokenPath: '/p',
        readFile: read('{"fake":true}'),
        fetch: http.fetch,
      }).read(),
    ).toEqual({ ok: false });
    const rejected = fakeFetch({ [GOOGLE_TOKEN_URL]: json({ error: 'invalid_grant' }, 400) });
    expect(
      await new AntigravityUsage({
        tokenPath: '/p',
        readFile: read(TOKEN),
        fetch: rejected.fetch,
      }).read(),
    ).toEqual({ ok: false });
    expect(
      await new AntigravityUsage({
        tokenPath: '/p',
        readFile: read(TOKEN),
        fetch: http.fetch,
      }).read(),
    ).toEqual({ ok: false });
  });
});

describe.skipIf(process.platform === 'win32')('AntigravityAccounts 的用量', () => {
  let home: string;
  let adapter: AntigravityAdapter | undefined;
  beforeEach(() => {
    home = tempDir();
  });
  afterEach(async () => {
    await adapter?.dispose();
    adapter = undefined;
    removeDir(home);
  });

  it('已登录时在后台读用量、经 onChange 报；重新检测时等新的用量；读不到时留着上一次的', async () => {
    const bin = path.join(home, 'bin');
    installFakeRuntime(bin);
    const routes: Record<string, () => Response> = {
      ...TOKEN_OK,
      ':retrieveUserQuotaSummary': json(SUMMARY),
    };
    const http = fakeFetch(routes);
    adapter = new AntigravityAdapter({
      home,
      logger: collectingLogger(),
      env: { PATH: process.env.PATH, HOME: home },
      usageFetch: http.fetch,
    });
    const accounts = adapter.accounts;
    await accounts.setExecutablePath('antigravity', path.join(bin, 'agy_acp_server.par'));
    const tokenPath = antigravityTokenPath(path.join(home, 'engines', 'antigravity', 'profile'));
    mkdirSync(path.dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, TOKEN);
    const states: AccountState[] = [];
    accounts.onChange((state) => states.push(state));

    const first = await accounts.read('antigravity');
    expect(first.status).toBe('signed_in');
    await waitFor(() => states.some((state) => state.rateLimits !== undefined), 'usage reported');
    const reported = states.find((state) => state.rateLimits !== undefined);
    expect(reported?.rateLimits?.windows).toHaveLength(4);
    expect((await accounts.read('antigravity')).rateLimits).toEqual(reported?.rateLimits);

    routes[':retrieveUserQuotaSummary'] = json({}, 500);
    const calls = http.calls.length;
    const refreshed = await accounts.read('antigravity', { refresh: true });
    expect(http.calls.length).toBeGreaterThan(calls);
    expect(refreshed.status).toBe('signed_in');
    expect(refreshed.rateLimits).toEqual(reported?.rateLimits);

    await accounts.logout('antigravity');
    expect((await accounts.read('antigravity')).rateLimits).toBeUndefined();
  });
});
