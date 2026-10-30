import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { AdapterError, trackProcessGroup } from '@wevir/runtime-adapter';
import type {
  ClientInfo,
  InitializeParams,
  InitializeResponse,
  RequestId,
  RpcErrorBody,
} from './protocol.js';

// 一个 codex-app-server 进程（ADR-0005 决策 1.1：一个 Host 一个进程，承载全部会话）。照 adapter-acp 的
// AcpProcess（acp-process.ts）写：启动（经 CodexLauncher）、握手、意外退出的上报与有限次数的自动重启、回收；
// 连接换成 app-server 自己的逐行 JSON（protocol.ts）。

/** `initialize` 的时限。冷启动到 `initialize` 响应中位 49 ms、最大 203 ms（codex-notes §1）。 */
export const INITIALIZE_TIMEOUT_MS = 15_000;

/** stderr 只保留尾部，用于诊断（字符数）。 */
export const STDERR_TAIL_CHARS = 16 * 1024;

/**
 * 回收阶梯每一步等待退出的时限：关 stdin（Spike 实测 EOF 后 6 ms 退出）→ SIGTERM → SIGKILL。三步加起来 4.5 s，
 * 与 adapter-acp 相同。
 */
export interface DisposeTimeouts {
  stdinEofMs: number;
  sigtermMs: number;
  sigkillMs: number;
}

export const DISPOSE_TIMEOUTS: DisposeTimeouts = {
  stdinEofMs: 2000,
  sigtermMs: 1500,
  sigkillMs: 1000,
};

/**
 * 意外退出后的自动重启：最多连续 `maxRestarts` 次，第 n 次等 `baseDelayMs · 2^(n-1)`（不超过 `maxDelayMs`）。
 * 就绪后连续运行满 `stableAfterMs` 再退出，计数从零算起。与 adapter-acp 相同。
 */
export interface RestartPolicy {
  maxRestarts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  stableAfterMs: number;
}

export const RESTART_POLICY: RestartPolicy = {
  maxRestarts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  stableAfterMs: 60_000,
};

export type CodexProcessState =
  /** 还没启动，或显式 `start()` 失败。 */
  | 'stopped'
  | 'starting'
  | 'ready'
  /** 意外退出后等待重启。 */
  | 'restarting'
  /** 自动重启次数用完；可以再调 `start()`。 */
  | 'failed'
  | 'disposing'
  | 'disposed';

/** 一次进程退出。 */
export interface CodexExit {
  /** 第几次启动的进程（从 1 起）。 */
  generation: number;
  pid: number | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  /** spawn 本身失败（如可执行文件不存在）时的错误。 */
  error?: Error;
}

export interface CodexReady {
  generation: number;
  pid: number;
  initialize: InitializeResponse;
  /** 是自动重启拉起的。 */
  restarted: boolean;
}

export interface CodexRestarting {
  attempt: number;
  maxRestarts: number;
  delayMs: number;
  cause: CodexExit | unknown;
}

export interface CodexFailed {
  restarts: number;
  cause: CodexExit | unknown;
}

export interface CodexProcessEventMap {
  /** 进程完成握手，可以发请求。 */
  ready: [CodexReady];
  /** 就绪的进程意外退出（不论是否在回合中）。`dispose`、`restart` 引起的退出不报。 */
  exit: [CodexExit];
  restarting: [CodexRestarting];
  failed: [CodexFailed];
}

export interface CodexSpawnSpec {
  command: string;
  args: string[];
  options: SpawnOptions & { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] };
}

/** 每次启动（含自动重启、计划重启）之前调用：准备目录与配置、核对版本，给出 spawn 参数。抛错即这次启动失败。 */
export interface CodexLauncher {
  prepare(): Promise<CodexSpawnSpec>;
}

/** 服务端发给客户端的请求（审批等，ServerRequest.ts）。 */
export interface CodexServerRequest {
  id: RequestId;
  method: string;
  params: unknown;
}

