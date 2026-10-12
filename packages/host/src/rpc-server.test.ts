// T2.4 的集成测试：真实的 WebSocket 连接（ws 客户端或裸 TCP）连到监听 127.0.0.1 的 HostRpcServer，
// 后面是真实的 EventStore、SessionManager 与 EchoAdapter。

import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { basename, join } from 'node:path';
import { setTimeout as delay, setImmediate as nextTick } from 'node:timers/promises';
import {
  type ClientIdentity,
  CloseCode,
  ErrorCode,
  type HostId,
  MIN_PROTOCOL_VERSION,
  PERMISSIONS,
  PROTOCOL_VERSION,
  type SessionId,
  type WevirEvent,
} from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore, type Storage } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ClientOptions, WebSocket } from 'ws';
import type { AppendInput } from './event-store.js';
import { EventStore } from './event-store.js';
import { createHostMethods, type HostMethods } from './host-methods.js';
import { InvalidResultError } from './rpc-connection.js';
import { HostRpcServer, type HostRpcServerOptions } from './rpc-server.js';
import { SessionManager } from './session-manager.js';
import { useStorages, useTempDir } from './test-utils.js';

const TOKEN = 'token-0123456789abcdefghijklmnopqrstuvwxyz';
const HOST_ID: HostId = 'hst_01JA2B3C4D5E6F7G8H9JKMNPQR';
const HOST_VERSION = '0.1.0';
const cli: ClientIdentity = { deviceId: 'dev-mac', clientId: 'cli-1', clientKind: 'cli' };
const desktop: ClientIdentity = { deviceId: 'dev-mac', clientId: 'desk-1', clientKind: 'desktop' };

const tempDir = useTempDir();
const storages = useStorages();

interface Harness {
  server: HostRpcServer;
  url: string;
  port: number;
  dataDir: string;
  workspaceDir: string;
  storage: Storage;
  events: EventStore;
  adapter: EchoAdapter;
  manager: SessionManager;
  secrets: FileSecretStore;
  /** 各组件的 onError；用例结束时必须为空，预期的错误由用例自己取走。 */
  errors: unknown[];
}

const hosts: Harness[] = [];
const clients: RpcClient[] = [];
let hostCount = 0;

// 注册在 useStorages 之后：after 钩子按注册的逆序执行，先断客户端、停服务，再关数据库。
afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const h of hosts.splice(0)) {
    await h.server.close({ drainTimeoutMs: 200 });
    await Promise.race([h.manager.dispose(), delay(200)]);
    await h.adapter.dispose();
    h.events.close();
    expect(h.errors).toEqual([]);
  }
});

async function startHost(
  options: Partial<Omit<HostRpcServerOptions, 'methods'>> & {
    methods?: Partial<HostMethods>;
  } = {},
): Promise<Harness> {
  hostCount += 1;
  const dataDir = join(tempDir(), `data-${hostCount}`);
  const workspaceDir = join(tempDir(), `workspace-${hostCount}`);
  mkdirSync(workspaceDir, { recursive: true });
  const storage = storages.open(dataDir);
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  const events = new EventStore({ storage, deltaWindowMs: 5, onError });
  const adapter = new EchoAdapter({ stepDelayMs: 1 });
  const manager = new SessionManager({ storage, events, adapter, onError });
  const secrets = new FileSecretStore(dataDir);
  const { methods: overrides, ...serverOptions } = options;
  const methods = {
    ...createHostMethods({ storage, events, sessions: manager, secrets }),
    ...overrides,
  };
  const server = new HostRpcServer({
    token: TOKEN,
    hostId: HOST_ID,
    hostVersion: HOST_VERSION,
    storage,
    events,
    methods,
    onError,
    ...serverOptions,
  });
  const url = await server.listen();
  const h: Harness = {
    server,
    url,
    port: server.port,
    dataDir,
    workspaceDir,
    storage,
    events,
    adapter,
    manager,
    secrets,
    errors,
  };
  hosts.push(h);
  return h;
}

// ── 测试客户端 ──────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: 测试按需读取任意形状的 result / data。
type Json = any;

interface Frame {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: Json;
  error?: { code: number; message: string; data?: Json };
  method?: string;
  params?: Json;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: Json,
  ) {
    super(message);
  }
}

