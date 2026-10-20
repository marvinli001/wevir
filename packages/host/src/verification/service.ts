// 回合后验证（0.65.0，Host 功能 `verification`，ADR-0008）。
//
// - **检查配置**存在 Host（ChecksStore），仓库里的命令只是候选；用户保存才算认可，脚本正文变了要重新认可。
// - **验证记录**是会话事件流里的 `verification.updated`，与回合分开；一次触发是一轮（`roundId`），一轮里的检查按顺序跑，每个工作区
//   同时最多 `VERIFICATION_MAX_CONCURRENT` 个。每条记录绑定开始时的代码状态，结束时代码状态变了就是 `stale`。
// - **验收状态**（`acceptance.changed`）按最近一轮算，与引擎的回合状态分开；`verification.status` 发现代码变了就回到 `unverified`。
//
// 事件直接追加到事件库（不经 SessionManager 的状态机，这些事件不改会话状态）。

import { join } from 'node:path';
import type {
  CheckCandidate,
  CheckDefinition,
  CheckId,
  CheckInput,
  CodeState,
  RepairSettings,
  SessionAcceptance,
  SessionId,
  SessionSnapshot,
  SessionVerification,
  TurnId,
  VerificationRoundId,
  VerificationRun,
  VerificationRunId,
  VerificationTrigger,
  WorkspaceId,
} from '@wevir/protocol';
import type { SessionRecord, Storage } from '@wevir/storage';
import { HostError } from '../errors.js';
import type { AppendInput, EventStore } from '../event-store.js';
import { newId } from '../ids.js';
import { findCandidates, readScript, scriptHash } from './candidates.js';
import { type ChecksStore, normalizeRelative, type WorkspaceChecks } from './checks-store.js';
import { readCodeState, sameCodeState } from './code-state.js';
import { errorFingerprint, judgeOutcome, summarize, validExpectOutput } from './outcome.js';
import { type CheckRunner, environmentPrecheck } from './runner.js';

/** 每个工作区同时最多跑几个检查。 */
export const VERIFICATION_MAX_CONCURRENT = 2;
/** 一轮记录 → 验收状态。 */
export function acceptanceOf(
  runs: readonly VerificationRun[],
  base: { roundId: VerificationRoundId; turnId?: TurnId; at: string },
): SessionAcceptance {
  const common = {
    roundId: base.roundId,
    ...(base.turnId !== undefined && { turnId: base.turnId }),
    updatedAt: base.at,
  };
  if (runs.some((run) => run.status === 'running')) return { status: 'verifying', ...common };
  if (runs.some((run) => run.status === 'failed' || run.status === 'timed_out')) {
    return { status: 'failed', ...common, ...codeStateOf(runs) };
  }
  if (runs.some((run) => run.status === 'environment_unavailable')) {
    return { status: 'environment_unavailable', ...common, ...codeStateOf(runs) };
  }
  const blocking = runs.find((run) => run.status !== 'passed');
  if (blocking !== undefined || runs.length === 0) {
    return {
      status: 'unverified',
      reason: blocking?.reason ?? blocking?.status ?? 'no_checks',
      ...common,
    };
  }
  // 全部通过：各检查开始时的代码状态要是同一个（中途变了的已经记成 stale，这里再确认一次）。
  const states = runs.map((run) => run.codeState);
  const first = states[0];
  if (states.some((state) => sameCodeState(state, first) === false)) {
    return { status: 'unverified', reason: 'code_changed', ...common };
  }
  return { status: 'accepted', ...common, ...codeStateOf(runs) };
}

function codeStateOf(runs: readonly VerificationRun[]): { codeState?: CodeState } {
  const state = runs.find((run) => run.codeState !== undefined)?.codeState;
  return state === undefined ? {} : { codeState: state };
}

const isoNow = () => new Date().toISOString();

interface Round {
  readonly id: VerificationRoundId;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly trigger: VerificationTrigger;
  readonly turnId?: TurnId;
  /** 会话目录（检查的 cwd 相对它）。 */
  readonly root: string;
  readonly checks: ReadonlyMap<VerificationRunId, CheckDefinition>;
  runs: VerificationRun[];
  readonly abort: AbortController;
  cancelReason?: string;
}

export interface VerificationServiceOptions {
  storage: Storage;
  events: EventStore;
  checks: ChecksStore;
  runner: CheckRunner;
  maxConcurrent?: number;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  onError?: (error: unknown) => void;
}

