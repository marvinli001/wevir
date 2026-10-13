import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { AdapterError } from '@wevir/runtime-adapter';
import { buildDshEnv, STREAM_FD } from './env.js';
import { DSH_PROFILE, type DshPaths, dshPaths, prepareDshHome, resolveDshEntry } from './paths.js';
import {
  defaultStreamTapPluginDir,
  ensureStreamTapInstalled,
  StreamTapDecoder,
  type StreamTapEvent,
  type StreamTapWarning,
  streamTapOverlay,
} from './stream-tap.js';

/** `initialize` 的时限。T0.3 实测冷启动到 initialize 完成中位约 0.5 s，最大 0.61 s。 */
export const INITIALIZE_TIMEOUT_MS = 15_000;

const DEFAULT_CLIENT_INFO: Implementation = { name: 'wevir', version: '0.0.0' };

/** stderr 只保留尾部，用于诊断（字符数）。 */
export const STDERR_TAIL_CHARS = 16 * 1024;

/**
 * 回收阶梯每一步等待退出的时限：关 stdin（T0.3：EOF 后 22–29 ms 退出）→ SIGTERM → SIGKILL。
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

export type DshProcessState =
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
export interface DshExit {
  /** 第几次启动的进程（从 1 起）。 */
  generation: number;
  pid: number | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  /** spawn 本身失败（如 Node 可执行文件不存在）时的错误。 */
  error?: Error;
}

export interface DshReady {
  generation: number;
  pid: number;
  initialize: InitializeResponse;
  /** 是自动重启拉起的。 */
  restarted: boolean;
}

export interface DshRestarting {
  /** 第几次连续重启（从 1 起）。 */
  attempt: number;
  maxRestarts: number;
  delayMs: number;
  /** 触发这次重启的原因：进程退出（`DshExit`）或上一次重启失败的错误。 */
  cause: DshExit | unknown;
}

export interface DshFailed {
  restarts: number;
  cause: DshExit | unknown;
}

export interface DshProcessEventMap {
  /** 进程完成 `initialize`，可以使用 `connection`。 */
  ready: [DshReady];
  /**
   * 就绪的进程意外退出（不论是否在回合中，ADR-0001 §2）。挂在它上面的会话全部失效，适配器据此对每个
   * 会话上报 `engine.exited`。`dispose` 引起的退出不报。
   */
  exit: [DshExit];
  restarting: [DshRestarting];
  /** 自动重启次数用完，进程停在 `failed`。 */
  failed: [DshFailed];
}

