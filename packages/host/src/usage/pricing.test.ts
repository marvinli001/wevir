import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useTempDir } from '../test-utils.js';
import {
  compact,
  modelCandidates,
  PRICING_MAX_AGE_MS,
  PricingStore,
  providerForUrl,
} from './pricing.js';

/** models.dev api.json 的一小段（字段同真实数据）。 */
const API = {
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-opus-5-5': { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
      'claude-haiku-4-5-20251001': { cost: { input: 1, output: 5 } },
    },
  },
  openai: {
    id: 'openai',
    models: {
      'gpt-5.5': {
        cost: {
          input: 2,
          output: 10,
          cache_read: 0.2,
          tiers: [
            { input: 4, output: 15, cache_read: 0.4, tier: { type: 'context', size: 272_000 } },
          ],
          context_over_200k: { input: 9, output: 9 },
        },
      },
      'gpt-image-1': { cost: {} },
    },
  },
  deepseek: {
    id: 'deepseek',
    api: 'https://api.deepseek.com',
    models: {
      'deepseek-chat': { cost: { input: 0.28, output: 0.42, cache_read: 0.028 } },
    },
  },
  google: {
    id: 'google',
    models: {
      'gemini-3-pro': {
        cost: { input: 2, output: 12, context_over_200k: { input: 4, output: 18 } },
      },
    },
  },
  'github-copilot': {
    id: 'github-copilot',
    api: 'https://api.githubcopilot.com',
    models: {
      'gpt-5.5': { cost: { input: 0, output: 0 } },
      'free-only': { cost: { input: 0, output: 0 } },
    },
  },
  openrouter: {
    id: 'openrouter',
    api: 'https://openrouter.ai/api/v1',
    models: { 'anthropic/claude-opus-5-5': { cost: { input: 5.5, output: 27 } } },
  },
  zai: {
    id: 'zai',
    api: 'https://api.z.ai/api/paas/v4',
    models: { 'glm-5': { cost: { input: 1, output: 3 } } },
  },
  'zai-coding-plan': {
    id: 'zai-coding-plan',
    api: 'https://api.z.ai/api/coding/paas/v4',
    models: { 'glm-5': { cost: { input: 0, output: 0 } } },
  },
};

const T0 = 1_760_918_400_000;

function respond(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', etag: '"v1"', ...init.headers },
  });
}

