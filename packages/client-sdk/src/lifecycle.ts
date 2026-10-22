// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/src/react-app/domains/session/sync/sync-stream-lifecycle.ts
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：改写为 Host 连接的重连状态机。保留阶段划分、两套指数退避（普通 1 s → 10 s，鉴权类 5 s → 60 s）、
// 同一时刻只有一个重试计时器、“换代”（reconnectNow）时重置退避并立即重连、换代前发起的尝试报的鉴权失败
// 按普通失败处理。阶段改为 connecting / connected / reconnecting / closed，去掉 auth-blocked 与 stale
// （归入 reconnecting 的 reason）；订阅 SSE 改为一次“建立传输 + host.hello”的尝试，连接断开由调用方报告；
// 静默看门狗移到每条连接上（rpc-channel.ts 的心跳超时）；新增不可恢复的失败（直接 closed）、首次连接
// 失败即 closed 并 reject；去掉诊断历史。

import { ClientClosedError } from './errors.js';

/** 进入 `reconnecting` 的原因。 */
export type ReconnectReason =
  /** 连接断开，或连不上。 */
  | 'connection_lost'
  /** 心跳超时：太久没有收到 Host 的任何一帧。 */
  | 'heartbeat_timeout'
  /** 连接与握手没有在时限内完成。 */
  | 'connect_timeout'
  /** 令牌被拒（Host 重启换了令牌）；走慢速退避。 */
  | 'unauthorized'
  /** 找不到可连的 Host（`run/host.json` 不存在或还没写入端点）。 */
  | 'host_unavailable';

/** 一次失败怎么处理：按普通或鉴权类退避重试，或不可恢复（进入 closed）。 */
export type FailureClass = { retry: 'normal' | 'auth'; reason: ReconnectReason } | { retry: false };

export interface BackoffOptions {
  /** 普通失败的首次重试延迟，之后每次翻倍。默认 1000。 */
  initialDelayMs: number;
  /** 普通失败的重试延迟上限。默认 10000。 */
  maxDelayMs: number;
  /** 鉴权类失败的首次重试延迟。默认 5000。 */
  authInitialDelayMs: number;
  /** 鉴权类失败的重试延迟上限。默认 60000。 */
  authMaxDelayMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialDelayMs: 1_000,
  maxDelayMs: 10_000,
  authInitialDelayMs: 5_000,
  authMaxDelayMs: 60_000,
};

export type LifecycleState<C> =
  | { phase: 'connecting' }
  | { phase: 'connected'; connection: C }
  | {
      phase: 'reconnecting';
      /** 自上次连上以来连续失败的次数，从 1 开始。 */
      attempt: number;
      /** 距下一次尝试的延迟。 */
      delayMs: number;
      reason: ReconnectReason;
      error?: unknown;
    }
  | { phase: 'closed'; error?: unknown };

export interface LifecycleOptions<C> {
  /** 一次连接尝试：建立传输并完成握手。`signal` 中止（`close()`）时应尽快 reject。 */
  attempt(signal: AbortSignal): Promise<C>;
  /** 尝试成功、但生命周期已经关闭时，丢弃这条连接。 */
  discard(connection: C): void;
  classify(error: unknown): FailureClass;
  /** 同步调用；`connected` 先于该连接上的任何后续动作。 */
  onStateChange(state: LifecycleState<C>): void;
  backoff: BackoffOptions;
}

/**
 * 连接的生命周期：`connecting` →（首次尝试）→ `connected` ⇄ `reconnecting` → `closed`。
 *
 * - 首次尝试失败直接 `closed`，`start()` 以该错误 reject：调用方（CLI）据此报“Host 没有运行”等。
 * - 连上之后断开（`lost()`）按普通退避重试；尝试失败按 `classify` 的结果选择普通或慢速（鉴权类）退避，
 *   不可恢复的失败进入 `closed`。连上即重置两套退避。
 * - `reconnectNow()`：端点或令牌可能变了（例如桌面得知 Host 重启），重置退避；没有连接、也没有尝试在跑
 *   时立即尝试。
 */
export class ConnectionLifecycle<C> {
  readonly #options: LifecycleOptions<C>;
  #state: LifecycleState<C> = { phase: 'connecting' };
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** 正在进行的尝试。 */
  #attempt: AbortController | undefined;
  #retryDelayMs: number;
  #authRetryDelayMs: number;
  #failures = 0;
  #generation = 0;
  #started = false;