/** 一个真实的 ws 客户端：按顺序记下收到的每一帧，按 `id` 等响应、按条件等事件。 */
class RpcClient {
  readonly frames: Frame[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #listeners = new Set<() => void>();
  #nextId = 1;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.frames.push(JSON.parse(String(data)) as Frame);
      this.#notify();
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: String(reason) });
        this.#notify();
      });
    });
  }

  static connect(url: string, options?: ClientOptions): Promise<RpcClient> {
    const client = new RpcClient(new WebSocket(url, options));
    clients.push(client);
    return new Promise((resolve, reject) => {
      client.ws.once('open', () => resolve(client));
      client.ws.once('error', reject);
    });
  }

  send(frame: unknown): void {
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  /** 发请求，返回对应 `id` 的响应帧。 */
  call(method: string, params?: unknown): Promise<Frame> {
    const id = this.#nextId++;
    this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return this.waitFor((frame) => frame.id === id && ('result' in frame || 'error' in frame));
  }

  /** 发请求，成功返回 result，失败抛 `RpcError`。 */
  async request(method: string, params?: unknown): Promise<Json> {
    const frame = await this.call(method, params);
    if (frame.error) throw new RpcError(frame.error.code, frame.error.message, frame.error.data);
    return frame.result;
  }

  hello(identity: ClientIdentity = cli, overrides: Record<string, unknown> = {}): Promise<Frame> {
    return this.call('host.hello', {
      token: TOKEN,
      protocolVersion: PROTOCOL_VERSION,
      ...identity,
      capabilities: {},
      ...overrides,
    });
  }

  /** 等到 `check` 返回真值；每收到一帧时重查，连接关闭后仍不满足就失败。 */
  until<T>(check: () => T | undefined | false, label = 'condition', timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const listener = () => {
        const value = check();
        if (value) {
          cleanup();
          resolve(value);
        } else if (this.ws.readyState === WebSocket.CLOSED) {
          cleanup();
          reject(new Error(`连接已关闭，${label} 未满足`));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`等待 ${label} 超时；已收到 ${this.frames.length} 帧`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.#listeners.delete(listener);
      };
      this.#listeners.add(listener);
      listener();
    });
  }

  waitFor(predicate: (frame: Frame) => boolean): Promise<Frame> {
    return this.until(() => this.frames.find(predicate), 'frame');
  }

  /** 某个订阅收到的事件，按到达顺序。 */
  events(subscriptionId: string): WevirEvent[] {
    return this.frames
      .filter((f) => f.method === 'events.event' && f.params.subscriptionId === subscriptionId)
      .map((f) => f.params.event as WevirEvent);
  }

  waitForEvent(subscriptionId: string, predicate: (event: WevirEvent) => boolean) {
    return this.until(() => this.events(subscriptionId).find(predicate), 'event');
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

async function readyClient(h: Harness, identity: ClientIdentity = cli): Promise<RpcClient> {
  const client = await RpcClient.connect(h.url);
  const frame = await client.hello(identity);
  expect(frame.error).toBeUndefined();
  return client;
}

/** 经 RPC 加工作区与 Provider、建会话。 */
async function createSession(h: Harness, client: RpcClient): Promise<SessionId> {
  const { workspace } = await client.request('workspace.add', { rootPath: h.workspaceDir });
  await client.request('provider.upsert', {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [],
    defaultModelId: 'deepseek-chat',
  });
  const { session } = await client.request('session.create', {
    workspaceId: workspace.id,
    providerId: 'deepseek-official',
  });
  return session.id;
}

async function subscribe(client: RpcClient, sessionId: SessionId, sinceSeq = 0) {
  const result = await client.request('events.subscribe', { sessionId, sinceSeq });
  return result as { subscriptionId: string; replayedThroughSeq: number };
}

function usage(contextUsed: number): AppendInput {
  return {
    type: 'usage.updated',
    source: 'engine',
    payload: { contextUsed, contextSize: 1 << 20 },
  };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** 不经 ws 客户端发一个升级请求，返回响应的状态行（便于构造缺失或伪造的头）。 */
function rawUpgrade(port: number, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const socket = connect(port, '127.0.0.1', () => {
      const lines = [
        'GET / HTTP/1.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\r\n')) socket.destroy();
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
  });
}

// ── 用例 ────────────────────────────────────────────────────────────────

describe('监听与升级校验', () => {
  it('只监听 127.0.0.1，端口由系统分配，url 照此给出', async () => {
    const h = await startHost();
    expect(h.port).toBeGreaterThan(0);
    expect(h.url).toBe(`ws://127.0.0.1:${h.port}/`);
    const client = await readyClient(h);
    expect(await client.request('host.ping')).toEqual({});
  });

  it('Host 头只放行 127.0.0.1:<port> 与 localhost:<port>，缺失或其他一律 403', async () => {
    const h = await startHost();
    expect(await rawUpgrade(h.port, {})).toBe('HTTP/1.1 403 Forbidden');
    expect(await rawUpgrade(h.port, { Host: `evil.example:${h.port}` })).toBe(
      'HTTP/1.1 403 Forbidden',
    );
    expect(await rawUpgrade(h.port, { Host: '127.0.0.1:1' })).toBe('HTTP/1.1 403 Forbidden');
    expect(await rawUpgrade(h.port, { Host: '127.0.0.1' })).toBe('HTTP/1.1 403 Forbidden');
    expect(await rawUpgrade(h.port, { Host: `127.0.0.1:${h.port}` })).toBe(
      'HTTP/1.1 101 Switching Protocols',
    );
    expect(await rawUpgrade(h.port, { Host: `localhost:${h.port}` })).toBe(
      'HTTP/1.1 101 Switching Protocols',
    );
  });

  it('不带 Origin 放行；带 Origin 只放行白名单，其余 403', async () => {
    const h = await startHost({ allowedOrigins: ['app://wevir'] });
    const host = `127.0.0.1:${h.port}`;
    expect(await rawUpgrade(h.port, { Host: host, Origin: 'https://evil.example' })).toBe(
      'HTTP/1.1 403 Forbidden',
    );
    expect(await rawUpgrade(h.port, { Host: host, Origin: 'null' })).toBe('HTTP/1.1 403 Forbidden');
    expect(await rawUpgrade(h.port, { Host: host, Origin: 'app://wevir' })).toBe(
      'HTTP/1.1 101 Switching Protocols',
    );

    await expect(RpcClient.connect(h.url, { origin: 'http://localhost:5173' })).rejects.toThrow(
      /403/,
    );
    const allowed = await RpcClient.connect(h.url, { origin: 'app://wevir' });
    expect((await allowed.hello()).result.hostId).toBe(HOST_ID);
  });

  it('默认白名单为空：任何带 Origin 的升级都被拒', async () => {
    const h = await startHost();
    expect(
      await rawUpgrade(h.port, {
        Host: `localhost:${h.port}`,
        Origin: `http://localhost:${h.port}`,
      }),
    ).toBe('HTTP/1.1 403 Forbidden');
  });

  it('普通 HTTP 请求回 426', async () => {
    const h = await startHost();
    const response = await fetch(`http://127.0.0.1:${h.port}/`);
    expect(response.status).toBe(426);
  });
});

describe('host.hello', () => {
  it('成功：返回 Host 信息、协商后的版本与全部权限', async () => {
    const h = await startHost();
    const client = await RpcClient.connect(h.url);
    const frame = await client.hello();
    expect(frame).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        hostId: HOST_ID,
        hostVersion: HOST_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        minProtocolVersion: MIN_PROTOCOL_VERSION,
        features: {},
        permissions: [...PERMISSIONS],
      },
    });
  });

  it('hello 之前发其他请求：回 HELLO_REQUIRED，再以 4002 关闭', async () => {
    const h = await startHost();
    const client = await RpcClient.connect(h.url);
    const frame = await client.call('session.list', {});
    expect(frame.error).toMatchObject({ code: ErrorCode.HELLO_REQUIRED });
    expect(frame.id).toBe(1);
    expect((await client.closed).code).toBe(CloseCode.HELLO_REQUIRED);
  });

  it('hello 之前帧不合法：回 PARSE_ERROR / INVALID_REQUEST（id 为 null），再以 4002 关闭', async () => {
    const h = await startHost();
    const a = await RpcClient.connect(h.url);
    a.send('{not json');
    expect((await a.waitFor((f) => f.error !== undefined)).error?.code).toBe(ErrorCode.PARSE_ERROR);
    expect((await a.closed).code).toBe(CloseCode.HELLO_REQUIRED);

    const b = await RpcClient.connect(h.url);
    b.send([{ jsonrpc: '2.0', id: 1, method: 'host.hello', params: {} }]);
    const frame = await b.waitFor((f) => f.error !== undefined);
    expect(frame).toMatchObject({ id: null, error: { code: ErrorCode.INVALID_REQUEST } });
    expect((await b.closed).code).toBe(CloseCode.HELLO_REQUIRED);
  });

  it('hello 超时：以 4001 关闭，之前不发任何东西', async () => {
    const h = await startHost({ helloTimeoutMs: 100 });
    const client = await RpcClient.connect(h.url);
    expect((await client.closed).code).toBe(CloseCode.HELLO_TIMEOUT);
    expect(client.frames).toEqual([]);
  });

  it('令牌错误：回 UNAUTHORIZED，再以 4004 关闭', async () => {
    const h = await startHost();
    const client = await RpcClient.connect(h.url);
    const frame = await client.hello(cli, { token: `${TOKEN}x` });
    expect(frame.error).toEqual({ code: ErrorCode.UNAUTHORIZED, message: 'unauthorized' });
    expect((await client.closed).code).toBe(CloseCode.UNAUTHORIZED);
  });

  it('协议主版本不同：回 INCOMPATIBLE_PROTOCOL（带版本信息），再以 4003 关闭；排在令牌检查之前', async () => {
    const h = await startHost();
    const client = await RpcClient.connect(h.url);
    const frame = await client.hello(cli, { protocolVersion: '1.0.0', token: 'wrong' });
    expect(frame.error).toEqual({
      code: ErrorCode.INCOMPATIBLE_PROTOCOL,
      message: 'incompatible protocol version 1.0.0',
      data: {
        hostVersion: HOST_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        minProtocolVersion: MIN_PROTOCOL_VERSION,
      },
    });
    expect((await client.closed).code).toBe(CloseCode.INCOMPATIBLE_PROTOCOL);
  });

  it('参数不合 schema：回 INVALID_PARAMS（带 issues），再以 4002 关闭', async () => {
    const h = await startHost();
    const client = await RpcClient.connect(h.url);
    const frame = await client.hello(cli, { deviceId: undefined, clientKind: 'watch' });
    expect(frame.error?.code).toBe(ErrorCode.INVALID_PARAMS);
    const paths = frame.error?.data.issues.map((issue: { path: string[] }) => issue.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['deviceId', 'clientKind']));
    expect((await client.closed).code).toBe(CloseCode.HELLO_REQUIRED);
  });

  it('hello 之后再发 hello：回 INVALID_REQUEST，连接不关', async () => {
    const h = await startHost();
    const client = await readyClient(h);
    expect((await client.hello()).error?.code).toBe(ErrorCode.INVALID_REQUEST);
    expect(await client.request('host.ping')).toEqual({});
  });

  it('未知方法：回 -32601，data 带 hostVersion 与升级提示', async () => {
    const h = await startHost();
    const client = await readyClient(h);
    const frame = await client.call('session.rename', { title: 'x' });
    expect(frame.error).toEqual({
      code: -32601,
      message: 'Method not found: session.rename',
      data: { hostVersion: HOST_VERSION, hint: '请升级 Wevir Host' },
    });
    expect(await client.request('host.ping')).toEqual({});
  });
});

