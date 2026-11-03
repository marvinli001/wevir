import { describe, expect, it } from 'vitest';
import { type BaselineRun, comparePaired, pairedOrder } from './baseline.js';

function run(
  arm: string,
  pair: number,
  cost: number,
  overrides: Partial<BaselineRun> = {},
): BaselineRun {
  return {
    arm,
    pair,
    order: pair * 2,
    precision: 'exact',
    success: true,
    check: {},
    turns: 1,
    requests: {
      total: 2,
      agent: 1,
      compaction: 0,
      subagent: 0,
      auxiliary: 1,
      unknown: 0,
      capHit: false,
    },
    tokens: { input: 100, output: 1, cacheRead: 10, cacheWrite: 1, reasoning: 0 },
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    cacheHitRate: 0,
    compactions: { manual: 0, auto: 0 },
    supply: {
      toolCountFirst: 1,
      toolBytesFirst: 20,
      toolBytesMean: 20,
      toolBytesChanged: false,
      instructionBytes: 10,
      mcpNoteBytes: 0,
      wevirOutputBytes: 0,
      wevirCalls: 0,
    },
    estimates: { precision: 'estimate', toolTokensAtCacheRead: 20 },
    wallMs: 100,
    ledgerMismatch: [],
    ...overrides,
  };
}

describe('paired baselines', () => {
  it('uses ABBA order, pairing the nth A with the nth B', () => {
    expect(pairedOrder('full', 'core', 3).map(({ arm, pair }) => [arm, pair])).toEqual([
      ['full', 1],
      ['core', 1],
      ['core', 2],
      ['full', 2],
      ['full', 3],
      ['core', 3],
    ]);
  });
  it('requires five reconciled exact pairs, prices, success and request-count constraints', () => {
    const runs = Array.from({ length: 5 }, (_, i) => [run('A', i, 2), run('B', i, 1)]).flat();
    const result = comparePaired(runs, 'A', 'B');
    expect(result).toMatchObject({
      n: 5,
      verdict: 'cheaper',
      costDelta: { mean: -1, ci95: [-1, -1] },
      agentRequestsDelta: { mean: 0 },
    });
    expect(comparePaired(runs.slice(0, 8), 'A', 'B').verdict).toBe('inconclusive');
    expect(
      comparePaired(
        runs.map((r) => ({ ...r, cost: undefined })),
        'A',
        'B',
      ).verdict,
    ).toBe('inconclusive');
    expect(
      comparePaired(
        runs.map((r) => ({ ...r, success: r.arm === 'A' })),
        'A',
        'B',
      ).verdict,
    ).toBe('inconclusive');
    expect(
      comparePaired(
        runs.map((r) => (r.arm === 'B' ? { ...r, requests: { ...r.requests, agent: 3 } } : r)),
        'A',
        'B',
      ).verdict,
    ).toBe('inconclusive');
    expect(
      comparePaired(
        runs.map((r) => ({ ...r, ledgerMismatch: ['missing'] })),
        'A',
        'B',
      ).n,
    ).toBe(0);
    expect(
      comparePaired(
        runs.map((r) => ({ ...r, precision: 'engine' })),
        'A',
        'B',
      ).n,
    ).toBe(0);
  });
  it('identical arms and zero baseline cost remain inconclusive; bootstrap is deterministic', () => {
    const runs = Array.from({ length: 5 }, (_, i) => [run('A', i, 0), run('B', i, 0)]).flat();
    expect(comparePaired(runs, 'A', 'B')).toEqual(comparePaired(runs, 'A', 'B'));
    expect(comparePaired(runs, 'A', 'B')).toMatchObject({
      verdict: 'inconclusive',
      costDelta: { relativeMedian: null },
    });
  });
});
