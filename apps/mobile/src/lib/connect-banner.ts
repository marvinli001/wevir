// 顶部的连接浮窗：App 启动、回到前台或连接断了、正在连电脑或读会话列表时显示“正在连接”，连上并读到列表后收起；这一轮没连上时短暂显示
// 离线原因；之后在后台的自动重试不再弹出，等它连上时短暂显示“已连接”。
//
// 很快就连上的不显示（出现前先等 `BANNER_SHOW_DELAY_MS`）；显示了就至少停 `BANNER_MIN_SHOW_MS`，不一闪而过。计时器由环境注入（测试用假的）。

import type { LinkSnapshot, OfflineReason } from './computer-link';
import { displayName } from './records';

/** 连了这么久还没好才显示。 */
export const BANNER_SHOW_DELAY_MS = 600;
/** “正在连接”显示后至少停多久。 */
export const BANNER_MIN_SHOW_MS = 1_200;
/** 离线原因与“已连接”停多久。 */
export const BANNER_RESULT_MS = 2_500;

/** `names` 是那几台电脑的显示名称（`displayName`）。 */
export type BannerView =
  /** `loading`：都已连上，只在读会话列表。 */
  | { kind: 'connecting'; stage: 'connecting' | 'loading'; names: readonly string[] }
  /** `reason`：各台原因相同时给出，不同时没有。 */
  | { kind: 'offline'; reason?: OfflineReason; names: readonly string[] }
  | { kind: 'connected'; names: readonly string[] };

export interface BannerEnvironment {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

type Phase = 'idle' | 'connecting' | 'loading' | 'online' | 'offline';

function phaseOf(snapshot: LinkSnapshot): Phase {
  switch (snapshot.status.kind) {
    case 'paused':
    case 'removed':
      return 'idle';
    case 'connecting':
      return 'connecting';
    case 'offline':
      return 'offline';
    case 'online': {
      const { sessions } = snapshot;
      // 缓存的列表（`cachedAt`）在连上后还要换成新读的。
      const loading =
        sessions.kind === 'none' ||
        sessions.kind === 'loading' ||
        (sessions.kind === 'ready' && sessions.cachedAt !== undefined);
      return loading ? 'loading' : 'online';
    }
  }
}

interface Track {
  /** 这一轮连接没连上，此后还没连上过：它的自动重试不弹出。 */
  quiet: boolean;
  /** 这一轮在显示“正在连接”的范围里。 */
  busy: boolean;
}

interface Busy {
  name: string;
  phase: 'connecting' | 'loading';
}

type TimerKind = 'delay' | 'settle' | 'result';

interface Outcome {
  failed: Map<string, OfflineReason>;
  reconnected: Set<string>;
}

export class ConnectBanner {
  readonly #env: BannerEnvironment;
  readonly #listeners = new Set<() => void>();
  readonly #tracks = new Map<string, Track>();
  /** 记录名称 → 显示名称。 */
  readonly #labels = new Map<string, string>();
  #view: BannerView | undefined;
  #shownAt = 0;
  /** 正在连的（不算安静重试的）：名称与阶段。 */
  #busy: Busy[] = [];
  /** 这一轮攒下的结果，“正在连接”收起时显示。 */
  #outcome: Outcome = { failed: new Map(), reconnected: new Set() };
  #timer: unknown;
  #timerKind: TimerKind | undefined;

  constructor(env: BannerEnvironment) {
    this.#env = env;
  }

