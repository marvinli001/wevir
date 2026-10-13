// 测试共用：临时数据目录上的 Storage / EventStore、各类事件的构造函数、最小 RPC 客户端，以及在进程内跑
// runHostCli 用的假进程。只被 *.test.ts 引用，不进 index。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type {
  ApprovalId,
  ApprovalRequest,
  ClientIdentity,
  EngineErrorCategory,
  ResolvedApprovalStatus,
  SessionId,
  SessionState,
  StateChangeReason,
  StreamId,
  ToolFinishStatus,
  TurnId,
  TurnOutcome,
} from '@wevir/protocol';
import { PROTOCOL_VERSION, type WevirEvent } from '@wevir/protocol';
import { openStorage, type Storage } from '@wevir/storage';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { HostCliProcess } from './cli.js';
import type { AppendInput, DeltaInput } from './event-store.js';
import { EventStore, type EventStoreOptions } from './event-store.js';

export const SES: SessionId = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';
export const SES2: SessionId = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQS';
export const TURN: TurnId = 'trn_1';
export const TURN2: TurnId = 'trn_2';
export const STREAM: StreamId = 'stm_1';
export const T0 = '2026-10-13T00:00:00.000Z';

export const identity: ClientIdentity = { deviceId: 'dev-1', clientId: 'cli-1', clientKind: 'cli' };

/** 注册 beforeEach / afterEach：每个用例一个新的临时数据目录，结束时删除。 */
export function useTempDir(): () => string {
  let dir: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wevir-host-'));
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  return () => {
    if (!dir) throw new Error('useTempDir() 只能在用例里取值');
    return dir;
  };
}

/** 打开的 Storage 在用例结束时统一关闭。 */
export function useStorages(): { open: (dataDir: string) => Storage } {
  const opened: Storage[] = [];
  afterEach(() => {
    for (const storage of opened.splice(0)) if (storage.db.isOpen) storage.close();
  });
  return {
    open: (dataDir) => {
      const storage = openStorage({ dataDir });
      opened.push(storage);
      return storage;
    },
  };
}

/** 插入工作区与会话行（身份字段），满足事件表的外键。 */
export function seedSession(storage: Storage, id: SessionId = SES): void {
  const workspaceId = 'ws_1';
  if (!storage.workspaces.get(workspaceId)) {
    storage.workspaces.insert({
      id: workspaceId,
      rootPath: '/home/u/project',
      displayName: 'project',
      createdAt: T0,
      updatedAt: T0,
    });
  }
  storage.sessions.insert({
    id,
    workspaceId,
    cwd: '/home/u/project',
    engine: 'dsh',
    engineSessionId: `engine-${id}`,
    providerId: 'deepseek-official',
    modelId: 'deepseek-chat',
    reasoningEffort: 'high',
    title: '',
    titleSource: 'first_prompt',
    state: 'idle',
    lastSeq: 0,
    createdAt: T0,
    updatedAt: T0,
  });
}

/** 一个会话已建好（行已插入、`session.created` 已写）的 EventStore。 */
export function createStore(
  storage: Storage,
  options: Omit<EventStoreOptions, 'storage'> = {},
  sessionIds: SessionId[] = [SES],
): EventStore {
  const store = new EventStore({ storage, ...options });
  for (const id of sessionIds) {
    if (!storage.sessions.get(id)) seedSession(storage, id);
    if (storage.events.lastSeq(id) === 0) store.append(id, ev.created());
  }
  return store;
}

export function approval(id: ApprovalId, turnId: TurnId = TURN): ApprovalRequest {
  return {
    id,
    sessionId: SES,
    turnId,
    toolCallId: `call_${id}`,
    options: [
      { optionId: 'allow-once', label: 'Allow once', kind: 'allow_once', category: 'allow' },
      { optionId: 'reject-once', label: 'Reject', kind: 'reject_once', category: 'reject' },
    ],
    detail: {
      toolName: 'write',
      display: { kind: 'write', paths: ['/tmp/out.txt'] },
      input: { file_path: '/tmp/out.txt', content: 'x' },
    },
    status: 'pending',
    createdAt: T0,
  };
}

