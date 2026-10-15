// 登录流程跑真的 SDK（`Cursor.auth.login`），登录端点换成本机的 mock：浏览器登录页 `/loginDeepControl`、轮询 `/auth/poll`
// （JSON）、铸 Key 的 `aiserver.v1.DashboardService/CreateUserApiKey` 与 `GetMe`（Connect 协议，二进制 protobuf，字段号取自
// SDK 1.0.35 打包的 proto 描述）。不打开浏览器（openBrowser: false，测试自己访问登录网址），不连外网（外连会让测试失败）。
// 登录后读账号与模型用假 SDK（真实的要 Cursor 账号）。

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountState } from '@wevir/runtime-adapter';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CursorAccounts } from './accounts.js';
import { CursorCredentialFile, cursorCredentialsPath } from './credentials.js';
import { type CursorSdk, loadCursorSdk } from './sdk.js';
import { FakeCursorSdk } from './test-fixtures/fake-sdk.js';

const MINTED_KEY = 'crsr_minted_by_mock_backend';
const ACCESS_TOKEN = 'mock-access-token';

interface MockBackend {
  base: string;
  server: Server;
  requests: string[];
  mintNames: string[];
  completed: Set<string>;
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

/** 一个 protobuf 字符串字段。 */
function stringField(field: number, value: string): Buffer {
  const data = Buffer.from(value, 'utf8');
  return Buffer.concat([varint((field << 3) | 2), varint(data.length), data]);
}

/** 读 protobuf 消息里第一个 `field` 号字符串字段（只够读 CreateUserApiKeyRequest.name）。 */
function readStringField(body: Buffer, field: number): string | undefined {
  let offset = 0;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = body[offset++] ?? 0;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
  };
  while (offset < body.length) {
    const key = readVarint();
    const wire = key & 7;
    if (wire === 2) {
      const length = readVarint();
      const value = body.subarray(offset, offset + length).toString('utf8');
      offset += length;
      if (key >>> 3 === field) return value;
    } else if (wire === 0) {
      readVarint();
    } else {
      return undefined;
    }
  }
  return undefined;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function startBackend(): Promise<MockBackend> {
  const backend: Omit<MockBackend, 'base' | 'server'> = {
    requests: [],
    mintNames: [],
    completed: new Set(),
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = await readBody(request);
    backend.requests.push(`${request.method} ${url.pathname}`);
    if (request.method === 'GET' && url.pathname === '/loginDeepControl') {
      // “浏览器里登录完成”：记下这次登录的 uuid。
      backend.completed.add(url.searchParams.get('uuid') ?? '');
      response.writeHead(200, { 'content-type': 'text/html' }).end('<p>signed in</p>');
      return;
    }
    if (request.method === 'POST' && url.pathname === '/auth/poll') {
      const { uuid, verifier } = JSON.parse(body.toString('utf8')) as {
        uuid: string;
        verifier: string;
      };
      if (!backend.completed.has(uuid) || verifier === '') {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ accessToken: ACCESS_TOKEN, refreshToken: 'mock-refresh-token' }));
      return;
    }
    const authorized = request.headers.authorization === `Bearer ${ACCESS_TOKEN}`;
    if (
      request.method === 'POST' &&
      url.pathname === '/aiserver.v1.DashboardService/CreateUserApiKey'
    ) {
      backend.mintNames.push(readStringField(body, 1) ?? '');
      if (!authorized) {
        response.writeHead(401).end();
        return;
      }
      response
        .writeHead(200, { 'content-type': 'application/proto' })
        .end(stringField(1, MINTED_KEY));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/aiserver.v1.DashboardService/GetMe') {
      response
        .writeHead(200, { 'content-type': 'application/proto' })
        .end(stringField(3, 'me@example.com'));
      return;
    }
    response.writeHead(500).end('unexpected request');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { ...backend, server, base: `http://127.0.0.1:${port}` };
}

/** 登录用真 SDK（端点指向 mock 后端），其余用假 SDK。 */
function loginAgainstMock(real: CursorSdk, base: string): CursorSdk {
  const fake = new FakeCursorSdk();
  return {
    createAgent: (options) => fake.createAgent(options),
    resumeAgent: (agentId, options) => fake.resumeAgent(agentId, options),
    listRuns: (agentId) => fake.listRuns(agentId),
    cancelRun: (runId) => fake.cancelRun(runId),
    me: (apiKey) => fake.me(apiKey),
    listModels: (apiKey) => fake.listModels(apiKey),
    login: (options) => real.login({ ...options, backendUrl: base, websiteUrl: base }),
  };
}

