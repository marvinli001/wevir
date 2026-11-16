import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import {
  ZUV_API_PROVIDER_ID,
  type ZuvApiError,
  ZuvApiErrorSchema,
  type ZuvApiState,
  ZuvApiStateSchema,
} from '@wevir/protocol';
import type { SecretStore, Storage } from '@wevir/storage';
import { mergeAccountModelSettings } from '../accounts.js';
import type { ProviderLock } from '../host-methods.js';
import { discoverZuvModels } from '../zuv-models.js';
import { ZUV_ORIGIN } from './client.js';
import { zuvOrigin } from './transport.js';

const IDENTITY = 'zuv.api.connection';
const KEY = 'zuv.api.key';
const PENDING = 'zuv.api.authorization';
const PATH = '/api/wevir/api-connection';
type Account = NonNullable<ZuvApiState['account']>;
type Login = NonNullable<ZuvApiState['login']>;
type Identity = { origin: string; account: Account; key: { id: string; prefix: string } };
type Delivery = Identity & { secret: string };
type Pending = {
  origin: string;
  verifier: string;
  login: Login;
  intervalMs: number;
  delivery?: Delivery;
};

export interface ZuvApiConnectionOptions {
  storage: Storage;
  secrets: SecretStore;
  providerLock: ProviderLock;
  applyProviders: () => Promise<void>;
  onSecret?: (secret: string) => void;
  origin?: string;
  allowLoopback?: boolean;
  fetch?: typeof fetch;
  hostName?: string;
}

class Failure extends Error {
  constructor(
    readonly code: ZuvApiError,
    readonly retryMs = 2000,
  ) {
    super(code);
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const reason = (error: unknown): ZuvApiError => (error instanceof Failure ? error.code : 'service');

export class ZuvApiConnection {
  readonly #options: ZuvApiConnectionOptions;
  readonly #origin: string;
  #identity?: Identity;
  #pending?: Pending;
  #error?: ZuvApiError;
  #modelsError?: ZuvApiError;
  #queue: Promise<unknown> = Promise.resolve();
  #timer?: ReturnType<typeof setTimeout>;
  #abort = new AbortController();
  #generation = 0;
  #closed = false;
  #lastRefresh = 0;

  constructor(options: ZuvApiConnectionOptions) {
    this.#options = options;
    this.#origin = zuvOrigin(options.origin ?? ZUV_ORIGIN, options.allowLoopback);
  }

  async load(): Promise<void> {
    const identity = await this.#options.secrets.get(IDENTITY);
    const pending = await this.#options.secrets.get(PENDING);
    if (identity) {
      const saved = JSON.parse(identity) as Identity;
      const secret = await this.#options.secrets.get(KEY);
      if (
        saved.origin !== this.#origin ||
        !secret ||
        !ZuvApiStateSchema.shape.account.unwrap().safeParse(saved.account).success
      )
        throw new Error('ZUV API credentials unreadable');
      this.#options.onSecret?.(secret);
      this.#identity = saved;
    }
    if (pending) {
      const saved = JSON.parse(pending) as Pending;
      if (saved.origin !== this.#origin || !/^[A-Za-z0-9_-]{43}$/.test(saved.verifier))
        throw new Error('ZUV API authorization unreadable');
      this.#validateLogin(saved.login);
      this.#options.onSecret?.(saved.verifier);
      if (saved.delivery) this.#options.onSecret?.(saved.delivery.secret);
      this.#pending = saved;
      this.#schedule(saved.intervalMs);
    }
  }

  get(): ZuvApiState {
    const models = this.#options.storage.providers.get(ZUV_API_PROVIDER_ID)?.models;
    return {
      status: this.#pending
        ? 'authorizing'
        : this.#identity
          ? 'connected'
          : this.#error
            ? 'error'
            : 'disconnected',
      ...(this.#pending && { login: this.#pending.login }),
      ...(this.#identity && {
        account: this.#identity.account,
        keyPrefix: this.#identity.key.prefix,
        providerId: ZUV_API_PROVIDER_ID,
        modelCount: Array.isArray(models) ? models.length : 0,
      }),
      ...(this.#error && { error: this.#error }),
      ...(this.#modelsError && { modelsError: this.#modelsError }),
    };
  }

  read(): Promise<ZuvApiState> {
    return this.#serial(async () => {
      if (this.#identity && !this.#pending && Date.now() - this.#lastRefresh >= 60_000)
        await this.#refresh(false);
      return this.get();
    });
  }

  login(): Promise<ZuvApiState> {
    return this.#serial(async () => {
      if (this.#pending && Date.parse(this.#pending.login.expiresAt) > Date.now())
        return this.get();
      await this.#clearLocal();
      this.#abort = new AbortController();
      this.#error = undefined;
      this.#modelsError = undefined;
      try {
        const verifier = randomBytes(32).toString('base64url');
        this.#options.onSecret?.(verifier);
        const response = await this.#request('/start', {
          hostName:
            (this.#options.hostName ?? hostname()).replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 100) ||
            'Wevir Host',
          verifierHash: createHash('sha256').update(verifier).digest('hex'),
        });
        const login = this.#validateLogin(response);
        const intervalMs =
          typeof response.intervalMs === 'number'
            ? Math.max(1000, Math.min(10000, response.intervalMs))
            : 2000;
        const pending: Pending = { origin: this.#origin, verifier, login, intervalMs };
        await this.#options.secrets.set(PENDING, JSON.stringify(pending));
        this.#pending = pending;
        this.#schedule(intervalMs);
      } catch (error) {
        this.#error = reason(error);
      }
      return this.get();
    });
  }

  cancel(requestId?: string): Promise<ZuvApiState> {
    if (requestId && requestId !== this.#pending?.login.requestId)
      return Promise.resolve(this.get());
    this.#interrupt();
    return this.#serial(async () => {
      const pending = this.#pending;
      this.#abort = new AbortController();
      if (pending)
        await this.#request('/cancel', {
          requestId: pending.login.requestId,
          verifier: pending.verifier,
        }).catch(() => {});
      if (pending) await this.#clearLocal();
      else await this.#options.secrets.delete(PENDING);
      this.#pending = undefined;
      this.#error = undefined;
      return this.get();
    });
  }

