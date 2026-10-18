import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import {
  type AnyMessage,
  type ClientConnection,
  client,
  type Implementation,
  type InitializeResponse,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { AdapterError, isAdapterError } from '@wevir/runtime-adapter';
import type { AcpEngine } from './engine.js';

/** `initialize` 的时限。dsh 实测冷启动到 initialize 完成中位约 0.5 s，最大 0.61 s（T0.3）。 */
export const INITIALIZE_TIMEOUT_MS = 15_000;

const DEFAULT_CLIENT_INFO: Implementation = { name: 'wevir', version: '0.0.0' };

/** stderr 只保留尾部，用于诊断（字符数）。 */
export const STDERR_TAIL_CHARS = 16 * 1024;

/**
 * 回收阶梯每一步等待退出的时限：关 stdin（dsh 实测 EOF 后 22–29 ms 退出）→ SIGTERM → SIGKILL。
 * 三步加起来 4.5 s，满足“整个阶梯在 5 s 内返回”（SKELETON_PLAN §6 T3.1）。
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
 * 进程意外退出后的自动重启：最多连续 `maxRestarts` 次，第 n 次等 `baseDelayMs · 2^(n-1)`
 * （不超过 `maxDelayMs`）。进程就绪后连续运行满 `stableAfterMs` 再退出，计数从零算起。
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

export type AcpProcessState =
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
export interface AcpExit {
  /** 第几次启动的进程（从 1 起）。 */
  generation: number;
  pid: number | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  /** spawn 本身失败（如可执行文件不存在）时的错误。 */
  error?: Error;
}

export interface AcpReady {
  generation: number;
  pid: number;
  initialize: InitializeResponse;
  /** 是自动重启拉起的。 */
  restarted: boolean;
}

export interface AcpRestarting {
  /** 第几次连续重启（从 1 起）。 */
  attempt: number;
  maxRestarts: number;
  delayMs: number;
  /** 触发这次重启的原因：进程退出（`AcpExit`）或上一次重启失败的错误。 */
  cause: AcpExit | unknown;
}

export interface AcpFailed {
  restarts: number;
  cause: AcpExit | unknown;
}

export interface AcpProcessEventMap {
  /** 进程完成 `initialize`，可以使用 `connection`。 */
  ready: [AcpReady];
  /**
   * 就绪的进程意外退出（不论是否在回合中，ADR-0001 §2）。挂在它上面的会话全部失效，适配器据此对每个
   * 会话上报 `engine.exited`。`dispose` 引起的退出不报。
   */
  exit: [AcpExit];
  restarting: [AcpRestarting];
  /** 自动重启次数用完，进程停在 `failed`。 */
  failed: [AcpFailed];
}

export interface AcpSpawnSpec {
  command: string;
  args: string[];
  options: SpawnOptions & { cwd: string; env: NodeJS.ProcessEnv; stdio: 'pipe'[] };
}

/**
 * 一个引擎进程的启动方式（引擎描述里随进程实例变化的部分：可执行入口与参数、cwd、环境）。每次启动、自动重启、
 * 计划重启之前调用 `prepare`。
 */
export interface AcpLauncher {
  /** 建目录、解析可执行入口等可能耗时的步骤。抛错即这次启动失败（`engine_unavailable`）。 */
  prepare(): Promise<AcpPreparedLaunch>;
}

export interface AcpPreparedLaunch {
  /**
   * 这次的 spawn 参数。`prepare` 完成后由 `AcpProcess` 立即同步调用；这时读到的启动配置就是这个进程用的
   * （`launchConfigStale` 据此判断）。可以抛错（例如环境变量不合法），同样算启动失败。
   */
  spawnSpec(): AcpSpawnSpec;
}

