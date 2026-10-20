// 自动化（0.66.0，domain-model §3.26）：存下按计划反复交给 Agent 的指令，Host 自己计时，到点时开会话、发指令、记下这次运行。
//
// 每个自动化存成 `<数据目录>/automations/<自动化 ID>.json`（0600，临时文件加 rename 原子写），里面是自动化本身与最近
// `AUTOMATION_RUNS_KEPT` 次运行；Host 启动时全部读进内存，改动写回。计时是每 `TICK_MS` 看一遍到点的：只在 Host 运行时执行，
// 电脑睡眠或 Wevir 退出期间错过的，醒来后只补跑最近错过的那一次（`catch_up`，七天内的；照 Claude 桌面端的定时任务），
// 更早的不补、直接算下一次。
// 同一个自动化同时只跑一次：到点时上一次还在跑（含等用户批准）就记一次 `skipped`（连着的几次并成一条）。
//
// 一次运行：按自动化的设置开会话（`newSessionEachRun` 为 `false` 时沿用 `sessionId`，那个会话不能用了就另开一个并换成它），
// 改标题、发出指令，回合结束时按结果记 `completed` / `failed` / `cancelled`，摘下最后一条回答作 `summary`；回合等用户批准或回答
// 时是 `waiting`。Host 重启时还在跑的运行记为 `cancelled`（回合已被打断）。
//
// 0.73.0：可以指定一个已有会话（`sessionId`），用它的项目与模型，每次往里面发一条消息；有检查脚本（`check`）时运行先是
// `checking`，Host 跑完脚本（check.ts）按结论唤醒 Agent，或记 `silent`（连着的几次并成一条，不开回合）。`output_changed`
// 的基准（上一次输出的摘要）与连着失败的次数存在同一个文件里，不出现在协议里；连着失败 `AUTOMATION_MAX_CONSECUTIVE_FAILURES`
// 次自动停用，记 `autoPausedAt`。完成的运行的 `summary` 与上一次完成的相同时记 `unchanged`（`notify: "changes"`）。

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AUTOMATION_MAX_CONSECUTIVE_FAILURES,
  AUTOMATION_QUIET_MARKER,
  AUTOMATION_RUN_SUMMARY_MAX_LENGTH,
  AUTOMATION_RUNS_KEPT,
  type Automation,
  type AutomationCheck,
  type AutomationCheckResult,
  type AutomationCreator,
  type AutomationId,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationRunTrigger,
  type ClientIdentity,
  type MethodParams,
  type NotificationParams,
  type PermissionMode,
  type Session,
  type SessionAutomation,
  type SessionId,
  type TurnId,
  type TurnOutcome,
  type WevirEvent,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { HostError } from '../errors.js';
import { newId } from '../ids.js';
import { type CheckExecutor, checkTimeoutMs, decide, runCheck } from './check.js';
import { isValidTimezone, localTimezone, nextOccurrence } from './schedule.js';

export type AutomationChanged = NotificationParams<'automation.changed'>;

/** 多久看一遍到点的自动化。 */
export const TICK_MS = 20_000;
/** 到点后晚了这么久才开始的运行算补跑（睡眠、Host 没运行）。 */
const LATE_MS = 3 * TICK_MS;
/** 错过的运行最多补多早的：更早的不补，直接算下一次。 */
const CATCH_UP_MAX_MS = 7 * 24 * 60 * 60_000;

/** 自动化要用的会话操作（SessionManager 的一部分）。 */
export interface AutomationSessions {
  create(
    params: MethodParams<'session.create'>,
    options: { automation: SessionAutomation },
  ): Promise<Session>;
  rename(sessionId: SessionId, title: string): Promise<unknown>;
  send(
    params: MethodParams<'session.send'>,
    sentBy: ClientIdentity,
  ): Promise<{ turnId?: TurnId; seq: number }>;
}

/** 自动化要用的事件库（EventStore 的一部分）。 */
export interface AutomationEvents {
  snapshot(sessionId: SessionId): { session: Session } | undefined;
  subscribe(sessionId: SessionId, listener: (event: WevirEvent) => void): { unsubscribe(): void };
  readSince(sessionId: SessionId, sinceSeq: number): WevirEvent[];
}

