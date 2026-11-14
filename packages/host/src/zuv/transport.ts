import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { type ErrorCode, jcs, LIMITS, schemas } from '@wevir/protocol/sync';
import { sha256 } from '../sync/crypto.js';

export interface ZuvDeviceKey {
  privateKey: string;
  publicKey: { kty: 'OKP'; crv: 'Ed25519'; x: string };
}

export function newZuvDeviceKey(): ZuvDeviceKey {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = schemas.enrollmentStart.shape.publicKey.parse(
    keys.publicKey.export({ format: 'jwk' }),
  );
  return {
    privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey,
  };
}

export class ZuvRequestError extends Error {
  constructor(
    readonly code: ErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE',
    readonly status = 0,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = 'ZuvRequestError';
  }
}

export function zuvOrigin(value: string, allowLoopback = false): string {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const loopback =
    hostname === 'localhost' ||
    hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.startsWith('127.'));
  if (
    (url.protocol !== 'https:' && !(allowLoopback && loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('invalid ZUV origin');
  return url.origin;
}

export function deviceProof(input: {
  key: ZuvDeviceKey;
  secret: string;
  method: string;
  url: string;
  body?: Uint8Array;
  now?: number;
}): string {
  const url = new URL(input.url);
  const header = Buffer.from(
    jcs({ typ: 'dpop+jwt', alg: 'EdDSA', jwk: input.key.publicKey }),
  ).toString('base64url');
  const payload = Buffer.from(
    jcs({
      jti: randomUUID(),
      htm: input.method,
      htu: `${url.origin}${url.pathname}`,
      iat: Math.floor((input.now ?? Date.now()) / 1000),
      ath: sha256(input.secret),
      ...(input.body !== undefined && { bht: sha256(input.body) }),
    }),
  ).toString('base64url');
  const privateKey = createPrivateKey({
    key: Buffer.from(input.key.privateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}

export interface ZuvTransportOptions {
  origin: string;
  allowLoopback?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}

export class ZuvTransport {
  readonly origin: string;
  readonly #options: ZuvTransportOptions;
  #clock: { server: number; monotonic: number } | undefined;
  constructor(options: ZuvTransportOptions) {
    this.origin = zuvOrigin(options.origin, options.allowLoopback);
    this.#options = options;
  }

  serverNow(): number {
    return this.#clock
      ? this.#clock.server + performance.now() - this.#clock.monotonic
      : (this.#options.now?.() ?? Date.now());
  }

  async request(input: {
    method: 'GET' | 'POST' | 'PUT';
    path: string;
    body?: Uint8Array;
    contentType?: string;
    proof?: { key: ZuvDeviceKey; secret: string; authorization?: boolean };
    maxBytes?: number;
    signal?: AbortSignal;
    transfer?: { bytesPerSecond: number; chunkBytes: number; timeoutMs: number };
  }): Promise<{ bytes: Buffer; status: number; headers: Headers }> {
    const url = new URL(input.path, this.origin);
    if (
      url.origin !== this.origin ||
      !url.pathname.startsWith('/api/wevir/') ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('invalid ZUV route');
    const headers: Record<string, string> = { accept: 'application/json' };
    const bodyBytes = input.body === undefined ? undefined : new Uint8Array(input.body);
    if (bodyBytes !== undefined) {
      headers['content-type'] = input.contentType ?? 'application/json';
      headers['content-length'] = String(bodyBytes.byteLength);
    }
    if (input.proof) {
      headers.dpop = deviceProof({
        ...input.proof,
        method: input.method,
        url: url.href,
        body: bodyBytes,
        now: this.#options.now?.(),
      });
      if (input.proof.authorization !== false) headers.authorization = `DPoP ${input.proof.secret}`;
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(
        Math.min(input.transfer?.timeoutMs ?? LIMITS.transferMs, LIMITS.transferMs),
      ),
      ...(input.signal ? [input.signal] : []),
      ...(this.#options.signal ? [this.#options.signal] : []),
    ]);
    const transfer = input.transfer;
    if (
      transfer &&
      (transfer.bytesPerSecond < 1 || transfer.chunkBytes < 1 || transfer.timeoutMs < 1)
    )
      throw new ZuvRequestError('QUOTA_EXCEEDED');
    const started = performance.now();
    let sent = 0;
    const paced =
      transfer && bodyBytes
        ? new ReadableStream<Uint8Array>({
            async pull(controller) {
              signal.throwIfAborted();
              const wait = started + (sent * 1000) / transfer.bytesPerSecond - performance.now();
              if (wait > 0) await delay(wait, undefined, { signal });
              const end = Math.min(
                bodyBytes.length,
                sent + Math.min(transfer.chunkBytes, LIMITS.transferChunkBytes),
              );
              controller.enqueue(bodyBytes.subarray(sent, end));
              sent = end;
              if (sent === bodyBytes.length) controller.close();
            },
          })
        : undefined;
    let response: Response;
    try {
      response = await (this.#options.fetch ?? fetch)(url, {
        method: input.method,
        headers,
        ...(bodyBytes !== undefined && { body: paced ?? bodyBytes }),
        ...(paced && { duplex: 'half' as const }),
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal,
      });
    } catch {
      throw new ZuvRequestError('NETWORK_ERROR');
    }
    const serverTime = Date.parse(response.headers.get('date') ?? '');
    if (Number.isFinite(serverTime))
      this.#clock = { server: serverTime, monotonic: performance.now() };
    const maximum = response.ok ? (input.maxBytes ?? LIMITS.changeBytes) : 8192;
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(maximum))) {
      await response.body?.cancel();
      throw new ZuvRequestError('INVALID_RESPONSE', response.status);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    let consumed = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maximum) {
            await reader.cancel();
            throw new ZuvRequestError('INVALID_RESPONSE', response.status);
          }
          if (transfer)
            for (
              let offset = 0;
              offset < chunk.value.byteLength;
              offset += Math.min(transfer.chunkBytes, LIMITS.transferChunkBytes)
            ) {
              const piece = chunk.value.subarray(
                offset,
                offset + Math.min(transfer.chunkBytes, LIMITS.transferChunkBytes),
              );
              const wait =
                started + (consumed * 1000) / transfer.bytesPerSecond - performance.now();
              if (wait > 0) await delay(wait, undefined, { signal });
              consumed += piece.byteLength;
            }
          chunks.push(chunk.value);
        }
      } catch (error) {
        if (error instanceof ZuvRequestError) throw error;
        throw new ZuvRequestError('NETWORK_ERROR');
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = Buffer.concat(chunks, size);
    if (!response.ok) {
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        /* Non-protocol responses stay opaque. */
      }
      const error = schemas.error.safeParse(value);
      const retry = response.headers.get('retry-after');
      const delay =
        retry === null
          ? undefined
          : /^\d+(?:\.\d+)?$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry) - (this.#options.now?.() ?? Date.now());
      const retryAfterMs =
        Math.max(
          error.success ? (error.data.error.retryAfterMs ?? 0) : 0,
          delay && Number.isFinite(delay) ? delay : 0,
        ) || undefined;
      throw new ZuvRequestError(
        error.success ? error.data.error.code : 'INVALID_RESPONSE',
        response.status,
        retryAfterMs,
      );
    }
    return { bytes, status: response.status, headers: response.headers };
  }

  async json<T>(
    input: Parameters<ZuvTransport['request']>[0],
    schema: { parse(value: unknown): T },
  ): Promise<T> {
    const result = await this.request(input);
    try {
      return schema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)),
      );
    } catch {
      throw new ZuvRequestError('INVALID_RESPONSE', result.status);
    }
  }
}
