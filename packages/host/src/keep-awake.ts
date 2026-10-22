import type { HostSettings, SessionId, SessionState, WevirEvent } from '@wevir/protocol';

interface SessionActivity {
  state: SessionState;
  /** 还没回答的问题：有的话回合在等用户，不算在跑。 */
  questions: Set<string>;
}

/**
 * 防休眠的判定（0.102.0，domain-model §3.45，ADR-0017 §5）：`keepAwake = preventSleep && (有回合在跑 || 有保持请求)`。
 *
 * “有回合在跑”照桌面端原来的判定：某个会话 `running` 且没有未答的问题，或 `cancelling`；等审批、等回答不算。状态从会话事件
 * （`session.state_changed`、`question.requested` / `question.resolved`）逐个会话记下，不扫全部会话；Host 启动时没有回合在跑。
 * `hold()` 是内部入口，留给下一阶段的“有远程设备连着”。值变了时通知 `watch` 的监听者（`power.changed`）。
 */
export class KeepAwake {
  readonly #sessions = new Map<SessionId, SessionActivity>();
  readonly #holds = new Map<symbol, string>();
  readonly #listeners = new Set<(keepAwake: boolean) => void>();
  #preventSleep: boolean;
  #running = 0;
  #value: boolean;

  constructor(settings: Pick<HostSettings, 'preventSleep'>) {
    this.#preventSleep = settings.preventSleep === true;
    this.#value = this.#compute();
  }

  get keepAwake(): boolean {
    return this.#value;
  }

  /** 设置变了（`HostSettingsStore.watch`）。 */
  settingsChanged(settings: Pick<HostSettings, 'preventSleep'>): void {
    this.#preventSleep = settings.preventSleep === true;
    this.#update();
  }

  /** 会话事件（`EventStore.listenAll`）。 */
  onEvent(event: WevirEvent): void {
    if (
      event.type !== 'session.state_changed' &&
      event.type !== 'question.requested' &&
      event.type !== 'question.resolved'
    ) {
      return;
    }
    const before = this.#isRunning(this.#sessions.get(event.sessionId));
    let activity = this.#sessions.get(event.sessionId);
    if (event.type === 'session.state_changed') {
      const state = event.payload.to;
      if (state === 'running' || state === 'awaiting_approval') {
        activity ??= { state, questions: new Set() };
        activity.state = state;
        this.#sessions.set(event.sessionId, activity);
      } else if (state === 'cancelling') {
        // 取消中算在跑，不管还有没有没回答的问题。
        this.#sessions.set(event.sessionId, { state, questions: new Set() });
      } else {
        // 回合结束（idle、error、closed）：不再记这个会话，没回答的问题随回合作废。
        this.#sessions.delete(event.sessionId);
      }
    } else if (activity !== undefined) {
      if (event.type === 'question.requested') activity.questions.add(event.payload.question.id);
      else activity.questions.delete(event.payload.questionId);
    }
    const after = this.#isRunning(this.#sessions.get(event.sessionId));
    if (before === after) return;
    this.#running += after ? 1 : -1;
    this.#update();
  }

  /** 内部的保持请求（下一阶段：有远程设备连着）；返回释放函数，可重复调用。 */
  hold(reason: string): () => void {
    const key = Symbol(reason);
    this.#holds.set(key, reason);
    this.#update();
    return () => {
      if (this.#holds.delete(key)) this.#update();
    };
  }

  /** `keepAwake` 变了时调用 `listener`。返回退订函数。 */
  watch(listener: (keepAwake: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #isRunning(activity: SessionActivity | undefined): boolean {
    if (activity === undefined) return false;
    return (
      (activity.state === 'running' && activity.questions.size === 0) ||
      activity.state === 'cancelling'
    );
  }

  #compute(): boolean {
    return this.#preventSleep && (this.#running > 0 || this.#holds.size > 0);
  }

  #update(): void {
    const next = this.#compute();
    if (next === this.#value) return;
    this.#value = next;
    for (const listener of [...this.#listeners]) listener(next);
  }
}
