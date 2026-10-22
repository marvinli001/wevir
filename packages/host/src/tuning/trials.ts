// 自动调优的试用与总览（0.107.0，`tuning.overview`，domain-model §3.49，ADR-0018）。
//
// 一个项目里状态是 `trial` 的改动是一组试用（同时只有一组；试用中又进来的并进这一组）。起点是这些改动里最早记进 `cause` 的档案版本，
// 起点还没开出来时试用会话数是 0。试用会话是起点及以后版本上合格的会话（metrics.ts）；基线是起点之前版本上最近 `BASELINE_SESSIONS` 个。
// 试用会话凑够 `TUNING_TRIAL_SESSIONS` 个、或者试用满 `TUNING_TRIAL_MAX_DAYS` 天，就按 `judgeTrial` 整组保留或回退。核对发生在这个项目的
// 回合结束时、Host 启动时与 `tuning.overview` 里。
//
// 预算是全局的：本月（Host 本地时区的自然月）`tuning_runs` 里的 token 合计，后台生成的上限只算 `auto` 的。

import {
  AUTO_TUNING_MONTHLY_TOKENS_DEFAULT,
  type HostSettings,
  type MethodParams,
  type MethodResult,
  type ProfileVersionId,
  type ProfileVersionRef,
  TUNING_SERIES_MAX,
  TUNING_TRIAL_MAX_DAYS,
  TUNING_TRIAL_SESSIONS,
  type TuningBudget,
  type TuningMetrics,
  type TuningProposalId,
  type TuningRunSummary,
  type TuningTrial,
  TuningUsageSchema,
  type WorkspaceId,
} from '@wevir/protocol';
import type { ProfileVersionRecord, Storage, TuningProposalRecord } from '@wevir/storage';
import { judgeTrial, type SessionMetrics, sumMetrics } from './metrics.js';
import type { ProposalService } from './proposals.js';

/** 基线最多取几个会话。 */
export const BASELINE_SESSIONS = 20;
/** 一个版本最多看多少个会话。 */
const SESSIONS_PER_VERSION = 200;
/** 找基线时最多往前看几个版本。 */
const BASELINE_VERSIONS_MAX = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrialServiceOptions {
  storage: Pick<Storage, 'profileVersions' | 'tuningProposals' | 'tuningRuns'>;
  metrics: Pick<SessionMetrics, 'eligible'>;
  proposals: Pick<ProposalService, 'trialRecords' | 'conclude' | 'revert'>;
  settings: () => HostSettings;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
}

interface TrialState {
  records: TuningProposalRecord[];
  start?: ProfileVersionRecord;
  startedAt: Date;
  deadline: Date;
  sessions: TuningMetrics[];
}

export class TrialService {
  readonly #options: TrialServiceOptions;
  readonly #now: () => Date;
  /** 正在做决定的项目：同一项目的核对不并发。 */
  readonly #deciding = new Set<string>();

  constructor(options: TrialServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** 这个项目有没有进行中的试用。 */
  hasTrial(workspaceId: string): boolean {
    return this.#options.proposals.trialRecords(workspaceId).length > 0;
  }

  /** 本月的消耗与上限（全局）。 */
  budget(): TuningBudget {
    const now = this.#now();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let usedTokens = 0;
    let autoTokens = 0;
    for (const run of this.#options.storage.tuningRuns.since(monthStart.toISOString())) {
      const usage = TuningUsageSchema.safeParse(run.usage);
      if (!usage.success) continue;
      const tokens = usage.data.inputTokens + usage.data.outputTokens;
      usedTokens += tokens;
      if (run.origin === 'auto') autoTokens += tokens;
    }
    const limitTokens =
      this.#options.settings().autoTuningMonthlyTokens ?? AUTO_TUNING_MONTHLY_TOKENS_DEFAULT;
    return {
      month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      limitTokens,
      usedTokens,
      autoTokens,
      exhausted: autoTokens >= limitTokens,
    };
  }

  /** 有试用的全部项目各核对一次（Host 启动时）。 */
  async evaluateAll(): Promise<void> {
    const workspaces = new Set(
      this.#options.storage.tuningProposals
        .list({ statuses: ['trial'] })
        .map((record) => record.workspaceId),
    );
    for (const workspaceId of workspaces) await this.evaluate(workspaceId);
  }

  /** 核对这个项目的试用：凑够会话或到期就整组保留或回退。 */
  async evaluate(workspaceId: string): Promise<void> {
    if (this.#deciding.has(workspaceId)) return;
    const state = this.#state(workspaceId);
    if (state === undefined) return;
    const enough = state.sessions.length >= TUNING_TRIAL_SESSIONS;
    if (!enough && this.#now() < state.deadline) return;
    this.#deciding.add(workspaceId);
    try {
      const trial = sumMetrics(state.sessions);
      const baseline = sumMetrics(this.#baseline(workspaceId, state.start));
      const verdict = enough ? judgeTrial(baseline, trial) : 'insufficient';
      const evidence = { baseline, trial };
      for (const record of state.records) {
        const id = record.id as TuningProposalId;
        try {
          if (verdict === 'worse') {
            await this.#options.proposals.revert(id, 'auto', { reason: 'worse', ...evidence });
          } else {
            this.#options.proposals.conclude(id, {
              decidedBy: 'auto',
              reason: verdict,
              ...evidence,
            });
          }
        } catch (error) {
          this.#options.onWarning?.('调优试用的结论没能写入', {
            proposalId: id,
            verdict,
            error: (error as Error).message,
          });
        }
      }
    } finally {
      this.#deciding.delete(workspaceId);
    }
  }