  get view(): BannerView | undefined {
    return this.#view;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 电脑列表变了（每次 `ComputerRegistry` 通知都给）。 */
  update(snapshots: readonly LinkSnapshot[]): void {
    this.#track(snapshots);
    if (this.#busy.length > 0) {
      this.#whileBusy();
      return;
    }
    if (this.#view?.kind === 'connecting') {
      // 已经显示了：停够了再换成结果或收起（`#settle` 时取结果，停的这段里攒下的也算）。
      if (this.#timerKind !== 'settle') {
        const wait = this.#shownAt + BANNER_MIN_SHOW_MS - this.#env.now();
        if (wait > 0) this.#schedule('settle', wait, () => this.#settle());
        else this.#settle();
      }
      return;
    }
    const outcome = this.#takeOutcome();
    if (outcome !== undefined) {
      this.#showResult(outcome);
      return;
    }
    // 很快就连上了：不显示。
    if (this.#timerKind === 'delay') this.#cancel();
  }

  /** 不再跟着电脑列表时：停掉计时器（显示的样子不变，再 `update` 时接着算）。 */
  dispose(): void {
    this.#cancel();
  }

  #track(snapshots: readonly LinkSnapshot[]): void {
    const seen = new Set<string>();
    const busy: Busy[] = [];
    for (const snapshot of snapshots) {
      const { name } = snapshot.record;
      seen.add(name);
      this.#labels.set(name, displayName(snapshot.record));
      const phase = phaseOf(snapshot);
      const track = this.#tracks.get(name) ?? { quiet: false, busy: false };
      switch (phase) {
        case 'idle':
          // 进后台或已移除：下次回到前台重新算一轮。
          this.#tracks.set(name, { quiet: false, busy: false });
          this.#outcome.failed.delete(name);
          this.#outcome.reconnected.delete(name);
          break;
        case 'connecting':
        case 'loading':
          if (track.quiet) break;
          this.#tracks.set(name, { quiet: false, busy: true });
          busy.push({ name, phase });
          break;
        case 'online':
          if (track.quiet) {
            this.#outcome.failed.delete(name);
            this.#outcome.reconnected.add(name);
          }
          this.#tracks.set(name, { quiet: false, busy: false });
          break;
        case 'offline':
          if (track.busy && snapshot.status.kind === 'offline')
            this.#outcome.failed.set(name, snapshot.status.reason);
          this.#tracks.set(name, { quiet: true, busy: false });
          break;
      }
    }
    for (const name of [...this.#tracks.keys()]) {
      if (seen.has(name)) continue;
      this.#tracks.delete(name);
      this.#labels.delete(name);
      this.#outcome.failed.delete(name);
      this.#outcome.reconnected.delete(name);
    }
    this.#busy = busy;
  }

  #connectingView(): BannerView {
    return {
      kind: 'connecting',
      stage: this.#busy.every((b) => b.phase === 'loading') ? 'loading' : 'connecting',
      names: this.#busy.map((b) => this.#label(b.name)),
    };
  }

  #whileBusy(): void {
    if (this.#view?.kind === 'connecting') {
      if (this.#timerKind === 'settle') this.#cancel();
      this.#set(this.#connectingView(), false);
      return;
    }
    if (this.#view !== undefined) {
      // 正显示离线或“已连接”：直接换成“正在连接”，不再等。
      this.#cancel();
      this.#set(this.#connectingView(), true);
      return;
    }
    if (this.#timerKind === 'delay') return;
    this.#schedule('delay', BANNER_SHOW_DELAY_MS, () => {
      if (this.#busy.length > 0) this.#set(this.#connectingView(), true);
    });
  }

  #settle(): void {
    const outcome = this.#takeOutcome();
    if (outcome !== undefined) this.#showResult(outcome);
    else this.#set(undefined, false);
  }

  #showResult(outcome: Outcome): void {
    this.#cancel();
    this.#set(
      resultView(outcome, (name) => this.#label(name)),
      true,
    );
    this.#schedule('result', BANNER_RESULT_MS, () => this.#set(undefined, false));
  }

  /** 取走攒下的结果；没有时 `undefined`。 */
  #takeOutcome(): Outcome | undefined {
    const outcome = this.#outcome;
    if (outcome.failed.size === 0 && outcome.reconnected.size === 0) return undefined;
    this.#outcome = { failed: new Map(), reconnected: new Set() };
    return outcome;
  }

  #label(name: string): string {
    return this.#labels.get(name) ?? name;
  }

  #schedule(kind: TimerKind, ms: number, run: () => void): void {
    this.#cancel();
    this.#timerKind = kind;
    this.#timer = this.#env.setTimer(() => {
      this.#timer = undefined;
      this.#timerKind = undefined;
      run();
    }, ms);
  }

  #cancel(): void {
    if (this.#timer !== undefined) this.#env.clearTimer(this.#timer);
    this.#timer = undefined;
    this.#timerKind = undefined;
  }

  #set(view: BannerView | undefined, appeared: boolean): void {
    if (appeared) this.#shownAt = this.#env.now();
    if (sameView(this.#view, view)) return;
    this.#view = view;
    for (const listener of [...this.#listeners]) listener();
  }
}

/** 有没连上的就只报离线，否则报重新连上的。 */
function resultView({ failed, reconnected }: Outcome, label: (name: string) => string): BannerView {
  if (failed.size > 0) {
    const reasons = new Set(failed.values());
    const [reason] = reasons;
    return {
      kind: 'offline',
      ...(reasons.size === 1 && reason !== undefined && { reason }),
      names: [...failed.keys()].map(label),
    };
  }
  return { kind: 'connected', names: [...reconnected].map(label) };
}

function sameView(a: BannerView | undefined, b: BannerView | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'connecting' && b.kind === 'connecting' && a.stage !== b.stage) return false;
  if (a.kind === 'offline' && b.kind === 'offline' && a.reason !== b.reason) return false;
  return a.names.length === b.names.length && a.names.every((name, i) => name === b.names[i]);
}