export interface DshProcessOptions {
  /** Wevir 数据目录（绝对路径）；dsh 用其中的 `engines/dsh` 与 `engines/dsh-agents`（`dshPaths`）。 */
  home: string;
  /** 依次以 `--patch <文件>` 传给 dsh 的配置 overlay（T3.4 生成 Provider 配置）。 */
  patches?: readonly string[];
  /** 额外注入 dsh 环境的变量（T3.4：`WEVIR_PROVIDER_<ID>_KEY`），不能覆盖固定注入的变量。 */
  env?: Readonly<Record<string, string>>;
  /**
   * 增量流式旁路（T3.2a，ADR-0001 §3）。不给时 dsh 只有 stdin、stdout、stderr，只有 ACP 的已提交消息。
   * 给了则每次启动前确认 stream-tap 插件已装进 acp profile（`ensureStreamTapInstalled`），以
   * `--patch` 插入插件行，打开 fd 3 并设 `WEVIR_STREAM_FD=3`，把解码出的增量交给 `onEvent`。
   * 装不上时照常启动，只是没有旁路（`streamTapState` 为 `unavailable`）。
   */
  streamTap?: DshStreamTapOptions;
  /**
   * ACP `session/update` 通知的原始参数，按 dsh 写出的顺序同步调用，不得抛错。在 ACP SDK 之前截下、不经它的
   * 校验（T3.2）：SDK 的 zod 校验会丢掉不认识的 `sessionUpdate` 类型、删掉不认识的字段，而这些要以
   * `engine.raw` 原样保留。因为在 SDK 读到消息之前调用，同一条流里排在后面的响应（例如 `session/prompt`
   * 的结果）兑现时，它前面的通知都已交付。
   */
  onSessionUpdate?: (params: unknown) => void;
  /**
   * ACP `session/request_permission`。不给时一律回复 `cancelled`：不替用户批准任何操作。
   * `signal` 在 dsh 取消请求或连接关闭时触发。
   */
  onRequestPermission?: (
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
  /** `initialize` 的 `clientInfo`，默认 `{name: 'wevir', version: '0.0.0'}`。 */
  clientInfo?: { name: string; version: string };
  initializeTimeoutMs?: number;
  restart?: Partial<RestartPolicy>;
  disposeTimeouts?: Partial<DisposeTimeouts>;
  /** 运行 dsh 的 Node，默认 `process.execPath`（开发模式用系统 Node，ADR-0002 未决事项 1）。 */
  nodePath?: string;
  /** dsh 可执行入口，默认 `resolveDshEntry()`；测试用假引擎替换。 */
  entry?: string;
  /** 环境变量的继承来源，默认 `process.env`。 */
  parentEnv?: NodeJS.ProcessEnv;
}

export interface DshStreamTapOptions {
  /** 插件目录，默认 `defaultStreamTapPluginDir()`（开发模式下即本包的 `stream-tap/`）；打包后由调用方给出。 */
  pluginDir?: string;
  /** 文本与推理的增量、attempt 结束（按 dsh 写出的顺序，带 dsh 的会话 ID）。同步调用，不得抛错。 */
  onEvent: (event: StreamTapEvent) => void;
  /** 畸形行、插件装不上或没加载。旁路的任何问题都只告警，不影响 dsh 进程。 */
  onWarning: (warning: StreamTapWarning) => void;
  installTimeoutMs?: number;
  /** initialize 完成后等插件报到的时间，超时报 `not_loaded`。默认 `STREAM_TAP_READY_GRACE_MS`。 */
  readyGraceMs?: number;
}

/**
 * 当前进程的旁路状态。off：没有配置旁路；unavailable：插件装不上或启动后没有报到，本进程只有已提交消息；
 * waiting：已插入插件，还没收到它的 ready；active：插件已加载，增量从 fd 3 到达。
 */
export type StreamTapState = 'off' | 'unavailable' | 'waiting' | 'active';

/**
 * initialize 完成后等插件报到的时间。插件在 dsh 启动挂载插件时写 ready，实测比 initialize 的响应早几毫秒
 * 到达（两条管道之间没有顺序保证）。
 */
export const STREAM_TAP_READY_GRACE_MS = 2000;

export interface DshSpawnSpecInput {
  entry: string;
  paths: DshPaths;
  nodePath?: string;
  patches?: readonly string[];
  env?: Readonly<Record<string, string>>;
  streamFd?: boolean;
  parentEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface DshSpawnSpec {
  command: string;
  args: string[];
  options: SpawnOptions & { cwd: string; env: NodeJS.ProcessEnv; stdio: 'pipe'[] };
}

/**
 * 启动 dsh 的完整参数：`<node> <dsh 入口> --profile acp [--patch <overlay>]…`。
 * - cwd 是 `DSH_HOME`，绝不是用户工作区：环境里没有 Key 时 dsh 会读 `<进程 cwd>/.env`（T0.3 §6.3）。
 * - 环境按白名单构造（`buildDshEnv`）。
 * - stdin / stdout 走 ACP，stderr 只用于诊断；`streamFd` 时再开 fd 3（T3.2a）。
 * - POSIX 上 dsh 自成进程组：终端的 Ctrl-C 只到 Host，由 Host 按顺序退出；回收时 SIGTERM / SIGKILL
 *   发给整个进程组。Windows 上不分离（分离会给子进程开新控制台）。
 */
export function dshSpawnSpec(input: DshSpawnSpecInput): DshSpawnSpec {
  const platform = input.platform ?? process.platform;
  const streamFd = input.streamFd === true;
  return {
    command: input.nodePath ?? process.execPath,
    args: [
      input.entry,
      '--profile',
      DSH_PROFILE,
      ...(input.patches ?? []).flatMap((patch) => ['--patch', patch]),
    ],
    options: {
      cwd: input.paths.dshHome,
      env: buildDshEnv({
        paths: input.paths,
        parent: input.parentEnv,
        platform,
        streamFd,
        extra: input.env,
      }),
      stdio: Array.from({ length: streamFd ? STREAM_FD + 1 : 3 }, () => 'pipe' as const),
      detached: platform !== 'win32',
      windowsHide: true,
    },
  };
}

interface Launch {
  generation: number;
  child: ChildProcess;
  connection: ClientConnection;
  stderrTail: string;
  /** 进程退出（或 spawn 失败）时兑现。 */
  exited: Promise<DshExit>;
  exit?: DshExit;
  initialize?: InitializeResponse;
  readyAt?: number;
  /** 回收阶梯，每个进程只跑一次。 */
  stopping?: Promise<DshExit | undefined>;
  streamTap: StreamTapState;
  /** initialize 之后等插件报到的计时器。 */
  streamTapGrace?: NodeJS.Timeout;
}

/**
 * 一个 dsh ACP 进程（ADR-0001 §2：一个 Host 一个 dsh 进程，承载全部会话）。负责定位与启动、
 * `initialize`、意外退出的上报与有限次数的自动重启，以及回收。ACP 的会话方法由使用方经 `connection`
 * 调用；每次（重新）启动都是一条新连接，旧连接上的会话随进程一起失效。
 *
 * ACP 没有 shutdown 方法：`dispose` 先关 stdin，dsh 读到 EOF 自行退出；超时再 SIGTERM、SIGKILL。
 * Host 被强杀或没来得及 `dispose` 时，dsh 同样因 stdin EOF 退出。
 */
export class DshProcess extends EventEmitter<DshProcessEventMap> {
  readonly paths: DshPaths;
  readonly #options: DshProcessOptions;
  readonly #restartPolicy: RestartPolicy;
  readonly #disposeTimeouts: DisposeTimeouts;
  #state: DshProcessState = 'stopped';
  #generation = 0;
  #current: Launch | undefined;
  #lastExit: DshExit | undefined;
  #starting: Promise<InitializeResponse> | undefined;
  #restarts = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #disposing: Promise<void> | undefined;

