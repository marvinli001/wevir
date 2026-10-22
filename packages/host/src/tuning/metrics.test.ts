import type { TuningMetrics } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { EMPTY_METRICS, judgeTrial, sumMetrics } from './metrics.js';

/** `turns` 个回合里 `failed` 个失败，验证 `passed/total`（`total` 为 0 时没有运行）。 */
function m(turns: number, failed: number, passed = 0, total = 0): TuningMetrics {
  return {
    sessions: 5,
    turns,
    failedTurns: failed,
    ...(total > 0 && { checks: { passed, total } }),
    guardrailHits: 0,
  };
}

describe('judgeTrial', () => {
  it('通过率低 0.10 以上回退', () => {
    expect(judgeTrial(m(0, 0, 8, 10), m(0, 0, 6, 10))).toBe('worse');
    // 正好低 0.10 不算越过。
    expect(judgeTrial(m(0, 0, 8, 10), m(0, 0, 7, 10))).toBe('no_worse');
  });

  it('失败回合占比高 0.10 以上回退，即使通过率变高', () => {
    expect(judgeTrial(m(20, 2, 5, 10), m(20, 5, 9, 10))).toBe('worse');
    expect(judgeTrial(m(10, 1), m(10, 2))).toBe('no_worse');
  });

  it('通过率高 0.05 以上是 better，否则 no_worse', () => {
    expect(judgeTrial(m(0, 0, 6, 10), m(0, 0, 7, 10))).toBe('better');
    expect(judgeTrial(m(0, 0, 6, 10), m(0, 0, 13, 20))).toBe('no_worse');
  });

  it('只有失败回合可比时 no_worse；只有一边够数时不比', () => {
    expect(judgeTrial(m(10, 0), m(8, 0))).toBe('no_worse');
    // 失败回合：试用只有 4 个回合；通过率：基线只有 2 次运行。
    expect(judgeTrial(m(10, 0, 2, 2), m(4, 4, 0, 5))).toBe('insufficient');
  });

  it('基线为空时数据不足', () => {
    expect(judgeTrial(EMPTY_METRICS, m(30, 20, 0, 10))).toBe('insufficient');
  });
});

describe('sumMetrics', () => {
  it('逐项相加，没有验证运行与 token 的省略', () => {
    expect(sumMetrics([])).toEqual(EMPTY_METRICS);
    expect(
      sumMetrics([
        { sessions: 1, turns: 3, failedTurns: 1, guardrailHits: 2, tokens: 100 },
        {
          sessions: 1,
          turns: 2,
          failedTurns: 0,
          checks: { passed: 1, total: 2 },
          guardrailHits: 0,
        },
      ]),
    ).toEqual({
      sessions: 2,
      turns: 5,
      failedTurns: 1,
      checks: { passed: 1, total: 2 },
      guardrailHits: 2,
      tokens: 100,
    });
  });
});
