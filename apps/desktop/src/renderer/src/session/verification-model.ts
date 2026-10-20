// 回合后验证（0.65.0，Host 功能 `verification`）的显示逻辑：验收状态、记录与修复链的文案，最近一轮，每个回合下面那一行的检查结果。
// 数据是投影里的 `transcript.verification`（client-sdk 的 projection.ts）。

import type {
  AcceptanceStatus,
  RepairChain,
  SessionVerification,
  TurnId,
  VerificationRun,
  VerificationStatus,
} from '@wevir/protocol';
import type { PlainMessageKey } from '@/i18n';

export const ACCEPTANCE_LABELS: Record<AcceptanceStatus, PlainMessageKey> = {
  unverified: 'verification.acceptance.unverified',
  verifying: 'verification.acceptance.verifying',
  accepted: 'verification.acceptance.accepted',
  failed: 'verification.acceptance.failed',
  environment_unavailable: 'verification.acceptance.environment_unavailable',
};

export const RUN_LABELS: Record<VerificationStatus, PlainMessageKey> = {
  not_run: 'verification.status.not_run',
  running: 'verification.status.running',
  passed: 'verification.status.passed',
  failed: 'verification.status.failed',
  timed_out: 'verification.status.timed_out',
  cancelled: 'verification.status.cancelled',
  environment_unavailable: 'verification.status.environment_unavailable',
  stale: 'verification.status.stale',
};

/** 记录与验收的原因（Host 写的机器可读字符串）；不认识的不显示。 */
const REASON_LABELS: Record<string, PlainMessageKey> = {
  code_changed: 'verification.reason.code_changed',
  no_tests: 'verification.reason.no_tests',
  tests_unconfirmed: 'verification.reason.tests_unconfirmed',
  expect_unmatched: 'verification.reason.expect_unmatched',
  approval_required: 'verification.reason.approval_required',
  changes_unknown: 'verification.reason.changes_unknown',
  dependencies_missing: 'verification.reason.dependencies_missing',
  command_not_found: 'verification.reason.command_not_found',
  cwd_missing: 'verification.reason.cwd_missing',
  spawn_failed: 'verification.reason.spawn_failed',
  turn_started: 'verification.reason.turn_started',
  host_restarted: 'verification.reason.host_restarted',
  host_shutdown: 'verification.reason.host_restarted',
  no_checks: 'verification.reason.no_checks',
};

/** 修复链停下的原因。 */
const STOP_LABELS: Record<string, PlainMessageKey> = {
  limit: 'verification.stop.limit',
  repeated_failure: 'verification.stop.repeated_failure',
  budget: 'verification.stop.budget',
  environment_unavailable: 'verification.stop.environment_unavailable',
  permission_denied: 'verification.stop.permission_denied',
  user_cancelled: 'verification.stop.user_cancelled',
  user_message: 'verification.stop.user_message',
  host_restarted: 'verification.stop.host_restarted',
  not_repairable: 'verification.stop.not_repairable',
  turn_failed: 'verification.stop.turn_failed',
  disabled: 'verification.stop.disabled',
  session_unavailable: 'verification.stop.session_unavailable',
  goal_active: 'verification.stop.goal_active',
  code_changed: 'verification.reason.code_changed',
};

export function reasonLabel(reason: string | undefined): PlainMessageKey | undefined {
  return reason === undefined ? undefined : REASON_LABELS[reason];
}

export function stopLabel(reason: string | undefined): PlainMessageKey | undefined {
  return reason === undefined ? undefined : STOP_LABELS[reason];
}

/** 记录排着队（`running` 但还没开始）。 */
export function isQueued(run: VerificationRun): boolean {
  return run.status === 'running' && run.startedAt === undefined;
}

/** 最近一轮的记录（按出现的顺序）。 */
export function latestRound(verification: SessionVerification | undefined): VerificationRun[] {
  const runs = verification?.runs ?? [];
  const roundId = verification?.acceptance.roundId ?? runs.at(-1)?.roundId;
  if (roundId === undefined) return [];
  return runs.filter((run) => run.roundId === roundId);
}

export type ChecksTone = 'running' | 'passed' | 'failed' | 'environment_unavailable' | 'unverified';

/** 一轮的结果：在跑、全部通过、有失败、环境不可用，其余（过期、没跑、取消）是未验证。 */
export interface ChecksSummary {
  tone: ChecksTone;
  passed: number;
  total: number;
  /** 比较用（TurnView 按它决定要不要重画）。 */
  key: string;
}

export function summarizeRound(runs: readonly VerificationRun[]): ChecksSummary | undefined {
  if (runs.length === 0) return undefined;
  const passed = runs.filter((run) => run.status === 'passed').length;
  const tone: ChecksTone = runs.some((run) => run.status === 'running')
    ? 'running'
    : runs.some((run) => run.status === 'failed' || run.status === 'timed_out')
      ? 'failed'
      : runs.some((run) => run.status === 'environment_unavailable')
        ? 'environment_unavailable'
        : passed === runs.length
          ? 'passed'
          : 'unverified';
  return { tone, passed, total: runs.length, key: `${tone}:${passed}/${runs.length}` };
}

/**
 * 每个回合下面那一行：这个回合触发的最近一轮（回合后自动运行的一轮记在原来的回合上，修复后复验的一轮记在修复回合上）。手动运行的
 * 不记在回合上。
 */
export function turnChecks(
  verification: SessionVerification | undefined,
): ReadonlyMap<TurnId, ChecksSummary> {
  const rounds = new Map<string, { turnId: TurnId; runs: VerificationRun[] }>();
  for (const run of verification?.runs ?? []) {
    if (run.turnId === undefined || run.trigger === 'manual') continue;
    const round = rounds.get(run.roundId);
    if (round) round.runs.push(run);
    else rounds.set(run.roundId, { turnId: run.turnId, runs: [run] });
  }
  const result = new Map<TurnId, ChecksSummary>();
  for (const { turnId, runs } of rounds.values()) {
    const summary = summarizeRound(runs);
    if (summary !== undefined) result.set(turnId, summary);
  }
  return result;
}

export const TURN_CHECK_LABELS: Record<ChecksTone, PlainMessageKey | undefined> = {
  running: 'turn.checks.running',
  passed: undefined,
  failed: undefined,
  environment_unavailable: 'turn.checks.environment_unavailable',
  unverified: 'turn.checks.unverified',
};

/** 这条修复链属于这一轮（链开始的一轮或它复验的一轮），或者还在进行；之后手动运行的一轮不显示旧的链。 */
export function repairForRound(
  repair: RepairChain | undefined,
  roundId: string | undefined,
): RepairChain | undefined {
  if (repair === undefined) return undefined;
  if (repair.status === 'running') return repair;
  return roundId !== undefined && (repair.roundId === roundId || repair.lastRoundId === roundId)
    ? repair
    : undefined;
}

/** 修复链在进行（检查或修复回合还在跑）。 */
export function repairActive(repair: RepairChain | undefined): boolean {
  return repair?.status === 'running';
}

/** 测试计数的“通过 / 总数”（没有计数时 undefined）。 */
export function testCount(run: VerificationRun): { passed: number; total: number } | undefined {
  const { tests } = run;
  if (tests === undefined) return undefined;
  return { passed: tests.passed, total: tests.passed + tests.failed };
}