describe('PricingStore', () => {
  const dir = useTempDir();

  async function loaded(now = T0) {
    const fetch = vi.fn(async () => respond(API));
    const store = new PricingStore({ file: join(dir(), 'pricing.json'), fetch, now: () => now });
    await store.refresh();
    return { store, fetch };
  }

  it('取到后存进数据目录，状态里有取到的时间与模型数', async () => {
    const onChange = vi.fn();
    const store = new PricingStore({
      file: join(dir(), 'pricing.json'),
      fetch: async () => respond(API),
      now: () => T0,
      onChange,
    });
    expect(store.status()).toEqual({ source: 'models.dev', models: 0, refreshing: false });
    await store.refresh();
    expect(onChange).toHaveBeenCalledTimes(1);
    // gpt-5.5 在两家里，按模型 ID 去重；gpt-image-1 没有价格不收。
    expect(store.status()).toEqual({
      source: 'models.dev',
      fetchedAt: T0,
      models: 8,
      refreshing: false,
    });
    const saved = JSON.parse(readFileSync(join(dir(), 'pricing.json'), 'utf8'));
    expect(saved.etag).toBe('"v1"');
    expect(saved.providers.openai.models['gpt-image-1']).toBeUndefined();

    const reopened = new PricingStore({ file: join(dir(), 'pricing.json'), fetch: vi.fn() });
    await reopened.load();
    expect(reopened.status().fetchedAt).toBe(T0);
  });

  it('按来源找：Claude 找 anthropic，日期后缀与 [1m] 后缀去掉再找', async () => {
    const { store } = await loaded();
    expect(store.lookup('claude-opus-5-5[1m]', { source: 'claude' }, 10)).toEqual({
      provider: 'anthropic',
      price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    });
    expect(store.lookup('claude-haiku-4-5-20251001', { source: 'claude' }, 10)?.price).toEqual({
      input: 1,
      output: 5,
    });
    expect(store.lookup('claude-haiku-4-5', { source: 'claude' }, 10)).toBeUndefined();
    expect(store.lookup('anthropic/claude-opus-5-5', { source: 'cursor' }, 10)?.provider).toBe(
      'anthropic',
    );
  });

  it('输入超过某一档时用那一档的价格；有 tiers 时不看 context_over_200k', async () => {
    const { store } = await loaded();
    const hints = { source: 'chatgpt' };
    expect(store.lookup('gpt-5.5', hints, 272_000)?.price).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
    });
    expect(store.lookup('gpt-5.5', hints, 272_001)?.price).toEqual({
      input: 4,
      output: 15,
      cacheRead: 0.4,
    });
    expect(store.lookup('gemini-3-pro', { source: 'antigravity' }, 200_001)?.price).toEqual({
      input: 4,
      output: 18,
    });
    expect(store.lookup('gemini-3-pro-high', { source: 'antigravity' }, 1)?.price).toEqual(
      store.lookup('gemini-3-pro', { source: 'antigravity' }, 1)?.price,
    );
  });

  it('自填的 Provider 按地址认；路径最长的那家优先', async () => {
    const { store } = await loaded();
    expect(
      store.lookup(
        'deepseek-chat',
        { source: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1' },
        1,
      )?.provider,
    ).toBe('deepseek');
    // coding plan 的价格全是 0：在认出的那家里找到也继续找别家的，找不到才用 0。
    expect(
      store.lookup(
        'glm-5',
        { source: 'openai-compatible', baseURL: 'https://api.z.ai/api/coding/paas/v4' },
        1,
      ),
    ).toEqual({ provider: 'zai', price: { input: 1, output: 3 } });
    expect(
      store.lookup(
        'anthropic/claude-opus-5-5',
        { source: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1' },
        1,
      )?.provider,
    ).toBe('openrouter');
  });

  it('OpenCode 按上游找；上游的价格是 0 时改用一手厂商的', async () => {
    const { store } = await loaded();
    expect(
      store.lookup('gpt-5.5', { source: 'opencode', upstream: 'github-copilot' }, 1)?.provider,
    ).toBe('openai');
    expect(
      store.lookup('free-only', { source: 'opencode', upstream: 'github-copilot' }, 1),
    ).toEqual({
      provider: 'github-copilot',
      price: { input: 0, output: 0 },
    });
  });

  it('不到一天不刷新；过了一天带 ETag 再取，304 只更新时间', async () => {
    let now = T0;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
      new Headers(init?.headers).get('if-none-match') === '"v1"'
        ? new Response(null, { status: 304 })
        : respond(API),
    );
    const store = new PricingStore({ file: join(dir(), 'pricing.json'), fetch, now: () => now });
    await store.start();
    await vi.waitFor(() => expect(store.status().fetchedAt).toBe(T0));
    store.stop();
    expect(fetch).toHaveBeenCalledTimes(1);

    const again = new PricingStore({ file: join(dir(), 'pricing.json'), fetch, now: () => now });
    await again.start();
    again.stop();
    expect(fetch).toHaveBeenCalledTimes(1);

    now = T0 + PRICING_MAX_AGE_MS;
    const later = new PricingStore({ file: join(dir(), 'pricing.json'), fetch, now: () => now });
    await later.start();
    later.stop();
    await vi.waitFor(() => expect(later.status().fetchedAt).toBe(now));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(later.lookup('deepseek-chat', { source: 'deepseek-official' }, 1)?.provider).toBe(
      'deepseek',
    );
  });

  it('取不到时沿用旧表并记下原因，下次成功后清掉', async () => {
    const { store } = await loaded();
    const failing = new PricingStore({
      file: join(dir(), 'pricing.json'),
      fetch: async () => new Response('busy', { status: 503 }),
    });
    await failing.load();
    await failing.refresh();
    expect(failing.status()).toMatchObject({ fetchedAt: T0, lastError: 'HTTP 503', models: 8 });
    expect(failing.lookup('deepseek-chat', { source: 'deepseek-official' }, 1)).toBeDefined();
    await store.refresh();
    expect(store.status().lastError).toBeUndefined();
  });
});

describe('价格表的辅助函数', () => {
  it('modelCandidates：从精确到宽松', () => {
    expect(modelCandidates('anthropic/claude-haiku-4-5-20251001')).toEqual([
      'anthropic/claude-haiku-4-5-20251001',
      'claude-haiku-4-5-20251001',
      'claude-haiku-4-5',
    ]);
    expect(modelCandidates('gpt-5.5')).toEqual(['gpt-5.5']);
    expect(modelCandidates('gemini-3-pro-2026-01-15')).toEqual([
      'gemini-3-pro-2026-01-15',
      'gemini-3-pro',
    ]);
    // Antigravity 的思考档位。
    expect(modelCandidates('gemini-3.8-flash-high')).toEqual([
      'gemini-3.8-flash-high',
      'gemini-3.8-flash',
    ]);
    expect(modelCandidates('claude-opus-4-6-thinking')).toEqual([
      'claude-opus-4-6-thinking',
      'claude-opus-4-6',
    ]);
  });

  it('providerForUrl：主机名相同、路径前缀最长；不认识的一手厂商按主机名', () => {
    const table = compact(API, T0);
    expect(providerForUrl('https://api.z.ai/api/coding/paas/v4/', table)).toBe('zai-coding-plan');
    expect(providerForUrl('https://api.z.ai/api/paas/v4', table)).toBe('zai');
    expect(providerForUrl('https://api.openai.com/v1', table)).toBe('openai');
    expect(providerForUrl('http://localhost:8080/v1', table)).toBeUndefined();
    expect(providerForUrl('not a url', table)).toBeUndefined();
  });
});