export interface AcpProcessOptions {
  /** 引擎描述：名字进错误与告警，`initialize` 的 `_meta` 与扩展方法的名单也取自这里。 */
  engine: Pick<AcpEngine, 'name' | 'initializeMeta' | 'extensions'>;
  launcher: AcpLauncher;
  /**
   * ACP `session/update` 通知的原始参数，按引擎写出的顺序同步调用，不得抛错。在 ACP SDK 之前截下、不经它的
   * 校验（T3.2）：SDK 的 zod 校验会丢掉不认识的 `sessionUpdate` 类型、删掉不认识的字段，而这些要以
   * `engine.raw` 原样保留。因为在 SDK 读到消息之前调用，同一条流里排在后面的响应（例如 `session/prompt`
   * 的结果）兑现时，它前面的通知都已交付。
   */
  onSessionUpdate?: (params: unknown) => void;
  /**
   * ACP `session/request_permission`。不给时一律回复 `cancelled`：不替用户批准任何操作。
   * `signal` 在引擎取消请求或连接关闭时触发。
   */
  onRequestPermission?: (
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
  /**
   * 引擎的扩展通知（引擎描述 `extensions.notifications` 里的方法），与 `onSessionUpdate` 一样在 SDK 之前按引擎写出的
   * 顺序同步调用，不得抛错。
   */
  onExtNotification?: (method: string, params: unknown) => void;
  /**
   * 引擎的扩展请求（引擎描述 `extensions.requests` 里的方法）：返回值作为响应写给引擎，抛错时回 JSON-RPC 错误。不给时
   * 这些方法回 `Method not found`。`signal` 在引擎取消请求或连接关闭时触发。
   */
  onExtRequest?: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
  /** `initialize` 的 `clientInfo`，默认 `{name: 'wevir', version: '0.0.0'}`。 */
  clientInfo?: { name: string; version: string };
  /**
   * 接受的 `initialize` 协议版本，默认只有 SDK 的 `PROTOCOL_VERSION`。有的引擎报的版本号与线上格式不一致（Antigravity
   * 1.1.1 报 2，说的仍是 v1 的格式），由引擎的适配器放宽。
   */
  protocolVersions?: readonly number[];
  /**
   * `initialize` 成功之后、进程报就绪之前调用（Antigravity：ACP `authenticate`）。抛错即这次启动失败；抛出的
   * `missing_credentials` 原样交给调用方（`start` / `restart`），其余包成 `engine_unavailable`。
   */
  afterInitialize?: (connection: ClientConnection, response: InitializeResponse) => Promise<void>;
  /** stderr 的每一段（utf8）。只观察，不影响尾部的保留；不得抛错。 */
  onStderr?: (chunk: string) => void;
  /**
   * 在 ACP 解码之前改写 stdout 的字节流（Antigravity：去掉它写在 stdout 上的登录提示行，那不是 JSON-RPC）。
   * 每个进程调用一次。
   */
  transformStdout?: (stdout: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
  initializeTimeoutMs?: number;
  restart?: Partial<RestartPolicy>;
  disposeTimeouts?: Partial<DisposeTimeouts>;
}

interface Launch {
  generation: number;
  child: ChildProcess;
  connection: ClientConnection;
  stderrTail: string;
  /** 进程退出（或 spawn 失败）时兑现。 */
  exited: Promise<AcpExit>;
  exit?: AcpExit;
  initialize?: InitializeResponse;
  readyAt?: number;
  /** 回收阶梯，每个进程只跑一次。 */
  stopping?: Promise<AcpExit | undefined>;
  /** spawn 时用的启动配置版本（`launchConfigChanged` 每调用一次加一）。 */
  configRevision: number;
}

/**
 * 一个 ACP 引擎进程（ADR-0001 §2：一个 Host 一个引擎进程，承载全部会话）。负责启动（经 `AcpLauncher`）、
 * `initialize`、意外退出的上报与有限次数的自动重启，以及回收。ACP 的会话方法由使用方经 `connection` 调用；
 * 每次（重新）启动都是一条新连接，旧连接上的会话随进程一起失效。
 *
 * ACP 没有 shutdown 方法：`dispose` 先关 stdin，引擎读到 EOF 自行退出；超时再 SIGTERM、SIGKILL。
 * Host 被强杀或没来得及 `dispose` 时，引擎同样因 stdin EOF 退出（dsh 实测，ADR-0001 补记 1）。
 */
export class AcpProcess extends EventEmitter<AcpProcessEventMap> {
  readonly #options: AcpProcessOptions;
  readonly #name: string;
  readonly #restartPolicy: RestartPolicy;
  readonly #disposeTimeouts: DisposeTimeouts;
  #state: AcpProcessState = 'stopped';
  #generation = 0;
  #current: Launch | undefined;
  #lastExit: AcpExit | undefined;
  #starting: Promise<InitializeResponse> | undefined;
  #restarts = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #disposing: Promise<void> | undefined;
  #configRevision = 0;
  #restartRequest: Promise<InitializeResponse> | undefined;

  constructor(options: AcpProcessOptions) {
    super();
    this.#options = options;
    this.#name = options.engine.name;
    this.#restartPolicy = { ...RESTART_POLICY, ...options.restart };
    this.#disposeTimeouts = { ...DISPOSE_TIMEOUTS, ...options.disposeTimeouts };
  }

  get state(): AcpProcessState {
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
  get lastExit(): AcpExit | undefined {
    return this.#lastExit;
  }

  /** 当前进程的 `initialize` 结果；没有就绪的进程时为 undefined。 */
  get initializeResponse(): InitializeResponse | undefined {
    return this.#state === 'ready' ? this.#current?.initialize : undefined;
  }

  /**
   * 当前进程是否用的是旧的启动配置：`launchConfigChanged` 之后还没有重新 spawn。引擎不热加载配置时（dsh，
   * ADR-0001 补记 5）要 `restart()` 才生效。没有进程时为 false。
   */
  get launchConfigStale(): boolean {
    const launch = this.#current;
    return (
      launch !== undefined &&
      launch.exit === undefined &&
      launch.stopping === undefined &&
      launch.configRevision !== this.#configRevision
    );
  }

  /**
   * 启动配置（启动器在 `spawnSpec` 里读的 Provider overlay、Key 等）换了：不影响正在运行的进程，之后的任何
   * 启动（`start`、自动重启、`restart`）都用新配置。由引擎的进程类在换配置时调用。
   */
  protected launchConfigChanged(): void {
    this.#configRevision += 1;
  }

  /**
   * 有计划地重启：回收当前进程（与 `dispose` 同一个阶梯，不发 `exit` 事件，不计入自动重启次数），再按当前的
   * 启动配置启动一个新进程。旧连接上的会话随旧进程失效，调用方先自行处理（`AcpAdapter` 发 `engine.exited`）。
   * 进行中的 ACP 请求以 `engine_unavailable` 失败。没有进程时等同 `start()`；正在启动时等它完成再重启。
   * 并发调用合并为一次。失败抛 `engine_unavailable`，`dispose` 之后抛 `disposed`。
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
            new AdapterError('engine_unavailable', `${this.#name} 进程正在重启`),
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

  /** 当前进程的 ACP 连接。不在 `ready` 时抛 `engine_unavailable`（`disposed` 之后抛 `disposed`）。 */
  get connection(): ClientConnection {
    if (this.#disposing !== undefined) throw this.#disposedError();
    const launch = this.#current;
    if (this.#state !== 'ready' || launch === undefined) {
      throw new AdapterError('engine_unavailable', `${this.#name} 进程不可用（${this.#state}）`);
    }
    return launch.connection;
  }

  /**
   * 启动引擎并完成 `initialize`；已就绪时直接返回上次的结果，启动中则等同一次启动。等待自动重启时
   * 立即启动；`failed` 之后重新计算重启次数。失败抛 `engine_unavailable`（不自动重试），
   * `dispose` 之后抛 `disposed`。
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
   * 停掉当前进程而不再启动（Antigravity：登出后旧进程里还缓存着凭据）：与 `restart` 同一个回收阶梯，不发 `exit`
   * 事件，状态回到 `stopped`，之后的 `start()` 拉起新进程。旧连接上的会话随旧进程失效，调用方先自行处理。正在启动
   * 时等它完成再停。没有进程时什么都不做；`dispose` 之后抛 `disposed`。
   */
  stop(): Promise<void> {
    if (this.#disposing !== undefined) return Promise.reject(this.#disposedError());
    return (async () => {
      await this.#restartRequest?.catch(() => {});
      await this.#starting?.catch(() => {});
      if (this.#disposing !== undefined) throw this.#disposedError();
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
      const launch = this.#current;
      if (launch !== undefined) {
        await this.#stop(
          launch,
          new AdapterError('engine_unavailable', `${this.#name} 进程已停止`),
        );
      }
      if (this.#disposing === undefined && this.#starting === undefined) this.#state = 'stopped';
    })();
  }

  /**
   * 回收进程：关 stdin → SIGTERM → SIGKILL，每步等到进程退出或超时，整个阶梯 4.5 s 内返回。
   * 停止自动重启，进行中的 ACP 请求以 `disposed` 失败，不发 `exit` 事件。幂等。
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

  async #launch(restarted: boolean): Promise<InitializeResponse> {
    const generation = ++this.#generation;
    this.#state = 'starting';
    let launch: Launch;
    try {
      const prepared = await this.#options.launcher.prepare();
      if (this.#disposing !== undefined) throw this.#disposedError();
      const configRevision = this.#configRevision;
      launch = this.#spawn(prepared.spawnSpec(), generation, configRevision);
    } catch (error) {
      if (this.#disposing !== undefined) throw this.#disposedError();
      this.#state = 'stopped';
      throw new AdapterError('engine_unavailable', `${this.#name} 启动失败：${describe(error)}`, {
        cause: error,
      });
    }
    this.#current = launch;

    let timer: NodeJS.Timeout | undefined;
    try {
      const timeoutMs = this.#options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
      const clientInfo: Implementation = this.#options.clientInfo ?? DEFAULT_CLIENT_INFO;
      const initializeMeta = this.#options.engine.initializeMeta;
      const initialize = launch.connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        // 不声明 fs 与 terminal：Host 不替引擎读写文件或执行命令，工具一律在引擎自己的沙箱里执行
        // （ADR-0001 §1）。
        clientCapabilities: {},
        clientInfo,
        ...(initializeMeta !== undefined && { _meta: { ...initializeMeta } }),
      });
      const response = await Promise.race([
        initialize,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`initialize 在 ${timeoutMs} ms 内没有完成`)),
            timeoutMs,
          );
        }),
      ]);
      const accepted = this.#options.protocolVersions ?? [PROTOCOL_VERSION];
      if (!accepted.includes(response.protocolVersion)) {
        throw new Error(
          `${this.#name} 的 ACP 协议版本是 ${response.protocolVersion}，客户端是 ${PROTOCOL_VERSION}`,
        );
      }
      if (launch.exit !== undefined) throw new Error(`${this.#name} 在 initialize 之后立即退出`);
      if (this.#options.afterInitialize !== undefined) {
        clearTimeout(timer);
        await this.#options.afterInitialize(launch.connection, response);
        if (launch.exit !== undefined) throw new Error(`${this.#name} 在启动过程中退出`);
      }
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
      if (isAdapterError(error, 'missing_credentials')) throw error;
      const detail = exit === undefined ? '' : `；${describeExit(exit)}`;
      throw new AdapterError(
        'engine_unavailable',
        `${this.#name} 启动失败：${describe(error)}${detail}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  #spawn(spec: AcpSpawnSpec, generation: number, configRevision: number): Launch {
    const child = nodeSpawn(spec.command, spec.args, spec.options);
    const { stdin, stdout, stderr } = child;
    if (stdin === null || stdout === null || stderr === null) {
      child.kill('SIGKILL');
      throw new Error(`${this.#name} 的 stdio 没有建立`);
    }
    // 进程退出后的写入会报 EPIPE，结果以 exit 事件为准。
    for (const stream of child.stdio) stream?.on('error', () => {});

    let settle!: (exit: AcpExit) => void;
    const exited = new Promise<AcpExit>((resolve) => {
      settle = resolve;
    });
    const wire = ndJsonStream(
      Writable.toWeb(stdin) as WritableStream<Uint8Array>,
      // stdout 可能先于 exit 事件结束；等进程退出记下来再结束输入，进行中的请求才会以
      // “进程已退出”失败，而不是笼统的连接关闭。
      (this.#options.transformStdout ?? ((stream) => stream))(
        Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
      ).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({ flush: () => exited.then(() => {}) }),
      ),
    );
    const app = client({ name: 'wevir' }).onRequest(
      methods.client.session.requestPermission,
      ({ params, signal }) =>
        this.#options.onRequestPermission !== undefined
          ? this.#options.onRequestPermission(params, signal)
          : { outcome: { outcome: 'cancelled' } },
    );
    const onExtRequest = this.#options.onExtRequest;
    if (onExtRequest !== undefined) {
      for (const method of this.#options.engine.extensions?.requests ?? []) {
        app.onRequest(method, RAW_PARAMS, ({ params, signal }) =>
          onExtRequest(method, params, signal),
        );
      }
    }
    const extNotifications = new Set(this.#options.engine.extensions?.notifications ?? []);
    const connection = app.connect({
      writable: wire.writable,
      readable: wire.readable.pipeThrough(
        new TransformStream<AnyMessage, AnyMessage>({
          transform: (message, controller) => {
            const method = notificationMethod(message);
            if (method !== methods.client.session.update && !extNotifications.has(method ?? '')) {
              controller.enqueue(message);
              return;
            }
            const params = (message as { params?: unknown }).params;
            try {
              if (method === methods.client.session.update) {
                this.#options.onSessionUpdate?.(params);
              } else {
                this.#options.onExtNotification?.(method as string, params);
              }
            } catch {
              // 回调约定不抛错；万一抛了也不能让 ACP 连接断开。
            }
          },
        }),
      ),
    });
    const launch: Launch = {
      generation,
      child,
      connection,
      stderrTail: '',
      exited,
      configRevision,
    };

    stderr.setEncoding('utf8');
    stderr.on('data', (chunk: string) => {
      launch.stderrTail = (launch.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
      try {
        this.#options.onStderr?.(chunk);
      } catch {
        // 回调约定不抛错。
      }
    });
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (launch.exit !== undefined) return;
      const exit: AcpExit = {
        generation,
        pid: child.pid,
        exitCode,
        signal,
        stderrTail: launch.stderrTail,
        ...(error === undefined ? {} : { error }),
      };
      launch.exit = exit;
      // 关掉我们这端的 stdin：引擎经启动脚本起时（Windows 上 npm 的 .cmd 经 cmd.exe），退出的可能只是启动脚本，
      // 还拿着管道的引擎读到 EOF 才会退出。
      stdin.destroy();
      this.#lastExit = exit;
      settle(exit);
      connection.close(
        new AdapterError('engine_unavailable', `${this.#name} 进程已退出（${describeExit(exit)}）`),
      );
      this.#onExit(launch, exit);
    };
    child.once('exit', (code, signal) => finish(code, signal));
    // spawn 失败时可能只有 error 没有 exit；进程活着时的 error（如 kill 失败）不算退出。
    // 用 on 而不是 once：没有监听器的 error 事件会让 Host 进程崩溃。
    child.on('error', (error) => {
      if (child.pid === undefined) finish(null, null, error);
    });
    return launch;
  }

  #onExit(launch: Launch, exit: AcpExit): void {
    // 启动中的退出由 #launch 处理；回收中的退出是预期的。
    if (this.#current !== launch || launch.stopping !== undefined || launch.readyAt === undefined) {
      return;
    }
    this.emit('exit', exit);
    if (Date.now() - launch.readyAt >= this.#restartPolicy.stableAfterMs) this.#restarts = 0;
    this.#scheduleRestart(exit);
  }

  #scheduleRestart(cause: AcpExit | unknown): void {
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

  /** 回收阶梯：关连接（进行中的请求以 `reason` 失败）→ 关 stdin → SIGTERM → SIGKILL。 */
  #stop(launch: Launch, reason: unknown): Promise<AcpExit | undefined> {
    launch.stopping ??= (async () => {
      launch.connection.close(reason);
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
    return new AdapterError('disposed', `${this.#name} 进程已释放`);
  }
}

/**
 * POSIX 上发给整个进程组（启动器以 detached 启动引擎，它自己是组长），带上它留在组里的工具子进程。
 * 不是组长时（启动器没有分离）`-pid` 报 ESRCH，退回只发给引擎本身。
 */
function signal(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      // 进程组已不存在（ESRCH），退回只发给引擎本身。
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

/** 引擎写出的通知（没有 id 的 JSON-RPC 消息）的方法名；不是通知时 undefined。 */
function notificationMethod(message: AnyMessage): string | undefined {
  if (Array.isArray(message) || 'id' in message) return undefined;
  const method = (message as { method?: unknown }).method;
  return typeof method === 'string' ? method : undefined;
}

/** 扩展请求的参数原样交给处理器，由引擎的适配器自己检查。 */
const RAW_PARAMS = { parse: (params: unknown) => params };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeExit(exit: AcpExit): string {
  const how =
    exit.error !== undefined
      ? `spawn 失败：${exit.error.message}`
      : exit.signal !== null
        ? `信号 ${exit.signal}`
        : `退出码 ${exit.exitCode}`;
  const tail = exit.stderrTail.trim();
  return tail === '' ? how : `${how}；stderr 尾部：${tail.slice(-2000)}`;
}
