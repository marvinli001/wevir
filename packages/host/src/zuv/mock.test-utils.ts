import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { schemas } from '@wevir/protocol/sync';
import { MockSyncError, MockSyncGateway } from './mock-sync.test-utils.js';

type PublicKey = { kty: 'OKP'; crv: 'Ed25519'; x: string };
const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('base64url');
const id = (prefix: string) => `${prefix}_${randomUUID()}`;

export async function startMockZuv() {
  const sync = new MockSyncGateway();
  const enrollments = new Map<
    string,
    { publicKey: PublicKey; challenge: string; approved: boolean; userId?: string }
  >();
  const grants = new Map<string, string>();
  const tokens = new Map<string, string>();
  const devices = new Map<string, PublicKey>();
  const deviceUsers = new Map<string, string>();
  const seen = new Set<string>();
  const requests: string[] = [];
  const errors: string[] = [];
  const originFor = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const proof = (req: IncomingMessage, raw: Buffer, key: PublicKey, token: string) => {
    const parts = String(req.headers.dpop ?? '').split('.');
    const [head = '', payload = '', signature = ''] = parts;
    const header = JSON.parse(Buffer.from(head, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (
      parts.length !== 3 ||
      header.typ !== 'dpop+jwt' ||
      header.alg !== 'EdDSA' ||
      header.jwk.x !== key.x ||
      !verify(
        null,
        Buffer.from(`${head}.${payload}`),
        createPublicKey({ key, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      ) ||
      claims.ath !== digest(token) ||
      claims.htm !== req.method ||
      claims.htu !== new URL(new URL(req.url as string, originFor()).pathname, originFor()).href ||
      (raw.length > 0 && claims.bht !== digest(raw)) ||
      seen.has(claims.jti)
    )
      throw new Error('invalid device proof');
    seen.add(claims.jti);
  };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    const path = new URL(req.url as string, originFor()).pathname;
    requests.push(path);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 1024 * 1024) throw new Error('request size');
        chunks.push(bytes);
      }
      const raw = Buffer.concat(chunks);
      const body =
        raw.length && req.headers['content-type'] !== 'application/octet-stream'
          ? JSON.parse(raw.toString())
          : undefined;
      let response: unknown;
      if (path === '/api/wevir/enrollment/start') {
        const input = schemas.enrollmentStart.parse(body);
        const enrollmentId = id('enrollment');
        enrollments.set(enrollmentId, {
          publicKey: input.publicKey,
          challenge: input.codeChallenge,
          approved: false,
        });
        response = schemas.enrollmentStarted.parse({
          enrollmentId,
          verificationUri: `${originFor()}/console/devices/enroll?id=${enrollmentId}`,
          intervalMs: 25,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        });
      } else if (path === '/api/wevir/enrollment/poll') {
        const input = schemas.enrollmentPoll.parse(body);
        const enrollment = enrollments.get(input.enrollmentId);
        if (!enrollment || enrollment.challenge !== digest(input.codeVerifier))
          throw new Error('invalid enrollment');
        proof(req, raw, enrollment.publicKey, input.enrollmentId);
        if (!enrollment.approved) response = { state: 'pending', retryAfterMs: 25 };
        else {
          const deviceId = id('device');
          const grant = id('grant');
          devices.set(deviceId, enrollment.publicKey);
          deviceUsers.set(deviceId, enrollment.userId ?? 'user_synthetic');
          grants.set(grant, deviceId);
          enrollments.delete(input.enrollmentId);
          response = {
            state: 'approved',
            deviceId,
            grant,
            clientId: 'wevir',
            expiresAt: new Date(Date.now() + 300000).toISOString(),
          };
        }
      } else if (path === '/api/wevir/token' || path === '/api/wevir/refresh') {
        const credentials = path.endsWith('/refresh') ? tokens : grants;
        const deviceId = credentials.get(body.token);
        const key = deviceId && devices.get(deviceId);
        if (!key || !deviceId || body.client_id !== 'wevir')
          throw new MockSyncError('AUTH_REQUIRED', 401);
        proof(req, raw, key, body.token);
        credentials.delete(body.token);
        const access = id('access');
        const refresh = id('refresh');
        tokens.set(access, deviceId);
        tokens.set(refresh, deviceId);
        response = {
          client_id: 'wevir',
          token_type: 'DPoP',
          access_token: access,
          refresh_token: refresh,
          expires_in: 900,
        };
      } else {
        const token = /^DPoP (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        const deviceId = token && tokens.get(token);
        const key = deviceId && devices.get(deviceId);
        if (!deviceId || !key || !token) throw new MockSyncError('AUTH_REQUIRED', 401);
        proof(req, raw, key, token);
        if (path === '/api/wevir/entitlements') {
          response = schemas.entitlements.parse(
            sync.entitlements(deviceUsers.get(deviceId) as string, deviceId),
          );
        } else if (path === '/api/wevir/v1/models')
          response = {
            object: 'list',
            data: [{ id: 'synthetic-model', object: 'model', owned_by: 'synthetic' }],
          };
        else {
          const result = sync.handle(
            deviceUsers.get(deviceId) as string,
            deviceId,
            new URL(req.url as string, originFor()),
            req.method as string,
            body,
            raw,
          );
          if (result.bytes) {
            res.setHeader('content-type', 'application/octet-stream');
            res.end(result.bytes);
            return;
          }
          res.statusCode = result.status ?? 200;
          response = result.value;
        }
      }
      res.end(JSON.stringify(response));
    } catch (error) {
      if (error instanceof MockSyncError) {
        if (error.retryAfterMs)
          res.setHeader('retry-after', String(Math.ceil(error.retryAfterMs / 1000)));
        res.writeHead(error.status);
        res.end(
          JSON.stringify({
            error: {
              code: error.code,
              message: error.code,
              ...(error.retryAfterMs && { retryAfterMs: error.retryAfterMs }),
            },
          }),
        );
        return;
      }
      errors.push(error instanceof Error ? error.message : 'mock failure');
      res.writeHead(400);
      res.end(JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'INVALID_REQUEST' } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: originFor(),
    sync,
    requests,
    errors,
    approve(url: string, userId = 'user_synthetic') {
      const enrollment = enrollments.get(new URL(url).searchParams.get('id') as string);
      if (!enrollment) throw new Error('enrollment not found');
      enrollment.approved = true;
      enrollment.userId = userId;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
