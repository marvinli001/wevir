// 回合后验证与有限自动修复（0.65.0，Host 功能 `verification`，ADR-0008）。
//
// - **检查配置**存在 Host（ChecksStore），仓库里的命令只是候选；用户保存才算认可，脚本正文变了要重新认可。
// - **验证记录**是会话事件流里的 `verification.updated`，与回合分开；一次触发是一轮（`roundId`），一轮里的检查按顺序跑，每个工作区
//   同时最多 `VERIFICATION_MAX_CONCURRENT` 个。每条记录绑定开始时的代码状态，结束时代码状态变了就是 `stale`。
// - **验收状态**（`acceptance.changed`）按最近一轮算，与引擎的回合状态分开；之后的回合改了代码就回到 `unverified`。
// - **回合后自动运行**：普通会话的回合以 `completed` 结束、改到了文件时，按适用条件跑 `after_turn` 的检查；同一回合只跑一轮。
// - **自动修复**（默认关闭）：`after_turn` 的一轮有可修的失败时开一条修复链，每次修复是一个带 `from.repair` 的回合，回合结束后
//   重跑原来那一轮的检查；同一错误再次出现、达到次数、超出预算、环境不可用、权限被拒、用户停止或发了消息时停下。修复回合结束后
//   不走回合后自动运行（防递归）；Host 重启时进行中的链停下（`host_restarted`），不会重开。
//
// 事件直接追加到事件库（不经 SessionManager 的状态机，这些事件不改会话状态）；会话里的动静从事件总线的 `listenAll` 收。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CheckCandidate,
  CheckDefinition,
  CheckId,
  CheckInput,
  ClientIdentity,
  CodeState,
  HostId,
  RepairChain,
  RepairId,
  RepairSettings,
  SessionAcceptance,
  SessionId,
  SessionSnapshot,
  SessionVerification,
  TurnId,
  TurnOutcome,
  VerificationRoundId,
  VerificationRun,
  VerificationRunId,
  VerificationTrigger,
  WevirEvent,
  WorkspaceId,
} from '@wevir/protocol';
import type { SessionRecord, Storage } from '@wevir/storage';
import type { TurnCheckpoints } from '../checkpoints.js';
import { HostError } from '../errors.js';
import type { AppendInput, EventStore } from '../event-store.js';
import { newId } from '../ids.js';
import type { SessionManager } from '../session-manager.js';
import { defaultPromptsDir } from '../title.js';
import { findCandidates, readScript, scriptHash } from './candidates.js';
import { type ChecksStore, normalizeRelative, type WorkspaceChecks } from './checks-store.js';
import { readCodeState, sameCodeState } from './code-state.js';
import {
  errorFingerprint,
  judgeOutcome,
  REPAIRABLE_REASONS,
  roundFingerprint,
  summarize,
  validExpectOutput,
} from './outcome.js';
import { type CheckRunner, environmentPrecheck } from './runner.js';

/** 每个工作区同时最多跑几个检查。 */
export const VERIFICATION_MAX_CONCURRENT = 2;
/** 交给 Agent 的材料里每个失败检查的输出最多这么多字；整份材料最多 `REPAIR_MATERIAL_MAX_LENGTH`。 */
export const REPAIR_OUTPUT_MAX_LENGTH = 6000;
export const REPAIR_MATERIAL_MAX_LENGTH = 24_000;