export interface AutomationServiceOptions {
  dir: string;
  storage: Pick<Storage, 'workspaces' | 'providers' | 'sessions'>;
  events: AutomationEvents;
  sessions: AutomationSessions;
  /** Host 代发消息用的身份。 */
  identity: ClientIdentity;
  /** 这个工作区是不是“对话”工作区（不在项目中）；Host 没有对话时省略，此时自动化必须有项目。 */
  isChats?: (workspaceId: string) => boolean;
  /** 跑检查脚本（测试换成假的）；省略时用 check.ts 的 `runCheck`。 */
  runCheck?: CheckExecutor;
  /** 不在项目中的检查脚本在哪个目录跑；省略时用户主目录。 */
  homeDir?: string;
  /**
   * 发给 Agent 的消息（automation-tools.ts 的 `automationRunMessage`）：`existingSession` 表示发进的会话不是这个自动化开的，
   * 那里没有运行须知。省略时只发指令。
   */
  message?: (
    automation: Automation,
    context: { existingSession: boolean; check?: AutomationCheckResult },
  ) => string;
  now?: () => number;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

/** 不出现在协议里的状态。 */
interface EntryState {
  /** `output_changed` 的基准：上一次检查的输出摘要。 */
  checkBaseline?: string;
  /** 连着失败的次数（完成或 `silent` 清零）。 */
  failures?: number;
}

interface Entry {
  automation: Omit<Automation, 'lastRun'>;
  /** 新的在前。 */
  runs: AutomationRun[];
  state: EntryState;
}

interface StoredFile {
  version: 1;
  automation: Omit<Automation, 'lastRun'>;
  runs: AutomationRun[];
  state?: EntryState;
}

/** 进行中的运行。 */
interface ActiveRun {
  automationId: AutomationId;
  runId: AutomationRun['id'];
  sessionId: SessionId;
  turnId: TurnId;
  /** 本次 `user.message` 的 seq，摘回答时从这里往后读。 */
  seq: number;
  /** 在等用户处理的审批与提问。 */
  open: Set<string>;
  unsubscribe: () => void;
}

type CreateParams = MethodParams<'automation.create'>;
type UpdateParams = MethodParams<'automation.update'>;

function invalid(path: string, message: string): HostError<'INVALID_PARAMS'> {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path: [path], message }] });
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** 回答的开头作 `summary`；最后一行是 `AUTOMATION_QUIET_MARKER` 时去掉它，记 `quiet`。 */
export function answerOf(text: string): { summary?: string; quiet?: true } {
  let body = text.trim();
  let quiet = false;
  const lines = body.split('\n');
  const last = lines
    .at(-1)
    ?.trim()
    .replace(/^[*`]+|[*`.]+$/g, '');
  if (last === AUTOMATION_QUIET_MARKER) {
    quiet = true;
    body = lines.slice(0, -1).join('\n').trim();
  }
  return {
    ...(body !== '' && { summary: clip(body, AUTOMATION_RUN_SUMMARY_MAX_LENGTH) }),
    ...(quiet && { quiet: true as const }),
  };
}

/** 去掉命令两头的空白（schema 只校验 trim 后不空）。 */
function normalizeCheck(check: AutomationCheck): AutomationCheck {
  return { ...check, command: check.command.trim() };
}

const FINISHED: Record<TurnOutcome, AutomationRunStatus> = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'cancelled',
};

export class AutomationService {
  readonly #options: AutomationServiceOptions;
  readonly #now: () => number;
  readonly #entries = new Map<AutomationId, Entry>();
  /** 运行 ID → 进行中的运行。 */
  readonly #active = new Map<string, ActiveRun>();
  readonly #listeners = new Set<(change: AutomationChanged) => void>();
  readonly #writes = new Map<string, Promise<void>>();
  /** 运行 ID → 在跑的检查脚本。 */
  readonly #checks = new Map<string, { automationId: AutomationId; abort: AbortController }>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  #loaded = false;