  constructor(options: DshProcessOptions) {
    super();
    this.paths = dshPaths(options.home);
    this.#options = options;
    this.#restartPolicy = { ...RESTART_POLICY, ...options.restart };
    this.#disposeTimeouts = { ...DISPOSE_TIMEOUTS, ...options.disposeTimeouts };
  }

  get state(): DshProcessState {
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
  get lastExit(): DshExit | undefined {
    return this.#lastExit;
  }

  /** 当前（或最近一个）进程的增量流式旁路状态（T3.2a）；还没启动过或没有配置旁路时为 `off`。 */
  get streamTapState(): StreamTapState {
    return this.#current?.streamTap ?? 'off';
  }

  /** 当前进程的 ACP 连接。不在 `ready` 时抛 `engine_unavailable`（`disposed` 之后抛 `disposed`）。 */
  get connection(): ClientConnection {
    if (this.#disposing !== undefined) throw new AdapterError('disposed', 'dsh 进程已释放');
    const launch = this.#current;
    if (this.#state !== 'ready' || launch === undefined) {
      throw new AdapterError('engine_unavailable', `dsh 进程不可用（${this.#state}）`);
    }
    return launch.connection;
  }

  /**
   * 启动 dsh 并完成 `initialize`；已就绪时直接返回上次的结果，启动中则等同一次启动。等待自动重启时
   * 立即启动；`failed` 之后重新计算重启次数。失败抛 `engine_unavailable`（不自动重试），
   * `dispose` 之后抛 `disposed`。
   */
  start(): Promise<InitializeResponse> {
    if (this.#disposing !== undefined) {
      return Promise.reject(new AdapterError('disposed', 'dsh 进程已释放'));
    }
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
   * 回收进程：关 stdin → SIGTERM → SIGKILL，每步等到进程退出或超时，整个阶梯 4.5 s 内返回。
   * 停止自动重启，进行中的 ACP 请求以 `disposed` 失败，不发 `exit` 事件。幂等。
   */
  dispose(): Promise<void> {
    this.#disposing ??= (async () => {
      this.#state = 'disposing';
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
      const launch = this.#current;
      if (launch !== undefined) {
        await this.#stop(launch, new AdapterError('disposed', 'dsh 进程已释放'));
      }
      this.#state = 'disposed';
    })();
    return this.#disposing;
  }

  async #launch(restarted: boolean): Promise<InitializeResponse> {
    const generation = ++this.#generation;
    this.#state = 'starting';
    let launch: Launch;
    try {
      prepareDshHome(this.paths);
      const entry = this.#options.entry ?? resolveDshEntry().entry;
      const tapOverlay = await this.#prepareStreamTap(entry);
      if (this.#disposing !== undefined) throw new AdapterError('disposed', 'dsh 进程已释放');
      const patches = this.#options.patches ?? [];
      const spec = dshSpawnSpec({
        entry,
        paths: this.paths,
        nodePath: this.#options.nodePath,
        patches: tapOverlay === undefined ? patches : [...patches, tapOverlay],
        env: this.#options.env,
        streamFd: tapOverlay !== undefined,
        parentEnv: this.#options.parentEnv,
      });
      const streamTap: StreamTapState =
        tapOverlay !== undefined
          ? 'waiting'
          : this.#options.streamTap === undefined
            ? 'off'
            : 'unavailable';
      launch = this.#spawn(spec, generation, streamTap);
    } catch (error) {
      if (this.#disposing !== undefined) throw new AdapterError('disposed', 'dsh 进程已释放');
      this.#state = 'stopped';
      throw new AdapterError('engine_unavailable', `dsh 启动失败：${describe(error)}`, {
        cause: error,
      });
    }
    this.#current = launch;

    let timer: NodeJS.Timeout | undefined;
    try {
      const timeoutMs = this.#options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
      const clientInfo: Implementation = this.#options.clientInfo ?? DEFAULT_CLIENT_INFO;
      const initialize = launch.connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        // 不声明 fs 与 terminal：Host 不替引擎读写文件或执行命令，工具一律在 dsh 的沙箱里执行
        // （ADR-0001 §1）。
        clientCapabilities: {},
        clientInfo,
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
      if (response.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `dsh 的 ACP 协议版本是 ${response.protocolVersion}，客户端是 ${PROTOCOL_VERSION}`,
        );
      }
      if (launch.exit !== undefined) throw new Error('dsh 在 initialize 之后立即退出');
      launch.initialize = response;
      launch.readyAt = Date.now();
      if (launch.streamTap === 'waiting') this.#awaitStreamTap(launch);
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
      if (this.#disposing !== undefined) throw new AdapterError('disposed', 'dsh 进程已释放');
      this.#state = 'stopped';
      const detail = exit === undefined ? '' : `；${describeExit(exit)}`;
      throw new AdapterError('engine_unavailable', `dsh 启动失败：${describe(error)}${detail}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 旁路的准备：确认插件已装好，返回要追加的 overlay；装不上时告警并返回 undefined，本次启动不开 fd 3。
   * 旁路的任何问题都不让启动失败。
   */
  async #prepareStreamTap(entry: string): Promise<string | undefined> {
    const tap = this.#options.streamTap;
    if (tap === undefined) return undefined;
    const pluginDir = resolve(tap.pluginDir ?? defaultStreamTapPluginDir());
    try {
      const overlay = streamTapOverlay(pluginDir);
      // overlay 读不到时 dsh 整个启动失败，先在这里挡住。
      if (!existsSync(overlay)) throw new Error(`插件目录里没有 ${overlay}`);
      await ensureStreamTapInstalled({
        paths: this.paths,
        pluginDir,
        entry,
        nodePath: this.#options.nodePath,
        parentEnv: this.#options.parentEnv,
        timeoutMs: tap.installTimeoutMs,
      });
      return overlay;
    } catch (error) {
      tap.onWarning({
        kind: 'install_failed',
        message: `stream-tap 插件装不上，本次启动只有已提交消息：${describe(error)}`,
      });
      return undefined;
    }
  }

  /** initialize 之后插件迟迟不报到（没装上、加载失败）：告警，本进程按没有旁路处理。 */
  #awaitStreamTap(launch: Launch): void {
    const tap = this.#options.streamTap;
    if (tap === undefined) return;
    const graceMs = tap.readyGraceMs ?? STREAM_TAP_READY_GRACE_MS;
    launch.streamTapGrace = setTimeout(() => {
      if (launch.streamTap !== 'waiting' || launch.exit !== undefined) return;
      launch.streamTap = 'unavailable';
      const tail = launch.stderrTail.trim().slice(-1000);
      tap.onWarning({
        kind: 'not_loaded',
        message:
          `dsh 就绪后 ${graceMs} ms 内 stream-tap 插件没有报到，本进程只有已提交消息` +
          (tail === '' ? '' : `；stderr 尾部：${tail}`),
      });
    }, graceMs);
    launch.streamTapGrace.unref();
  }

  #spawn(spec: DshSpawnSpec, generation: number, streamTap: StreamTapState): Launch {
    const child = nodeSpawn(spec.command, spec.args, spec.options);
    const { stdin, stdout, stderr } = child;
    if (stdin === null || stdout === null || stderr === null) {
      child.kill('SIGKILL');
      throw new Error('dsh 的 stdio 没有建立');
    }
    // 进程退出后的写入会报 EPIPE，结果以 exit 事件为准。
    for (const stream of child.stdio) stream?.on('error', () => {});

    let settle!: (exit: DshExit) => void;
    const exited = new Promise<DshExit>((resolve) => {
      settle = resolve;
    });
    const wire = ndJsonStream(
      Writable.toWeb(stdin) as WritableStream<Uint8Array>,
      // stdout 可能先于 exit 事件结束；等进程退出记下来再结束输入，进行中的请求才会以
      // “进程已退出”失败，而不是笼统的连接关闭。
      (Readable.toWeb(stdout) as ReadableStream<Uint8Array>).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({ flush: () => exited.then(() => {}) }),
      ),
    );
    const connection = client({ name: 'wevir' })
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) =>
        this.#options.onRequestPermission !== undefined
          ? this.#options.onRequestPermission(params, signal)
          : { outcome: { outcome: 'cancelled' } },
      )
      .connect({
        writable: wire.writable,
        readable: wire.readable.pipeThrough(
          new TransformStream<AnyMessage, AnyMessage>({
            transform: (message, controller) => {
              if (!isSessionUpdate(message)) {
                controller.enqueue(message);
                return;
              }
              try {
                this.#options.onSessionUpdate?.(message.params);
              } catch {
                // 回调约定不抛错；万一抛了也不能让 ACP 连接断开。
              }
            },
          }),
        ),
      });
    const launch: Launch = { generation, child, connection, stderrTail: '', exited, streamTap };

    stderr.setEncoding('utf8');
    stderr.on('data', (chunk: string) => {
      launch.stderrTail = (launch.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    const tap = child.stdio[STREAM_FD];
    const tapOptions = this.#options.streamTap;
    if (streamTap === 'waiting' && tapOptions !== undefined && tap instanceof Readable) {
      // 一个进程一个解码器：上一个进程留下的半行不会接到新进程的数据上。
      const decoder = new StreamTapDecoder({
        onEvent: tapOptions.onEvent,
        onReady: () => {
          clearTimeout(launch.streamTapGrace);
          launch.streamTap = 'active';
        },
        onWarning: tapOptions.onWarning,
      });
      tap.on('data', (chunk: Buffer) => decoder.push(chunk));
      tap.on('end', () => decoder.end());
    }

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (launch.exit !== undefined) return;
      const exit: DshExit = {
        generation,
        pid: child.pid,
        exitCode,
        signal,
        stderrTail: launch.stderrTail,
        ...(error === undefined ? {} : { error }),
      };
      launch.exit = exit;
      clearTimeout(launch.streamTapGrace);
      this.#lastExit = exit;
      settle(exit);
      connection.close(
        new AdapterError('engine_unavailable', `dsh 进程已退出（${describeExit(exit)}）`),
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

  #onExit(launch: Launch, exit: DshExit): void {
    // 启动中的退出由 #launch 处理；回收中的退出是预期的。
    if (this.#current !== launch || launch.stopping !== undefined || launch.readyAt === undefined) {
      return;
    }
    this.emit('exit', exit);
    if (Date.now() - launch.readyAt >= this.#restartPolicy.stableAfterMs) this.#restarts = 0;
    this.#scheduleRestart(exit);
  }

  #scheduleRestart(cause: DshExit | unknown): void {
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
  #stop(launch: Launch, reason: unknown): Promise<DshExit | undefined> {
    launch.stopping ??= (async () => {
      clearTimeout(launch.streamTapGrace);
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
}

/** POSIX 上发给整个进程组（dsh 以 detached 启动，自己是组长），带上它留在组里的工具子进程。 */
function signal(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      // 进程组已不存在（ESRCH），退回只发给 dsh 本身。
    }
  }
  child.kill(sig);
}

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
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

/** dsh 写出的 `session/update` 通知（没有 id 的 JSON-RPC 消息）。 */
function isSessionUpdate(message: AnyMessage): message is AnyMessage & { params?: unknown } {
  return (
    !Array.isArray(message) &&
    (message as { method?: unknown }).method === methods.client.session.update &&
    !('id' in message)
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeExit(exit: DshExit): string {
  const how =
    exit.error !== undefined
      ? `spawn 失败：${exit.error.message}`
      : exit.signal !== null
        ? `信号 ${exit.signal}`
        : `退出码 ${exit.exitCode}`;
  const tail = exit.stderrTail.trim();
  return tail === '' ? how : `${how}；stderr 尾部：${tail.slice(-2000)}`;
}
