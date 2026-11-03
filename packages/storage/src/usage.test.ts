import { describe, expect, it } from 'vitest';
import { seedSession, useTempStorage } from './test-utils.js';
import type { UsageRow } from './usage.js';

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    sessionId: 'ses_01',
    requestId: 'req_1',
    at: 1_000,
    source: 'claude',
    providerId: 'prv_claude',
    providerName: 'Claude',
    model: 'claude-opus-5-5',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 300,
    cacheWriteTokens: 40,
    reasoningTokens: 0,
    ...overrides,
  };
}

describe('usage_records', () => {
  const { storage } = useTempStorage();

  it('插入与按时间段读取；可选列省略时读出来也省略', () => {
    const s = storage();
    expect(s.usage.insert(row())).toBe(true);
    expect(
      s.usage.insert(
        row({
          requestId: 'req_2',
          at: 2_000,
          upstream: 'openai',
          durationMs: 900,
          firstTokenMs: 300,
        }),
      ),
    ).toBe(true);
    const all = s.usage.range(0, 10_000);
    expect(all.map(({ id: _id, ...rest }) => rest)).toEqual([
      row(),
      row({
        requestId: 'req_2',
        at: 2_000,
        upstream: 'openai',
        durationMs: 900,
        firstTokenMs: 300,
      }),
    ]);
    expect(s.usage.range(1_000, 2_000).map((r) => r.requestId)).toEqual(['req_1']);
  });

  it('同一会话的同一请求只记第一次；会话不存在也能记', () => {
    const s = storage();
    expect(s.usage.insert(row())).toBe(true);
    expect(s.usage.insert(row({ outputTokens: 99 }))).toBe(false);
    expect(s.usage.insert(row({ sessionId: 'ses_02' }))).toBe(true);
    expect(s.usage.range(0, 10_000).map((r) => [r.sessionId, r.outputTokens])).toEqual([
      ['ses_01', 20],
      ['ses_02', 20],
    ]);
  });

  it('分页：最新的在前，按条件过滤，total 是总数', () => {
    const s = storage();
    for (let i = 0; i < 5; i += 1) {
      s.usage.insert(
        row({ requestId: `r${i}`, at: 1_000 + i, model: i % 2 === 0 ? 'a' : 'b', source: 'codex' }),
      );
    }
    s.usage.insert(row({ requestId: 'other', at: 1_002, providerId: 'prv_x' }));
    const first = s.usage.page(0, 10_000, {}, 0, 2);
    expect(first.total).toBe(6);
    expect(first.rows.map((r) => r.requestId)).toEqual(['r4', 'r3']);
    const models = s.usage.page(0, 10_000, { models: ['a'] }, 1, 10);
    expect(models.total).toBe(3);
    expect(models.rows.map((r) => r.requestId)).toEqual(['r2', 'r0']);
    expect(s.usage.page(0, 10_000, { providerIds: ['prv_x'] }, 0, 10).total).toBe(1);
    expect(s.usage.page(0, 10_000, { sources: [] }, 0, 10).total).toBe(0);
    expect(s.usage.page(1_001, 1_003, { sources: ['codex'] }, 0, 10).total).toBe(2);
  });

  it('按 Provider 删除记录，别的 Provider 不动', () => {
    const s = storage();
    s.usage.insert(row());
    s.usage.insert(row({ requestId: 'req_2' }));
    s.usage.insert(row({ requestId: 'req_3', providerId: 'prv_other' }));
    expect(s.usage.deleteProvider('prv_claude')).toBe(2);
    expect(s.usage.deleteProvider('prv_claude')).toBe(0);
    expect(s.usage.range(0, 10_000).map((r) => r.providerId)).toEqual(['prv_other']);
  });

  it('会话合计：请求数与输入、缓存写入、输出之和，不含缓存读取', () => {
    const s = storage();
    expect(s.usage.sessionTotals('ses_01')).toEqual({ requests: 0, tokens: 0 });
    s.usage.insert(row());
    s.usage.insert(
      row({ requestId: 'req_2', inputTokens: 5, outputTokens: 5, cacheWriteTokens: 0 }),
    );
    s.usage.insert(row({ sessionId: 'ses_02', requestId: 'req_3' }));
    expect(s.usage.sessionTotals('ses_01')).toEqual({ requests: 2, tokens: 80 });
  });
});

describe('usage.byTurn', () => {
  const { storage } = useTempStorage();
  it('按精度分组，回合外独立，Cursor 的请求数未知，Grok 使用 modelCalls', () => {
    const s = storage();
    seedSession(s);
    for (const [index, type, payload] of [
      [1, 'turn.started', { turnId: 't' }],
      [2, 'context.compacted', { turnId: 't', trigger: 'auto' }],
      [3, 'turn.finished', { turnId: 't', outcome: 'completed' }],
    ] as const)
      s.events.insert({
        sessionId: 'ses_01',
        seq: index,
        ts: '2026-11-04T00:00:00.000Z',
        type,
        source: 'host',
        payload,
      });
    s.usage.insert(row({ requestId: 'exact', turnId: 't', origin: 'gateway', kind: 'agent' }));
    s.usage.insert(row({ requestId: 'engine', turnId: 't' }));
    s.usage.insert(
      row({ requestId: 'missing', turnId: 't', origin: 'gateway', usageReported: false }),
    );
    s.usage.insert(row({ requestId: 'grok', turnId: 'g', granularity: 'turn', modelCalls: 4 }));
    s.usage.insert(row({ requestId: 'cursor', turnId: 'c', source: 'cursor' }));
    s.usage.insert(row({ requestId: 'outside' }));
    const turns = s.usage.byTurn(['ses_01']);
    expect(turns[0]).toMatchObject({
      turnId: 't',
      outcome: 'completed',
      compactions: { auto: 1, manual: 0 },
      groups: [
        { precision: 'exact', requests: 2, tokens: { input: 10 }, missingUsage: 1 },
        { precision: 'engine', requests: 1, tokens: { input: 10 } },
      ],
    });
    expect(turns.find((turn) => turn.turnId === 'g')?.groups[0]?.requests).toBe(4);
    expect(turns.find((turn) => turn.turnId === 'c')?.groups[0]?.requests).toBeUndefined();
    expect(turns.find((turn) => turn.turnId === undefined)?.groups[0]?.records).toHaveLength(1);
    expect(s.usage.byTurn([])).toEqual([]);
  });
});