  constructor(options: AutomationServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** 读进存下的自动化，把重启前还在跑的运行记为 `cancelled`，补算缺的下一次，开始计时。 */
  async start(): Promise<void> {
    await this.load();
    this.#timer = setInterval(() => void this.tick(), TICK_MS);
    this.#timer.unref?.();
    void this.tick();
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    const names = await readdir(this.#options.dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = join(this.#options.dir, name);
      try {
        const stored = JSON.parse(await readFile(file, 'utf8')) as StoredFile;
        if (stored.version !== 1 || typeof stored.automation?.id !== 'string') continue;
        this.#entries.set(stored.automation.id, {
          automation: stored.automation,
          runs: Array.isArray(stored.runs) ? stored.runs : [],
          state: typeof stored.state === 'object' && stored.state !== null ? stored.state : {},
        });
      } catch (error) {
        this.#options.onWarning?.('automation file unreadable', { file, error });
      }
    }
    const now = this.#now();
    for (const entry of this.#entries.values()) {
      let changed = false;
      for (const run of entry.runs) {
        if (run.status === 'running' || run.status === 'waiting' || run.status === 'checking') {
          run.status = 'cancelled';
          run.finishedAt = iso(now);
          run.error = 'Interrupted when Wevir stopped.';
          changed = true;
        }
      }
      const { automation } = entry;
      if (automation.enabled && automation.nextRunAt === undefined) {
        const next = this.#next(automation, now);
        if (next !== undefined) {
          automation.nextRunAt = iso(next);
          changed = true;
        }
      }
      if (changed) void this.#save(entry);
    }
  }

  /** 停止计时（Host 退出时先停，进行中的运行照常记下结果）。 */
  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  dispose(): void {
    this.stop();
    for (const check of this.#checks.values()) check.abort.abort();
    this.#checks.clear();
    for (const active of this.#active.values()) active.unsubscribe();
    this.#active.clear();
    this.#listeners.clear();
  }

  /** 等写盘做完（测试与退出时用）。 */
  async flush(): Promise<void> {
    await Promise.all(this.#writes.values());
  }

  watch(listener: (change: AutomationChanged) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(): Automation[] {
    return [...this.#entries.values()]
      .map((entry) => this.#view(entry))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(automationId: string): { automation: Automation; runs: AutomationRun[] } {
    const entry = this.#entry(automationId);
    return { automation: this.#view(entry), runs: entry.runs.map((run) => ({ ...run })) };
  }

  /** 这个工作区是不是“对话”工作区（不在项目中）。 */
  isChats(workspaceId: string): boolean {
    return this.#options.isChats?.(workspaceId) === true;
  }

  /** 会话所在的自动化运行（会话是自动化开的，或某个自动化一直发进它）。 */
  automationOfSession(sessionId: SessionId): Automation | undefined {
    const record = this.#options.storage.sessions.get(sessionId);
    const origin = record?.origin;
    const id =
      origin?.kind === 'automation'
        ? origin.automationId
        : [...this.#entries.values()].find((entry) => entry.automation.sessionId === sessionId)
            ?.automation.id;
    const entry = id === undefined ? undefined : this.#entries.get(id as AutomationId);
    return entry === undefined ? undefined : this.#view(entry);
  }

  async create(params: CreateParams, createdBy: AutomationCreator): Promise<Automation> {
    const now = this.#now();
    const timezone = params.timezone ?? localTimezone();
    const target =
      params.sessionId !== undefined
        ? this.#targetOf(params.sessionId)
        : {
            ...(params.workspaceId !== undefined && { workspaceId: params.workspaceId }),
            providerId: params.providerId,
            ...(params.modelId !== undefined && { modelId: params.modelId }),
            ...(params.reasoningEffort !== undefined && {
              reasoningEffort: params.reasoningEffort,
            }),
          };
    if (target.providerId === undefined) {
      throw invalid('providerId', 'providerId is required unless sessionId is given');
    }
    this.#checkTarget({ timezone, providerId: target.providerId, workspaceId: target.workspaceId });
    this.#checkSchedule(params.schedule, now);
    const automation: Entry['automation'] = {
      id: newId('aut'),
      title: params.title.trim(),
      prompt: params.prompt.trim(),
      schedule: params.schedule,
      timezone,
      enabled: params.enabled ?? true,
      ...(target.workspaceId !== undefined && { workspaceId: target.workspaceId }),
      providerId: target.providerId,
      ...(target.modelId !== undefined && { modelId: target.modelId }),
      ...(target.reasoningEffort !== undefined && { reasoningEffort: target.reasoningEffort }),
      permissionMode: params.permissionMode ?? 'on_request',
      newSessionEachRun:
        params.sessionId === undefined ? (params.newSessionEachRun ?? true) : false,
      notify: params.notify ?? 'important',
      ...(params.check !== undefined && { check: normalizeCheck(params.check) }),
      ...(params.sessionId !== undefined && { sessionId: params.sessionId }),
      createdBy,
      createdAt: iso(now),
      updatedAt: iso(now),
      runCount: 0,
    };
    const next = automation.enabled ? this.#next(automation, now) : undefined;
    if (next !== undefined) automation.nextRunAt = iso(next);
    const entry: Entry = { automation, runs: [], state: {} };
    this.#entries.set(automation.id, entry);
    await this.#save(entry);
    this.#emit({ automationId: automation.id });
    return this.#view(entry);
  }

  /** Agent 建的自动化发回它所在的会话（`wevir_automation_create` 的 `runIn: "this_session"`）。 */
  async bindSession(automationId: AutomationId, sessionId: SessionId): Promise<Automation> {
    const entry = this.#entry(automationId);
    entry.automation.sessionId = sessionId;
    entry.automation.newSessionEachRun = false;
    await this.#save(entry);
    this.#emit({ automationId });
    return this.#view(entry);
  }

  async update(params: UpdateParams): Promise<Automation> {
    const entry = this.#entry(params.automationId);
    const current = entry.automation;
    const now = this.#now();
    const next: Entry['automation'] = { ...current };
    if (params.title !== undefined) next.title = params.title.trim();
    if (params.prompt !== undefined) next.prompt = params.prompt.trim();
    if (params.schedule !== undefined) next.schedule = params.schedule;
    if (params.timezone !== undefined) next.timezone = params.timezone;
    if (params.enabled !== undefined) next.enabled = params.enabled;
    if (params.workspaceId !== undefined) {
      if (params.workspaceId === null) delete next.workspaceId;
      else next.workspaceId = params.workspaceId;
    }
    if (params.providerId !== undefined) next.providerId = params.providerId;
    if (params.modelId !== undefined) {
      if (params.modelId === null) delete next.modelId;
      else next.modelId = params.modelId;
    }
    if (params.reasoningEffort !== undefined) {
      if (params.reasoningEffort === null) delete next.reasoningEffort;
      else next.reasoningEffort = params.reasoningEffort;
    }
    if (params.permissionMode !== undefined) next.permissionMode = params.permissionMode;
    if (params.newSessionEachRun !== undefined) next.newSessionEachRun = params.newSessionEachRun;
    if (params.notify !== undefined) next.notify = params.notify;
    let resetBaseline = false;
    if (params.check !== undefined) {
      const check = params.check === null ? undefined : normalizeCheck(params.check);
      if (JSON.stringify(check) !== JSON.stringify(current.check)) resetBaseline = true;
      if (check === undefined) delete next.check;
      else next.check = check;
    }
    if (params.sessionId === null) {
      delete next.sessionId;
      if (params.newSessionEachRun === undefined) next.newSessionEachRun = true;
    }
    if (params.sessionId != null) {
      const target = this.#targetOf(params.sessionId);
      if (target.workspaceId === undefined) delete next.workspaceId;
      else next.workspaceId = target.workspaceId;
      next.providerId = target.providerId;
      if (target.modelId === undefined) delete next.modelId;
      else next.modelId = target.modelId;
      if (target.reasoningEffort === undefined) delete next.reasoningEffort;
      else next.reasoningEffort = target.reasoningEffort;
      next.sessionId = params.sessionId;
      next.newSessionEachRun = false;
    }
    this.#checkTarget(next);
    // 换了项目，沿用的会话不再适用。
    if (next.workspaceId !== current.workspaceId && params.sessionId == null) delete next.sessionId;
    if (params.enabled === true) delete next.autoPausedAt;
    const timing =
      params.schedule !== undefined ||
      params.timezone !== undefined ||
      (params.enabled !== undefined && params.enabled !== current.enabled);
    if (params.schedule !== undefined && next.enabled) this.#checkSchedule(next.schedule, now);
    if (timing) {
      const at = next.enabled ? this.#next(next, now) : undefined;
      if (at === undefined) delete next.nextRunAt;
      else next.nextRunAt = iso(at);
    }
    next.updatedAt = iso(now);
    entry.automation = next;
    if (resetBaseline) delete entry.state.checkBaseline;
    if (params.enabled === true) delete entry.state.failures;
    await this.#save(entry);
    this.#emit({ automationId: next.id });
    return this.#view(entry);
  }

  async delete(automationId: string): Promise<void> {
    const entry = this.#entry(automationId);
    const id = entry.automation.id;
    this.#entries.delete(id);
    for (const [runId, check] of this.#checks) {
      if (check.automationId !== id) continue;
      check.abort.abort();
      this.#checks.delete(runId);
    }
    for (const [runId, active] of this.#active) {
      if (active.automationId !== id) continue;
      active.unsubscribe();
      this.#active.delete(runId);
    }
    await this.#queue(id, () => rm(this.#file(id), { force: true }));
    this.#emit({ automationId: id, deleted: true });
  }

  /** 立即运行一次（`automation.run`）。 */
  async runNow(automationId: string): Promise<AutomationRun> {
    const entry = this.#entry(automationId);
    if (this.#running(entry)) {
      throw invalid('automationId', 'a run of this automation is still in progress');
    }
    const bound = this.#boundSession(entry.automation);
    if (bound !== undefined && bound.state !== 'idle' && bound.state !== 'error') {
      throw invalid('automationId', `its session ${bound.id} is busy; try again when it is idle`);
    }
    return this.#run(entry, 'manual');
  }

  /**
   * 试跑一次检查脚本（`automation.testCheck`）：不唤醒、不记运行、不改基准。
   */
  async testCheck(params: MethodParams<'automation.testCheck'>): Promise<AutomationCheckResult> {
    const entry = params.automationId === undefined ? undefined : this.#entry(params.automationId);
    let cwd: string;
    if (params.sessionId !== undefined) {
      const session = this.#options.events.snapshot(params.sessionId)?.session;
      if (session === undefined) {
        throw new HostError('SESSION_NOT_FOUND', `session ${params.sessionId} not found`);
      }
      cwd = session.cwd;
    } else if (params.workspaceId !== undefined) {
      const workspace = this.#options.storage.workspaces.get(params.workspaceId);
      if (workspace === undefined || workspace.removedAt !== undefined) {
        throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${params.workspaceId} not found`);
      }
      cwd = this.#isChatsWorkspace(params.workspaceId) ? this.#homeDir() : workspace.rootPath;
    } else {
      cwd = entry === undefined ? this.#homeDir() : this.#checkDir(entry.automation);
    }
    const check = normalizeCheck(params.check);
    const outcome = await (this.#options.runCheck ?? runCheck)({
      command: check.command,
      cwd,
      timeoutMs: checkTimeoutMs(check),
    });
    const sameCheck =
      entry !== undefined && JSON.stringify(entry.automation.check) === JSON.stringify(check);
    return decide(check, outcome, sameCheck ? entry.state.checkBaseline : undefined).result;
  }

  /** 看一遍到点的自动化（定时器调用，测试直接调）。 */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#now();
      for (const entry of [...this.#entries.values()]) {
        const { automation } = entry;
        if (!automation.enabled || automation.nextRunAt === undefined) continue;
        const due = Date.parse(automation.nextRunAt);
        if (due > now) continue;
        await this.#due(entry, due, now).catch((error: unknown) =>
          this.#options.onWarning?.('automation run failed to start', {
            automationId: automation.id,
            error,
          }),
        );
      }
    } finally {
      this.#ticking = false;
    }
  }

  /** SessionManager 的 `onTurnFinished`：结束对应的运行。 */
  onTurnFinished(info: { sessionId: SessionId; turnId: TurnId; outcome: TurnOutcome }): void {
    for (const active of this.#active.values()) {
      if (active.sessionId !== info.sessionId || active.turnId !== info.turnId) continue;
      const answer = this.#answer(active);
      const error =
        info.outcome === 'failed'
          ? (this.#options.events.snapshot(info.sessionId)?.session.lastError?.message ??
            'The turn failed.')
          : info.outcome === 'interrupted'
            ? 'The turn was interrupted.'
            : undefined;
      this.#finish(active.automationId, active.runId, FINISHED[info.outcome], {
        ...answer,
        ...(error !== undefined && { error }),
      });
      return;
    }
  }

  // ── 内部 ─────────────────────────────────────────────────────────────

  async #due(entry: Entry, due: number, now: number): Promise<void> {
    const { automation } = entry;
    const advance = async () => {
      const at = this.#next(automation, now, true);
      if (automation.schedule.kind === 'once') automation.enabled = false;
      if (at === undefined) delete automation.nextRunAt;
      else automation.nextRunAt = iso(at);
    };
    if (this.#running(entry)) {
      await advance();
      this.#skip(entry, now, 'The previous run was still in progress.');
      return;
    }
    const late = now - due;
    if (late > CATCH_UP_MAX_MS) {
      // 错过太久：不补，算下一次。一次性的记一条“错过”。
      await advance();
      if (automation.schedule.kind === 'once') {
        this.#skip(entry, now, 'Missed while Wevir was not running.');
      } else {
        await this.#save(entry);
        this.#emit({ automationId: automation.id });
      }
      return;
    }
    // 一直发进同一个会话、而那个会话正忙（用户在用）：等它空下来，这期间不算错过。
    const bound = this.#boundSession(automation);
    if (bound !== undefined && bound.state !== 'idle' && bound.state !== 'error') return;
    await advance();
    await this.#run(entry, late > LATE_MS ? 'catch_up' : 'schedule');
  }

  /** 记一次 `skipped`；最近一条已经是 `skipped` 时只更新它的时刻。 */
  #skip(entry: Entry, now: number, reason: string): void {
    const latest = entry.runs[0];
    let run: AutomationRun;
    if (latest?.status === 'skipped' && latest.error === reason) {
      latest.startedAt = iso(now);
      latest.finishedAt = iso(now);
      run = latest;
    } else {
      run = {
        id: newId('arn'),
        automationId: entry.automation.id,
        trigger: 'schedule',
        status: 'skipped',
        startedAt: iso(now),
        finishedAt: iso(now),
        error: reason,
      };
      this.#addRun(entry, run);
    }
    void this.#save(entry);
    this.#emit({ automationId: entry.automation.id, run: { ...run } });
  }

  async #run(entry: Entry, trigger: AutomationRunTrigger): Promise<AutomationRun> {
    const { automation } = entry;
    const now = this.#now();
    const run: AutomationRun = {
      id: newId('arn'),
      automationId: automation.id,
      trigger,
      status: automation.check === undefined ? 'running' : 'checking',
      startedAt: iso(now),
    };
    this.#addRun(entry, run);
    await this.#save(entry);
    this.#emit({ automationId: automation.id, run: { ...run } });
    if (automation.check === undefined) {
      await this.#wake(entry, run);
    } else {
      // 检查脚本可能跑上几分钟：不挡住计时与 `automation.run` 的返回。
      void this.#checkThenWake(entry, run, automation.check);
    }
    return { ...run };
  }

  /** 跑检查脚本，按结论唤醒 Agent、记 `silent` 或 `failed`。 */
  async #checkThenWake(entry: Entry, run: AutomationRun, check: AutomationCheck): Promise<void> {
    const automationId = entry.automation.id;
    const abort = new AbortController();
    this.#checks.set(run.id, { automationId, abort });
    let result: AutomationCheckResult;
    const before = entry.state.checkBaseline;
    try {
      const outcome = await (this.#options.runCheck ?? runCheck)({
        command: check.command,
        cwd: this.#checkDir(entry.automation),
        timeoutMs: checkTimeoutMs(check),
        signal: abort.signal,
      });
      const decided = decide(check, outcome, entry.state.checkBaseline);
      result = decided.result;
      if (decided.baseline !== undefined) entry.state.checkBaseline = decided.baseline;
    } catch (error) {
      result = {
        decision: 'failed',
        exitCode: null,
        durationMs: 0,
        output: '',
        error: errorMessage(error),
      };
    } finally {
      this.#checks.delete(run.id);
    }
    // 跑的期间自动化删了。
    if (this.#entries.get(automationId) !== entry || abort.signal.aborted) return;
    run.check = result;
    if (result.decision === 'failed') {
      this.#finish(automationId, run.id, 'failed', { error: result.error ?? 'The check failed.' });
      return;
    }
    if (result.decision === 'silent') {
      this.#silent(entry, run);
      return;
    }
    // 等脚本的期间，沿用的会话被用户用上了：这次算跳过，基准不动，下一次照样看得出变化。
    const bound = this.#boundSession(entry.automation);
    if (bound !== undefined && bound.state !== 'idle' && bound.state !== 'error') {
      if (before === undefined) delete entry.state.checkBaseline;
      else entry.state.checkBaseline = before;
      this.#finish(automationId, run.id, 'skipped', { error: 'Its session was busy.' });
      return;
    }
    run.status = 'running';
    void this.#save(entry);
    this.#emit({ automationId, run: { ...run } });
    await this.#wake(entry, run);
  }

  /** 检查脚本判定不用唤醒：记 `silent`；上一条也是 `silent` 时并进它。 */
  #silent(entry: Entry, run: AutomationRun): void {
    const now = iso(this.#now());
    entry.state.failures = 0;
    const index = entry.runs.indexOf(run);
    const previous = index === -1 ? undefined : entry.runs[index + 1];
    let kept = run;
    if (index === 0 && previous?.status === 'silent') {
      entry.runs.splice(0, 1);
      previous.trigger = run.trigger;
      previous.startedAt = run.startedAt;
      if (run.check !== undefined) previous.check = run.check;
      kept = previous;
    }
    kept.status = 'silent';
    kept.finishedAt = now;
    void this.#save(entry);
    this.#emit({ automationId: entry.automation.id, run: { ...kept } });
  }

  /** 开会话（或用沿用的）、发出指令、盯住回合。 */
  async #wake(entry: Entry, run: AutomationRun): Promise<void> {
    const { automation } = entry;
    try {
      const sessionId = await this.#sessionFor(entry, run);
      run.sessionId = sessionId;
      const origin = this.#options.storage.sessions.get(sessionId)?.origin;
      const existingSession = !(
        origin?.kind === 'automation' && origin.automationId === automation.id
      );
      const text =
        this.#options.message?.(this.#view(entry), {
          existingSession,
          ...(run.check !== undefined && { check: run.check }),
        }) ?? automation.prompt;
      const sent = await this.#options.sessions.send(
        {
          sessionId,
          content: [{ type: 'text', text }],
          clientMessageId: run.id,
        },
        this.#options.identity,
      );
      if (sent.turnId === undefined) throw new Error('The session did not start a turn.');
      run.turnId = sent.turnId;
      this.#watch(entry, run, sessionId, sent.turnId, sent.seq);
      await this.#save(entry);
      this.#emit({ automationId: automation.id, run: { ...run } });
    } catch (error) {
      this.#finish(automation.id, run.id, 'failed', { error: errorMessage(error) });
    }
  }

  /** 这次运行发进哪个会话：沿用的会话还能用就用它，否则开一个新的。 */
  async #sessionFor(entry: Entry, run: AutomationRun): Promise<SessionId> {
    const { automation } = entry;
    const bound = this.#boundSession(automation);
    if (bound !== undefined) return bound.id;
    const session = await this.#options.sessions.create(
      {
        ...(automation.workspaceId !== undefined && { workspaceId: automation.workspaceId }),
        providerId: automation.providerId,
        ...(automation.modelId !== undefined && { modelId: automation.modelId }),
        ...(automation.reasoningEffort !== undefined && {
          reasoningEffort: automation.reasoningEffort,
        }),
        ...(automation.permissionMode !== 'on_request' && {
          permissionMode: automation.permissionMode as PermissionMode,
        }),
      },
      { automation: { automationId: automation.id, runId: run.id } },
    );
    await this.#options.sessions.rename(session.id, automation.title).catch(() => undefined);
    if (!automation.newSessionEachRun) automation.sessionId = session.id;
    return session.id;
  }

  /** 沿用的会话；不沿用、会话不在了、归档了或不能再发送时 `undefined`。 */
  #boundSession(automation: Entry['automation']): Session | undefined {
    if (automation.newSessionEachRun || automation.sessionId === undefined) return undefined;
    const record = this.#options.storage.sessions.get(automation.sessionId);
    if (record === undefined || record.archivedAt !== undefined) return undefined;
    const session = this.#options.events.snapshot(automation.sessionId)?.session;
    if (session === undefined || session.state === 'closed' || session.readOnly !== undefined) {
      return undefined;
    }
    return session;
  }

  /** 盯住回合：等用户批准或回答时是 `waiting`，处理完回到 `running`。 */
  #watch(entry: Entry, run: AutomationRun, sessionId: SessionId, turnId: TurnId, seq: number) {
    const active: ActiveRun = {
      automationId: entry.automation.id,
      runId: run.id,
      sessionId,
      turnId,
      seq,
      open: new Set(),
      unsubscribe: () => {},
    };
    this.#active.set(run.id, active);
    const subscription = this.#options.events.subscribe(sessionId, (event) => {
      const before = active.open.size;
      switch (event.type) {
        case 'approval.requested':
          if (event.payload.approval.turnId === turnId) active.open.add(event.payload.approval.id);
          break;
        case 'question.requested':
          if (event.payload.question.turnId === turnId) active.open.add(event.payload.question.id);
          break;
        case 'approval.resolved':
          active.open.delete(event.payload.approvalId);
          break;
        case 'question.resolved':
          active.open.delete(event.payload.questionId);
          break;
        default:
          return;
      }
      if ((before === 0) === (active.open.size === 0)) return;
      this.#setStatus(active, active.open.size > 0 ? 'waiting' : 'running');
    });
    active.unsubscribe = () => subscription.unsubscribe();
  }

  #setStatus(active: ActiveRun, status: 'running' | 'waiting'): void {
    const entry = this.#entries.get(active.automationId);
    const run = entry?.runs.find((candidate) => candidate.id === active.runId);
    if (entry === undefined || run === undefined || run.status === status) return;
    run.status = status;
    void this.#save(entry);
    this.#emit({ automationId: entry.automation.id, run: { ...run } });
  }

  #finish(
    automationId: AutomationId,
    runId: AutomationRun['id'],
    status: AutomationRunStatus,
    detail: { error?: string; summary?: string; quiet?: true },
  ): void {
    const active = this.#active.get(runId);
    active?.unsubscribe();
    this.#active.delete(runId);
    const entry = this.#entries.get(automationId);
    const run = entry?.runs.find((candidate) => candidate.id === runId);
    if (entry === undefined || run === undefined) return;
    run.status = status;
    run.finishedAt = iso(this.#now());
    if (detail.error !== undefined) run.error = detail.error;
    if (detail.summary !== undefined) run.summary = detail.summary;
    if (detail.quiet === true) run.quiet = true;
    if (status === 'completed') {
      entry.state.failures = 0;
      const previous = entry.runs
        .slice(entry.runs.indexOf(run) + 1)
        .find((candidate) => candidate.status === 'completed');
      if (
        previous !== undefined &&
        (previous.summary ?? '') === (run.summary ?? '') &&
        previous.quiet === run.quiet
      ) {
        run.unchanged = true;
      }
    }
    if (status === 'failed') this.#failed(entry);
    void this.#save(entry);
    this.#emit({ automationId, run: { ...run } });
  }

  /** 又失败一次；连着 `AUTOMATION_MAX_CONSECUTIVE_FAILURES` 次时停用。 */
  #failed(entry: Entry): void {
    const failures = (entry.state.failures ?? 0) + 1;
    entry.state.failures = failures;
    const { automation } = entry;
    if (failures < AUTOMATION_MAX_CONSECUTIVE_FAILURES || !automation.enabled) return;
    automation.enabled = false;
    delete automation.nextRunAt;
    automation.autoPausedAt = iso(this.#now());
    automation.updatedAt = automation.autoPausedAt;
    this.#options.onWarning?.('automation paused after repeated failures', {
      automationId: automation.id,
      failures,
    });
  }

  /** 回合最后一条回答：开头作 `summary`；以 `AUTOMATION_QUIET_MARKER` 结尾时是 `quiet`。 */
  #answer(active: ActiveRun): { summary?: string; quiet?: true } {
    let text: string | undefined;
    for (const event of this.#options.events.readSince(active.sessionId, active.seq)) {
      if (event.type === 'assistant.message' && event.payload.turnId === active.turnId) {
        text = event.payload.text;
      }
    }
    return answerOf(text ?? '');
  }

  #running(entry: Entry): boolean {
    for (const active of this.#active.values()) {
      if (active.automationId === entry.automation.id) return true;
    }
    // 在跑检查脚本，或刚记下、还在开会话的运行（还没进 #active）。
    return entry.runs.some(
      (run) => run.status === 'checking' || (run.status === 'running' && run.turnId === undefined),
    );
  }

  #addRun(entry: Entry, run: AutomationRun): void {
    entry.runs.unshift(run);
    if (entry.runs.length > AUTOMATION_RUNS_KEPT) entry.runs.length = AUTOMATION_RUNS_KEPT;
    entry.automation.runCount += 1;
  }

  /**
   * 下一次运行的时刻。`interval` 从 `from` 起算；`once` 已到点（`afterRun`）或时刻已过时没有下一次。
   */
  #next(automation: Entry['automation'], from: number, afterRun = false): number | undefined {
    if (!automation.enabled) return undefined;
    if (automation.schedule.kind === 'once') {
      if (afterRun) return undefined;
      return Date.parse(automation.schedule.at);
    }
    return nextOccurrence(automation.schedule, automation.timezone, from);
  }

  #checkSchedule(schedule: Automation['schedule'], now: number): void {
    if (schedule.kind === 'once' && Date.parse(schedule.at) <= now) {
      throw invalid('schedule', 'schedule.at is in the past');
    }
  }

  #checkTarget(target: {
    timezone: string;
    providerId: string;
    workspaceId?: string | undefined;
  }): void {
    if (!isValidTimezone(target.timezone)) {
      throw invalid('timezone', `unknown time zone ${target.timezone}`);
    }
    if (this.#options.storage.providers.get(target.providerId) === undefined) {
      throw new HostError('PROVIDER_NOT_FOUND', `provider ${target.providerId} not found`);
    }
    if (target.workspaceId === undefined) {
      if (this.#options.isChats === undefined) {
        throw invalid('workspaceId', 'this host needs a workspaceId (no chat sessions)');
      }
      return;
    }
    const workspace = this.#options.storage.workspaces.get(target.workspaceId);
    if (workspace === undefined || workspace.removedAt !== undefined) {
      throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${target.workspaceId} not found`);
    }
    if (this.#options.isChats?.(target.workspaceId) === true) {
      throw invalid('workspaceId', 'omit workspaceId to run outside a project');
    }
  }

  /** 发进已有会话时自动化的项目与模型取那个会话的（`sessionId`）。 */
  #targetOf(sessionId: SessionId): {
    workspaceId?: Automation['workspaceId'];
    providerId: Automation['providerId'];
    modelId?: string;
    reasoningEffort?: string;
  } {
    const record = this.#options.storage.sessions.get(sessionId);
    const session = this.#options.events.snapshot(sessionId)?.session;
    if (record === undefined || session === undefined) {
      throw new HostError('SESSION_NOT_FOUND', `session ${sessionId} not found`);
    }
    if (record.archivedAt !== undefined) throw invalid('sessionId', 'the session is archived');
    if (session.state === 'closed') throw invalid('sessionId', 'the session is closed');
    if (session.readOnly !== undefined || session.parentSessionId !== undefined) {
      throw invalid('sessionId', 'the session cannot take new messages');
    }
    return {
      ...(!this.#isChatsWorkspace(session.workspaceId) && { workspaceId: session.workspaceId }),
      providerId: session.providerId,
      modelId: session.modelId,
      ...(session.reasoningEffort !== undefined && { reasoningEffort: session.reasoningEffort }),
    };
  }

  /** 检查脚本在哪跑：沿用的会话的目录 > 项目目录 > 用户主目录。 */
  #checkDir(automation: Entry['automation']): string {
    const bound = this.#boundSession(automation);
    if (bound !== undefined) return bound.cwd;
    if (automation.workspaceId !== undefined) {
      const workspace = this.#options.storage.workspaces.get(automation.workspaceId);
      if (workspace !== undefined && workspace.removedAt === undefined) return workspace.rootPath;
    }
    return this.#homeDir();
  }

  #homeDir(): string {
    return this.#options.homeDir ?? homedir();
  }

  #isChatsWorkspace(workspaceId: string): boolean {
    return this.#options.isChats?.(workspaceId) === true;
  }

  #entry(automationId: string): Entry {
    const entry = this.#entries.get(automationId as AutomationId);
    if (entry === undefined) {
      throw new HostError('AUTOMATION_NOT_FOUND', `automation ${automationId} not found`);
    }
    return entry;
  }

  #view(entry: Entry): Automation {
    const latest = entry.runs[0];
    return {
      ...structuredClone(entry.automation),
      ...(latest !== undefined && { lastRun: { ...latest } }),
    };
  }

  #emit(change: AutomationChanged): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#options.onWarning?.('automation listener failed', { error });
      }
    }
  }

  #file(id: string): string {
    return join(this.#options.dir, `${id}.json`);
  }

  #save(entry: Entry): Promise<void> {
    const id = entry.automation.id;
    return this.#queue(id, async () => {
      if (!this.#entries.has(id)) return;
      await mkdir(this.#options.dir, { recursive: true, mode: 0o700 });
      const stored: StoredFile = {
        version: 1,
        automation: entry.automation,
        runs: entry.runs,
        ...(Object.keys(entry.state).length > 0 && { state: entry.state }),
      };
      const file = this.#file(id);
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    });
  }

  /** 同一个自动化的写盘排队，依次做。 */
  #queue(id: string, task: () => Promise<unknown>): Promise<void> {
    const previous = this.#writes.get(id) ?? Promise.resolve();
    const next = previous
      .then(task)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#options.onWarning?.('automation write failed', { automationId: id, error });
      });
    this.#writes.set(id, next);
    void next.then(() => {
      if (this.#writes.get(id) === next) this.#writes.delete(id);
    });
    return next;
  }
}
