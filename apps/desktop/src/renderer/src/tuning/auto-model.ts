// 自动调优（0.108.0，desktop-layout.md §34/§35）的纯逻辑：引导页的上限选项、试用卡的状态、指标块的数字与对比、走势的点、版本时间线
// （版本按 `cause.proposalIds` 配上改动）与改动的来源和结论。

import {
  AUTO_TUNING_MONTHLY_TOKENS_DEFAULT,
  type ProfileVersionSummary,
  type TuningMetrics,
  type TuningOverview,
  type TuningProposal,
} from '@wevir/protocol';
import { type PlainMessageKey, t } from '@/i18n';
import { formatTokens } from '@/layout/rail-model';
import { changesSummary, versionLabel } from './tuning-model';

/** 每月上限的选项（引导页与页头）。 */
export const MONTHLY_LIMITS = [100_000, 200_000, 500_000, 1_000_000] as const;

/** 选择框里的上限：设置里的值不在选项里时也列出它。 */
export function limitOptions(current: number | undefined): { value: string; label: string }[] {
  const values = new Set<number>(MONTHLY_LIMITS);
  values.add(current ?? AUTO_TUNING_MONTHLY_TOKENS_DEFAULT);
  return [...values]
    .sort((a, b) => a - b)
    .map((value) => ({ value: String(value), label: formatTokens(value) }));
}

/** 通过率（0–1）；没有可比的运行时 undefined。 */
export function passRate(metrics: TuningMetrics | undefined): number | undefined {
  const checks = metrics?.checks;
  return checks === undefined || checks.total === 0 ? undefined : checks.passed / checks.total;
}

