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
  #refreshSent = false;
  #identityWrites: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #identityTransitions = 0;
  #closed = false;
  readonly #abort = new AbortController();
  readonly #writes = new Set<Promise<unknown>>();
  #persistence: Promise<unknown> = Promise.resolve();

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
    const generation = ++this.#generation;
    this.#abort.abort();
    await this.#identityWrites;
    if (generation === this.#generation && this.#identity?.refreshPending && !this.#refreshSent) {
      this.#identity = { ...this.#identity, refreshPending: false };
      await this.#options.secrets.set(IDENTITY_SECRET, JSON.stringify(this.#identity));
    }
    await Promise.allSettled(this.#writes);
    this.#listeners.clear();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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
    return (
      (this.#identity?.refreshPending === true && !this.#refreshing) ||
      this.#identity?.blocked !== undefined
    );
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
      if (generation !== this.#generation || this.#closed)
        throw new ZuvRequestError('ENROLLMENT_EXPIRED');
      this.#pending = pending;
      return started;
    } finally {
      this.#identityTransitions--;
    }
  }

  async pollEnrollment(
    signal?: AbortSignal,
  ): Promise<{ state: 'pending'; retryAfterMs: number } | { state: 'approved' }> {
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
        signal,
      },
      schemas.enrollmentPolled,
    );
    if (generation !== this.#generation || this.#pending !== pending)
      throw new ZuvRequestError('ENROLLMENT_EXPIRED');
    if (polled.state === 'pending') return polled;
    const tokens = await this.#exchange('/api/wevir/token', pending.key, polled.grant, signal);
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
      await this.#identityWrites;
      await this.cancelEnrollment();
      await this.#persist(() => this.#options.secrets.delete(IDENTITY_SECRET));
      this.#identity = undefined;
    } finally {
      this.#identityTransitions--;
    }
  }

  async getEntitlements(signal?: AbortSignal): Promise<Entitlements> {
    const generation = this.#generation;
    for (let attempt = 0; ; attempt++) {
      const proof = await this.#proof();
      let result: Entitlements;
      try {
        result = await this.transport.json(
          { method: 'GET', path: '/api/wevir/entitlements', proof, signal },
          schemas.entitlements,
        );
      } catch (error) {
        if (
          generation === this.#generation &&
          !this.changingIdentity &&
          this.#identity &&
          error instanceof ZuvRequestError &&
          (error.code === 'AUTH_REQUIRED' || error.code === 'DEVICE_REVOKED')
        ) {
          if (proof.secret !== this.#identity.tokens.accessToken) {
            if (attempt === 0) continue;
          } else
            await this.#save(
              (current) => ({
                ...current,
                blocked: error.code as 'AUTH_REQUIRED' | 'DEVICE_REVOKED',
              }),
              generation,
            );
        }
        throw error;
      }
      if (generation !== this.#generation) throw new ZuvRequestError('AUTH_REQUIRED', 401);
      const identity = this.#identity;
      if (
        !identity ||
        identity.deviceId !== result.identity.deviceId ||
        (identity.entitlements && identity.entitlements.identity.userId !== result.identity.userId)
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
      await this.#save((current) => ({ ...current, entitlements: result }), generation);
      return result;
    }
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
    this.#inferenceScope();
    const proof = await this.#proof();
    this.#inferenceScope();
    return {
      headers: {
        authorization: `DPoP ${proof.secret}`,
        dpop: deviceProof({ ...proof, method: 'POST', url, body, now: this.#now() }),
        'content-length': String(body.byteLength),
      },
      secrets: [proof.secret],
    };
  }

  async inferenceDenied(authorization: string, status: 401 | 403): Promise<void> {
    const identity = this.#identity;
    if (!identity || authorization !== `DPoP ${identity.tokens.accessToken}` || this.#closed)
      return;
    if (status === 401)
      await this.#save((current) =>
        current.tokens.accessToken === identity.tokens.accessToken
          ? { ...current, blocked: 'AUTH_REQUIRED' }
          : current,
      );
    else await this.getEntitlements();
  }

  #inferenceScope(): void {
    if (!this.#identity || this.#closed || this.changingIdentity || this.requiresLogin)
      throw new ZuvRequestError(this.blockedReason ?? 'AUTH_REQUIRED', 401);
    if (this.entitlements?.subscriptionState !== 'active')
      throw new ZuvRequestError('SUBSCRIPTION_REQUIRED', 403);
    if (!this.entitlements.deviceScopes.includes('inference'))
      throw new ZuvRequestError('SCOPE_DISABLED', 403);
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
      this.#notify();
    });
    const secret = await this.#refreshing;
    if (!this.#identity) throw new ZuvRequestError('AUTH_REQUIRED', 401);
    return { key: this.#identity.key, secret };
  }

  async #refresh(identity: Identity): Promise<string> {
    const generation = this.#generation;
    // Refresh consumes its token; an uncertain attempt must survive restart without replaying it.
    this.#refreshSent = false;
    await this.#save((current) => ({ ...current, refreshPending: true }), generation);
    if (generation !== this.#generation || this.#closed || this.changingIdentity)
      throw new ZuvRequestError('AUTH_REQUIRED', 401);
    this.#refreshSent = true;
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
        await this.#save(
          (current) => ({
            ...current,
            refreshPending: false,
            ...((error.code === 'AUTH_REQUIRED' || error.code === 'DEVICE_REVOKED') && {
              blocked: error.code as 'AUTH_REQUIRED' | 'DEVICE_REVOKED',
            }),
          }),
          generation,
        );
      throw error;
    }
    if (generation !== this.#generation) throw new ZuvRequestError('AUTH_REQUIRED', 401);
    await this.#save((current) => ({ ...current, tokens, refreshPending: false }), generation);
    return tokens.accessToken;
  }

  #exchange(path: string, key: ZuvDeviceKey, token: string, signal?: AbortSignal): Promise<Tokens> {
    const body = Buffer.from(JSON.stringify({ client_id: 'wevir', token }));
    return this.transport.json(
      {
        method: 'POST',
        path,
        body,
        proof: { key, secret: token, authorization: false },
        maxBytes: 8192,
        signal,
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

  #save(
    update: Identity | ((current: Identity) => Identity),
    generation = this.#generation,
  ): Promise<void> {
    const pending = this.#identityWrites.then(async () => {
      if (generation !== this.#generation || this.#closed)
        throw new ZuvRequestError('AUTH_REQUIRED', 401);
      const current = this.#identity;
      if (typeof update === 'function' && !current) throw new ZuvRequestError('AUTH_REQUIRED', 401);
      const identity = typeof update === 'function' ? update(current as Identity) : update;
      await this.#persist(async () => {
        await this.#options.secrets.set(IDENTITY_SECRET, JSON.stringify(identity));
        if (generation !== this.#generation || this.#closed) {
          if (current) await this.#options.secrets.set(IDENTITY_SECRET, JSON.stringify(current));
          else await this.#options.secrets.delete(IDENTITY_SECRET);
          throw new ZuvRequestError('AUTH_REQUIRED', 401);
        }
      });
      this.#identity = identity;
      this.#notify();
    });
    this.#identityWrites = pending.catch(() => {});
    return pending;
  }
  #notify(): void {
    if (!this.#closed) for (const listener of this.#listeners) listener();
  }

  #persist<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new ZuvRequestError('AUTH_REQUIRED', 401);
    const pending = this.#persistence.then(operation);
    this.#persistence = pending.catch(() => {});
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