  async overview(
    params: MethodParams<'tuning.overview'>,
  ): Promise<MethodResult<'tuning.overview'>> {
    const settings = this.#options.settings();
    const auto = {
      enabled: settings.autoTuning === true,
      decided: settings.autoTuning !== undefined,
    };
    const workspaceId = params.workspaceId;
    if (workspaceId !== undefined) await this.evaluate(workspaceId);
    const state = workspaceId === undefined ? undefined : this.#state(workspaceId);
    const series = this.#series(workspaceId, state);
    if (workspaceId === undefined) return { auto, budget: this.budget(), series };
    const lastRun = this.#lastRun(workspaceId);
    return {
      auto,
      budget: this.budget(),
      ...(state !== undefined && { trial: this.#trialOf(state) }),
      series,
      totals: this.#totals(workspaceId),
      ...(lastRun !== undefined && { lastRun }),
    };
  }

  #state(workspaceId: string): TrialState | undefined {
    const records = this.#options.proposals.trialRecords(workspaceId);
    if (records.length === 0) return undefined;
    const { profileVersions } = this.#options.storage;
    let start: ProfileVersionRecord | undefined;
    for (const record of records) {
      if (record.versionId === undefined) continue;
      const version = profileVersions.get(record.versionId);
      if (version !== undefined && (start === undefined || version.seq < start.seq))
        start = version;
    }
    const startedAt = new Date(
      Math.min(...records.map((r) => Date.parse(r.decidedAt ?? r.createdAt))),
    );
    const deadline = new Date(startedAt.getTime() + TUNING_TRIAL_MAX_DAYS * DAY_MS);
    const sessions: TuningMetrics[] = [];
    if (start !== undefined) {
      for (const version of profileVersions.list(workspaceId)) {
        if (version.seq < start.seq) break;
        sessions.push(...this.#versionSessions(version.id));
      }
    }
    return { records, ...(start !== undefined && { start }), startedAt, deadline, sessions };
  }

  /** 起点之前的版本上最近的合格会话；没有起点时取最新的那些。 */
  #baseline(workspaceId: string, start: ProfileVersionRecord | undefined): TuningMetrics[] {
    const versions = this.#options.storage.profileVersions.list(workspaceId, {
      ...(start !== undefined && { beforeSeq: start.seq }),
      limit: BASELINE_VERSIONS_MAX,
    });
    const sessions: TuningMetrics[] = [];
    for (const version of versions) {
      for (const metrics of this.#versionSessions(version.id)) {
        sessions.push(metrics);
        if (sessions.length >= BASELINE_SESSIONS) return sessions;
      }
    }
    return sessions;
  }

  #versionSessions(versionId: string): TuningMetrics[] {
    const ids = this.#options.storage.profileVersions.sessionIds(versionId, SESSIONS_PER_VERSION);
    return this.#options.metrics.eligible(ids).map((item) => item.metrics);
  }

  #trialOf(state: TrialState): TuningTrial {
    return {
      proposalIds: state.records.map((record) => record.id as TuningProposalId),
      ...(state.start !== undefined && { startVersion: refOf(state.start) }),
      sessions: state.sessions.length,
      needed: TUNING_TRIAL_SESSIONS,
      startedAt: state.startedAt.toISOString(),
      deadline: state.deadline.toISOString(),
    };
  }

  #series(
    workspaceId: WorkspaceId | undefined,
    state: TrialState | undefined,
  ): MethodResult<'tuning.overview'>['series'] {
    const versions = this.#options.storage.profileVersions
      .list(workspaceId, { limit: TUNING_SERIES_MAX })
      .reverse();
    return versions.map((version) => ({
      version: refOf(version),
      createdAt: version.createdAt,
      metrics: sumMetrics(this.#versionSessions(version.id)),
      ...(state?.start !== undefined && version.seq >= state.start.seq && { trial: true as const }),
    }));
  }

  /** 经过试用的改动：试用中的、有结论的、或不是用户点出来的。 */
  #totals(workspaceId: string): { adopted: number; kept: number; reverted: number } {
    let adopted = 0;
    let kept = 0;
    let reverted = 0;
    for (const record of this.#options.storage.tuningProposals.list({
      workspaceId,
      statuses: ['trial', 'accepted', 'reverted'],
    })) {
      if (record.status !== 'trial' && record.outcome === undefined && record.origin === 'user') {
        continue;
      }
      adopted += 1;
      if (record.status === 'accepted') kept += 1;
      if (record.status === 'reverted') reverted += 1;
    }
    return { adopted, kept, reverted };
  }

  #lastRun(workspaceId: string): TuningRunSummary | undefined {
    const run = this.#options.storage.tuningRuns.latest({ workspaceId });
    if (run === undefined) return undefined;
    const usage = TuningUsageSchema.safeParse(run.usage);
    return {
      at: run.createdAt,
      origin: run.origin === 'auto' ? 'auto' : 'user',
      proposals: run.proposals,
      ...(run.reason !== undefined && { reason: run.reason }),
      ...(usage.success && { usage: usage.data }),
    };
  }
}

function refOf(version: ProfileVersionRecord): ProfileVersionRef {
  return {
    id: version.id as ProfileVersionId,
    seq: version.seq,
    fingerprint: version.fingerprint as ProfileVersionRef['fingerprint'],
  };
}
