// 自动调优的会话指标与试用结论（0.108.0，domain-model §3.50，ADR-0018）。
//
// 一个会话的指标现算：回合与护栏命中从事件库（`tuningRuns.sessionCounts`），回合后验证有结果的运行从会话快照，token 从用量记录；按会话的
// `lastSeq` 缓存，会话有新事件就重算。参与比较的是“合格”的会话：顶层（不是子会话、不是支线）、至少完成一个回合。
//
// 结论只看两个信号，两边（基线与试用）分别求和后比：回合后验证的通过率（两边各至少 3 次有结果的运行）低 0.10 以上算变差；失败回合的占比
// （两边各至少 5 个回合）高 0.10 以上算变差。任一变差就回退（`worse`）；否则保留：通过率高 0.05 以上 `better`，有可比的 `no_worse`，都比
// 不了 `insufficient`。

import type { SessionId, TuningMetrics } from '@wevir/protocol';
import type { SessionRecord, Storage } from '@wevir/storage';
import type { EventStore } from '../event-store.js';

/** 通过率至少几次有结果的运行才比。 */
export const MIN_CHECKS = 3;
/** 失败回合占比至少几个回合才比。 */
export const MIN_TURNS = 5;
/** 变差的幅度。 */
export const WORSE_DELTA = 0.1;
/** 通过率高多少算变好。 */
export const BETTER_DELTA = 0.05;

export type TrialVerdict = 'better' | 'no_worse' | 'worse' | 'insufficient';

export const EMPTY_METRICS: TuningMetrics = Object.freeze({
  sessions: 0,
  turns: 0,
  failedTurns: 0,
  guardrailHits: 0,
});

/** 把几个会话的指标加起来（`sessions` 是会话数）。 */
export function sumMetrics(list: readonly TuningMetrics[]): TuningMetrics {
  let checks: { passed: number; total: number } | undefined;
  let tokens: number | undefined;
  const sum = { sessions: 0, turns: 0, failedTurns: 0, guardrailHits: 0 };
  for (const item of list) {
    sum.sessions += item.sessions;
    sum.turns += item.turns;
    sum.failedTurns += item.failedTurns;
    sum.guardrailHits += item.guardrailHits;
    if (item.checks !== undefined) {
      checks = {
        passed: (checks?.passed ?? 0) + item.checks.passed,
        total: (checks?.total ?? 0) + item.checks.total,
      };
    }
    if (item.tokens !== undefined) tokens = (tokens ?? 0) + item.tokens;
  }
  return {
    ...sum,
    ...(checks !== undefined && { checks }),
    ...(tokens !== undefined && { tokens }),
  };
}

function passRate(metrics: TuningMetrics): number | undefined {
  const checks = metrics.checks;
  return checks === undefined || checks.total < MIN_CHECKS
    ? undefined
    : checks.passed / checks.total;
}

function failedRate(metrics: TuningMetrics): number | undefined {
  return metrics.turns < MIN_TURNS ? undefined : metrics.failedTurns / metrics.turns;
}

/** 按 §7.2 的规则比较基线与试用。浮点误差用一个很小的余量吸收（0.1 整的差算到线上，不算越过）。 */
export function judgeTrial(baseline: TuningMetrics, trial: TuningMetrics): TrialVerdict {
  const EPSILON = 1e-9;
  const basePass = passRate(baseline);
  const trialPass = passRate(trial);
  const baseFailed = failedRate(baseline);
  const trialFailed = failedRate(trial);
  const passComparable = basePass !== undefined && trialPass !== undefined;
  const failedComparable = baseFailed !== undefined && trialFailed !== undefined;
  if (passComparable && trialPass < basePass - WORSE_DELTA - EPSILON) return 'worse';
  if (failedComparable && trialFailed > baseFailed + WORSE_DELTA + EPSILON) return 'worse';
  if (passComparable && trialPass > basePass + BETTER_DELTA + EPSILON) return 'better';
  if (passComparable || failedComparable) return 'no_worse';
  return 'insufficient';
}

/** 顶层会话：不是子会话、不是支线。 */
export function isTopLevel(record: Pick<SessionRecord, 'parentSessionId' | 'side'>): boolean {
  return record.parentSessionId === undefined && record.side !== true;
}

export interface SessionMetricsOptions {
  storage: Pick<Storage, 'sessions' | 'tuningRuns'>;
  events: Pick<EventStore, 'snapshot'>;
}

/** 会话的指标，按 `lastSeq` 缓存。 */
export class SessionMetrics {
  readonly #options: SessionMetricsOptions;
  readonly #cache = new Map<string, { lastSeq: number; metrics: TuningMetrics }>();

  constructor(options: SessionMetricsOptions) {
    this.#options = options;
  }

  /** 这些会话里合格的（顶层、至少完成一个回合）各自的指标，次序同输入。 */
  eligible(sessionIds: readonly string[]): { sessionId: string; metrics: TuningMetrics }[] {
    const { storage } = this.#options;
    const records = new Map<string, SessionRecord>();
    const stale: string[] = [];
    for (const id of sessionIds) {
      const record = storage.sessions.get(id);
      if (record === undefined || !isTopLevel(record)) continue;
      records.set(id, record);
      if (this.#cache.get(id)?.lastSeq !== record.lastSeq) stale.push(id);
    }
    if (stale.length > 0) {
      const counts = storage.tuningRuns.sessionCounts(stale);
      for (const id of stale) {
        const record = records.get(id) as SessionRecord;
        const count = counts.get(id);
        const checks = this.#checks(id as SessionId);
        this.#cache.set(id, {
          lastSeq: record.lastSeq,
          metrics: {
            sessions: 1,
            turns: count?.turns ?? 0,
            failedTurns: count?.failedTurns ?? 0,
            ...(checks !== undefined && { checks }),
            guardrailHits: count?.guardrailHits ?? 0,
            ...(count?.tokens !== undefined && { tokens: count.tokens }),
          },
        });
      }
    }
    const result: { sessionId: string; metrics: TuningMetrics }[] = [];
    for (const id of records.keys()) {
      const metrics = this.#cache.get(id)?.metrics;
      if (metrics !== undefined && metrics.turns > 0) result.push({ sessionId: id, metrics });
    }
    return result;
  }

  /** 会话删了之后丢掉缓存。 */
  forget(sessionIds: readonly string[]): void {
    for (const id of sessionIds) this.#cache.delete(id);
  }

  #checks(sessionId: SessionId): { passed: number; total: number } | undefined {
    let passed = 0;
    let total = 0;
    for (const run of this.#options.events.snapshot(sessionId)?.verification?.runs ?? []) {
      if (run.status === 'passed') passed += 1;
      if (run.status === 'passed' || run.status === 'failed' || run.status === 'timed_out') {
        total += 1;
      }
    }
    return total === 0 ? undefined : { passed, total };
  }
}
