import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CursorAccounts } from './accounts.js';
import { CursorCredentialFile, cursorCredentialsPath } from './credentials.js';
import { FakeCursorSdk } from './test-fixtures/fake-sdk.js';
import { cursorUsageRateLimits, readCursorUsage } from './usage.js';

// GetCurrentPeriodUsage 的 JSON 照 @cursor/sdk 1.0.35 里的 proto 字段（Connect 的 JSON：小驼峰，int64 是字符串）；没有真实
// 账号的录制，百分比是编的。
const USAGE = {
  billingCycleStart: '1791100800000',
  billingCycleEnd: '1793779200000',
  planUsage: { totalPercentUsed: 41.5, autoPercentUsed: 12, apiPercentUsed: 71 },
  enabled: true,
};
const RESETS_AT = new Date(1793779200000).toISOString();
/** 2026-10-04 到 2026-11-04（UTC）：31 天。 */
const CYCLE_MINUTES = 31 * 24 * 60;

interface Call {
  url: string;
  authorization: string | null;
  headers: Headers;
}

function fakeFetch(responses: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get('authorization'), headers });
    const path = new URL(url).pathname;
    const respond = responses[path];
    if (respond === undefined) return new Response('not found', { status: 404 });
    return respond();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const OK = {
  '/auth/exchange_user_api_key': json({ accessToken: 'access-token' }),
  '/aiserver.v1.DashboardService/GetCurrentPeriodUsage': json(USAGE),
};

describe('cursorUsageRateLimits', () => {
  it('两份额度是两个按月的窗口，带额度名，重置时间是计费周期的结束、长度是周期的分钟数；两份都有时不报总的', () => {
    expect(cursorUsageRateLimits(USAGE)).toEqual([
      {
        usedPercent: 12,
        period: 'monthly',
        windowMinutes: CYCLE_MINUTES,
        resetsAt: RESETS_AT,
        scope: 'Auto + Composer',
      },
      {
        usedPercent: 71,
        period: 'monthly',
        windowMinutes: CYCLE_MINUTES,
        resetsAt: RESETS_AT,
        scope: 'API',
      },
    ]);
  });

  it('统一额度（总的与 Auto + Composer 相同）只留 Auto + Composer；只有总的与一份不同的额度时都留着', () => {
    const windows = (planUsage: Record<string, number>) =>
      cursorUsageRateLimits({ planUsage }).map((window) => [window.scope, window.usedPercent]);
    expect(windows({ totalPercentUsed: 1.77, autoPercentUsed: 1.77 })).toEqual([
      ['Auto + Composer', 1.77],
    ]);
    expect(windows({ totalPercentUsed: 20, autoPercentUsed: 10 })).toEqual([
      [undefined, 20],
      ['Auto + Composer', 10],
    ]);
    expect(windows({ totalPercentUsed: 100, apiPercentUsed: 100 })).toEqual([
      [undefined, 100],
      ['API', 100],
    ]);
    expect(windows({ totalPercentUsed: 40 })).toEqual([[undefined, 40]]);
  });

  it('周期开始缺失、无效或不在结束之前时不报周期长度', () => {
    for (const billingCycleStart of [
      undefined,
      '',
      '0',
      'not-a-number',
      '1793779200000',
      '1799999999999',
    ]) {
      expect(
        cursorUsageRateLimits({
          billingCycleStart,
          billingCycleEnd: '1793779200000',
          planUsage: { totalPercentUsed: 40 },
        }),
      ).toEqual([{ usedPercent: 40, period: 'monthly', resetsAt: RESETS_AT }]);
    }
    expect(
      cursorUsageRateLimits({
        billingCycleStart: 1_791_100_800_000,
        planUsage: { totalPercentUsed: 40 },
      }),
    ).toEqual([{ usedPercent: 40, period: 'monthly' }]);
  });

  it('缺的百分比跳过；没有周期结束时不报重置时间；没有套餐用量时是空的', () => {
    expect(
      cursorUsageRateLimits({ planUsage: { autoPercentUsed: 3, apiPercentUsed: 'x' } }),
    ).toEqual([{ usedPercent: 3, period: 'monthly', scope: 'Auto + Composer' }]);
    expect(cursorUsageRateLimits({ billingCycleEnd: '0', planUsage: {} })).toEqual([]);
    expect(cursorUsageRateLimits({})).toEqual([]);
    expect(cursorUsageRateLimits(null)).toEqual([]);
  });
});