/** 某一类型的 `append` 输入。 */
export type Input<T extends AppendInput['type']> = Extract<AppendInput, { type: T }>;

/** 各类事件的构造函数（payload 取最小合法形状）。 */
export const ev = {
  created: (): Input<'session.created'> => ({
    type: 'session.created',
    source: 'host',
    payload: {
      workspaceId: 'ws_1',
      cwd: '/home/u/project',
      providerId: 'deepseek-official',
      modelId: 'deepseek-chat',
      reasoningEffort: 'high',
    },
  }),
  title: (title: string): Input<'session.title_changed'> => ({
    type: 'session.title_changed',
    source: 'host',
    payload: { title, source: 'first_prompt' },
  }),
  state: (
    from: SessionState,
    to: SessionState,
    reason: StateChangeReason,
  ): Input<'session.state_changed'> => ({
    type: 'session.state_changed',
    source: 'host',
    payload: { from, to, reason },
  }),
  user: (turnId: TurnId = TURN, clientMessageId?: string): Input<'user.message'> => ({
    type: 'user.message',
    source: 'host',
    payload: {
      turnId,
      content: [{ type: 'text', text: '写一个 summary.md' }],
      sentBy: identity,
      ...(clientMessageId === undefined ? {} : { clientMessageId }),
    },
  }),
  turnStarted: (turnId: TurnId = TURN): Input<'turn.started'> => ({
    type: 'turn.started',
    source: 'host',
    payload: { turnId },
  }),
  turnFinished: (outcome: TurnOutcome, turnId: TurnId = TURN): Input<'turn.finished'> => ({
    type: 'turn.finished',
    source: 'host',
    payload: { turnId, outcome, durationMs: 10 },
  }),
  toolStarted: (
    toolCallId: string,
    input?: unknown,
    turnId: TurnId = TURN,
  ): Input<'tool.started'> => ({
    type: 'tool.started',
    source: 'engine',
    payload: {
      turnId,
      toolCallId,
      toolName: 'bash',
      display: { kind: 'shell', command: 'ls' },
      ...(input === undefined ? {} : { input }),
    },
  }),
  toolFinished: (
    toolCallId: string,
    status: ToolFinishStatus,
    text?: string,
    turnId: TurnId = TURN,
  ): Input<'tool.finished'> => ({
    type: 'tool.finished',
    source: status === 'unknown' ? 'host' : 'engine',
    payload: {
      turnId,
      toolCallId,
      status,
      ...(text === undefined ? {} : { output: { text, truncated: false } }),
    },
  }),
  approvalRequested: (id: ApprovalId, turnId: TurnId = TURN): Input<'approval.requested'> => ({
    type: 'approval.requested',
    source: 'engine',
    payload: { approval: approval(id, turnId) },
  }),
  approvalResolved: (
    approvalId: ApprovalId,
    status: ResolvedApprovalStatus,
    reason: 'user' | 'turn_cancelled' | 'session_closed' | 'engine_exited' | 'host_restarted',
  ): Input<'approval.resolved'> => ({
    type: 'approval.resolved',
    source: 'host',
    payload: {
      approvalId,
      status,
      resolution:
        reason === 'user' ? { reason, optionId: 'allow-once', decidedBy: identity } : { reason },
    },
  }),
  engineError: (
    category: EngineErrorCategory,
    fatal: boolean,
    turnId?: TurnId,
  ): Input<'engine.error'> => ({
    type: 'engine.error',
    source: fatal ? 'host' : 'engine',
    payload: {
      category,
      message: `${category} 原文`,
      fatal,
      ...(turnId === undefined ? {} : { turnId }),
    },
  }),
  usage: (contextUsed: number): Input<'usage.updated'> => ({
    type: 'usage.updated',
    source: 'engine',
    payload: { contextUsed, contextSize: 262144 },
  }),
  todo: (items: Array<{ content: string; status: string }>): Input<'todo.updated'> => ({
    type: 'todo.updated',
    source: 'host',
    payload: { turnId: TURN, toolCallId: 'call_todo', items },
  }),
};

