import type {
  ProfileVersionSummary,
  TuningMetrics,
  TuningOverview,
  TuningProposal,
} from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  autoStatus,
  budgetText,
  canUndo,
  limitOptions,
  metricDelta,
  outcomeText,
  passRate,
  seriesPoints,
  sparklinePath,
  statusName,
  timeline,
  trialTitle,
  unversionedTrial,
} from './auto-model';

const T0 = '2026-10-22T00:00:00.000Z';
const FP = 'f'.repeat(64);

function metrics(passed: number, total: number, turns = 10, failedTurns = 1): TuningMetrics {
  return { sessions: 2, turns, failedTurns, checks: { passed, total }, guardrailHits: 0 };
}

function version(seq: number, proposalIds: string[] = []): ProfileVersionSummary {
  return {
    id: `pfv_${seq}`,
    seq,
    fingerprint: FP,
    createdAt: T0,
    sessions: 1,
    ...(proposalIds.length > 0 && { cause: { proposalIds } }),
  } as ProfileVersionSummary;
}

function proposal(id: string, patch: Partial<TuningProposal> = {}): TuningProposal {
  return {
    id,
    workspaceId: 'ws_1',
    sessionId: 'ses_1',
    kind: 'rule',
    title: 'Build first',
    target: 'AGENTS.md',
    change: { kind: 'rule', path: '/p/AGENTS.md', before: '', after: 'x' },
    evidence: [],
    status: 'trial',
    createdAt: T0,
    ...patch,
  } as TuningProposal;
}

function overview(patch: Partial<TuningOverview> = {}): TuningOverview {
  return {
    auto: { enabled: true, decided: true },
    budget: {
      month: '2026-10',
      limitTokens: 200_000,
      usedTokens: 38_000,
      autoTokens: 30_000,
      exhausted: false,
    },
    series: [],
    ...patch,
  };
}

const point = (seq: number, m: TuningMetrics, trial = false) => ({
  version: { id: `pfv_${seq}` as const, seq, fingerprint: FP },
  createdAt: T0,
  metrics: m,
  ...(trial && { trial: true as const }),
});

describe('auto-model', () => {
  it('上限选项：设置里的值不在选项里也列出，按大小排', () => {
    expect(limitOptions(undefined).map((o) => o.label)).toEqual(['100k', '200k', '500k', '1M']);
    expect(limitOptions(300_000).map((o) => o.value)).toEqual([
      '100000',
      '200000',
      '300000',
      '500000',
      '1000000',
    ]);
  });

  it('指标块：当前版本对第一个有数据的版本，失败回合越低越好', () => {
    expect(passRate(metrics(0, 0))).toBeUndefined();
    const series = [point(1, metrics(6, 10, 10, 3)), point(2, metrics(8, 10, 10, 1))];
    expect(metricDelta(series, passRate, true)).toEqual({
      value: '80%',
      delta: '↑20',
      trend: 'better',
    });
    expect(
      metricDelta(series, (m) => (m.turns === 0 ? undefined : m.failedTurns / m.turns), false),
    ).toEqual({ value: '10%', delta: '↓20', trend: 'better' });
    expect(metricDelta(series.slice(0, 1), passRate, true)).toEqual({ value: '60%' });
    expect(metricDelta([], passRate, true)).toEqual({});
  });

  it('走势：回退过改动的版本与试用中的版本有标记；没有通过率的点不连线', () => {
    const versions = [version(3, ['tpr_b']), version(2, ['tpr_a']), version(1)];
    const proposals = [proposal('tpr_a', { status: 'reverted' }), proposal('tpr_b')];
    const points = seriesPoints(
      [point(1, metrics(5, 10)), point(2, metrics(0, 0)), point(3, metrics(9, 10), true)],
      versions,
      proposals,
    );
    expect(points).toEqual([
      { seq: 1, rate: 0.5, trial: false, reverted: false },
      { seq: 2, trial: false, reverted: true },
      { seq: 3, rate: 0.9, trial: true, reverted: false },
    ]);
    expect(sparklinePath(points, 100, 20).path).toBe('M0.0,10.0 L100.0,2.0');
  });

  it('试用卡：标题与状态', () => {
    expect(trialTitle(overview(), 4)).toBe('已稳定 · v4');
    expect(trialTitle(overview(), undefined)).toBe('已稳定');
    const trial = {
      proposalIds: ['tpr_a'],
      sessions: 2,
      needed: 5,
      startedAt: T0,
      deadline: T0,
    } as NonNullable<TuningOverview['trial']>;
    expect(trialTitle(overview({ trial }), 4)).toBe('试用中');
    expect(
      trialTitle(
        overview({ trial: { ...trial, startVersion: { id: 'pfv_5', seq: 5, fingerprint: FP } } }),
        5,
      ),
    ).toBe('v5 试用中');
    expect(autoStatus(overview())).toBeUndefined();
    expect(autoStatus(overview({ auto: { enabled: false, decided: true } }))).toBe(
      '自动调优已关闭',
    );
    const budget = { ...overview().budget, exhausted: true };
    expect(autoStatus(overview({ budget }))).toBe('本月上限已用完');
    expect(budgetText(overview().budget)).toBe('38k/200k');
  });

  it('改动：状态、结论与能不能撤销', () => {
    expect(statusName('trial')).toBe('试用中');
    expect(statusName('accepted')).toBe('已保留');
    expect(statusName('reverted')).toBe('已回退');
    expect(statusName('rejected')).toBeUndefined();
    const decided = { decidedBy: 'auto', result: 'kept', decidedAt: T0 } as const;
    expect(
      outcomeText({
        outcome: {
          ...decided,
          reason: 'better',
          baseline: metrics(64, 100),
          trial: metrics(76, 100),
        },
      }),
    ).toBe('通过率 64% → 76%');
    expect(
      outcomeText({
        outcome: {
          ...decided,
          result: 'reverted',
          reason: 'worse',
          baseline: { ...metrics(0, 0, 10, 1), checks: undefined },
          trial: { ...metrics(0, 0, 10, 4), checks: undefined },
        },
      }),
    ).toBe('失败回合 10% → 40%');
    expect(outcomeText({ outcome: { ...decided, reason: 'conflict' } })).toBe('目标已改动');
    expect(outcomeText({ outcome: { ...decided, reason: 'insufficient' } })).toBe('数据不足');
    expect(outcomeText({ outcome: { ...decided, decidedBy: 'user', reason: 'manual' } })).toBe(
      undefined,
    );
    expect(outcomeText({})).toBeUndefined();
    expect(canUndo({ status: 'trial' })).toBe(true);
    expect(canUndo({ status: 'accepted' })).toBe(true);
    expect(canUndo({ status: 'reverted' })).toBe(false);
  });

  it('时间线：版本配上记下的改动，第一版写基线；还没有版本的试用改动另列', () => {
    const versions = [version(2, ['tpr_a', 'tpr_gone']), version(1)];
    const a = proposal('tpr_a', { status: 'accepted' });
    const pending = proposal('tpr_b');
    const entries = timeline(versions, [a, pending]);
    expect(entries.map((e) => e.proposals.map((p) => p.id))).toEqual([['tpr_a'], []]);
    expect(entries[1]?.summary).toBe('基线');
    expect(unversionedTrial([a, pending]).map((p) => p.id)).toEqual(['tpr_b']);
  });
});