export class VerificationService {
  readonly #storage: Storage;
  readonly #events: EventStore;
  readonly #checks: ChecksStore;
  readonly #runner: CheckRunner;
  readonly #maxConcurrent: number;
  readonly #onWarning: (message: string, fields?: Record<string, unknown>) => void;
  readonly #onError: (error: unknown) => void;
  readonly #rounds = new Map<VerificationRoundId, Round>();
  /** 每个工作区正在跑的检查数与排队等的。 */
  readonly #slots = new Map<WorkspaceId, { running: number; waiting: Array<() => void> }>();
  #disposed = false;

  constructor(options: VerificationServiceOptions) {
    this.#storage = options.storage;
    this.#events = options.events;
    this.#checks = options.checks;
    this.#runner = options.runner;
    this.#maxConcurrent = options.maxConcurrent ?? VERIFICATION_MAX_CONCURRENT;
    this.#onWarning = options.onWarning ?? (() => {});
    this.#onError =
      options.onError ?? ((error) => console.error('[wevir-host] verification:', error));
  }

  // ── 检查配置 ─────────────────────────────────────────────────

  async listChecks(workspaceId: WorkspaceId): Promise<WorkspaceChecks> {
    this.#workspace(workspaceId);
    return this.#checks.list(workspaceId);
  }

  async candidates(workspaceId: WorkspaceId): Promise<CheckCandidate[]> {
    return findCandidates(this.#workspace(workspaceId).rootPath);
  }

  async saveCheck(workspaceId: WorkspaceId, input: CheckInput): Promise<CheckDefinition> {
    const workspace = this.#workspace(workspaceId);
    if (input.expectOutput !== undefined && !validExpectOutput(input.expectOutput)) {
      throw new HostError('INVALID_PARAMS', 'expectOutput is not a valid regular expression', {
        issues: [{ path: ['check', 'expectOutput'], message: 'invalid regular expression' }],
      });
    }
    let hash: string | undefined;
    if (input.source?.kind === 'package_script') {
      const file = normalizeRelative(input.source.file);
      const body =
        file === undefined || file === ''
          ? undefined
          : await readScript(workspace.rootPath, file, input.source.script);
      if (body !== undefined) hash = scriptHash(body);
    }
    return this.#checks.save(workspaceId, input, hash === undefined ? {} : { scriptHash: hash });
  }

  async removeCheck(workspaceId: WorkspaceId, checkId: CheckId): Promise<boolean> {
    this.#workspace(workspaceId);
    return this.#checks.remove(workspaceId, checkId);
  }

  async setRepair(
    workspaceId: WorkspaceId,
    patch: Partial<RepairSettings>,
  ): Promise<RepairSettings> {
    this.#workspace(workspaceId);
    return this.#checks.setRepair(workspaceId, patch);
  }

  #workspace(workspaceId: WorkspaceId) {
    const workspace = this.#storage.workspaces.get(workspaceId);
    if (!workspace || workspace.removedAt !== undefined) {
      throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
    }
    return workspace;
  }

  // ── 运行 ─────────────────────────────────────────────────────

  /** `verification.run`：会话空闲时手动运行（省略 `checkIds` 是全部检查，不看适用条件）。 */
  async run(
    sessionId: SessionId,
    checkIds?: readonly CheckId[],
  ): Promise<{ roundId: VerificationRoundId; runs: VerificationRun[] }> {
    const { record, snapshot } = this.#session(sessionId);
    const { state } = snapshot.session;
    if (state !== 'idle') {
      throw new HostError('SESSION_BUSY', 'wait for the turn to finish before running checks', {
        state,
        ...(snapshot.session.activeTurn !== undefined && {
          activeTurn: snapshot.session.activeTurn,
        }),
      });
    }
    if (this.#activeRounds(sessionId).length > 0) {
      throw new HostError('SESSION_BUSY', 'checks are already running in this session', { state });
    }
    const { checks } = await this.#checks.list(record.workspaceId as WorkspaceId);
    let chosen = checks;
    if (checkIds !== undefined) {
      const unknown = checkIds.find((id) => !checks.some((check) => check.id === id));
      if (unknown !== undefined) {
        throw new HostError('INVALID_PARAMS', `check ${unknown} not found`, {
          issues: [{ path: ['checkIds'], message: `check ${unknown} not found` }],
        });
      }
      chosen = checks.filter((check) => checkIds.includes(check.id));
    }
    if (chosen.length === 0) {
      throw new HostError('INVALID_PARAMS', 'this project has no checks', {
        issues: [{ path: ['sessionId'], message: 'no checks configured' }],
      });
    }
    const round = this.#startRound(record, { trigger: 'manual' }, chosen);
    return { roundId: round.id, runs: [...round.runs] };
  }