export function delta(
  text: string,
  blockIndex = 0,
  kind: 'text' | 'reasoning' = 'text',
  turnId: TurnId = TURN,
): DeltaInput {
  return { turnId, streamId: STREAM, blockIndex, kind, text };
}

// ── 进程级测试用的最小 RPC 客户端 ───────────────────────────────────────

interface RpcFrame {
  id?: number;
  // biome-ignore lint/suspicious/noExplicitAny: 测试按需读取任意形状的 result。
  result?: any;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: { subscriptionId: string; event: WevirEvent };
}

/** 连到 Host 的 ws 客户端：按 `id` 等响应，按订阅收事件，`until` 每收到一帧重查一次。 */
export class TestRpcClient {
  readonly ws: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #frames: RpcFrame[] = [];
  readonly #listeners = new Set<() => void>();
  #nextId = 1;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      this.#frames.push(JSON.parse(String(data)) as RpcFrame);
      this.#notify();
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: String(reason) });
        this.#notify();
      });
    });
  }

  static connect(url: string): Promise<TestRpcClient> {
    const client = new TestRpcClient(new WebSocket(url));
    return new Promise((resolve, reject) => {
      client.ws.once('open', () => resolve(client));
      client.ws.once('error', reject);
    });
  }

  /** 发请求，返回响应帧（成功或失败都返回）。 */
  call(method: string, params: unknown = {}): Promise<RpcFrame> {
    const id = this.#nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return this.until(() => this.#frames.find((frame) => frame.id === id), method);
  }

  /** 发请求，成功返回 result，失败抛错（带 `code`）。 */
  // biome-ignore lint/suspicious/noExplicitAny: 同上。
  async request(method: string, params: unknown = {}): Promise<any> {
    const frame = await this.call(method, params);
    if (frame.error) throw Object.assign(new Error(frame.error.message), frame.error);
    return frame.result;
  }

  hello(token: string, who: ClientIdentity = identity): Promise<RpcFrame> {
    return this.call('host.hello', {
      token,
      protocolVersion: PROTOCOL_VERSION,
      ...who,
      capabilities: {},
    });
  }

  events(subscriptionId: string): WevirEvent[] {
    return this.#frames.flatMap((frame) =>
      frame.method === 'events.event' && frame.params?.subscriptionId === subscriptionId
        ? [frame.params.event]
        : [],
    );
  }

  until<T>(check: () => T | undefined, label: string, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const listener = () => {
        const value = check();
        if (value !== undefined) {
          cleanup();
          resolve(value);
        } else if (this.ws.readyState === WebSocket.CLOSED) {
          cleanup();
          reject(new Error(`连接已关闭，${label} 未满足`));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`等待 ${label} 超时`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.#listeners.delete(listener);
      };
      this.#listeners.add(listener);
      listener();
    });
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

// ── 进程内运行 runHostCli ──────────────────────────────────────────────

type Listener = (arg: never) => void;

/** runHostCli 用的假进程：信号与 stdin 由测试触发，stdout / stderr 收进 `out`。 */
export function fakeProcess(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const listeners = new Map<string, Listener[]>();
  const out = { stdout: '', stderr: '' };
  const stdin = new PassThrough();
  const proc: HostCliProcess = {
    argv,
    env,
    stdin,
    stdout: { write: (text: string) => (out.stdout += text) },
    stderr: { write: (text: string) => (out.stderr += text) },
    on: ((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }) as HostCliProcess['on'],
    pid: process.pid,
  };
  const emit = (event: string, arg?: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(arg as never);
  };
  return { proc, out, stdin, emit };
}

export interface Ready {
  event: 'ready';
  pid: number;
  url: string;
  hostId: string;
  home: string;
}

/** 等 runHostCli 往 stdout 写就绪行。 */
export async function waitReady(out: { stdout: string }): Promise<Ready> {
  await vi.waitFor(() => expect(out.stdout).toContain('"event":"ready"'), { timeout: 5000 });
  const line = out.stdout.split('\n').find((l) => l.includes('"event":"ready"')) as string;
  return JSON.parse(line) as Ready;
}
