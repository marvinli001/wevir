import { randomBytes } from 'node:crypto';
import { jcs, schemas } from '@wevir/protocol/sync';
import type { SecretStore } from '@wevir/storage';
import { sha256 } from '../sync/crypto.js';
import {
  deviceProof,
  newZuvDeviceKey,
  type ZuvDeviceKey,
  ZuvRequestError,
  ZuvTransport,
  type ZuvTransportOptions,
} from './transport.js';

export const ZUV_ORIGIN = 'https://zuv.wevir.si';
const IDENTITY_SECRET = 'zuv.identity';
const ENROLLMENT_SECRET = 'zuv.enrollment';
type Entitlements = typeof schemas.entitlements._output;
type Enrollment = typeof schemas.enrollmentStarted._output;
interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
interface Identity {
  v: 1;
  origin: string;
  key: ZuvDeviceKey;
  deviceId: string;
  tokens: Tokens;
  refreshPending?: boolean;
  blocked?: 'AUTH_REQUIRED' | 'DEVICE_REVOKED';
  entitlements?: Entitlements;
}
interface PendingEnrollment {
  v: 1;
  origin: string;
  key: ZuvDeviceKey;
  verifier: string;
  started: Enrollment;
  startedAt: string;
}

export interface ZuvClientOptions extends Omit<ZuvTransportOptions, 'origin'> {
  origin?: string;
  secrets: SecretStore;
  onSecret?: (secret: string) => void;
  onIdentityChanging?: () => void | Promise<void>;
}

export class ZuvClient {
  readonly transport: ZuvTransport;
  readonly #options: ZuvClientOptions;
  #identity: Identity | undefined;
  #pending: PendingEnrollment | undefined;
  #refreshing: Promise<string> | undefined;
  #generation = 0;
  #identityTransitions = 0;
  #closed = false;
  readonly #abort = new AbortController();
  readonly #writes = new Set<Promise<unknown>>();