describe('分发与校验', () => {
  it('params 按注册表校验，不合法回 INVALID_PARAMS；hello 之后的坏帧不关连接', async () => {
    const h = await startHost();
    const client = await readyClient(h);
    const frame = await client.call('session.get', { sessionId: 'nope' });
    expect(frame.error).toMatchObject({
      code: ErrorCode.INVALID_PARAMS,
      data: { issues: [{ path: ['sessionId'] }] },
    });

    client.send('{oops');
    expect((await client.waitFor((f) => f.error?.code === ErrorCode.PARSE_ERROR)).id).toBeNull();
    client.send({ jsonrpc: '2.0', id: 'x1', params: {} });
    expect((await client.waitFor((f) => f.id === 'x1')).error?.code).toBe(
      ErrorCode.INVALID_REQUEST,
    );
    client.ws.send(Buffer.from('{}'), { binary: true });
    expect(
      (await client.waitFor((f) => f.error?.message === 'binary frames are not supported')).error
        ?.code,
    ).toBe(ErrorCode.INVALID_REQUEST);
    client.send([]);
    const batch = await client.waitFor(
      (f) => f.error?.message === 'batch requests are not supported',
    );
    expect(batch).toMatchObject({ id: null, error: { code: ErrorCode.INVALID_REQUEST } });
    expect(await client.request('host.ping')).toEqual({});
  });

  it('HostError 原样映射成 JSON-RPC 错误', async () => {
    const h = await startHost();
    const client = await readyClient(h);
    const frame = await client.call('session.get', { sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' });
    expect(frame.error).toEqual({
      code: ErrorCode.SESSION_NOT_FOUND,
      message: 'session ses_01JA2B3C4D5E6F7G8H9JKMNPQR not found',
    });
  });

  it('其他异常：回 INTERNAL_ERROR，不带内部信息，错误交给 onError', async () => {
    const boom = new Error('boom at /secret/path');
    const h = await startHost({
      methods: {
        'workspace.list': () => {
          throw boom;
        },
      },
    });
    const client = await readyClient(h);
    const frame = await client.call('workspace.list', {});
    expect(frame.error).toEqual({ code: ErrorCode.INTERNAL_ERROR, message: 'internal error' });
    expect(h.errors.splice(0)).toEqual([boom]);
  });

  it('result 不合 schema：严格模式回 INTERNAL_ERROR', async () => {
    const h = await startHost({
      resultValidation: 'strict',
      methods: { 'workspace.list': () => ({ workspaces: [{ id: 'bad' }] }) as never },
    });
    const client = await readyClient(h);
    const frame = await client.call('workspace.list');
    expect(frame.error).toEqual({ code: ErrorCode.INTERNAL_ERROR, message: 'internal error' });
    const [error] = h.errors.splice(0);
    expect(error).toBeInstanceOf(InvalidResultError);
    expect((error as InvalidResultError).method).toBe('workspace.list');
  });

  it('result 不合 schema：宽松模式照发并记录告警', async () => {
    const h = await startHost({
      resultValidation: 'warn',
      methods: { 'workspace.list': () => ({ workspaces: [{ id: 'bad' }] }) as never },
    });
    const client = await readyClient(h);
    expect(await client.request('workspace.list')).toEqual({ workspaces: [{ id: 'bad' }] });
    expect(h.errors.splice(0)).toEqual([expect.any(InvalidResultError)]);
  });

  it('result 合法时按 schema 输出（剥掉 schema 之外的字段）', async () => {
    const h = await startHost({
      methods: { 'workspace.list': () => ({ workspaces: [], internal: 'x' }) as never },
    });
    const client = await readyClient(h);
    expect(await client.request('workspace.list')).toEqual({ workspaces: [] });
  });

  it('同一连接上的请求并发执行，响应按 id 对应', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await startHost({
      methods: {
        'workspace.list': async () => {
          await gate;
          return { workspaces: [] };
        },
      },
    });
    const client = await readyClient(h);
    const slow = client.call('workspace.list');
    expect(await client.request('host.ping')).toEqual({});
    release();
    expect((await slow).result).toEqual({ workspaces: [] });
  });
});

describe('工作区与 Provider', () => {
  it('workspace.add：按 realpath 去重，移除后再加恢复原 id', async () => {
    const h = await startHost();
    const client = await readyClient(h);
    const first = await client.request('workspace.add', { rootPath: h.workspaceDir });
    expect(first).toMatchObject({
      created: true,
      workspace: { rootPath: realpathSync(h.workspaceDir), displayName: basename(h.workspaceDir) },
    });
    const link = join(tempDir(), 'link');
    symlinkSync(h.workspaceDir, link);
    const again = await client.request('workspace.add', { rootPath: link, displayName: 'other' });
    expect(again).toEqual({ created: false, workspace: first.workspace });

    await client.request('workspace.remove', { workspaceId: first.workspace.id });
    expect(await client.request('workspace.list')).toEqual({ workspaces: [] });
    const restored = await client.request('workspace.add', { rootPath: h.workspaceDir });
    expect(restored).toMatchObject({ created: false, workspace: { id: first.workspace.id } });
    expect((await client.request('workspace.list')).workspaces).toHaveLength(1);
  });

  it('workspace.add：路径不可用时回 WORKSPACE_PATH_INVALID', async () => {
    const h = await startHost();
    const client = await readyClient(h);
    const file = join(tempDir(), 'file.txt');
    writeFileSync(file, 'x');
    for (const [rootPath, reason] of [
      ['relative/dir', 'not_absolute'],
      [join(tempDir(), 'missing'), 'not_found'],
      [file, 'not_directory'],
    ]) {
      const frame = await client.call('workspace.add', { rootPath });
      expect(frame.error).toMatchObject({
        code: ErrorCode.WORKSPACE_PATH_INVALID,
        data: { path: rootPath, reason },
      });
    }
  });

  it('有未关闭会话时不能移除工作区与 Provider；移除工作区后其会话不可见', async () => {
    const h = await startHost();
    const client = await readyClient(h);
    const sessionId = await createSession(h, client);
    const { session } = await client.request('session.get', { sessionId });

    const removeWs = await client.call('workspace.remove', { workspaceId: session.workspaceId });
    expect(removeWs.error).toMatchObject({
      code: ErrorCode.RESOURCE_IN_USE,
      data: { sessionIds: [sessionId] },
    });
    const removeProvider = await client.call('provider.remove', {
      providerId: 'deepseek-official',
    });
    expect(removeProvider.error).toMatchObject({
      code: ErrorCode.RESOURCE_IN_USE,
      data: { sessionIds: [sessionId] },
    });

    expect(
      (await client.request('session.list')).sessions.map((s: { id: string }) => s.id),
    ).toEqual([sessionId]);
    await client.request('session.close', { sessionId });
    await client.request('workspace.remove', { workspaceId: session.workspaceId });
    expect(await client.request('session.list')).toEqual({ sessions: [] });
    for (const [method, params] of [
      ['session.get', { sessionId }],
      ['events.subscribe', { sessionId, sinceSeq: 0 }],
    ] as const) {
      expect((await client.call(method, params)).error?.code).toBe(ErrorCode.SESSION_NOT_FOUND);
    }
    expect(
      (await client.call('session.list', { workspaceId: session.workspaceId })).error?.code,
    ).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
    await client.request('provider.remove', { providerId: 'deepseek-official' });
  });

  it('provider.upsert：Key 只进 SecretStore，响应里只有 hasSecret；kind 不可改', async () => {
    const h = await startHost();
    const client = await readyClient(h);
    const params = {
      id: 'qwen',
      kind: 'openai-compatible',
      displayName: '通义',
      api: 'openai-completions',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: [{ id: 'qwen-max' }],
      defaultModelId: 'qwen-max',
    };
    const notInModels = await client.call('provider.upsert', { ...params, defaultModelId: 'x' });
    expect(notInModels.error).toMatchObject({
      code: ErrorCode.INVALID_PARAMS,
      data: { issues: [{ path: ['defaultModelId'] }] },
    });

    const created = await client.call('provider.upsert', { ...params, apiKey: 'sk-secret-1' });
    expect(JSON.stringify(created)).not.toContain('sk-secret-1');
    expect(created.result).toMatchObject({
      created: true,
      provider: { id: 'qwen', hasSecret: true },
    });
    expect(await h.secrets.get('qwen')).toBe('sk-secret-1');

    // 省略 apiKey 保留已存的 Key；null 删除。
    const kept = await client.request('provider.upsert', { ...params, displayName: '通义千问' });
    expect(kept).toMatchObject({
      created: false,
      provider: { displayName: '通义千问', hasSecret: true },
    });
    const cleared = await client.request('provider.upsert', { ...params, apiKey: null });
    expect(cleared.provider.hasSecret).toBe(false);
    expect(await h.secrets.get('qwen')).toBeUndefined();

    const kindChange = await client.call('provider.upsert', {
      id: 'qwen',
      kind: 'deepseek-official',
      displayName: 'x',
      models: [],
      defaultModelId: 'x',
    });
    expect(kindChange.error?.code).toBe(ErrorCode.INVALID_PARAMS);

    expect((await client.request('provider.list')).providers).toHaveLength(1);
    expect(await client.request('provider.test', { providerId: 'qwen' })).toMatchObject({
      ok: false,
      error: { category: 'unknown' },
    });
    await client.request('provider.upsert', { ...params, apiKey: 'sk-secret-2' });
    await client.request('provider.remove', { providerId: 'qwen' });
    expect(await h.secrets.get('qwen')).toBeUndefined();
    expect((await client.call('provider.test', { providerId: 'qwen' })).error?.code).toBe(
      ErrorCode.PROVIDER_NOT_FOUND,
    );
  });
});

describe('events.subscribe', () => {
  it('先补发再实时：补发过程中并发写入的事件不丢不重、按 seq 连续，响应先于第一条事件', async () => {
    const h = await startHost({ replayBatchSize: 16 });
    const client = await readyClient(h);
    const sessionId = await createSession(h, client);
    for (let i = 0; i < 300; i += 1) h.events.append(sessionId, usage(i));

    // 补发每读一批之前插入一条事件（seq 大于 replayedThroughSeq，读出来的批里也会带上它）。
    const readSince = h.events.readSince.bind(h.events);
    let injected = 0;
    const spy = vi.spyOn(h.events, 'readSince').mockImplementation((id, sinceSeq, limit) => {
      if (id === sessionId) h.events.append(sessionId, usage(10_000 + injected++));
      return readSince(id, sinceSeq, limit);
    });
    // 另有一个写入方每轮事件循环写一条，与订阅请求、补发交错。
    let writing = true;
    let written = 0;
    const writer = (async () => {
      while (writing) {
        h.events.append(sessionId, usage(20_000 + written++));
        await nextTick();
      }
    })();

    const response = await client.call('events.subscribe', { sessionId, sinceSeq: 0 });
    const { subscriptionId, replayedThroughSeq } = response.result;
    await client.waitForEvent(subscriptionId, (e) => e.seq === replayedThroughSeq);
    for (let i = 0; i < 20; i += 1) await nextTick();
    writing = false;
    await writer;
    spy.mockRestore();

    const lastSeq = h.storage.events.lastSeq(sessionId);
    expect(injected).toBeGreaterThan(5);
    expect(lastSeq).toBeGreaterThan(replayedThroughSeq);
    await client.until(() => client.events(subscriptionId).at(-1)?.seq === lastSeq, 'last event');
    expect(client.events(subscriptionId).map((e) => e.seq)).toEqual(range(1, lastSeq));
    const responseIndex = client.frames.indexOf(response);
    const firstEventIndex = client.frames.findIndex((f) => f.method === 'events.event');
    expect(responseIndex).toBeLessThan(firstEventIndex);
  });

  it('sinceSeq 在中间只补发之后的；sinceSeq 已追平时不补发', async () => {
    const h = await startHost();
    const client = await readyClient(h);
    const sessionId = await createSession(h, client);
    for (let i = 0; i < 4; i += 1) h.events.append(sessionId, usage(i));

    const middle = await subscribe(client, sessionId, 3);
    expect(middle.replayedThroughSeq).toBe(5);
    const caughtUp = await subscribe(client, sessionId, 5);
    h.events.append(sessionId, usage(99));
    await client.waitForEvent(caughtUp.subscriptionId, (e) => e.seq === 6);
    await client.waitForEvent(middle.subscriptionId, (e) => e.seq === 6);
    expect(client.events(middle.subscriptionId).map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(client.events(caughtUp.subscriptionId).map((e) => e.seq)).toEqual([6]);
  });

  it('同一连接可订阅多个会话、对同一会话多次订阅，通知带各自的 subscriptionId', async () => {
    const h = await startHost();
    const client = await readyClient(h);
    const s1 = await createSession(h, client);
    const s2 = await createSession(h, client);
    const a = await subscribe(client, s1);
    const b = await subscribe(client, s2);
    const c = await subscribe(client, s1, 1);
    expect(new Set([a.subscriptionId, b.subscriptionId, c.subscriptionId]).size).toBe(3);
    expect(h.server.subscriptionCount).toBe(3);

    h.events.append(s1, usage(1));
    h.events.append(s2, usage(2));
    await client.waitForEvent(a.subscriptionId, (e) => e.seq === 2);
    await client.waitForEvent(b.subscriptionId, (e) => e.seq === 2);
    await client.waitForEvent(c.subscriptionId, (e) => e.seq === 2);
    expect(client.events(a.subscriptionId).every((e) => e.sessionId === s1)).toBe(true);
    expect(client.events(b.subscriptionId).every((e) => e.sessionId === s2)).toBe(true);
    expect(client.events(c.subscriptionId).map((e) => e.seq)).toEqual([2]);
  });

  it('events.unsubscribe：响应之后不再有该订阅的事件；不存在的 id 成功、无操作', async () => {
    const h = await startHost();
    const client = await readyClient(h);
    const sessionId = await createSession(h, client);
    const kept = await subscribe(client, sessionId, 1);
    const dropped = await subscribe(client, sessionId, 1);
    expect(await client.request('events.unsubscribe', dropped)).toEqual({});
    expect(await client.request('events.unsubscribe', dropped)).toEqual({});
    expect(
      await client.request('events.unsubscribe', {
        subscriptionId: 'sub_01JA2B3C4D5E6F7G8H9JKMNPQR',
      }),
    ).toEqual({});

    h.events.append(sessionId, usage(1));
    await client.waitForEvent(kept.subscriptionId, (e) => e.seq === 2);
    expect(client.events(dropped.subscriptionId)).toEqual([]);
    expect(h.server.subscriptionCount).toBe(1);
  });

  it('连接断开时丢弃它的全部订阅', async () => {
    const h = await startHost();
    const client = await readyClient(h);
    const sessionId = await createSession(h, client);
    await subscribe(client, sessionId);
    await subscribe(client, sessionId);
    const other = await readyClient(h, desktop);
    const kept = await subscribe(other, sessionId, 1);
    expect(h.server.subscriptionCount).toBe(3);

    client.ws.close();
    await vi.waitFor(() => expect(h.server.connectionCount).toBe(1));
    expect(h.server.subscriptionCount).toBe(1);
    h.events.append(sessionId, usage(1));
    await other.waitForEvent(kept.subscriptionId, (e) => e.seq === 2);
  });

  it('两个客户端同时订阅同一会话，各自收到同一条完整、连续的事件流', async () => {
    const h = await startHost();
    const a = await readyClient(h, cli);
    const b = await readyClient(h, desktop);
    const sessionId = await createSession(h, a);
    const subA = await subscribe(a, sessionId);
    const subB = await subscribe(b, sessionId);

    const sent = await a.request('session.send', {
      sessionId,
      content: [{ type: 'text', text: 'run a tool and think' }],
      clientMessageId: 'msg-1',
    });
    const finished = (e: WevirEvent) => e.type === 'turn.finished';
    await a.waitForEvent(subA.subscriptionId, finished);
    await b.waitForEvent(subB.subscriptionId, finished);
    await a.until(() => a.events(subA.subscriptionId).at(-1)?.type === 'session.state_changed');
    await b.until(() => b.events(subB.subscriptionId).at(-1)?.type === 'session.state_changed');

    const lastSeq = h.storage.events.lastSeq(sessionId);
    const eventsA = a.events(subA.subscriptionId);
    expect(eventsA.map((e) => e.seq)).toEqual(range(1, lastSeq));
    expect(b.events(subB.subscriptionId)).toEqual(eventsA);
    const message = eventsA.find((e) => e.seq === sent.seq);
    expect(message).toMatchObject({ type: 'user.message', payload: { sentBy: cli } });
    expect(eventsA.some((e) => e.type === 'assistant.delta')).toBe(true);
    expect(eventsA.some((e) => e.type === 'tool.finished')).toBe(true);
  });

  it('一个客户端审批，另一个客户端收到带 decidedBy 的 approval.resolved；后到者 ALREADY_DECIDED', async () => {
    const h = await startHost();
    const a = await readyClient(h, cli);
    const b = await readyClient(h, desktop);
    const sessionId = await createSession(h, a);
    const subA = await subscribe(a, sessionId);
    const subB = await subscribe(b, sessionId);

    await a.request('session.send', {
      sessionId,
      content: [{ type: 'text', text: 'please approve the write' }],
    });
    const requested = (e: WevirEvent) => e.type === 'approval.requested';
    const request = await a.waitForEvent(subA.subscriptionId, requested);
    await b.waitForEvent(subB.subscriptionId, requested);
    if (request.type !== 'approval.requested') throw new Error('unreachable');
    const approvalId = request.payload.approval.id;
    expect((await b.request('session.get', { sessionId })).pendingApprovals).toHaveLength(1);

    const decision = await b.request('approval.respond', { approvalId, optionId: 'allow-once' });
    const resolution = { reason: 'user', optionId: 'allow-once', decidedBy: desktop };
    expect(decision).toEqual({ approvalId, status: 'approved', resolution });
    for (const [client, sub] of [
      [a, subA],
      [b, subB],
    ] as const) {
      const resolved = await client.waitForEvent(
        sub.subscriptionId,
        (e) => e.type === 'approval.resolved',
      );
      expect(resolved.payload).toEqual({ approvalId, status: 'approved', resolution });
    }

    const late = await a.call('approval.respond', { approvalId, optionId: 'reject-once' });
    expect(late.error).toEqual({
      code: ErrorCode.ALREADY_DECIDED,
      message: 'approval already decided',
      data: { approvalId, status: 'approved', resolution },
    });
    await a.waitForEvent(subA.subscriptionId, (e) => e.type === 'turn.finished');
  });
});

describe('连接健康', () => {
  it('超过租约没有任何消息的连接以 4005 断开；按时 ping 的连接保持', async () => {
    const h = await startHost({ leaseMs: 200 });
    const idle = await readyClient(h);
    const active = await readyClient(h, desktop);
    let n = 0;
    const timer = setInterval(
      () => active.send({ jsonrpc: '2.0', id: `ping-${n++}`, method: 'host.ping' }),
      50,
    );
    try {
      expect((await idle.closed).code).toBe(CloseCode.LEASE_EXPIRED);
      await delay(300);
      expect(active.ws.readyState).toBe(WebSocket.OPEN);
      expect(active.frames.filter((f) => f.result !== undefined).length).toBeGreaterThan(5);
    } finally {
      clearInterval(timer);
    }
  });

  it('发送缓冲超限只断这一条连接（4006），同一会话的其他订阅者不受影响', async () => {
    const limit = 64 * 1024;
    const h = await startHost({ sendBufferLimitBytes: limit, closeTimeoutMs: 10_000 });
    const slow = await readyClient(h, cli);
    const fast = await readyClient(h, desktop);
    const sessionId = await createSession(h, slow);
    const subSlow = await subscribe(slow, sessionId, 1);
    const subFast = await subscribe(fast, sessionId, 1);

    // 慢客户端停止读取：内核缓冲填满后，Host 侧的积压开始增长。
    const socket = (slow.ws as unknown as { _socket: Socket })._socket;
    socket.pause();
    const chunk = 'x'.repeat(15_000);
    let appended = 0;
    while (h.server.subscriptionCount > 1 && appended < 2000) {
      h.events.append(sessionId, {
        type: 'engine.raw',
        source: 'engine',
        payload: {
          protocol: 'acp',
          method: 'session/update',
          params: { chunks: Array(8).fill(chunk) },
        },
      });
      appended += 1;
      await nextTick();
    }
    expect(h.server.subscriptionCount).toBe(1);

    await fast.until(
      () => fast.events(subFast.subscriptionId).length === appended,
      'all events on the fast client',
    );
    expect(fast.events(subFast.subscriptionId).map((e) => e.seq)).toEqual(range(2, appended + 1));
    expect(await fast.request('host.ping')).toEqual({});

    socket.resume();
    expect((await slow.closed).code).toBe(CloseCode.SEND_BUFFER_OVERFLOW);
    expect(slow.events(subSlow.subscriptionId).length).toBeLessThan(appended);
  });
});

describe('关闭', () => {
  it('通知客户端（1001）前等在途请求结束；关闭期间的新请求回 HOST_SHUTTING_DOWN', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const h = await startHost({
      methods: {
        'workspace.list': async () => {
          entered = true;
          await gate;
          return { workspaces: [] };
        },
      },
    });
    const client = await readyClient(h);
    const pending = await RpcClient.connect(h.url);
    const slow = client.call('workspace.list');
    await vi.waitFor(() => expect(entered && h.server.connectionCount === 2).toBe(true));

    const closing = h.server.close();
    expect((await pending.closed).code).toBe(CloseCode.GOING_AWAY);
    const rejected = await client.call('host.ping');
    expect(rejected.error?.code).toBe(ErrorCode.HOST_SHUTTING_DOWN);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);

    release();
    expect((await slow).result).toEqual({ workspaces: [] });
    expect((await client.closed).code).toBe(CloseCode.GOING_AWAY);
    await closing;
    expect(h.server.connectionCount).toBe(0);
    await expect(RpcClient.connect(h.url)).rejects.toThrow();
  });

  it('等在途请求有上限：超时后照样关闭', async () => {
    const h = await startHost({
      methods: { 'workspace.list': () => new Promise<never>(() => {}) },
    });
    const client = await readyClient(h);
    const never = client.call('workspace.list').catch(() => undefined);
    await delay(20);
    const started = Date.now();
    await h.server.close({ drainTimeoutMs: 100 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await client.closed).code).toBe(CloseCode.GOING_AWAY);
    await never;
  });

  it('还没发出升级请求的 TCP 连接不拖住关闭', async () => {
    const h = await startHost();
    const socket = connect(h.port, '127.0.0.1');
    socket.on('error', () => {}); // 被 Host 断开时可能是 ECONNRESET
    await new Promise((resolve) => socket.once('connect', resolve));
    const socketClosed = new Promise((resolve) => socket.once('close', resolve));
    const started = Date.now();
    await h.server.close();
    expect(Date.now() - started).toBeLessThan(1000);
    await socketClosed;
  });

  it('host.shutdown：先回 {}，再把发起方交给 onShutdownRequest', async () => {
    const requests: ClientIdentity[] = [];
    const h = await startHost({ onShutdownRequest: (client) => requests.push(client) });
    const client = await readyClient(h, desktop);
    expect(await client.request('host.shutdown')).toEqual({});
    expect(requests).toEqual([desktop]);
  });

  it('没有 onShutdownRequest 时 host.shutdown 关闭服务', async () => {
    const h = await startHost();
    const client = await readyClient(h);
    expect(await client.request('host.shutdown')).toEqual({});
    expect((await client.closed).code).toBe(CloseCode.GOING_AWAY);
  });
});