  constructor(options: LifecycleOptions<C>) {
    this.#options = options;
    this.#retryDelayMs = options.backoff.initialDelayMs;
    this.#authRetryDelayMs = options.backoff.authInitialDelayMs;
  }

  get state(): LifecycleState<C> {
    return this.#state;
  }

  /** 首次连接。失败时生命周期进入 `closed` 并以该错误 reject。只能调用一次。 */
  async start(): Promise<C> {
    if (this.#started) throw new Error('ConnectionLifecycle.start() 只能调用一次');
    this.#started = true;
    this.#options.onStateChange(this.#state);
    const result = await this.#run(true);
    if (!result.ok) throw result.error;
    return result.connection;
  }

  /** 已连上的 `connection` 断开了。不是当前连接时忽略。`kind` 是这次断开的退避（默认普通）。 */
  lost(
    connection: C,
    reason: ReconnectReason,
    error?: unknown,
    kind: 'normal' | 'auth' = 'normal',
  ): void {
    if (this.#state.phase !== 'connected' || this.#state.connection !== connection) return;
    this.#scheduleRetry(kind, reason, error);
  }

  reconnectNow(): void {
    if (this.#state.phase === 'closed' || !this.#started) return;
    this.#generation += 1;
    // 换代之后，之前的失败不再能预测下一次尝试。
    this.#retryDelayMs = this.#options.backoff.initialDelayMs;
    this.#authRetryDelayMs = this.#options.backoff.authInitialDelayMs;
    if (this.#state.phase === 'connected' || this.#attempt) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    void this.#run(false);
  }

  /** 进入 `closed`（`error` 为不可恢复的原因，主动关闭时不给）。可重复调用。 */
  close(error?: unknown): void {
    if (this.#state.phase === 'closed') return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    const attempt = this.#attempt;
    this.#attempt = undefined;
    this.#setState(error === undefined ? { phase: 'closed' } : { phase: 'closed', error });
    attempt?.abort(new ClientClosedError(error));
  }

  async #run(
    initial: boolean,
  ): Promise<{ ok: true; connection: C } | { ok: false; error: unknown }> {
    const controller = new AbortController();
    this.#attempt = controller;
    const generation = this.#generation;
    try {
      const connection = await this.#options.attempt(controller.signal);
      if (this.#attempt !== controller) {
        // 尝试期间被关闭了。
        this.#options.discard(connection);
        return { ok: false, error: controller.signal.reason };
      }
      this.#attempt = undefined;
      this.#retryDelayMs = this.#options.backoff.initialDelayMs;
      this.#authRetryDelayMs = this.#options.backoff.authInitialDelayMs;
      this.#failures = 0;
      this.#setState({ phase: 'connected', connection });
      return { ok: true, connection };
    } catch (error) {
      if (this.#attempt !== controller) return { ok: false, error };
      this.#attempt = undefined;
      const failure = this.#options.classify(error);
      if (initial || failure.retry === false) {
        this.close(error);
        return { ok: false, error };
      }
      // 换代期间发起的尝试报的鉴权失败，说明的是上一代的令牌。
      const kind =
        failure.retry === 'auth' && generation !== this.#generation ? 'normal' : failure.retry;
      this.#scheduleRetry(kind, failure.reason, error);
      return { ok: false, error };
    }
  }

  #scheduleRetry(kind: 'normal' | 'auth', reason: ReconnectReason, error: unknown): void {
    if (this.#state.phase === 'closed' || this.#retryTimer) return;
    const delayMs = kind === 'auth' ? this.#authRetryDelayMs : this.#retryDelayMs;
    if (kind === 'auth') {
      this.#authRetryDelayMs = Math.min(
        this.#authRetryDelayMs * 2,
        this.#options.backoff.authMaxDelayMs,
      );
    } else {
      this.#retryDelayMs = Math.min(this.#retryDelayMs * 2, this.#options.backoff.maxDelayMs);
    }
    this.#failures += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#run(false);
    }, delayMs);
    this.#setState({
      phase: 'reconnecting',
      attempt: this.#failures,
      delayMs,
      reason,
      ...(error === undefined ? {} : { error }),
    });
  }

  #setState(state: LifecycleState<C>): void {
    this.#state = state;
    this.#options.onStateChange(state);
  }
}