describe('readCursorUsage', () => {
  it('先用 API Key 换 accessToken，再用它读用量（Connect 协议的头）', async () => {
    const { fetch, calls } = fakeFetch(OK);
    const limits = await readCursorUsage({
      apiKey: 'key_1',
      backendUrl: 'https://api2.cursor.sh/',
      fetch,
    });
    expect(calls.map((call) => [call.url, call.authorization])).toEqual([
      ['https://api2.cursor.sh/auth/exchange_user_api_key', 'Bearer key_1'],
      [
        'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
        'Bearer access-token',
      ],
    ]);
    expect(calls[1]?.headers.get('connect-protocol-version')).toBe('1');
    expect(limits?.windows).toHaveLength(2);
    expect(limits?.primary).toEqual({
      usedPercent: 12,
      period: 'monthly',
      windowMinutes: CYCLE_MINUTES,
      resetsAt: RESETS_AT,
      scope: 'Auto + Composer',
    });
    expect(limits?.secondary?.scope).toBe('API');
  });

  it('换令牌或读用量失败时抛错，消息里没有 Key 与令牌；没有套餐用量时 undefined', async () => {
    const rejected = fakeFetch({ '/auth/exchange_user_api_key': json({ error: 'bad' }, 401) });
    await expect(
      readCursorUsage({ apiKey: 'key_1', backendUrl: 'https://b', fetch: rejected.fetch }),
    ).rejects.toThrow('HTTP 401');
    const noToken = fakeFetch({ '/auth/exchange_user_api_key': json({}) });
    await expect(
      readCursorUsage({ apiKey: 'key_1', backendUrl: 'https://b', fetch: noToken.fetch }),
    ).rejects.toThrow('no access token');
    const failed = fakeFetch({
      ...OK,
      '/aiserver.v1.DashboardService/GetCurrentPeriodUsage': json({}, 500),
    });
    const error = await readCursorUsage({
      apiKey: 'key_1',
      backendUrl: 'https://b',
      fetch: failed.fetch,
    }).catch((reason: Error) => reason);
    expect(String(error)).toContain('HTTP 500');
    expect(String(error)).not.toContain('access-token');
    const none = fakeFetch({
      ...OK,
      '/aiserver.v1.DashboardService/GetCurrentPeriodUsage': json({ enabled: false }),
    });
    expect(
      await readCursorUsage({ apiKey: 'key_1', backendUrl: 'https://b', fetch: none.fetch }),
    ).toBeUndefined();
  });
});

describe('CursorAccounts 的用量', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function setup(
    responses: Record<string, () => Response>,
    env: NodeJS.ProcessEnv = {},
    backendUrl = 'https://api2.cursor.sh',
  ) {
    const home = mkdtempSync(join(tmpdir(), 'wevir-cursor-usage-'));
    dirs.push(home);
    let now = 0;
    const fake = fakeFetch(responses);
    const accounts = new CursorAccounts({
      sdk: async () => new FakeCursorSdk(),
      credentialsPath: cursorCredentialsPath(home),
      env,
      fetch: fake.fetch,
      now: () => now,
    });
    const store = new CursorCredentialFile(cursorCredentialsPath(home));
    await store.save({ version: 1, backendUrl, apiKey: 'good', createdAtMs: 0 });
    return { accounts, store, fake, responses, advance: (ms: number) => (now += ms) };
  }

  it('已登录时带上用量；登录存下的 Key 用铸它的后端，CURSOR_API_KEY 用 CURSOR_BACKEND_URL', async () => {
    const { accounts, fake } = await setup(OK, {}, 'https://minted.example');
    const state = await accounts.read('cursor');
    expect(state).toMatchObject({ status: 'signed_in', email: 'me@example.com' });
    expect(state.rateLimits?.windows?.map((window) => window.usedPercent)).toEqual([12, 71]);
    expect(fake.calls[0]?.url).toBe('https://minted.example/auth/exchange_user_api_key');

    const env = await setup(OK, {
      CURSOR_API_KEY: 'env_key',
      CURSOR_BACKEND_URL: 'https://staging.example',
    });
    await env.accounts.read('cursor');
    expect(env.fake.calls[0]).toMatchObject({
      url: 'https://staging.example/auth/exchange_user_api_key',
      authorization: 'Bearer env_key',
    });
  });

  it('读不到用量时留着上一次的；换了 Key 后不沿用', async () => {
    const responses: Record<string, () => Response> = { ...OK };
    const { accounts, store, advance } = await setup(responses);
    const first = await accounts.read('cursor');
    expect(first.rateLimits).toBeDefined();
    responses['/aiserver.v1.DashboardService/GetCurrentPeriodUsage'] = json({}, 503);
    advance(10 * 60_000);
    expect((await accounts.read('cursor')).rateLimits).toEqual(first.rateLimits);
    await store.save({ version: 1, backendUrl: 'x', apiKey: 'other', createdAtMs: 0 });
    const other = await accounts.read('cursor', { refresh: true });
    expect(other.status).toBe('signed_in');
    expect(other.rateLimits).toBeUndefined();
  });
});
