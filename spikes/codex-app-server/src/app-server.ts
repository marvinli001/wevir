// codex-app-server 的最小客户端：起子进程，stdio 上逐行 JSON（JSON-RPC 形状，但不带 "jsonrpc" 字段，
// upstream/codex/codex-rs/app-server-protocol/src/rpc.rs:1-2）。只给 spike 用，不追求完备。

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface Notification {
  method: string;
  params: Record<string, unknown>;
  at: number;
}

export interface ServerRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

export type ServerRequestHandler = (request: ServerRequest) => Promise<unknown> | unknown;

export interface AppServerOptions {
  binary: string;
  codexHome: string;
  /** 子进程环境：白名单构造，不继承调用方的环境。 */
  env: Record<string, string>;
  args?: string[];
  onServerRequest?: ServerRequestHandler;
  /** 打印每一行收发（调试用）。 */
  trace?: boolean;
}

export class AppServer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly notifications: Notification[] = [];
  readonly serverRequests: ServerRequest[] = [];
  readonly stderr: string[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #waiters: Array<{ match: (n: Notification) => boolean; resolve: (n: Notification) => void }> = [];
  #requestWaiters: Array<{
    match: (r: ServerRequest) => boolean;
    resolve: (r: ServerRequest) => void;
  }> = [];
  #options: AppServerOptions;

  constructor(options: AppServerOptions) {
    this.#options = options;
    this.child = spawn(options.binary, options.args ?? [], {
      cwd: options.codexHome,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => {
        for (const p of this.#pending.values()) p.reject(new Error(`app-server 退出：${code}`));
        this.#pending.clear();
        resolve({ code, signal });
      });
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.#onLine(line));
    createInterface({ input: this.child.stderr }).on('line', (line) => {
      this.stderr.push(line);
      if (options.trace) console.error(`  [stderr] ${line}`);
    });
  }

  #send(message: unknown): void {
    const line = JSON.stringify(message);
    if (this.#options.trace) console.error(`  → ${line.slice(0, 300)}`);
    this.child.stdin.write(`${line}\n`);
  }

  #onLine(line: string): void {
    if (this.#options.trace) console.error(`  ← ${line.slice(0, 300)}`);
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      this.stderr.push(`[非 JSON 的 stdout] ${line}`);
      return;
    }
    if ('id' in message && 'method' in message) {
      const request = message as unknown as ServerRequest;
      this.serverRequests.push(request);
      this.#requestWaiters = this.#requestWaiters.filter((w) => {
        if (!w.match(request)) return true;
        w.resolve(request);
        return false;
      });
      void Promise.resolve(this.#options.onServerRequest?.(request)).then(
        (result) => this.#send({ id: request.id, result: result ?? {} }),
        (error: Error) =>
          this.#send({ id: request.id, error: { code: -32000, message: error.message } }),
      );
      return;
    }
    if ('id' in message) {
      const pending = this.#pending.get(message.id as number);
      if (!pending) return;
      this.#pending.delete(message.id as number);
      if ('error' in message) {
        const error = message.error as { code: number; message: string };
        pending.reject(Object.assign(new Error(`${error.code} ${error.message}`), { rpc: error }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    const notification: Notification = {
      method: message.method as string,
      params: (message.params ?? {}) as Record<string, unknown>,
      at: performance.now(),
    };
    this.notifications.push(notification);
    this.#waiters = this.#waiters.filter((w) => {
      if (!w.match(notification)) return true;
      w.resolve(notification);
      return false;
    });
  }

  request<T = Record<string, unknown>>(method: string, params: unknown): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#send(params === undefined ? { method } : { method, params });
  }

  async initialize(experimentalApi = false): Promise<Record<string, unknown>> {
    const result = await this.request('initialize', {
      clientInfo: { name: 'wevir_spike', title: 'Wevir spike', version: '0.0.0' },
      capabilities: { experimentalApi, requestAttestation: false },
    });
    this.notify('initialized');
    return result;
  }

  /** 等到一条满足条件的通知（已经到过的也算）。 */
  waitFor(
    match: (n: Notification) => boolean,
    timeoutMs = 30_000,
    label = 'notification',
  ): Promise<Notification> {
    const seen = this.notifications.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w.resolve !== done);
        reject(new Error(`等待 ${label} 超时（${timeoutMs} ms）`));
      }, timeoutMs);
      const done = (n: Notification) => {
        clearTimeout(timer);
        resolve(n);
      };
      this.#waiters.push({ match, resolve: done });
    });
  }

  /** 等到一条满足条件的服务端请求（审批等；已经到过的也算）。 */
  waitForRequest(match: (r: ServerRequest) => boolean, timeoutMs = 30_000): Promise<ServerRequest> {
    const seen = this.serverRequests.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#requestWaiters = this.#requestWaiters.filter((w) => w.resolve !== done);
        reject(new Error(`等待服务端请求超时（${timeoutMs} ms）`));
      }, timeoutMs);
      const done = (r: ServerRequest) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.#requestWaiters.push({ match, resolve: done });
    });
  }

  waitTurnCompleted(threadId: string, turnId: string, timeoutMs = 60_000): Promise<Notification> {
    return this.waitFor(
      (n) =>
        n.method === 'turn/completed' &&
        n.params.threadId === threadId &&
        (n.params.turn as { id: string }).id === turnId,
      timeoutMs,
      `turn/completed ${turnId}`,
    );
  }

  /** 先关 stdin，等不到退出再 SIGTERM、SIGKILL。 */
  async close(timeoutMs = 3000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.exited;
    this.child.stdin.end();
    const timeout = (ms: number) =>
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms));
    if ((await Promise.race([this.exited, timeout(timeoutMs)])) !== 'timeout') return this.exited;
    this.child.kill('SIGTERM');
    if ((await Promise.race([this.exited, timeout(timeoutMs)])) !== 'timeout') return this.exited;
    this.child.kill('SIGKILL');
    return this.exited;
  }
}
