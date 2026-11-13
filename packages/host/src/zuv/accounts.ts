import { hostname } from 'node:os';
import type {
  AccountKind,
  AccountLoginMethod,
  AccountModels,
  AccountState,
  EngineAccounts,
} from '@wevir/runtime-adapter';
import type { ZuvClient } from './client.js';
import { ZuvRequestError } from './transport.js';

export class ZuvAccounts implements EngineAccounts {
  readonly kinds = ['zuv'] as const;
  readonly client: ZuvClient;
  readonly #deviceName: string;
  readonly #listeners = new Set<(state: AccountState) => void>();
  #connection: NonNullable<AccountState['zuv']>['connection'] = 'online';
  #lastError: string | undefined;
  #lastRefresh = 0;
  #reading: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #failures = 0;

  constructor(client: ZuvClient, deviceName = hostname()) {
    this.client = client;
    this.#deviceName = deviceName.slice(0, 100);
  }

  async load(): Promise<void> {
    await this.client.load();
    if (this.client.enrollment) this.#schedule(this.client.enrollment.intervalMs);
  }

  async read(_kind: AccountKind, options?: { refresh?: boolean }): Promise<AccountState> {
    if (
      this.client.signedIn &&
      !this.client.requiresLogin &&
      (options?.refresh || Date.now() - this.#lastRefresh >= 60000)
    ) {
      this.#reading ??= this.#refresh().finally(() => {
        this.#reading = undefined;
      });
      await this.#reading;
    }
    return this.#state();
  }

  async login(_kind: AccountKind, method: AccountLoginMethod): Promise<AccountState> {
    if (method !== 'browser') throw new ZuvRequestError('INVALID_REQUEST');
    clearTimeout(this.#timer);
    this.#lastError = undefined;
    this.#failures = 0;
    try {
      const started = await this.client.beginEnrollment(this.#deviceName);
      this.#connection = 'online';
      this.#schedule(started.intervalMs);
    } catch (error) {
      this.#error(error);
    }
    return this.#emit();
  }

  async cancelLogin(_kind: AccountKind, loginId?: string): Promise<AccountState> {
    if (loginId !== undefined && loginId !== this.client.enrollment?.enrollmentId)
      return this.#state();
    clearTimeout(this.#timer);
    await this.client.cancelEnrollment(loginId);
    return this.#emit();
  }

  async logout(_kind: AccountKind): Promise<AccountState> {
    clearTimeout(this.#timer);
    await this.client.logout();
    this.#lastError = undefined;
    this.#connection = 'online';
    return this.#emit();
  }

  async models(_kind: AccountKind): Promise<AccountModels> {
    if (this.client.entitlements?.subscriptionState !== 'active') return { models: [] };
    const ids = await this.client.models();
    return {
      models: ids.map((id) => ({ id })),
      ...(ids[0] !== undefined && { defaultModelId: ids[0] }),
    };
  }

  async refreshUsage(kind: AccountKind): Promise<void> {
    await this.read(kind, { refresh: true });
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#listeners.clear();
    await this.client.close();
  }

  async #refresh(): Promise<void> {
    this.#lastRefresh = Date.now();
    try {
      await this.client.getEntitlements();
      this.#connection = 'online';
      this.#lastError = undefined;
    } catch (error) {
      this.#error(error);
    }
    this.#emit();
  }

  #schedule(delay: number): void {
    if (this.#closed) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      void this.#poll();
    }, delay);
    this.#timer.unref?.();
  }

  async #poll(): Promise<void> {
    try {
      const result = await this.client.pollEnrollment();
      if (this.#closed) return;
      this.#failures = 0;
      this.#lastError = undefined;
      this.#connection = 'online';
      if (result.state === 'pending') this.#schedule(result.retryAfterMs);
      else await this.#refresh();
    } catch (error) {
      if (this.#closed) return;
      this.#error(error);
      const pending = this.client.enrollment;
      const retryable =
        error instanceof ZuvRequestError &&
        ['NETWORK_ERROR', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'BUDGET_PAUSED'].includes(
          error.code,
        );
      if (pending && retryable && Date.parse(pending.expiresAt) > Date.now()) {
        const delay = Math.max(
          pending.intervalMs,
          error instanceof ZuvRequestError ? (error.retryAfterMs ?? 0) : 0,
          Math.min(30000, 1000 * 2 ** Math.min(++this.#failures, 5)) + Math.random() * 1000,
        );
        this.#schedule(delay);
      } else await this.client.cancelEnrollment(pending?.enrollmentId);
    }
    this.#emit();
  }

  #error(error: unknown): void {
    this.#lastError = error instanceof ZuvRequestError ? error.code : 'SERVICE_UNAVAILABLE';
    this.#connection =
      error instanceof ZuvRequestError && error.code === 'DEVICE_REVOKED'
        ? 'revoked'
        : this.client.requiresLogin
          ? 'reauthorization_required'
          : 'offline';
  }

  #state(): AccountState {
    const enrollment = this.client.enrollment;
    const entitlements = this.client.entitlements;
    const connection =
      this.client.blockedReason === 'DEVICE_REVOKED'
        ? 'revoked'
        : this.client.requiresLogin
          ? 'reauthorization_required'
          : this.#connection;
    return {
      kind: 'zuv',
      status: enrollment
        ? 'signing_in'
        : this.client.signedIn && !this.client.requiresLogin
          ? 'signed_in'
          : 'signed_out',
      signIn: 'in_app',
      loginMethods: ['browser'],
      ...(enrollment && {
        login: {
          loginId: enrollment.enrollmentId,
          method: 'browser',
          authUrl: enrollment.verificationUri,
          startedAt: this.client.enrollmentStartedAt as string,
        },
      }),
      ...(this.#lastError && { lastError: this.#lastError }),
      zuv: {
        connection,
        ...(entitlements && {
          subscriptionState: entitlements.subscriptionState,
          syncState: entitlements.syncState,
          quota: entitlements.quota,
          retentionUntil: entitlements.retentionUntil,
          recoveryEligible: entitlements.recovery.eligible,
        }),
      },
    };
  }

  #emit(): AccountState {
    const state = this.#state();
    for (const listener of this.#listeners) {
      try {
        listener(state);
      } catch {
        /* EngineAccounts observers are isolated. */
      }
    }
    return state;
  }
}