  /** `verification.cancel`：取消会话里还在跑或排着的检查。 */
  cancel(sessionId: SessionId): { cancelled: number } {
    this.#session(sessionId);
    return { cancelled: this.#cancelRounds(sessionId, 'user') };
  }

  /** `verification.status`：重算此刻的代码状态；与验收那一轮的不同时，验收回到 `unverified`（`code_changed`）。 */
  async status(
    sessionId: SessionId,
  ): Promise<{ verification: SessionVerification; codeState: CodeState }> {
    const { record } = this.#session(sessionId);
    const codeState = await readCodeState(record.cwd);
    this.#invalidateIfChanged(sessionId, codeState);
    const snapshot = this.#events.snapshot(sessionId);
    return {
      verification: snapshot?.verification ?? {
        acceptance: { status: 'unverified', updatedAt: isoNow() },
        runs: [],
      },
      codeState,
    };
  }

  /** `verification.output`。 */
  async output(sessionId: SessionId, runId: VerificationRunId, offset?: number) {
    const { snapshot } = this.#session(sessionId);
    const known =
      snapshot.verification?.runs.some((run) => run.id === runId) === true ||
      [...this.#rounds.values()].some((round) => round.runs.some((run) => run.id === runId));
    const result = await this.#runner.read(sessionId, runId, offset);
    if (!known && result.bytes === 0) {
      throw new HostError('INVALID_PARAMS', `verification run ${runId} not found`, {
        issues: [{ path: ['runId'], message: 'not found' }],
      });
    }
    return result;
  }

  #session(sessionId: SessionId): { record: SessionRecord; snapshot: SessionSnapshot } {
    const record = this.#storage.sessions.get(sessionId);
    const workspace = record && this.#storage.workspaces.get(record.workspaceId);
    const snapshot = record && this.#events.snapshot(sessionId);
    if (!record || !workspace || workspace.removedAt !== undefined || !snapshot) {
      throw new HostError('SESSION_NOT_FOUND', `session ${sessionId} not found`);
    }
    if (record.parentSessionId !== undefined) {
      throw new HostError('INVALID_STATE', 'a sub-agent session has no checks of its own', {
        state: snapshot.session.state,
        parentSessionId: record.parentSessionId as SessionId,
      });
    }
    return { record, snapshot };
  }

  #activeRounds(sessionId: SessionId): Round[] {
    return [...this.#rounds.values()].filter((round) => round.sessionId === sessionId);
  }

  // ── 一轮检查 ─────────────────────────────────────────────────

  #startRound(
    record: SessionRecord,
    meta: { trigger: VerificationTrigger; turnId?: TurnId },
    checks: readonly CheckDefinition[],
    notRun: ReadonlyArray<{ check: CheckDefinition; reason: string }> = [],
  ): Round {
    const sessionId = record.id as SessionId;
    const id = newId('vrd');
    const now = isoNow();
    const definitions = new Map<VerificationRunId, CheckDefinition>();
    const base = (check: CheckDefinition): VerificationRun => ({
      id: newId('vrn'),
      roundId: id,
      checkId: check.id,
      checkRevision: check.revision,
      name: check.name,
      command: check.command,
      cwd: check.cwd,
      kind: check.kind,
      trigger: meta.trigger,
      ...(meta.turnId !== undefined && { turnId: meta.turnId }),
      status: 'running',
      queuedAt: now,
    });
    const runs: VerificationRun[] = [];
    for (const check of checks) {
      const run = base(check);
      definitions.set(run.id, check);
      runs.push(run);
    }
    for (const { check, reason } of notRun) {
      runs.push({ ...base(check), status: 'not_run', reason, finishedAt: now });
    }
    const round: Round = {
      id,
      sessionId,
      workspaceId: record.workspaceId as WorkspaceId,
      trigger: meta.trigger,
      ...(meta.turnId !== undefined && { turnId: meta.turnId }),
      root: record.cwd,
      checks: definitions,
      runs,
      abort: new AbortController(),
    };
    this.#rounds.set(id, round);
    this.#write(sessionId, [
      ...runs.map((run) => updated(run)),
      acceptanceChanged(acceptanceOf(runs, { roundId: id, ...turnOf(meta), at: now })),
    ]);
    void this.#execute(round).catch((error: unknown) => this.#onError(error));
    return round;
  }

  async #execute(round: Round): Promise<void> {
    try {
      for (const run of round.runs) {
        if (run.status !== 'running') continue;
        if (round.abort.signal.aborted) {
          this.#finishRun(round, run, {
            status: 'cancelled',
            reason: round.cancelReason ?? 'user',
          });
          continue;
        }
        await this.#withSlot(round.workspaceId, round.abort.signal, () => this.#runOne(round, run));
      }
    } finally {
      this.#rounds.delete(round.id);
    }
    this.#roundFinished(round);
  }

  async #runOne(round: Round, queued: VerificationRun): Promise<void> {
    if (round.abort.signal.aborted || this.#disposed) {
      this.#finishRun(round, queued, { status: 'cancelled', reason: round.cancelReason ?? 'user' });
      return;
    }
    const check = round.checks.get(queued.id) as CheckDefinition;
    const cwd = check.cwd === '' ? round.root : join(round.root, ...check.cwd.split('/'));
    // 来源是脚本时对一次正文：变了（例如 Agent 改了 "test"）就不跑，等用户重新认可。
    if (check.source.kind === 'package_script') {
      const body = await readScript(round.root, check.source.file, check.source.script);
      if (body === undefined || scriptHash(body) !== check.source.scriptHash) {
        this.#finishRun(round, queued, { status: 'not_run', reason: 'approval_required' });
        return;
      }
    }
    const environment = await environmentPrecheck(cwd);
    if (environment !== undefined) {
      this.#finishRun(round, queued, { status: 'environment_unavailable', reason: environment });
      return;
    }
    const before = await readCodeState(round.root, round.abort.signal);
    const started: VerificationRun = { ...queued, codeState: before, startedAt: isoNow() };
    this.#replace(round, started);
    this.#write(round.sessionId, [updated(started)]);
    const result = await this.#runner
      .run({
        sessionId: round.sessionId,
        runId: queued.id,
        command: check.command,
        cwd,
        timeoutMs: check.timeoutMs,
        signal: round.abort.signal,
      })
      .catch((error: unknown) => {
        this.#onWarning('检查进程起不来', { runId: queued.id, error: String(error) });
        return undefined;
      });
    if (result === undefined) {
      this.#finishRun(round, started, {
        status: 'environment_unavailable',
        reason: 'spawn_failed',
      });
      return;
    }
    const facts = {
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      ...(result.signal !== null && { signal: result.signal }),
      ...(summarize(result.output) !== undefined && {
        summary: summarize(result.output) as string,
      }),
      output: { bytes: result.bytes, truncated: result.truncated },
    };
    if (result.kind === 'cancelled') {
      this.#finishRun(round, started, {
        status: 'cancelled',
        reason: round.cancelReason ?? 'user',
        ...facts,
      });
      return;
    }
    if (result.kind === 'spawn_failed') {
      this.#finishRun(round, started, {
        status: 'environment_unavailable',
        reason: 'spawn_failed',
        ...facts,
      });
      return;
    }
    const after = await readCodeState(round.root);
    if (sameCodeState(before, after) === false) {
      this.#finishRun(round, started, { status: 'stale', reason: 'code_changed', ...facts });
      return;
    }
    if (result.kind === 'timed_out') {
      this.#finishRun(round, started, { status: 'timed_out', ...facts });
      return;
    }
    const outcome = judgeOutcome({
      kind: check.kind,
      exitCode: result.exitCode,
      output: result.output,
      ...(check.expectOutput !== undefined && { expectOutput: check.expectOutput }),
    });
    const fingerprint =
      outcome.status === 'failed'
        ? errorFingerprint({
            checkId: check.id,
            reason: outcome.reason ?? 'exit_code',
            output: result.output,
            cwd: round.root,
          })
        : undefined;
    this.#finishRun(round, started, {
      status: outcome.status,
      ...(outcome.reason !== undefined && { reason: outcome.reason }),
      ...(outcome.tests !== undefined && { tests: outcome.tests }),
      ...(fingerprint !== undefined && { fingerprint }),
      ...facts,
    });
  }

  #finishRun(round: Round, run: VerificationRun, patch: Partial<VerificationRun>): void {
    const finished: VerificationRun = { ...run, ...patch, finishedAt: isoNow() };
    this.#replace(round, finished);
    this.#write(round.sessionId, [updated(finished)]);
  }

  #replace(round: Round, run: VerificationRun): void {
    round.runs = round.runs.map((item) => (item.id === run.id ? run : item));
  }

  async #withSlot(
    workspaceId: WorkspaceId,
    signal: AbortSignal,
    task: () => Promise<void>,
  ): Promise<void> {
    let slot = this.#slots.get(workspaceId);
    if (!slot) {
      slot = { running: 0, waiting: [] };
      this.#slots.set(workspaceId, slot);
    }
    const current = slot;
    if (current.running >= this.#maxConcurrent && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = current.waiting.indexOf(wake);
          if (index !== -1) current.waiting.splice(index, 1);
          resolve();
        };
        current.waiting.push(wake);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    current.running++;
    try {
      await task();
    } finally {
      current.running--;
      current.waiting.shift()?.();
    }
  }

  #cancelRounds(sessionId: SessionId, reason: string): number {
    let cancelled = 0;
    for (const round of this.#activeRounds(sessionId)) {
      cancelled += round.runs.filter((run) => run.status === 'running').length;
      round.cancelReason ??= reason;
      round.abort.abort();
    }
    return cancelled;
  }

  /** 一轮跑完：写验收状态。 */
  #roundFinished(round: Round): void {
    if (this.#disposed) return;
    const acceptance = acceptanceOf(round.runs, {
      roundId: round.id,
      ...turnOf(round),
      at: isoNow(),
    });
    this.#write(round.sessionId, [acceptanceChanged(acceptance)]);
  }

  #markUnverified(sessionId: SessionId, reason: string): void {
    const current = this.#events.snapshot(sessionId)?.verification?.acceptance;
    if (current === undefined || current.status === 'unverified') return;
    this.#write(sessionId, [
      acceptanceChanged({ status: 'unverified', reason, updatedAt: isoNow() }),
    ]);
  }

  #invalidateIfChanged(sessionId: SessionId, codeState: CodeState): void {
    const acceptance = this.#events.snapshot(sessionId)?.verification?.acceptance;
    if (
      acceptance === undefined ||
      acceptance.status === 'unverified' ||
      acceptance.status === 'verifying'
    )
      return;
    if (sameCodeState(acceptance.codeState, codeState) === false)
      this.#markUnverified(sessionId, 'code_changed');
  }

  // ── 生命周期 ─────────────────────────────────────────────────

  /**
   * Host 启动对账：上次没跑完的检查记为 `cancelled`（`host_restarted`），验证中的验收回到 `unverified`。
   * 什么都不重开。在服务客户端之前调用一次。
   */
  recover(): { cancelledRuns: number } {
    let cancelledRuns = 0;
    const records = this.#storage.sessions.list({
      includeRemovedWorkspaces: true,
      includeChildren: false,
      includeSide: true,
    });
    for (const record of records) {
      const sessionId = record.id as SessionId;
      const verification = this.#events.snapshot(sessionId)?.verification;
      if (verification === undefined) continue;
      const now = isoNow();
      const inputs: AppendInput[] = [];
      for (const run of verification.runs) {
        if (run.status !== 'running') continue;
        cancelledRuns++;
        inputs.push(
          updated({ ...run, status: 'cancelled', reason: 'host_restarted', finishedAt: now }),
        );
      }
      if (verification.acceptance.status === 'verifying') {
        inputs.push(
          acceptanceChanged({ status: 'unverified', reason: 'host_restarted', updatedAt: now }),
        );
      }
      if (inputs.length > 0) this.#write(sessionId, inputs);
    }
    return { cancelledRuns };
  }

  /** 删除会话：取消它的检查、结束检查进程（输出随会话的大输出目录删）。 */
  async removeSessions(sessionIds: readonly SessionId[]): Promise<void> {
    for (const sessionId of sessionIds) {
      this.#cancelRounds(sessionId, 'session_closed');
    }
    await this.#runner.removeSessions(sessionIds);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const round of this.#rounds.values()) {
      round.cancelReason ??= 'host_shutdown';
      round.abort.abort();
    }
    await this.#runner.close();
  }

  #write(sessionId: SessionId, inputs: readonly AppendInput[]): void {
    if (inputs.length === 0) return;
    try {
      this.#events.appendMany(sessionId, inputs);
    } catch (error) {
      // 会话在这期间被删了、事件库关了：记录写不进去，不影响别的。
      this.#onWarning('验证记录写不进事件库', { sessionId, error: String(error) });
    }
  }
}

function updated(run: VerificationRun): AppendInput {
  return { type: 'verification.updated', source: 'host', payload: { run } };
}

function acceptanceChanged(acceptance: SessionAcceptance): AppendInput {
  return { type: 'acceptance.changed', source: 'host', payload: { acceptance } };
}

function turnOf(meta: { turnId?: TurnId }): { turnId?: TurnId } {
  return meta.turnId === undefined ? {} : { turnId: meta.turnId };
}
