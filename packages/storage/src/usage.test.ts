import { describe, expect, it } from 'vitest';
import { useTempStorage } from './test-utils.js';
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
});
