/**
 * 新会话从 `session.create` 到第一个 token 的本地耗时：每个新会话记下各阶段距 `session.create` 到达的毫秒数，第一个 token 到达时
 * 交出这一条和最近若干条的 p50 / p90，便于改动前后对比。只计 Host 这一侧（模型自己的耗时在 `handed` 与 `firstDelta` 之间）。
 */

/**
 * 阶段，按通常的先后：`prepared` 目录准备好（worktree 等），`rules` 规则文件与说明，`engine` 引擎会话建好，`created`
 * `session.create` 返回，`send` 第一条消息到达，`handed` 引擎收下这个回合，`firstDelta` 第一段回答（`assistant.delta` 或整条消息）。
 */
export const STARTUP_STAGES = [
  'prepared',
  'rules',
  'engine',
  'created',
  'send',
  'handed',
  'firstDelta',
] as const;
export type StartupStage = (typeof STARTUP_STAGES)[number];
export type StartupStages = Partial<Record<StartupStage, number>>;

export interface StartupTiming {
  sessionId: string;
  /** 各阶段距 `session.create` 到达的毫秒数（保留一位小数）。 */
  stages: StartupStages;
}

export interface StartupSummary {
  /** 统计里的会话数（最近的 `window` 个）。 */
  count: number;
  p50: StartupStages;
  p90: StartupStages;
}

export interface StartupTimingsOptions {
  /** 一个会话拿到第一个 token 时调用。 */
  onDone: (timing: StartupTiming, summary: StartupSummary) => void;
  now?: () => number;
  /** 统计最近多少个会话；默认 100。 */
  window?: number;
  /** 最多同时记多少个还没拿到 token 的会话，多了丢掉最早的；默认 32。 */
  maxOpen?: number;
}

export class StartupTimings {
  readonly #onDone: StartupTimingsOptions['onDone'];
  readonly #window: number;
  readonly #maxOpen: number;
  readonly #open = new Map<string, { startedAt: number; stages: StartupStages }>();
  readonly #recent: StartupStages[] = [];
  readonly now: () => number;

  constructor(options: StartupTimingsOptions) {
    this.#onDone = options.onDone;
    this.now = options.now ?? (() => performance.now());
    this.#window = options.window ?? 100;
    this.#maxOpen = options.maxOpen ?? 32;
  }

  /** 开始记一个会话；`startedAt` 是 `session.create` 到达时的 `now()`。 */
  begin(sessionId: string, startedAt: number): void {
    if (this.#open.size >= this.#maxOpen) {
      const oldest = this.#open.keys().next().value;
      if (oldest !== undefined) this.#open.delete(oldest);
    }
    this.#open.set(sessionId, { startedAt, stages: {} });
  }

  /** 记下一个阶段；同一阶段只记第一次，没在记的会话忽略。`firstDelta` 结束这个会话的记录。 */
  mark(sessionId: string, stage: StartupStage): void {
    const open = this.#open.get(sessionId);
    if (open === undefined || open.stages[stage] !== undefined) return;
    open.stages[stage] = Math.round((this.now() - open.startedAt) * 10) / 10;
    if (stage !== 'firstDelta') return;
    this.#open.delete(sessionId);
    this.#recent.push(open.stages);
    if (this.#recent.length > this.#window) this.#recent.shift();
    this.#onDone({ sessionId, stages: open.stages }, this.summary());
  }

  /** 不再记（建会话失败、回合没有回答就结束、会话关闭）。 */
  drop(sessionId: string): void {
    this.#open.delete(sessionId);
  }

  summary(): StartupSummary {
    const p50: StartupStages = {};
    const p90: StartupStages = {};
    for (const stage of STARTUP_STAGES) {
      const values = this.#recent
        .map((stages) => stages[stage])
        .filter((value) => value !== undefined)
        .sort((a, b) => a - b);
      if (values.length === 0) continue;
      p50[stage] = percentile(values, 0.5);
      p90[stage] = percentile(values, 0.9);
    }
    return { count: this.#recent.length, p50, p90 };
  }
}

/** 最近秩法：排好序的 `values` 里第 ⌈q·n⌉ 个。 */
export function percentile(values: readonly number[], q: number): number {
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(q * values.length) - 1));
  return values[index] as number;
}
