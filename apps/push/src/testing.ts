// 只给测试：假的 APNs（明文 HTTP/2）与 FCM（OAuth 换令牌 + messages:send），以及测试用的密钥。网关的单测与 Host 的端到端测试共用；
// 不进构建产物（tsdown 只从 index.ts 与 main.ts 出发），经 `@wevir/push/testing` 的源码条件引用。

import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { constants, createServer as createHttp2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { FcmCredentials } from './upstream.js';

export interface FakeRequest {
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
}

export interface FakeApns {
  readonly url: string;
  readonly requests: FakeRequest[];
  /** 下一些请求怎么回；省略时回 200。 */
  respond(next: (request: FakeRequest) => FakeResponse | undefined): void;
  /** 每个请求的 JWT 都由这把公钥验过。 */
  readonly verifiedJwts: number;
  close(): Promise<void>;
}

/** 测试用的 APNs `.p8`（P-256）与它的公钥。 */
export function testApnsKey(): { pem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

export async function startFakeApns(publicPem: string): Promise<FakeApns> {
  const requests: FakeRequest[] = [];
  let responder: ((request: FakeRequest) => FakeResponse | undefined) | undefined;
  let verified = 0;
  const key = createPublicKey(publicPem);
  const server = createHttp2Server();
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const flat: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        if (typeof value === 'string') flat[name] = value;
      }
      const jwt = flat.authorization?.replace(/^bearer /, '') ?? '';
      const [head, claims, signature] = jwt.split('.');
      const ok =
        head !== undefined &&
        claims !== undefined &&
        signature !== undefined &&
        createVerify('sha256')
          .update(`${head}.${claims}`)
          .verify({ key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
      if (ok) verified += 1;
      const request: FakeRequest = {
        path: String(headers[constants.HTTP2_HEADER_PATH]),
        headers: flat,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'),
      };
      requests.push(request);
      const response = ok
        ? (responder?.(request) ?? { status: 200 })
        : { status: 403, body: { reason: 'InvalidProviderToken' } };
      stream.respond({ [constants.HTTP2_HEADER_STATUS]: response.status });
      stream.end(response.body === undefined ? '' : JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respond: (next) => {
      responder = next;
    },
    get verifiedJwts() {
      return verified;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface FakeFcm {
  readonly url: string;
  readonly credentials: FcmCredentials;
  readonly requests: FakeRequest[];
  readonly tokenRequests: number;
  respond(next: (request: FakeRequest) => FakeResponse | undefined): void;
  close(): Promise<void>;
}

/** 假的 FCM：`/token` 验 RS256 的断言后发访问令牌，`/v1/projects/<id>/messages:send` 要那个令牌。 */
export async function startFakeFcm(): Promise<FakeFcm> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const requests: FakeRequest[] = [];
  let responder: ((request: FakeRequest) => FakeResponse | undefined) | undefined;
  let tokenRequests = 0;
  let issued = 0;
  const server = createHttpServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/token') {
        tokenRequests += 1;
        const assertion = new URLSearchParams(text).get('assertion') ?? '';
        const [head, claims, signature] = assertion.split('.');
        const ok =
          head !== undefined &&
          claims !== undefined &&
          signature !== undefined &&
          createVerify('sha256')
            .update(`${head}.${claims}`)
            .verify(publicKey, Buffer.from(signature, 'base64url'));
        if (!ok) return reply(400, { error: 'invalid_grant' });
        issued += 1;
        return reply(200, { access_token: `fake-access-${issued}`, expires_in: 3600 });
      }
      const flat: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') flat[name] = value;
      }
      const request: FakeRequest = {
        path: req.url ?? '',
        headers: flat,
        body: JSON.parse(text || 'null'),
      };
      requests.push(request);
      if (!flat.authorization?.startsWith('Bearer fake-access-')) {
        return reply(401, { error: { status: 'UNAUTHENTICATED' } });
      }
      const response = responder?.(request) ?? { status: 200, body: { name: 'projects/x/1' } };
      reply(response.status, response.body ?? {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    credentials: {
      project_id: 'wevir-test',
      client_email: 'push@wevir-test.iam.gserviceaccount.com',
      private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      token_uri: `${url}/token`,
    },
    requests,
    get tokenRequests() {
      return tokenRequests;
    },
    respond: (next) => {
      responder = next;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
