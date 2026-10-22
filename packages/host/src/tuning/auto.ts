// 自动调优的后台生成（0.108.0，设置 `autoTuning`，domain-model §3.50，ADR-0018）。
//
// 项目里的顶层会话（不是子会话或支线，不在“对话”或已移除的项目里）一个回合结束后空闲满 `AUTO_TUNING_IDLE_MS`，或者被关闭、归档时，
// 满足这几条就用这个会话的模型生成一次（ProposalService.generate，来源 `auto`）：开关开着、本月后台生成没到上限、这个项目没有进行中的
// 试用、自这个会话上次自动生成以来又完成了至少 `AUTO_TUNING_MIN_TURNS` 个回合、这个项目距上次自动生成至少
// `AUTO_TUNING_WORKSPACE_INTERVAL_MS`、这个项目此刻没有别的生成在跑。生成要用引擎会话，所以关闭与归档在关掉引擎会话之前生成，关闭等它
// 结束。计时只在内存里，Host 重启后丢掉、不补跑。每个回合结束时还顺便核对这个项目的试用（TrialService.evaluate）。

import type { HostSettings, SessionId } from '@wevir/protocol';
import type { Storage, WorkspaceRecord } from '@wevir/storage';
import { isTopLevel } from './metrics.js';
import type { TrialService } from './trials.js';

/** 回合结束后空闲多久生成。 */
export const AUTO_TUNING_IDLE_MS = 10 * 60_000;
/** 同一会话两次自动生成之间至少完成几个回合。 */
export const AUTO_TUNING_MIN_TURNS = 2;
/** 同一项目两次自动生成之间至少隔多久。 */
export const AUTO_TUNING_WORKSPACE_INTERVAL_MS = 30 * 60_000;

export interface AutoTunerOptions {
  storage: Pick<Storage, 'sessions' | 'workspaces' | 'tuningRuns'>;
  settings: () => HostSettings;
  trials: Pick<TrialService, 'budget' | 'hasTrial' | 'evaluate'>;
  /** 后台生成一次（`ProposalService.generate`，来源 `auto`）。 */
  generate: (sessionId: SessionId) => Promise<unknown>;
  isChats?: (workspace: Pick<WorkspaceRecord, 'rootPath'>) => boolean;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class AutoTuner {
  readonly #options: AutoTunerOptions;
  readonly #now: () => Date;
  readonly #setTimer: (callback: () => void, ms: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;
  readonly #timers = new Map<string, unknown>();
  /** 正在生成的项目。 */
  readonly #running = new Set<string>();
  #disposed = false;

  constructor(options: AutoTunerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#setTimer =
      options.setTimer ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref?.();
        return timer;
      });
    this.#clearTimer =
      options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  /** 回合结束：项目里的顶层会话重新开始计空闲；核对这个项目的试用。 */
  onTurnFinished(sessionId: SessionId): void {
    if (this.#disposed) return;
    const workspace = this.#workspaceOf(sessionId);
    if (workspace === undefined) return;
    void this.#options.trials
      .evaluate(workspace.id)
      .catch((error: unknown) =>
        this.#options.onWarning?.('调优试用核对失败', { workspaceId: workspace.id, error }),
      );
    this.#cancel(sessionId);
    this.#timers.set(
      sessionId,
      this.#setTimer(() => {
        this.#timers.delete(sessionId);
        void this.run(sessionId);
      }, AUTO_TUNING_IDLE_MS),
    );
  }

  /** 关闭或归档之前：不再等空闲，满足条件就现在生成（关闭等它结束）。 */
  async beforeClose(sessionId: SessionId): Promise<void> {
    const pending = this.#timers.has(sessionId);
    this.#cancel(sessionId);
    if (pending) await this.run(sessionId);
  }

  /** 会话删掉了：丢掉计时。 */
  forget(sessionIds: readonly string[]): void {
    for (const id of sessionIds) this.#cancel(id);
  }

  dispose(): void {
    this.#disposed = true;
    for (const id of [...this.#timers.keys()]) this.#cancel(id);
  }

  /** 满足条件就生成一次；返回有没有生成。 */
  async run(sessionId: SessionId): Promise<boolean> {
    if (this.#disposed || !this.#eligible(sessionId)) return false;
    const workspaceId = this.#workspaceOf(sessionId)?.id as string;
    this.#running.add(workspaceId);
    try {
      await this.#options.generate(sessionId);
      return true;
    } catch (error) {
      this.#options.onWarning?.('后台生成调优建议失败', { sessionId, error });
      return false;
    } finally {
      this.#running.delete(workspaceId);
    }
  }

  #eligible(sessionId: SessionId): boolean {
    const { settings, trials, storage } = this.#options;
    if (settings().autoTuning !== true) return false;
    const workspace = this.#workspaceOf(sessionId);
    if (workspace === undefined || this.#running.has(workspace.id)) return false;
    if (trials.hasTrial(workspace.id) || trials.budget().exhausted) return false;
    const lastInWorkspace = storage.tuningRuns.latest({
      workspaceId: workspace.id,
      origin: 'auto',
    });
    if (
      lastInWorkspace !== undefined &&
      this.#now().getTime() - Date.parse(lastInWorkspace.createdAt) <
        AUTO_TUNING_WORKSPACE_INTERVAL_MS
    ) {
      return false;
    }
    const lastInSession = storage.tuningRuns.latest({ sessionId, origin: 'auto' });
    const turns = storage.tuningRuns.turnsSince(sessionId, lastInSession?.createdAt ?? '');
    return turns >= AUTO_TUNING_MIN_TURNS;
  }

  /** 会话所在的项目；不是顶层会话、在“对话”里或项目已移除时 undefined。 */
  #workspaceOf(sessionId: SessionId): WorkspaceRecord | undefined {
    const { storage } = this.#options;
    const session = storage.sessions.get(sessionId);
    if (session === undefined || !isTopLevel(session)) return undefined;
    const workspace = storage.workspaces.get(session.workspaceId);
    if (
      workspace === undefined ||
      workspace.removedAt !== undefined ||
      this.#options.isChats?.(workspace) === true
    ) {
      return undefined;
    }
    return workspace;
  }

  #cancel(sessionId: string): void {
    const timer = this.#timers.get(sessionId);
    if (timer === undefined) return;
    this.#clearTimer(timer);
    this.#timers.delete(sessionId);
  }
}