  disconnect(): Promise<ZuvApiState> {
    this.#interrupt();
    return this.#serial(async () => {
      await this.#clearLocal();
      this.#error = undefined;
      this.#modelsError = undefined;
      return this.get();
    });
  }

  refreshModels(): Promise<ZuvApiState> {
    return this.#serial(async () => {
      await this.#refresh(false);
      return this.get();
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#interrupt();
    await this.#queue;
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  #interrupt() {
    this.#generation++;
    clearTimeout(this.#timer);
    this.#abort.abort();
  }

  async #clearLocal() {
    this.#interrupt();
    this.#pending = undefined;
    this.#identity = undefined;
    await this.#options.providerLock(async () => {
      const provider = this.#options.storage.providers.get(ZUV_API_PROVIDER_ID);
      if (provider) {
        const { secretRef: _secret, ...rest } = provider;
        this.#options.storage.providers.update({
          ...rest,
          enabled: false,
          updatedAt: new Date().toISOString(),
        });
      }
      await this.#options.secrets.delete(KEY);
      await this.#options.secrets.delete(IDENTITY);
      await this.#options.secrets.delete(PENDING);
      await this.#options.applyProviders();
    });
  }

  #schedule(delay: number) {
    if (this.#closed) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      void this.#serial(() => this.#poll());
    }, delay);
    this.#timer.unref?.();
  }

  async #poll(): Promise<void> {
    const pending = this.#pending;
    if (!pending || this.#closed) return;
    const generation = this.#generation;
    const current = () => generation === this.#generation && !this.#closed;
    try {
      if (Date.parse(pending.login.expiresAt) <= Date.now())
        throw new Failure('authorization_expired');
      const proof = { requestId: pending.login.requestId, verifier: pending.verifier };
      if (!pending.delivery) {
        const response = await this.#request('/poll', proof);
        if (!current()) return;
        this.#error = undefined;
        if (response.state === 'pending') {
          this.#schedule(pending.intervalMs);
          return;
        }
        if (
          response.state !== 'delivered' ||
          typeof response.secret !== 'string' ||
          !/^zuv-[A-Za-z0-9]{48}$/.test(response.secret) ||
          !object(response.key) ||
          typeof response.key.id !== 'string' ||
          typeof response.key.prefix !== 'string' ||
          response.key.prefix !== response.secret.slice(0, 10) ||
          response.baseURL !== `${this.#origin}/v1`
        )
          throw new Failure('invalid_response');
        const account = ZuvApiStateSchema.shape.account.unwrap().safeParse(response.account);
        if (!account.success) throw new Failure('invalid_response');
        this.#options.onSecret?.(response.secret);
        pending.delivery = {
          origin: this.#origin,
          secret: response.secret,
          account: account.data,
          key: { id: response.key.id, prefix: response.key.prefix },
        };
        await this.#options.secrets.set(PENDING, JSON.stringify(pending));
      }
      const completed = await this.#request('/complete', proof);
      if (!current()) return;
      if (completed.state !== 'completed') throw new Failure('invalid_response');
      const { secret, ...identity } = pending.delivery;
      await this.#options.secrets.set(KEY, secret);
      await this.#options.secrets.set(IDENTITY, JSON.stringify(identity));
      await this.#options.secrets.delete(PENDING);
      if (!current()) return;
      this.#pending = undefined;
      this.#identity = identity;
      this.#error = undefined;
      await this.#refresh(true);
    } catch (error) {
      if (!current()) return;
      this.#error = reason(error);
      if (
        ['network', 'timeout', 'service', 'rate_limited', 'slow_down'].includes(this.#error) &&
        Date.parse(pending.login.expiresAt) > Date.now()
      )
        this.#schedule(
          Math.max(pending.intervalMs, error instanceof Failure ? error.retryMs : 5000),
        );
      else {
        await this.#options.secrets.delete(PENDING);
        this.#pending = undefined;
      }
    }
  }

  async #refresh(connecting: boolean) {
    if (!this.#identity) return;
    this.#lastRefresh = Date.now();
    const generation = this.#generation;
    const secret = await this.#options.secrets.get(KEY);
    if (!secret) {
      this.#error = 'invalid_api_key';
      return;
    }
    try {
      await this.#request('/check', undefined, secret);
      this.#error = undefined;
    } catch (error) {
      this.#error = reason(error);
      this.#modelsError = undefined;
      return;
    }
    const result = await discoverZuvModels(undefined, this.#options.fetch ?? fetch, {
      apiKey: secret,
      origin: this.#origin,
      signal: this.#abort.signal,
    });
    if (generation !== this.#generation || this.#closed) return;
    const models = result.models.map(({ model }) => model);
    const first = models[0];
    if (!result.ok || !first) {
      const parsed = ZuvApiErrorSchema.safeParse(result.reason);
      this.#modelsError = result.ok ? 'no_models' : parsed.success ? parsed.data : 'service';
      if (result.ok)
        await this.#options.providerLock(async () => {
          const current = this.#options.storage.providers.get(ZUV_API_PROVIDER_ID);
          if (current) {
            this.#options.storage.providers.update({
              ...current,
              models: [],
              enabled: false,
              updatedAt: new Date().toISOString(),
            });
            await this.#options.applyProviders();
          }
        });
      return;
    }
    this.#modelsError = undefined;
    try {
      await this.#options.providerLock(async () => {
        if (generation !== this.#generation || this.#closed) return;
        const current = this.#options.storage.providers.get(ZUV_API_PROVIDER_ID);
        const now = new Date().toISOString();
        const record = {
          id: ZUV_API_PROVIDER_ID,
          kind: 'openai-compatible',
          displayName: current?.displayName ?? 'ZUV API',
          api: 'openai-responses',
          baseURL: `${this.#origin}/v1`,
          secretRef: KEY,
          models: mergeAccountModelSettings(models, current?.models),
          defaultModelId:
            models.find((model) => model.id === current?.defaultModelId)?.id ?? first.id,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
          ...(!connecting && current?.enabled === false && { enabled: false }),
        };
        if (current) this.#options.storage.providers.update(record);
        else this.#options.storage.providers.insert(record);
        await this.#options.applyProviders();
      });
    } catch {
      this.#modelsError = 'service';
    }
  }

  #validateLogin(value: unknown): Login {
    const parsed = ZuvApiStateSchema.shape.login.unwrap().safeParse(value);
    if (!parsed.success) throw new Failure('invalid_response');
    const url = new URL(parsed.data.authorizationUrl);
    if (
      url.origin !== this.#origin ||
      url.pathname !== '/connect/wevir-api' ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].join(',') !== 'request' ||
      url.searchParams.get('request') !== parsed.data.requestId
    )
      throw new Failure('invalid_response');
    return parsed.data;
  }

  async #request(path: string, body?: unknown, apiKey?: string): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(15_000);
    try {
      const response = await (this.#options.fetch ?? fetch)(`${this.#origin}${PATH}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json' }),
          ...(apiKey && { authorization: `Bearer ${apiKey}` }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.any([this.#abort.signal, timeout]),
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!response.body) throw new Failure('invalid_response');
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 16384) throw new Failure('invalid_response');
        chunks.push(chunk);
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new Failure('invalid_response');
      }
      if (!object(value)) throw new Failure('invalid_response');
      if (!response.ok) {
        const parsed = ZuvApiErrorSchema.safeParse(value.error);
        const retry = Number(response.headers.get('retry-after')) * 1000;
        throw new Failure(
          parsed.success ? parsed.data : response.status === 429 ? 'rate_limited' : 'service',
          Number.isFinite(retry) && retry > 0 ? Math.min(retry, 30000) : 5000,
        );
      }
      return value;
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw new Failure(timeout.aborted ? 'timeout' : 'network');
    }
  }
}