/** 读 `verification-repair.md`：删掉注释与开头的空行；只能有 `attempt`、`max_attempts`、`failures` 三个变量。 */
export function loadRepairTemplate(dir: string = defaultPromptsDir()): string {
  const text = readFileSync(join(dir, 'verification-repair.md'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\n/, '');
  const rest = text.replace(/\{\{\s*(attempt|max_attempts|failures)\s*\}\}/g, '');
  if (rest.includes('{{')) {
    throw new Error('verification-repair.md 里有不认识的变量（prompts/README.md 模板语法）');
  }
  return text;
}

/** 渲染修复材料：先替换模板里的变量，再放进失败材料（材料里出现 `{{` 也不会被当成变量）。 */
export function renderRepairMaterial(
  template: string,
  vars: { attempt: number; maxAttempts: number; failures: string },
): string {
  const [head, tail = ''] = template
    .replace(/\{\{\s*attempt\s*\}\}/g, String(vars.attempt))
    .replace(/\{\{\s*max_attempts\s*\}\}/g, String(vars.maxAttempts))
    .split(/\{\{\s*failures\s*\}\}/);
  return `${head ?? ''}${vars.failures}${tail}`.trim();
}

/** 适用条件：回合改到的文件（相对会话目录）有一个命中 `paths` 的某一项。 */
export function matchesPaths(
  paths: readonly string[] | undefined,
  changed: readonly string[],
): boolean {
  if (paths === undefined || paths.length === 0) return changed.length > 0;
  return changed.some((file) => paths.some((pattern) => matchPath(pattern, file)));
}

function matchPath(pattern: string, file: string): boolean {
  if (!/[*?[]/.test(pattern)) {
    const prefix = pattern.replace(/\/+$/, '');
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  return globRegExp(pattern).test(file);
}

function globRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // 没有 `/` 的模式（`*.ts`）在任何一层都算。
  return new RegExp(pattern.includes('/') ? `^${source}$` : `(?:^|/)${source}$`);
}

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
  readonly repairId?: RepairId;
  readonly attempt?: number;
  /** 会话目录（检查的 cwd 相对它）。 */
  readonly root: string;
  readonly checks: ReadonlyMap<VerificationRunId, CheckDefinition>;
  runs: VerificationRun[];
  readonly abort: AbortController;
  cancelReason?: string;
}

interface Chain {
  chain: RepairChain;
  readonly settings: RepairSettings;
  readonly startedAtMs: number;
  readonly startTokens: number | undefined;
  /** 原来那一轮的检查（复验跑它们）。 */
  readonly checkIds: readonly CheckId[];
  lastFingerprint: string;
  /** 进行中的修复回合。 */
  turnId?: TurnId;
  permissionDenied: boolean;
  /** 是 Host 自己停下修复回合时的原因（超出时长、用户发了消息）。 */
  stopping?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export interface VerificationServiceOptions {
  storage: Storage;
  events: EventStore;
  /** 事件总线的 `listenAll`。 */
  listenAll: (listener: (event: WevirEvent) => void) => () => void;
  sessions: Pick<SessionManager, 'startRepairTurn' | 'cancel'>;
  checks: ChecksStore;
  runner: CheckRunner;
  checkpoints?: Pick<TurnCheckpoints, 'changedPaths'>;
  hostId: HostId;
  /** 修复材料的模板；省略时读仓库里的 `prompts/verification-repair.md`。 */
  repairTemplate?: string;
  maxConcurrent?: number;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  onError?: (error: unknown) => void;
}

export class VerificationService {
  readonly #storage: Storage;
  readonly #events: EventStore;
  readonly #sessions: VerificationServiceOptions['sessions'];
  readonly #checks: ChecksStore;
  readonly #runner: CheckRunner;
  readonly #checkpoints: VerificationServiceOptions['checkpoints'];
  readonly #template: string;
  readonly #identity: ClientIdentity;
  readonly #maxConcurrent: number;
  readonly #onWarning: (message: string, fields?: Record<string, unknown>) => void;
  readonly #onError: (error: unknown) => void;
  readonly #unlisten: () => void;
  readonly #rounds = new Map<VerificationRoundId, Round>();
  readonly #chains = new Map<SessionId, Chain>();
  /** 每个会话的回合后处理排队执行。 */
  readonly #tails = new Map<SessionId, Promise<unknown>>();
  /** 每个工作区正在跑的检查数与排队等的。 */
  readonly #slots = new Map<WorkspaceId, { running: number; waiting: Array<() => void> }>();
  /** 已经处理过的回合（同一回合只开一轮）。 */
  readonly #handledTurns = new Set<TurnId>();
  /** 修复回合（`user.message` 带 `from.repair`）：结束后不走回合后自动运行，防止修复再触发修复。 */
  readonly #repairTurns = new Set<TurnId>();
  #disposed = false;

  constructor(options: VerificationServiceOptions) {
    this.#storage = options.storage;
    this.#events = options.events;
    this.#sessions = options.sessions;
    this.#checks = options.checks;
    this.#runner = options.runner;
    this.#checkpoints = options.checkpoints;
    this.#template = options.repairTemplate ?? loadRepairTemplate();
    this.#identity = {
      deviceId: options.hostId,
      clientId: 'wevir-verification',
      clientKind: 'desktop',
    };
    this.#maxConcurrent = options.maxConcurrent ?? VERIFICATION_MAX_CONCURRENT;
    this.#onWarning = options.onWarning ?? (() => {});
    this.#onError =
      options.onError ?? ((error) => console.error('[wevir-host] verification:', error));
    this.#unlisten = options.listenAll((event) => this.#onEvent(event));
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
    const repair = await this.#checks.setRepair(workspaceId, patch);
    // 用户关掉自动修复：进行中的链停下（已经开始的修复回合照常结束，之后不再修）。
    if (!repair.enabled) {
      for (const [sessionId, chain] of this.#chains) {
        if (this.#record(sessionId)?.workspaceId === workspaceId) chain.stopping ??= 'disabled';
      }
    }
    return repair;
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
    // 手动运行时用户可能正在停修复链之外的东西：进行中的链此刻一定在等复验或下一次修复之间，交给用户。
    this.#stopChain(sessionId, 'user_message');
    const round = this.#startRound(record, { trigger: 'manual' }, chosen);
    return { roundId: round.id, runs: [...round.runs] };
  }

  /** `verification.cancel`：取消会话里还在跑或排着的检查，停下修复链；修复回合进行中时一并停下它。 */
  cancel(sessionId: SessionId): { cancelled: number } {
    this.#session(sessionId);
    const cancelled = this.#cancelRounds(sessionId, 'user');
    const chain = this.#chains.get(sessionId);
    if (chain !== undefined) {
      if (chain.turnId !== undefined) {
        chain.stopping ??= 'user_cancelled';
        void this.#sessions.cancel(sessionId).catch(() => {});
      } else {
        this.#stopChain(sessionId, 'user_cancelled');
      }
    }
    return { cancelled };
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

  #record(sessionId: SessionId): SessionRecord | undefined {
    return this.#storage.sessions.get(sessionId);
  }

  #activeRounds(sessionId: SessionId): Round[] {
    return [...this.#rounds.values()].filter((round) => round.sessionId === sessionId);
  }

  // ── 一轮检查 ─────────────────────────────────────────────────

  #startRound(
    record: SessionRecord,
    meta: { trigger: VerificationTrigger; turnId?: TurnId; repairId?: RepairId; attempt?: number },
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
      ...(meta.repairId !== undefined && { repairId: meta.repairId }),
      ...(meta.attempt !== undefined && { attempt: meta.attempt }),
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
      ...(meta.repairId !== undefined && { repairId: meta.repairId }),
      ...(meta.attempt !== undefined && { attempt: meta.attempt }),
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

  /** 一轮跑完：写验收状态，再看修复链。 */
  #roundFinished(round: Round): void {
    if (this.#disposed) return;
    const acceptance = acceptanceOf(round.runs, {
      roundId: round.id,
      ...turnOf(round),
      at: isoNow(),
    });
    this.#write(round.sessionId, [acceptanceChanged(acceptance)]);
    if (round.trigger === 'manual') return;
    this.#enqueue(round.sessionId, () => this.#afterRound(round, acceptance));
  }

  // ── 会话里的动静 ─────────────────────────────────────────────

  #onEvent(event: WevirEvent): void {
    if (this.#disposed) return;
    const sessionId = event.sessionId;
    switch (event.type) {
      case 'turn.started': {
        // 新回合开始：这个会话还在跑的检查反正会过期，取消掉。
        this.#cancelRounds(sessionId, 'turn_started');
        const chain = this.#chains.get(sessionId);
        if (
          chain !== undefined &&
          chain.turnId !== event.payload.turnId &&
          !this.#isRepairTurn(sessionId, event.payload.turnId)
        ) {
          // 修复链在两次修复之间（复验中）时用户开了回合：交给用户。
          this.#stopChain(sessionId, 'user_message');
        }
        break;
      }
      case 'user.message': {
        const repair = event.payload.from?.repair;
        if (repair !== undefined) this.#repairTurns.add(event.payload.turnId);
        const chain = this.#chains.get(sessionId);
        if (repair !== undefined && chain?.chain.id === repair.repairId) {
          chain.turnId = event.payload.turnId;
          this.#updateChain(sessionId, {
            turnIds: [...chain.chain.turnIds, event.payload.turnId],
          });
        }
        break;
      }
      case 'pending.added': {
        const chain = this.#chains.get(sessionId);
        // 用户的消息（不是别的会话或进程通知）：修复回合由 SessionManager 停下，这里记下原因；在复验中则直接停链。
        if (chain !== undefined && event.payload.pending.from === undefined) {
          if (chain.turnId !== undefined) chain.stopping ??= 'user_message';
          else {
            this.#cancelRounds(sessionId, 'turn_started');
            this.#stopChain(sessionId, 'user_message');
          }
        }
        break;
      }
      case 'approval.resolved': {
        const chain = this.#chains.get(sessionId);
        if (chain?.turnId !== undefined && event.payload.status === 'denied') {
          chain.permissionDenied = true;
        }
        break;
      }
      case 'turn.finished': {
        const { turnId, outcome } = event.payload;
        const chain = this.#chains.get(sessionId);
        if (chain?.turnId === turnId) {
          this.#enqueue(sessionId, () => this.#repairTurnFinished(sessionId, chain, outcome));
        } else {
          this.#enqueue(sessionId, () => this.#afterTurn(sessionId, turnId, outcome));
        }
        break;
      }
      default:
        break;
    }
  }

  #isRepairTurn(sessionId: SessionId, turnId: TurnId): boolean {
    return this.#chains.get(sessionId)?.chain.turnIds.includes(turnId) === true;
  }

  #enqueue(sessionId: SessionId, task: () => Promise<void> | void): void {
    const next = (this.#tails.get(sessionId) ?? Promise.resolve())
      .then(task)
      .catch((error: unknown) => {
        if (!(error instanceof HostError)) this.#onError(error);
      });
    this.#tails.set(sessionId, next);
    void next.finally(() => {
      if (this.#tails.get(sessionId) === next) this.#tails.delete(sessionId);
    });
  }

  /** 回合后自动运行（决策 11）。 */
  async #afterTurn(sessionId: SessionId, turnId: TurnId, outcome: TurnOutcome): Promise<void> {
    if (this.#disposed || this.#handledTurns.has(turnId) || this.#repairTurns.has(turnId)) return;
    this.#handledTurns.add(turnId);
    if (outcome !== 'completed') return;
    const record = this.#record(sessionId);
    if (!record || record.parentSessionId !== undefined || record.side) return;
    const workspace = this.#storage.workspaces.get(record.workspaceId);
    if (!workspace || workspace.removedAt !== undefined) return;
    const { checks } = await this.#checks.list(record.workspaceId as WorkspaceId);
    const snapshot = this.#events.snapshot(sessionId);
    if (checks.length === 0 && snapshot?.verification === undefined) return;
    const changed = await this.#checkpoints?.changedPaths(sessionId, record.cwd, turnId);
    if (changed !== undefined && changed.length === 0) return;
    // 回合改了代码（或不知道改没改）：之前的验收不再算数。
    this.#markUnverified(sessionId, 'code_changed');
    const automatic = checks.filter((check) => check.trigger === 'after_turn');
    if (automatic.length === 0) return;
    const run: CheckDefinition[] = [];
    const skipped: Array<{ check: CheckDefinition; reason: string }> = [];
    for (const check of automatic) {
      if (changed === undefined) {
        if (check.paths === undefined || check.paths.length === 0) run.push(check);
        else skipped.push({ check, reason: 'changes_unknown' });
      } else if (matchesPaths(check.paths, changed)) {
        run.push(check);
      }
    }
    if (run.length === 0 && skipped.length === 0) return;
    // 等待期间用户可能又开了回合。
    const now = this.#events.snapshot(sessionId);
    if (now?.session.state !== 'idle') return;
    this.#startRound(record, { trigger: 'after_turn', turnId }, run, skipped);
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

  // ── 自动修复（决策 12） ──────────────────────────────────────

  async #afterRound(round: Round, acceptance: SessionAcceptance): Promise<void> {
    if (this.#disposed) return;
    const sessionId = round.sessionId;
    if (round.trigger === 'repair') {
      const chain = this.#chains.get(sessionId);
      if (chain === undefined || chain.chain.id !== round.repairId) return;
      this.#updateChain(sessionId, { lastRoundId: round.id });
      await this.#continueChain(sessionId, chain, round, acceptance);
      return;
    }
    if (
      round.trigger !== 'after_turn' ||
      acceptance.status !== 'failed' ||
      round.turnId === undefined
    )
      return;
    const { repair } = await this.#checks.list(round.workspaceId);
    if (!repair.enabled) return;
    if (this.#chains.has(sessionId)) return;
    const failed = round.runs.filter(
      (run) => run.status === 'failed' || run.status === 'timed_out',
    );
    const repairable = failed.every(
      (run) => run.status === 'failed' && REPAIRABLE_REASONS.has(run.reason ?? ''),
    );
    const now = isoNow();
    const chain: Chain = {
      chain: {
        id: newId('rpr'),
        roundId: round.id,
        originTurnId: round.turnId,
        status: 'running',
        attempt: 0,
        maxAttempts: repair.maxAttempts,
        turnIds: [],
        lastRoundId: round.id,
        startedAt: now,
        updatedAt: now,
      },
      settings: repair,
      startedAtMs: Date.now(),
      startTokens: this.#events.snapshot(sessionId)?.usage?.totalTokens,
      checkIds: round.runs.filter((run) => run.status !== 'not_run').map((run) => run.checkId),
      lastFingerprint: roundFingerprint(failed.map((run) => run.fingerprint ?? run.id)),
      permissionDenied: false,
    };
    this.#chains.set(sessionId, chain);
    this.#write(sessionId, [repairUpdated(chain.chain)]);
    if (!repairable) {
      this.#stopChain(sessionId, 'not_repairable');
      return;
    }
    await this.#attempt(sessionId, chain, failed);
  }

  /** 修复后复验的一轮跑完。 */
  async #continueChain(
    sessionId: SessionId,
    chain: Chain,
    round: Round,
    acceptance: SessionAcceptance,
  ): Promise<void> {
    if (chain.stopping !== undefined) {
      this.#stopChain(sessionId, chain.stopping);
      return;
    }
    if (acceptance.status === 'accepted') {
      this.#endChain(sessionId, { status: 'passed' });
      return;
    }
    if (acceptance.status === 'environment_unavailable') {
      this.#stopChain(sessionId, 'environment_unavailable');
      return;
    }
    if (acceptance.status !== 'failed') {
      this.#stopChain(sessionId, acceptance.reason ?? 'not_repairable');
      return;
    }
    const failed = round.runs.filter(
      (run) => run.status === 'failed' || run.status === 'timed_out',
    );
    const fingerprint = roundFingerprint(failed.map((run) => run.fingerprint ?? run.id));
    if (fingerprint === chain.lastFingerprint) {
      this.#stopChain(sessionId, 'repeated_failure');
      return;
    }
    chain.lastFingerprint = fingerprint;
    if (
      !failed.every((run) => run.status === 'failed' && REPAIRABLE_REASONS.has(run.reason ?? ''))
    ) {
      this.#stopChain(sessionId, 'not_repairable');
      return;
    }
    if (chain.chain.attempt >= chain.chain.maxAttempts) {
      this.#stopChain(sessionId, 'limit');
      return;
    }
    await this.#attempt(sessionId, chain, failed);
  }

  /** 开一次修复：先写 `repair.updated`（次数加一），再开修复回合。 */
  async #attempt(
    sessionId: SessionId,
    chain: Chain,
    failed: readonly VerificationRun[],
  ): Promise<void> {
    const budget = this.#overBudget(sessionId, chain);
    if (budget) {
      this.#stopChain(sessionId, 'budget');
      return;
    }
    const workspaceId = this.#record(sessionId)?.workspaceId as WorkspaceId | undefined;
    const current =
      workspaceId === undefined ? undefined : (await this.#checks.list(workspaceId)).repair;
    if (current?.enabled !== true) {
      this.#stopChain(sessionId, 'disabled');
      return;
    }
    const attempt = chain.chain.attempt + 1;
    this.#updateChain(sessionId, { attempt });
    const content = renderRepairMaterial(this.#template, {
      attempt,
      maxAttempts: chain.chain.maxAttempts,
      failures: await this.#failureMaterial(sessionId, chain, failed),
    });
    const result = await this.#sessions
      .startRepairTurn(sessionId, {
        content: [{ type: 'text', text: content }],
        sentBy: this.#identity,
        from: {
          sessionId,
          kind: 'report',
          repair: {
            repairId: chain.chain.id,
            attempt,
            maxAttempts: chain.chain.maxAttempts,
            roundId: chain.chain.lastRoundId ?? chain.chain.roundId,
            originTurnId: chain.chain.originTurnId,
          },
        },
      })
      .catch((error: unknown) => {
        if (!(error instanceof HostError)) this.#onError(error);
        return { skipped: 'session_unavailable' };
      });
    if ('skipped' in result) {
      this.#stopChain(sessionId, result.skipped);
      return;
    }
    chain.turnId = result.turnId;
    // 修复回合进行中超出总时长：停下它（之后按 budget 停链）。
    const left = chain.settings.maxDurationMs - (Date.now() - chain.startedAtMs);
    chain.timer = setTimeout(
      () => {
        if (chain.turnId !== result.turnId) return;
        chain.stopping ??= 'budget';
        void this.#sessions.cancel(sessionId).catch(() => {});
      },
      Math.max(0, left),
    );
  }

  #overBudget(sessionId: SessionId, chain: Chain): boolean {
    if (Date.now() - chain.startedAtMs >= chain.settings.maxDurationMs) return true;
    const tokens = this.#events.snapshot(sessionId)?.usage?.totalTokens;
    if (tokens !== undefined && chain.startTokens !== undefined) {
      return tokens - chain.startTokens >= chain.settings.maxTokens;
    }
    return false;
  }

  /** 修复回合结束。 */
  async #repairTurnFinished(
    sessionId: SessionId,
    chain: Chain,
    outcome: TurnOutcome,
  ): Promise<void> {
    if (chain.timer !== undefined) clearTimeout(chain.timer);
    const turnId = chain.turnId;
    chain.turnId = undefined;
    if (this.#chains.get(sessionId) !== chain) return;
    if (turnId !== undefined) this.#handledTurns.add(turnId);
    if (outcome === 'cancelled') {
      this.#stopChain(sessionId, chain.stopping ?? 'user_cancelled');
      return;
    }
    if (outcome !== 'completed') {
      this.#stopChain(sessionId, chain.stopping ?? 'turn_failed');
      return;
    }
    if (chain.permissionDenied) {
      this.#stopChain(sessionId, 'permission_denied');
      return;
    }
    if (chain.stopping !== undefined) {
      this.#stopChain(sessionId, chain.stopping);
      return;
    }
    const record = this.#record(sessionId);
    if (!record) return;
    const { checks } = await this.#checks.list(record.workspaceId as WorkspaceId);
    const again = checks.filter((check) => chain.checkIds.includes(check.id));
    if (again.length === 0) {
      this.#stopChain(sessionId, 'not_repairable');
      return;
    }
    const snapshot = this.#events.snapshot(sessionId);
    if (snapshot?.session.state !== 'idle' || (snapshot.pendingMessages ?? []).length > 0) {
      this.#stopChain(sessionId, 'user_message');
      return;
    }
    this.#startRound(
      record,
      {
        trigger: 'repair',
        ...(turnId !== undefined && { turnId }),
        repairId: chain.chain.id,
        attempt: chain.chain.attempt,
      },
      again,
    );
  }

  /** 失败材料：每个失败检查一个 `<check-output>` 块，带来源；输出只给尾部，整份有上限。 */
  async #failureMaterial(
    sessionId: SessionId,
    chain: Chain,
    failed: readonly VerificationRun[],
  ): Promise<string> {
    const blocks: string[] = [];
    let budget = REPAIR_MATERIAL_MAX_LENGTH;
    for (const run of failed) {
      const page = await this.#runner.read(sessionId, run.id).catch(() => undefined);
      const full = page?.text ?? run.summary ?? '';
      const tail =
        full.length > REPAIR_OUTPUT_MAX_LENGTH
          ? `…\n${full.slice(-REPAIR_OUTPUT_MAX_LENGTH)}`
          : full;
      const state = run.codeState;
      const attrs = [
        `check="${escapeAttr(run.name)}"`,
        `revision="${run.checkRevision}"`,
        `command="${escapeAttr(run.command)}"`,
        `cwd="${escapeAttr(run.cwd === '' ? '.' : run.cwd)}"`,
        `status="${run.status}"`,
        ...(run.reason !== undefined ? [`reason="${run.reason}"`] : []),
        ...(run.exitCode !== undefined && run.exitCode !== null
          ? [`exit_code="${run.exitCode}"`]
          : []),
        ...(run.tests !== undefined
          ? [
              `tests="passed ${run.tests.passed}, failed ${run.tests.failed}, skipped ${run.tests.skipped}"`,
            ]
          : []),
        ...(state?.kind === 'git'
          ? [`code_state="${state.head ?? 'no-commit'} ${state.tree}"`]
          : []),
        `original_turn="${chain.chain.originTurnId}"`,
        `full_output="${escapeAttr(this.#runner.outputPath(sessionId, run.id))}"`,
      ];
      const body = tail.replace(/<\/check-output>/gi, '</check-output_>');
      let block = `<check-output ${attrs.join(' ')}>\n${body}\n</check-output>`;
      if (block.length > budget)
        block = `${block.slice(0, Math.max(0, budget - 40))}\n…\n</check-output>`;
      budget -= block.length;
      blocks.push(block);
      if (budget <= 200) break;
    }
    return blocks.join('\n\n');
  }

  #updateChain(sessionId: SessionId, patch: Partial<RepairChain>): void {
    const chain = this.#chains.get(sessionId);
    if (chain === undefined) return;
    chain.chain = { ...chain.chain, ...patch, updatedAt: isoNow() };
    this.#write(sessionId, [repairUpdated(chain.chain)]);
  }

  #stopChain(sessionId: SessionId, reason: string): void {
    this.#endChain(sessionId, { status: 'stopped', stopReason: reason });
  }

  #endChain(sessionId: SessionId, patch: Pick<RepairChain, 'status'> & Partial<RepairChain>): void {
    const chain = this.#chains.get(sessionId);
    if (chain === undefined) return;
    if (chain.timer !== undefined) clearTimeout(chain.timer);
    this.#updateChain(sessionId, patch);
    this.#chains.delete(sessionId);
  }

  // ── 生命周期 ─────────────────────────────────────────────────

  /**
   * Host 启动对账：上次没跑完的检查记为 `cancelled`（`host_restarted`），验证中的验收回到 `unverified`，进行中的修复链停下。
   * 什么都不重开。在服务客户端之前调用一次。
   */
  recover(): { cancelledRuns: number; stoppedRepairs: number } {
    let cancelledRuns = 0;
    let stoppedRepairs = 0;
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
      if (verification.repair?.status === 'running') {
        stoppedRepairs++;
        inputs.push(
          repairUpdated({
            ...verification.repair,
            status: 'stopped',
            stopReason: 'host_restarted',
            updatedAt: now,
          }),
        );
      }
      if (inputs.length > 0) this.#write(sessionId, inputs);
    }
    return { cancelledRuns, stoppedRepairs };
  }

  /** 删除会话：取消它的检查、停链、结束检查进程（输出随会话的大输出目录删）。 */
  async removeSessions(sessionIds: readonly SessionId[]): Promise<void> {
    for (const sessionId of sessionIds) {
      this.#cancelRounds(sessionId, 'session_closed');
      const chain = this.#chains.get(sessionId);
      if (chain?.timer !== undefined) clearTimeout(chain.timer);
      this.#chains.delete(sessionId);
    }
    await this.#runner.removeSessions(sessionIds);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unlisten();
    for (const round of this.#rounds.values()) {
      round.cancelReason ??= 'host_shutdown';
      round.abort.abort();
    }
    for (const chain of this.#chains.values()) {
      if (chain.timer !== undefined) clearTimeout(chain.timer);
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

function repairUpdated(repair: RepairChain): AppendInput {
  return { type: 'repair.updated', source: 'host', payload: { repair } };
}

function turnOf(meta: { turnId?: TurnId }): { turnId?: TurnId } {
  return meta.turnId === undefined ? {} : { turnId: meta.turnId };
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/\n/g, ' ');
}