export interface CodexProcessOptions {
  launcher: CodexLauncher;
  /** `initialize` 的 `clientInfo`（ADR-0005 决策 4：`name` 写 `wevir`，`version` 写 Host 版本）。 */
  clientInfo: { name: string; version: string; title?: string };
  /**
   * 通知（没有 id 的消息），按进程写出的顺序同步调用，不得抛错。同一条流里排在后面的响应在它之后才兑现，所以
   * `turn/start` 的结果兑现时，它之前的通知都已交付。
   */
  onNotification?: (method: string, params: unknown) => void;
  /** 服务端请求。返回值作为 `result` 回复；抛错（带数字 `code` 时原样用）回复 `error`。不给时一律回复“不支持”。 */
  onServerRequest?: (request: CodexServerRequest) => Promise<unknown>;
  initializeTimeoutMs?: number;
  restart?: Partial<RestartPolicy>;
  disposeTimeouts?: Partial<DisposeTimeouts>;
}

/** app-server 回复的 JSON-RPC 错误。 */
export class CodexRpcError extends Error {
  override readonly name = 'CodexRpcError';
  readonly code: number;
  /** app-server 的原文（`message` 前面加了方法名与错误码）。 */
  readonly rpcMessage: string;
  readonly data: unknown;

  constructor(method: string, body: RpcErrorBody) {
    super(`${method} 失败：${body.code} ${body.message}`);
    this.code = body.code;
    this.rpcMessage = body.message;
    this.data = body.data;
  }
}

/** 不支持的服务端请求的回复码（JSON-RPC Method not found）。 */
export const METHOD_NOT_FOUND = -32601;

/**
 * 服务端请求的处理结果是它时不回复：请求已经由 app-server 自己结束了（`serverRequest/resolved`，回合被中断），
 * 或者进程已经不在了。
 */
export const NO_REPLY: unique symbol = Symbol('codex-app-server: no reply');

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface Launch {
  generation: number;
  child: ChildProcess;
  stderrTail: string;
  nextId: number;
  pending: Map<RequestId, Pending>;
  /** 进程退出（或 spawn 失败）时兑现。 */
  exited: Promise<CodexExit>;
  exit?: CodexExit;
  initialize?: InitializeResponse;
  readyAt?: number;
  /** 回收阶梯，每个进程只跑一次。 */
  stopping?: Promise<CodexExit | undefined>;
}

/**
 * 一个 codex-app-server 进程。负责启动（经 `CodexLauncher`）、`initialize` + `initialized` 握手、请求与响应的
 * 配对、通知与服务端请求的交付、意外退出的上报与有限次数的自动重启，以及回收（关 stdin → SIGTERM → SIGKILL）。
 * 每次（重新）启动都是一个新进程，旧进程上的 thread 随它一起失效（要 `thread/resume`，R3）。
 */
export class CodexProcess extends EventEmitter<CodexProcessEventMap> {
  readonly #options: CodexProcessOptions;
  readonly #restartPolicy: RestartPolicy;
  readonly #disposeTimeouts: DisposeTimeouts;
  #state: CodexProcessState = 'stopped';
  #generation = 0;
  #current: Launch | undefined;
  #lastExit: CodexExit | undefined;
  #starting: Promise<InitializeResponse> | undefined;
  #restarts = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #disposing: Promise<void> | undefined;
  #restartRequest: Promise<InitializeResponse> | undefined;

  constructor(options: CodexProcessOptions) {
    super();
    this.#options = options;
    this.#restartPolicy = { ...RESTART_POLICY, ...options.restart };
    this.#disposeTimeouts = { ...DISPOSE_TIMEOUTS, ...options.disposeTimeouts };
  }

  get state(): CodexProcessState {
    return this.#state;
  }

  /** 当前进程的 pid；没有活着的进程时为 undefined。 */
  get pid(): number | undefined {
    const launch = this.#current;
    return launch !== undefined && launch.exit === undefined ? launch.child.pid : undefined;
  }

  /** 已启动过的进程数（含失败的启动）。 */
  get generation(): number {
    return this.#generation;
  }

  /** 当前（或最近一个）进程的 stderr 尾部。 */
  get stderrTail(): string {
    return this.#current?.stderrTail ?? '';
  }

  /** 最近一次进程退出，含 `dispose` 引起的。 */
  get lastExit(): CodexExit | undefined {
    return this.#lastExit;
  }