  constructor(options: ZuvClientOptions) {
    this.#options = options;
    this.transport = new ZuvTransport({
      ...options,
      origin: options.origin ?? ZUV_ORIGIN,
      signal: options.signal
        ? AbortSignal.any([options.signal, this.#abort.signal])
        : this.#abort.signal,
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#generation++;
    this.#abort.abort();
    await Promise.allSettled(this.#writes);
  }

  get deviceId(): string | undefined {
    return this.#identity?.deviceId;
  }
  get entitlements(): Entitlements | undefined {
    return this.#identity?.entitlements;
  }
  get signedIn(): boolean {
    return this.#identity !== undefined;
  }
  get changingIdentity(): boolean {
    return this.#identityTransitions > 0;
  }
  get requiresLogin(): boolean {
    return this.#identity?.refreshPending === true || this.#identity?.blocked !== undefined;
  }
  get blockedReason(): 'AUTH_REQUIRED' | 'DEVICE_REVOKED' | undefined {
    return this.#identity?.blocked;
  }
  get enrollment(): Enrollment | undefined {
    return this.#pending?.started;
  }
  get enrollmentStartedAt(): string | undefined {
    return this.#pending?.startedAt;
  }

  async load(): Promise<void> {
    try {
      const stored = await this.#options.secrets.get(IDENTITY_SECRET);
      const pending = await this.#options.secrets.get(ENROLLMENT_SECRET);
      const identity = stored === undefined ? undefined : (JSON.parse(stored) as Identity);
      const enrollment =
        pending === undefined ? undefined : (JSON.parse(pending) as PendingEnrollment);
      for (const value of [identity, enrollment]) {
        if (value && (value.v !== 1 || value.origin !== this.transport.origin))
          throw new Error('identity origin mismatch');
      }
      if (identity) {
        this.#remember(
          identity.key.privateKey,
          identity.tokens.accessToken,
          identity.tokens.refreshToken,
        );
        if (identity.entitlements) schemas.entitlements.parse(identity.entitlements);
      }
      if (enrollment) this.#remember(enrollment.key.privateKey, enrollment.verifier);
      this.#identity = identity;
      this.#pending = enrollment;
    } catch {
      throw new Error('ZUV credentials unreadable');
    }
  }

  async beginEnrollment(
    name: string,
    deviceType: 'desktop' | 'cli' | 'mobile' | 'browser' = 'desktop',
  ): Promise<Enrollment> {
    const generation = ++this.#generation;
    this.#identityTransitions++;
    try {
      await this.#options.onIdentityChanging?.();
      const key = newZuvDeviceKey();
      const verifier = randomBytes(32).toString('base64url');
      this.#remember(key.privateKey, verifier);
      const body = Buffer.from(
        jcs(
          schemas.enrollmentStart.parse({
            publicKey: key.publicKey,
            deviceType,
            name,
            codeChallenge: sha256(verifier),
            codeChallengeMethod: 'S256',
          }),
        ),
      );
      const started = await this.transport.json(
        { method: 'POST', path: '/api/wevir/enrollment/start', body, maxBytes: 8192 },
        schemas.enrollmentStarted,
      );
      const verification = new URL(started.verificationUri);
      if (
        verification.origin !== this.transport.origin ||
        verification.username ||
        verification.password ||
        verification.hash
      )
        throw new ZuvRequestError('INVALID_RESPONSE');
      if (generation !== this.#generation) throw new ZuvRequestError('ENROLLMENT_EXPIRED');
      const pending: PendingEnrollment = {
        v: 1,
        origin: this.transport.origin,
        key,
        verifier,
        started,
        startedAt: new Date(this.#now()).toISOString(),
      };
      await this.#persist(() =>
        this.#options.secrets.set(ENROLLMENT_SECRET, JSON.stringify(pending)),
      );
      this.#pending = pending;
      return started;
    } finally {
      this.#identityTransitions--;
    }
  }

  async pollEnrollment(): Promise<
    { state: 'pending'; retryAfterMs: number } | { state: 'approved' }
  > {
    const pending = this.#pending;
    const generation = this.#generation;
    if (!pending || Date.parse(pending.started.expiresAt) <= this.#now())
      throw new ZuvRequestError('ENROLLMENT_EXPIRED');
    const body = Buffer.from(
      jcs({ enrollmentId: pending.started.enrollmentId, codeVerifier: pending.verifier }),
    );
    const polled = await this.transport.json(
      {
        method: 'POST',
        path: '/api/wevir/enrollment/poll',
        body,
        proof: { key: pending.key, secret: pending.started.enrollmentId, authorization: false },
        maxBytes: 8192,
      },
      schemas.enrollmentPolled,
    );
    if (polled.state === 'pending') return polled;
    if (generation !== this.#generation || this.#pending !== pending)
      throw new ZuvRequestError('ENROLLMENT_EXPIRED');
    const tokens = await this.#exchange('/api/wevir/token', pending.key, polled.grant);
    if (generation !== this.#generation || this.#pending !== pending)
      throw new ZuvRequestError('ENROLLMENT_EXPIRED');
    const identity: Identity = {
      v: 1,
      origin: this.transport.origin,
      key: pending.key,
      deviceId: polled.deviceId,
      tokens,
    };
    await this.#save(identity);
    await this.#persist(() => this.#options.secrets.delete(ENROLLMENT_SECRET));
    this.#pending = undefined;
    return { state: 'approved' };
  }

  async cancelEnrollment(enrollmentId?: string): Promise<void> {
    if (enrollmentId !== undefined && enrollmentId !== this.#pending?.started.enrollmentId) return;
    this.#generation++;
    await this.#persist(() => this.#options.secrets.delete(ENROLLMENT_SECRET));
    this.#pending = undefined;
  }

  async logout(): Promise<void> {
    this.#generation++;
    this.#identityTransitions++;
    try {
      await this.#options.onIdentityChanging?.();
      await this.cancelEnrollment();
      await this.#persist(() => this.#options.secrets.delete(IDENTITY_SECRET));
      this.#identity = undefined;
    } finally {
      this.#identityTransitions--;
    }
  }

  async getEntitlements(signal?: AbortSignal): Promise<Entitlements> {
    const generation = this.#generation;
    let result: Entitlements;
    try {
      result = await this.json('entitlements', 'GET', '/api/wevir/entitlements', undefined, {
        signal,
      });
    } catch (error) {
      if (
        generation === this.#generation &&
        !this.changingIdentity &&
        this.#identity &&
        error instanceof ZuvRequestError &&
        (error.code === 'AUTH_REQUIRED' || error.code === 'DEVICE_REVOKED')
      )
        await this.#save({ ...this.#identity, blocked: error.code });
      throw error;
    }
    if (generation !== this.#generation) throw new ZuvRequestError('AUTH_REQUIRED', 401);
    const identity = this.#identity;
    if (!identity || identity.deviceId !== result.identity.deviceId)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    if (identity.entitlements && identity.entitlements.identity.userId !== result.identity.userId)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    await this.#save({ ...identity, entitlements: result });
    return result;
  }

  async models(): Promise<string[]> {
    const proof = await this.#proof();
    return this.transport.json(
      { method: 'GET', path: '/api/wevir/v1/models', proof },
      {
        parse(value: unknown) {
          const result = value as { object?: unknown; data?: Array<{ id?: unknown }> };
          if (result?.object !== 'list' || !Array.isArray(result.data) || result.data.length > 2000)
            throw new Error('invalid model catalog');
          const ids = result.data.map((model) => {
            if (typeof model.id !== 'string' || model.id.length < 1 || model.id.length > 256)
              throw new Error('invalid model id');
            return model.id;
          });
          return [...new Set(ids)];
        },
      },
    );
  }

  async json<N extends keyof typeof schemas>(
    name: N,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    value?: unknown,
    options?: { signal?: AbortSignal; maxBytes?: number },
  ): Promise<(typeof schemas)[N]['_output']> {
    const body = value === undefined ? undefined : Buffer.from(jcs(value));
    const proof = await this.#proof();
    return this.transport.json<(typeof schemas)[N]['_output']>(
      { ...options, method, path, body, proof },
      {
        parse: (value) => schemas[name].parse(value) as (typeof schemas)[N]['_output'],
      },
    );
  }

  async transfer(
    input: Omit<Parameters<ZuvTransport['request']>[0], 'proof'>,
  ): ReturnType<ZuvTransport['request']> {
    return this.transport.request({ ...input, proof: await this.#proof() });
  }

  async authorizeInference(
    url: string,
    body: Uint8Array,
  ): Promise<{ headers: Record<string, string>; secrets: string[] }> {
    const target = new URL(url);
    if (
      target.origin !== this.transport.origin ||
      target.pathname !== '/api/wevir/v1/responses' ||
      target.search ||
      target.hash ||
      target.username ||
      target.password
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
    const proof = await this.#proof();
    if (
      this.entitlements?.subscriptionState !== 'active' ||
      !this.entitlements.deviceScopes.includes('inference')
    )
      throw new ZuvRequestError('SUBSCRIPTION_REQUIRED', 403);
    return {
      headers: {
        authorization: `DPoP ${proof.secret}`,
        dpop: deviceProof({ ...proof, method: 'POST', url, body, now: this.#now() }),
        'content-length': String(body.byteLength),
      },
      secrets: [proof.secret],
    };
  }

  async #proof(): Promise<{ key: ZuvDeviceKey; secret: string }> {
    if (this.#closed || this.changingIdentity) throw new ZuvRequestError('AUTH_REQUIRED', 401);
    if (this.#refreshing) {
      const secret = await this.#refreshing;
      if (!this.#identity) throw new ZuvRequestError('AUTH_REQUIRED', 401);
      return { key: this.#identity.key, secret };
    }
    const identity = this.#identity;
    if (!identity || identity.refreshPending || identity.blocked)
      throw new ZuvRequestError(identity?.blocked ?? 'AUTH_REQUIRED', 401);
    if (identity.tokens.expiresAt - this.#now() > 30000)
      return { key: identity.key, secret: identity.tokens.accessToken };
    this.#refreshing ??= this.#refresh(identity).finally(() => {
      this.#refreshing = undefined;
    });
    const secret = await this.#refreshing;
    if (!this.#identity) throw new ZuvRequestError('AUTH_REQUIRED', 401);
    return { key: this.#identity.key, secret };
  }

  async #refresh(identity: Identity): Promise<string> {
    const generation = this.#generation;
    // Refresh consumes its token; an uncertain attempt must survive restart without replaying it.
    await this.#save({ ...identity, refreshPending: true });
    let tokens: Tokens;
    try {
      tokens = await this.#exchange(
        '/api/wevir/refresh',
        identity.key,
        identity.tokens.refreshToken,
      );
    } catch (error) {
      if (
        generation === this.#generation &&
        !this.#closed &&
        this.#identity &&
        error instanceof ZuvRequestError &&
        ['AUTH_REQUIRED', 'DEVICE_REVOKED', 'SCOPE_DISABLED', 'RATE_LIMITED'].includes(error.code)
      )
        await this.#save({
          ...this.#identity,
          refreshPending: false,
          ...((error.code === 'AUTH_REQUIRED' || error.code === 'DEVICE_REVOKED') && {
            blocked: error.code,
          }),
        });
      throw error;
    }
    if (generation !== this.#generation) throw new ZuvRequestError('AUTH_REQUIRED', 401);
    await this.#save({ ...identity, tokens, refreshPending: false });
    return tokens.accessToken;
  }

  #exchange(path: string, key: ZuvDeviceKey, token: string): Promise<Tokens> {
    const body = Buffer.from(JSON.stringify({ client_id: 'wevir', token }));
    return this.transport.json(
      {
        method: 'POST',
        path,
        body,
        proof: { key, secret: token, authorization: false },
        maxBytes: 8192,
      },
      {
        parse: (value: unknown): Tokens => {
          const result = value as {
            client_id?: unknown;
            token_type?: unknown;
            access_token?: unknown;
            refresh_token?: unknown;
            expires_in?: unknown;
          };
          if (
            result?.client_id !== 'wevir' ||
            result.token_type !== 'DPoP' ||
            typeof result.access_token !== 'string' ||
            result.access_token.length < 16 ||
            result.access_token.length > 256 ||
            typeof result.refresh_token !== 'string' ||
            result.refresh_token.length < 16 ||
            result.refresh_token.length > 256 ||
            typeof result.expires_in !== 'number' ||
            !Number.isSafeInteger(result.expires_in) ||
            result.expires_in < 1 ||
            result.expires_in > 86400
          )
            throw new Error('invalid device tokens');
          this.#remember(result.access_token, result.refresh_token);
          return {
            accessToken: result.access_token,
            refreshToken: result.refresh_token,
            expiresAt: this.#now() + result.expires_in * 1000,
          };
        },
      },
    );
  }

  async #save(identity: Identity): Promise<void> {
    await this.#persist(() => this.#options.secrets.set(IDENTITY_SECRET, JSON.stringify(identity)));
    this.#identity = identity;
  }
  #persist<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new ZuvRequestError('AUTH_REQUIRED', 401);
    const pending = operation();
    this.#writes.add(pending);
    return pending.finally(() => {
      this.#writes.delete(pending);
    });
  }
  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
  #remember(...values: string[]): void {
    for (const value of values) this.#options.onSecret?.(value);
  }
}
