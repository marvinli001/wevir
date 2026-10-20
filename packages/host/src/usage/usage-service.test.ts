import { join } from 'node:path';
import type { UsageRecordedEvent } from '@wevir/runtime-adapter';
import { describe, expect, it, vi } from 'vitest';
import { useStorages, useTempDir } from '../test-utils.js';
import { PricingStore } from './pricing.js';
import { costOf, UsageService } from './usage-service.js';

const API = {
  anthropic: {
    models: {
      'claude-opus-5-5': { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
    },
  },
  openai: { models: { 'gpt-5.5': { cost: { input: 2, output: 10, cache_read: 0.2 } } } },
};

const HOUR = 3_600_000;
const T0 = 1_760_918_400_000;

function event(overrides: Partial<UsageRecordedEvent> = {}): UsageRecordedEvent {
  return {
    type: 'usage.recorded',
    engineSessionId: 'eng_1',
    requestId: 'req_1',
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 10_000,
    cacheWriteTokens: 2_000,
    ...overrides,
  };
}

describe('UsageService', () => {
  const dir = useTempDir();
  const storages = useStorages();

  async function setup(options: { priced?: boolean } = {}) {
    const storage = storages.open(dir());
    for (const [id, kind, displayName] of [
      ['prv_claude', 'claude', 'Claude'],
      ['prv_chatgpt', 'chatgpt', 'ChatGPT'],
    ] as const) {
      storage.providers.insert({
        id,
        kind,
        displayName,
        models: [],
        defaultModelId: 'x',
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
      });
    }
    const pricing = new PricingStore({
      file: join(dir(), 'pricing.json'),
      fetch: async () => new Response(JSON.stringify(API)),
      now: () => T0,
    });
    if (options.priced !== false) await pricing.refresh();
    let now = T0;
    const service = new UsageService({ storage, pricing, now: () => now });
    return { storage, service, pricing, at: (ms: number) => (now = ms) };
  }

  const claude = { sessionId: 'ses_1', providerId: 'prv_claude', modelId: 'claude-opus-5-5' };
  const chatgpt = { sessionId: 'ses_2', providerId: 'prv_chatgpt', modelId: 'gpt-5.5' };

  it('记下请求：来源与显示名取自 Provider，模型缺省用会话的，重复的请求只记一次', async () => {
    const { service } = await setup();
    service.record(claude, event({ durationMs: 4_000, firstTokenMs: 900, reasoningTokens: 100 }));
    service.record(claude, event({ outputTokens: 9_999 }));
    service.record(chatgpt, event({ model: 'gpt-5.5-2026-04-01', durationMs: 7_200_000 }));
    const { records, total } = service.records({ from: 0, to: T0 + 1 });
    expect(total).toBe(2);
    expect(records[1]).toEqual({
      id: expect.any(String),
      at: T0,
      sessionId: 'ses_1',
      requestId: 'req_1',
      source: 'claude',
      providerId: 'prv_claude',
      providerName: 'Claude',
      model: 'claude-opus-5-5',
      tokens: { input: 1_000, output: 500, cacheRead: 10_000, cacheWrite: 2_000, reasoning: 100 },
      cost: costOf(
        { input: 1_000, output: 500, cacheRead: 10_000, cacheWrite: 2_000, reasoning: 100 },
        { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      ),
      price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      priceSource: 'anthropic',
      durationMs: 4_000,
      firstTokenMs: 900,
    });
    // 去掉日期找到 gpt-5.5；耗时超过一小时不记。
    expect(records[0]).toMatchObject({ model: 'gpt-5.5-2026-04-01', priceSource: 'openai' });
    expect(records[0]?.durationMs).toBeUndefined();
  });

  it('成本：单价是每百万 token，没有缓存价时按输入价', () => {
    expect(
      costOf(
        { input: 1e6, output: 2e6, cacheRead: 1e6, cacheWrite: 1e6, reasoning: 0 },
        { input: 2, output: 10 },
      ),
    ).toEqual({ input: 2, output: 20, cacheRead: 2, cacheWrite: 2, total: 26 });
  });

  it('汇总：按客户端的分桶聚合，过滤只影响统计不影响可选项', async () => {
    const { service, at } = await setup();
    at(T0 + 10);
    service.record(
      claude,
      event({ requestId: 'a', outputTokens: 400, durationMs: 2_000, firstTokenMs: 500 }),
    );
    at(T0 + HOUR + 10);
    service.record(claude, event({ requestId: 'b', outputTokens: 100, durationMs: 2_000 }));
    service.record(chatgpt, event({ requestId: 'c', model: 'unknown-model' }));
    at(T0 + 3 * HOUR);
    service.record(chatgpt, event({ requestId: 'late' }));

    const edges = [T0, T0 + HOUR, T0 + 2 * HOUR];
    const all = service.summary(edges, undefined);
    expect(all.totals.requests).toBe(3);
    expect(all.buckets.map((b) => b.requests)).toEqual([1, 2]);
    expect(all.totals.unpriced).toBe(1);
    expect(all.totals.tokens).toEqual({
      input: 3_000,
      output: 1_000,
      cacheRead: 30_000,
      cacheWrite: 6_000,
      reasoning: 0,
    });
    // 输出不到 200 的请求不算速度；首字照算。
    expect(all.totals.timing).toEqual({
      timedRequests: 1,
      outputTokens: 400,
      durationMs: 2_000,
      firstTokenCount: 1,
      firstTokenMs: 500,
    });
    expect(all.byProvider.map((p) => [p.providerName, p.requests])).toEqual([
      ['Claude', 2],
      ['ChatGPT', 1],
    ]);
    expect(all.byModel.map((m) => m.model)).toEqual(['claude-opus-5-5', 'unknown-model']);
    expect(all.options).toEqual({
      sources: ['chatgpt', 'claude'],
      providers: [
        { id: 'prv_chatgpt', name: 'ChatGPT', source: 'chatgpt' },
        { id: 'prv_claude', name: 'Claude', source: 'claude' },
      ],
      models: ['claude-opus-5-5', 'unknown-model'],
    });

    const filtered = service.summary(edges, { sources: ['chatgpt'], models: [] });
    expect(filtered.totals.requests).toBe(1);
    expect(filtered.totals.cost).toBe(0);
    expect(filtered.options.sources).toEqual(['chatgpt', 'claude']);
    expect(service.records({ from: T0, to: T0 + 2 * HOUR, filter: { sources: [] } }).total).toBe(3);
  });

  it('分桶要严格升序且不超过上限', async () => {
    const { service } = await setup();
    expect(() => service.summary([2, 1], undefined)).toThrow(/ascending/);
    expect(() =>
      service.summary(
        Array.from({ length: 402 }, (_, i) => i),
        undefined,
      ),
    ).toThrow(/at most 400/);
  });

  it('没有价格表时都不估价；价格表取到后同样的记录有了成本', async () => {
    const { service, pricing } = await setup({ priced: false });
    service.record(claude, event());
    expect(service.summary([0, T0 + 1], undefined).totals).toMatchObject({ cost: 0, unpriced: 1 });
    await pricing.refresh();
    expect(service.summary([0, T0 + 1], undefined).totals.unpriced).toBe(0);
  });

  it('新记录与价格表变化合并成最多每秒一次 usage.changed', async () => {
    vi.useFakeTimers();
    try {
      const { service } = await setup();
      const listener = vi.fn();
      service.watch(listener);
      service.record(claude, event({ requestId: 'x' }));
      service.record(claude, event({ requestId: 'y' }));
      service.pricingChanged();
      await vi.advanceTimersByTimeAsync(0);
      expect(listener).toHaveBeenCalledTimes(1);
      service.record(claude, event({ requestId: 'x' }));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(listener).toHaveBeenCalledTimes(1);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