  /**
   * 启动并完成握手；已就绪时直接返回上次的结果，启动中则等同一次启动。等待自动重启时立即启动；`failed` 之后
   * 重新计算重启次数。失败抛 `engine_unavailable`（不自动重试），`dispose` 之后抛 `disposed`。
   */
  start(): Promise<InitializeResponse> {
    if (this.#disposing !== undefined) return Promise.reject(this.#disposedError());
    const ready = this.#state === 'ready' ? this.#current?.initialize : undefined;
    if (ready !== undefined) return Promise.resolve(ready);
    if (this.#starting === undefined) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
      if (this.#state === 'failed') this.#restarts = 0;
      this.#starting = this.#launch(false).finally(() => {
        this.#starting = undefined;
      });
    }
    return this.#starting;
  }

  /**
   * 有计划地重启：回收当前进程（与 `dispose` 同一个阶梯，不发 `exit`，不计入自动重启次数），再启动一个新进程
   * （启动器重新准备配置）。进行中的请求以 `engine_unavailable` 失败。并发调用合并为一次。
   */
  restart(): Promise<InitializeResponse> {
    if (this.#disposing !== undefined) return Promise.reject(this.#disposedError());
    this.#restartRequest ??= (async () => {
      await this.#starting?.catch(() => {});
      if (this.#disposing !== undefined) throw this.#disposedError();
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
      const launch = this.#current;
      this.#state = 'starting';
      const run = (async () => {
        if (launch !== undefined) {
          await this.#stop(
            launch,
            new AdapterError('engine_unavailable', 'codex-app-server 正在重启'),
          );
        }
        if (this.#disposing !== undefined) throw this.#disposedError();
        return this.#launch(false);
      })();
      this.#starting = run.finally(() => {
        this.#starting = undefined;
      });
      return this.#starting;
    })().finally(() => {
      this.#restartRequest = undefined;
    });
    return this.#restartRequest;
  }

  /**
   * 发一个请求，等它的响应。进程不在 `ready` 时抛 `engine_unavailable`（`dispose` 之后抛 `disposed`）；进程在等待
   * 期间退出时以 `engine_unavailable` 失败；app-server 回错误时以 `CodexRpcError` 失败。
   */
  request<T>(method: string, params: unknown): Promise<T> {
    let launch: Launch;
    try {
      launch = this.#readyLaunch();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#request<T>(launch, method, params);
  }

  /** 发一个通知。进程不在 `ready` 时抛错。 */
  notify(method: string, params?: unknown): void {
    this.#write(this.#readyLaunch(), params === undefined ? { method } : { method, params });
  }

  /**
   * 回收进程：关 stdin → SIGTERM → SIGKILL，每步等到进程退出或超时，整个阶梯 4.5 s 内返回。停止自动重启，
   * 进行中的请求以 `disposed` 失败，不发 `exit` 事件。幂等。
   */
  dispose(): Promise<void> {
    this.#disposing ??= (async () => {
      this.#state = 'disposing';
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
      const launch = this.#current;
      if (launch !== undefined) await this.#stop(launch, this.#disposedError());
      this.#state = 'disposed';
    })();
    return this.#disposing;
  }

  #readyLaunch(): Launch {
    if (this.#disposing !== undefined) throw this.#disposedError();
    const launch = this.#current;
    if (this.#state !== 'ready' || launch === undefined) {
      throw new AdapterError('engine_unavailable', `codex-app-server 不可用（${this.#state}）`);
    }
    return launch;
  }

  #request<T>(launch: Launch, method: string, params: unknown): Promise<T> {
    if (launch.exit !== undefined || launch.stopping !== undefined) {
      return Promise.reject(new AdapterError('engine_unavailable', 'codex-app-server 已退出'));
    }
    const id = launch.nextId++;
    return new Promise<T>((resolve, reject) => {
      launch.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      this.#write(launch, { id, method, params });
    });
  }

  #write(launch: Launch, message: unknown): void {
    // 进程退出后的写入报 EPIPE（流上的 error 已经吞掉），结果以 exit 为准。
    launch.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  async #launch(restarted: boolean): Promise<InitializeResponse> {
    const generation = ++this.#generation;
    this.#state = 'starting';
    let launch: Launch;
    try {
      const spec = await this.#options.launcher.prepare();
      if (this.#disposing !== undefined) throw this.#disposedError();
      launch = this.#spawn(spec, generation);
    } catch (error) {
      if (this.#disposing !== undefined) throw this.#disposedError();
      this.#state = 'stopped';
      throw new AdapterError(
        'engine_unavailable',
        `codex-app-server 启动失败：${describe(error)}`,
        {
          cause: error,
        },
      );
    }
    this.#current = launch;

    let timer: NodeJS.Timeout | undefined;
    try {
      const timeoutMs = this.#options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
      const { clientInfo } = this.#options;
      const params: InitializeParams = {
        clientInfo: {
          name: clientInfo.name,
          title: clientInfo.title ?? null,
          version: clientInfo.version,
        } satisfies ClientInfo,
        // 实验面只为协作模式（计划模式）打开（0.36.0，ADR-0005 补记 16）；用到的实验字段在 protocol.ts 里逐个注明。
        capabilities: { experimentalApi: true, requestAttestation: false },
      };
      const response = await Promise.race([
        this.#request<InitializeResponse>(launch, 'initialize', params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`initialize 在 ${timeoutMs} ms 内没有完成`)),
            timeoutMs,
          );
        }),
      ]);
      if (launch.exit !== undefined) throw new Error('codex-app-server 在 initialize 之后立即退出');
      this.#write(launch, { method: 'initialized' });
      launch.initialize = response;
      launch.readyAt = Date.now();
      this.#state = 'ready';
      this.emit('ready', {
        generation,
        pid: launch.child.pid as number,
        initialize: response,
        restarted,
      });
      return response;
    } catch (error) {
      const exit = await this.#stop(launch, error);
      if (this.#disposing !== undefined) throw this.#disposedError();
      this.#state = 'stopped';
      const detail = exit === undefined ? '' : `；${describeExit(exit)}`;
      throw new AdapterError(
        'engine_unavailable',
        `codex-app-server 启动失败：${describe(error)}${detail}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  #spawn(spec: CodexSpawnSpec, generation: number): Launch {
    const child = nodeSpawn(spec.command, spec.args, spec.options);
    const { stdin, stdout, stderr } = child;
    if (stdin === null || stdout === null || stderr === null) {
      child.kill('SIGKILL');
      throw new Error('codex-app-server 的 stdio 没有建立');
    }
    // Host 被强行结束时由它的看门狗或下次启动结束（app-server 自己读到 stdin EOF 也会退出，组里的工具进程不一定）。
    trackProcessGroup(child, { kind: 'engine', name: 'codex-app-server' });
    for (const stream of child.stdio) stream?.on('error', () => {});

    let settle!: (exit: CodexExit) => void;
    const exited = new Promise<CodexExit>((resolve) => {
      settle = resolve;
    });
    const launch: Launch = {
      generation,
      child,
      stderrTail: '',
      nextId: 1,
      pending: new Map(),
      exited,
    };

    stderr.setEncoding('utf8');
    stderr.on('data', (chunk: string) => {
      launch.stderrTail = (launch.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    createInterface({ input: stdout, crlfDelay: Number.POSITIVE_INFINITY }).on('line', (line) =>
      this.#onLine(launch, line),
    );

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (launch.exit !== undefined) return;
      const exit: CodexExit = {
        generation,
        pid: child.pid,
        exitCode,
        signal,
        stderrTail: launch.stderrTail,
        ...(error === undefined ? {} : { error }),
      };
      launch.exit = exit;
      this.#lastExit = exit;
      settle(exit);
      this.#rejectPending(
        launch,
        new AdapterError('engine_unavailable', `codex-app-server 已退出（${describeExit(exit)}）`),
      );
      this.#onExit(launch, exit);
    };
    child.once('exit', (code, signal) => finish(code, signal));
    // spawn 失败时可能只有 error 没有 exit；用 on 而不是 once：没有监听器的 error 会让 Host 进程崩溃。
    child.on('error', (error) => {
      if (child.pid === undefined) finish(null, null, error);
    });
    return launch;
  }

  #onLine(launch: Launch, line: string): void {
    if (line.trim() === '') return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch {
      launch.stderrTail = `${launch.stderrTail}[stdout 非 JSON] ${line.slice(0, 500)}\n`.slice(
        -STDERR_TAIL_CHARS,
      );
      return;
    }
    const id = message.id;
    const hasId = typeof id === 'string' || typeof id === 'number';
    if (typeof message.method === 'string') {
      if (hasId)
        this.#onServerRequest(launch, { id, method: message.method, params: message.params });
      else this.#onNotification(message.method, message.params);
      return;
    }
    if (!hasId) return;
    const pending = launch.pending.get(id);
    if (pending === undefined) return;
    launch.pending.delete(id);
    const error = message.error as RpcErrorBody | undefined;
    if (error !== undefined && error !== null) {
      pending.reject(new CodexRpcError(pending.method, error));
    } else {
      pending.resolve(message.result);
    }
  }

  #onNotification(method: string, params: unknown): void {
    try {
      this.#options.onNotification?.(method, params);
    } catch {
      // 回调约定不抛错；万一抛了也不能让读循环断掉。
    }
  }

  #onServerRequest(launch: Launch, request: CodexServerRequest): void {
    const handler = this.#options.onServerRequest;
    const answer =
      handler === undefined
        ? Promise.reject(
            Object.assign(new Error(`不支持 ${request.method}`), { code: METHOD_NOT_FOUND }),
          )
        : handler(request);
    answer.then(
      (result) => {
        if (result === NO_REPLY) return;
        if (launch.exit === undefined)
          this.#write(launch, { id: request.id, result: result ?? {} });
      },
      (error: unknown) => {
        if (launch.exit !== undefined) return;
        const code = (error as { code?: unknown } | null)?.code;
        this.#write(launch, {
          id: request.id,
          error: {
            code: typeof code === 'number' ? code : -32000,
            message: describe(error),
          },
        });
      },
    );
  }

  #rejectPending(launch: Launch, reason: unknown): void {
    const pending = [...launch.pending.values()];
    launch.pending.clear();
    for (const { reject } of pending) reject(reason);
  }

  #onExit(launch: Launch, exit: CodexExit): void {
    // 启动中的退出由 #launch 处理；回收中的退出是预期的。
    if (this.#current !== launch || launch.stopping !== undefined || launch.readyAt === undefined) {
      return;
    }
    this.emit('exit', exit);
    if (Date.now() - launch.readyAt >= this.#restartPolicy.stableAfterMs) this.#restarts = 0;
    this.#scheduleRestart(exit);
  }

  #scheduleRestart(cause: CodexExit | unknown): void {
    if (this.#disposing !== undefined) return;
    const policy = this.#restartPolicy;
    if (this.#restarts >= policy.maxRestarts) {
      this.#state = 'failed';
      this.emit('failed', { restarts: this.#restarts, cause });
      return;
    }
    const attempt = ++this.#restarts;
    const delayMs = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
    this.#state = 'restarting';
    this.emit('restarting', { attempt, maxRestarts: policy.maxRestarts, delayMs, cause });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      this.#starting = this.#launch(true).finally(() => {
        this.#starting = undefined;
      });
      this.#starting.catch((error: unknown) => this.#scheduleRestart(error));
    }, delayMs);
  }

  /** 回收阶梯：进行中的请求以 `reason` 失败 → 关 stdin → SIGTERM → SIGKILL。 */
  #stop(launch: Launch, reason: unknown): Promise<CodexExit | undefined> {
    launch.stopping ??= (async () => {
      this.#rejectPending(launch, reason);
      if (launch.exit !== undefined) return launch.exit;
      const t = this.#disposeTimeouts;
      launch.child.stdin?.end();
      if (await settledWithin(launch.exited, t.stdinEofMs)) return launch.exit;
      signal(launch.child, 'SIGTERM');
      if (await settledWithin(launch.exited, t.sigtermMs)) return launch.exit;
      signal(launch.child, 'SIGKILL');
      await settledWithin(launch.exited, t.sigkillMs);
      return launch.exit;
    })();
    return launch.stopping;
  }

  #disposedError(): AdapterError {
    return new AdapterError('disposed', 'codex-app-server 进程已释放');
  }
}

/**
 * POSIX 上发给整个进程组（启动器以 detached 启动 app-server，它自己是组长），带上它留在组里的工具子进程。
 * 不是组长时 `-pid` 报 ESRCH，退回只发给 app-server 本身。
 */
function signal(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      // 进程组已不存在（ESRCH），退回只发给本身。
    }
  }
  child.kill(sig);
}

export async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function describeExit(exit: CodexExit): string {
  const how =
    exit.error !== undefined
      ? `spawn 失败：${exit.error.message}`
      : exit.signal !== null
        ? `信号 ${exit.signal}`
        : `退出码 ${exit.exitCode}`;
  const tail = exit.stderrTail.trim();
  return tail === '' ? how : `${how}；stderr 尾部：${tail.slice(-2000)}`;
}