function isLocal(url: string): boolean {
  const host = new URL(url).hostname;
  return host === '127.0.0.1' || host === 'localhost';
}

describe('Cursor 应用内登录（真实 SDK + 本机 mock 后端）', () => {
  let backend: MockBackend;
  let home: string;
  const outbound: string[] = [];
  const realFetch = globalThis.fetch;
  const realHttpsRequest = https.request;

  beforeAll(async () => {
    backend = await startBackend();
    home = mkdtempSync(join(tmpdir(), 'wevir-cursor-login-'));
    // 外连守卫：本机以外的请求记下并拒绝。
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!isLocal(url)) {
        outbound.push(url);
        throw new Error(`outbound request blocked in test: ${url}`);
      }
      return realFetch(input, init);
    }) as typeof fetch;
    https.request = ((...args: Parameters<typeof https.request>) => {
      const first: unknown = args[0];
      const host =
        typeof first === 'string' || first instanceof URL
          ? new URL(first).hostname
          : String(
              (first as { hostname?: string; host?: string } | undefined)?.hostname ??
                (first as { host?: string } | undefined)?.host,
            );
      outbound.push(`https://${host}`);
      throw new Error(`outbound https request blocked in test: ${host}`);
    }) as typeof https.request;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    https.request = realHttpsRequest;
    await new Promise((resolve) => backend.server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });

  it('login 给出 mock 网站上的登录网址；访问之后 SDK 轮询到令牌、铸 Key，Key 存进 0600 的文件，状态经 onChange 变成 signed_in', async () => {
    const real = await loadCursorSdk();
    const accounts = new CursorAccounts({
      sdk: async () => loginAgainstMock(real, backend.base),
      credentialsPath: cursorCredentialsPath(home),
    });
    const states: AccountState[] = [];
    accounts.onChange((state) => states.push(state));
    try {
      const signingIn = await accounts.login('cursor', 'browser');
      const authUrl = signingIn.login?.authUrl ?? '';
      expect(authUrl.startsWith(`${backend.base}/loginDeepControl?`)).toBe(true);
      expect(new URL(authUrl).searchParams.get('uuid')).toEqual(expect.any(String));
      // 用户在浏览器里登录。
      expect((await realFetch(authUrl)).status).toBe(200);
      await vi.waitFor(() => expect(states.at(-1)?.status).toBe('signed_in'), { timeout: 10_000 });
      expect(states.at(-1)).toMatchObject({
        kind: 'cursor',
        status: 'signed_in',
        email: 'me@example.com',
      });
      expect(backend.mintNames).toEqual(['Wevir']);
      const path = cursorCredentialsPath(home);
      expect(await new CursorCredentialFile(path).load()).toMatchObject({
        version: 1,
        backendUrl: backend.base,
        apiKey: MINTED_KEY,
        email: 'me@example.com',
      });
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(states)).not.toContain(MINTED_KEY);
      expect(await accounts.requireApiKey()).toBe(MINTED_KEY);
      expect(outbound).toEqual([]);
    } finally {
      accounts.dispose();
    }
  }, 20_000);

  it('取消：SDK 停止轮询，什么都不存', async () => {
    const real = await loadCursorSdk();
    const cancelHome = mkdtempSync(join(tmpdir(), 'wevir-cursor-login-cancel-'));
    const accounts = new CursorAccounts({
      sdk: async () => loginAgainstMock(real, backend.base),
      credentialsPath: cursorCredentialsPath(cancelHome),
    });
    try {
      const signingIn = await accounts.login('cursor', 'browser');
      const polls = () =>
        backend.requests.filter((request) => request === 'POST /auth/poll').length;
      await vi.waitFor(() => expect(polls()).toBeGreaterThan(0));
      expect(await accounts.cancelLogin('cursor', signingIn.login?.loginId)).toMatchObject({
        status: 'signed_out',
      });
      const after = polls();
      await realFetch(signingIn.login?.authUrl ?? '');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // 取消时可能已有一个轮询请求在路上（mock 收到时才记），之后不再有新的：浏览器里登录完成了也不再轮询。
      const settled = polls();
      expect(settled).toBeLessThanOrEqual(after + 1);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(polls()).toBe(settled);
      expect(
        await new CursorCredentialFile(cursorCredentialsPath(cancelHome)).load(),
      ).toBeUndefined();
      expect(outbound).toEqual([]);
    } finally {
      accounts.dispose();
      rmSync(cancelHome, { recursive: true, force: true });
    }
  }, 20_000);
});