/** 失败回合占比（0–1）；没有回合时 undefined。 */
export function failedRate(metrics: TuningMetrics | undefined): number | undefined {
  return metrics === undefined || metrics.turns === 0
    ? undefined
    : metrics.failedTurns / metrics.turns;
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** 指标块的对比：当前版本对第一个有数据的版本。`better` 按“越高越好”或“越低越好”判断。 */
export interface MetricDelta {
  value?: string;
  /** 百分点的变化，正负号已带上；没有可比的时 undefined。 */
  delta?: string;
  trend?: 'better' | 'worse' | 'same';
}

export function metricDelta(
  series: TuningOverview['series'],
  rate: (metrics: TuningMetrics) => number | undefined,
  higherIsBetter: boolean,
): MetricDelta {
  const points = series
    .map((point) => rate(point.metrics))
    .filter((value): value is number => value !== undefined);
  const last = points.at(-1);
  if (last === undefined) return {};
  const first = points[0] as number;
  if (points.length < 2) return { value: percent(last) };
  const change = Math.round((last - first) * 100);
  const trend =
    change === 0
      ? 'same'
      : change > 0 === higherIsBetter
        ? ('better' as const)
        : ('worse' as const);
  return {
    value: percent(last),
    delta: change > 0 ? `↑${change}` : change < 0 ? `↓${-change}` : '0',
    trend,
  };
}

/** 走势里的一个点：版本号、通过率（没有时 undefined）、是不是试用中、有没有回退的改动。 */
export interface SeriesPoint {
  seq: number;
  rate?: number;
  trial: boolean;
  reverted: boolean;
}

export function seriesPoints(
  series: TuningOverview['series'],
  versions: readonly ProfileVersionSummary[],
  proposals: readonly TuningProposal[],
): SeriesPoint[] {
  const status = new Map(proposals.map((p) => [p.id as string, p.status]));
  const causes = new Map(versions.map((v) => [v.id as string, v.cause?.proposalIds ?? []]));
  return series.map((point) => {
    const rate = passRate(point.metrics);
    return {
      seq: point.version.seq,
      ...(rate !== undefined && { rate }),
      trial: point.trial === true,
      reverted: (causes.get(point.version.id) ?? []).some((id) => status.get(id) === 'reverted'),
    };
  });
}

/** 走势折线（viewBox 是 `width × height`）：有通过率的点连起来，没有的跳过。 */
export function sparklinePath(points: readonly SeriesPoint[], width: number, height: number) {
  const step = points.length <= 1 ? 0 : width / (points.length - 1);
  const coords = points.map((point, index) => ({
    point,
    x: points.length <= 1 ? width / 2 : index * step,
    y: point.rate === undefined ? undefined : height - point.rate * height,
  }));
  const drawn = coords.filter((c): c is typeof c & { y: number } => c.y !== undefined);
  const path = drawn
    .map((c, index) => `${index === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(' ');
  return { path, coords };
}

/** 试用卡的标题：试用中写版本，没有试用时“已稳定 · vN”。 */
export function trialTitle(overview: TuningOverview, latest: number | undefined): string {
  if (overview.trial !== undefined) {
    const start = overview.trial.startVersion;
    return start === undefined
      ? t('tuning.trial.running')
      : t('tuning.trial.runningVersion', { version: versionLabel(start.seq) });
  }
  return latest === undefined
    ? t('tuning.trial.stable')
    : t('tuning.trial.stableVersion', { version: versionLabel(latest) });
}

/** 试用卡右边的状态：开关关着、本月上限用完。 */
export function autoStatus(overview: TuningOverview): string | undefined {
  if (!overview.auto.enabled) return t('tuning.status.autoOff');
  if (overview.budget.exhausted) return t('tuning.status.exhausted');
  return undefined;
}

const ORIGIN_KEYS: Record<string, PlainMessageKey> = {
  auto: 'tuning.origin.auto',
  user: 'tuning.origin.user',
  agent: 'tuning.origin.agent',
};

export function originName(origin: string | undefined): string {
  return t(ORIGIN_KEYS[origin ?? 'user'] ?? 'tuning.origin.user');
}

/** 时间线上改动的状态标签；旧的待审与拒绝的不显示。 */
export function statusName(status: TuningProposal['status']): string | undefined {
  switch (status) {
    case 'trial':
      return t('tuning.trial.running');
    case 'accepted':
      return t('tuning.status.kept');
    case 'reverted':
      return t('tuning.status.reverted');
    default:
      return undefined;
  }
}

/** 结论一行：“通过率 64% → 76%”；比不了时“数据不足”；目标被改过时“目标已改动”。 */
export function outcomeText(proposal: Pick<TuningProposal, 'outcome'>): string | undefined {
  const outcome = proposal.outcome;
  if (outcome === undefined) return undefined;
  if (outcome.reason === 'conflict') return t('tuning.outcome.conflict');
  const before = passRate(outcome.baseline);
  const after = passRate(outcome.trial);
  if (before !== undefined && after !== undefined) {
    return t('tuning.outcome.passRate', { before: percent(before), after: percent(after) });
  }
  if (outcome.reason === 'manual') return undefined;
  if (outcome.reason === 'worse') {
    const baseFailed = failedRate(outcome.baseline);
    const trialFailed = failedRate(outcome.trial);
    if (baseFailed !== undefined && trialFailed !== undefined) {
      return t('tuning.outcome.failedTurns', {
        before: percent(baseFailed),
        after: percent(trialFailed),
      });
    }
  }
  return t('tuning.outcome.insufficient');
}

/** 能撤销的：试用中与已保留的。 */
export function canUndo(proposal: Pick<TuningProposal, 'status'>): boolean {
  return proposal.status === 'trial' || proposal.status === 'accepted';
}

/** 时间线的一行：版本，与它记下的改动（新的在前的版本列表里按版本排）。 */
export interface TimelineEntry {
  version: ProfileVersionSummary;
  proposals: TuningProposal[];
  /** 没有改动时的灰字：层的变化摘要，第一版写“基线”。 */
  summary: string;
}

export function timeline(
  versions: readonly ProfileVersionSummary[],
  proposals: readonly TuningProposal[],
): TimelineEntry[] {
  const byId = new Map(proposals.map((p) => [p.id as string, p]));
  return versions.map((version, index) => {
    const linked = (version.cause?.proposalIds ?? []).flatMap((id) => {
      const proposal = byId.get(id);
      return proposal === undefined ? [] : [proposal];
    });
    const last = index === versions.length - 1 && version.seq === 1;
    return {
      version,
      proposals: linked,
      summary: last ? t('tuning.version.baseline') : changesSummary(version.changes),
    };
  });
}

/** 还没有版本的试用改动（下一个会话才开版本）：显示在时间线最上面。 */
export function unversionedTrial(proposals: readonly TuningProposal[]): TuningProposal[] {
  return proposals.filter((p) => p.status === 'trial' && p.version === undefined);
}

/** 本月消耗：“38k/200k”。 */
export function budgetText(budget: TuningOverview['budget']): string {
  return `${formatTokens(budget.usedTokens)}/${formatTokens(budget.limitTokens)}`;
}

/** 改动的用量：“1.8k tokens”；没报告时 undefined。 */
export function usageText(proposal: Pick<TuningProposal, 'usage'>): string | undefined {
  const usage = proposal.usage;
  return usage === undefined
    ? undefined
    : t('tuning.proposal.tokens', { count: formatTokens(usage.inputTokens + usage.outputTokens) });
}
