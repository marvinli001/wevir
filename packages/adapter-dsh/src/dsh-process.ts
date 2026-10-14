import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type AcpExit,
  type AcpIncrementalOptions,
  type AcpLauncher,
  type AcpPreparedLaunch,
  AcpProcess,
  type AcpProcessEventMap,
  type AcpProcessOptions,
  type AcpSpawnSpec,
  type IncrementalState,
} from '@wevir/adapter-acp';
import { DSH_ENGINE } from './engine.js';
import { buildDshEnv, STREAM_FD } from './env.js';
import { DSH_PROFILE, type DshPaths, dshPaths, prepareDshHome, resolveDshEntry } from './paths.js';
import {
  defaultStreamTapPluginDir,
  ensureStreamTapInstalled,
  streamTapOverlay,
} from './stream-tap.js';

/** dsh 进程的事件与退出记录（通用 ACP 进程的同一套）。 */
export type DshProcessEventMap = AcpProcessEventMap;
export type DshExit = AcpExit;

/**
 * 当前进程的旁路状态。off：没有配置旁路；unavailable：插件装不上或启动后没有报到，本进程只有已提交消息；
 * waiting：已插入插件，还没收到它的 ready；active：插件已加载，增量从 fd 3 到达。
 */
export type StreamTapState = IncrementalState;

export interface DshProcessOptions
  extends Omit<AcpProcessOptions, 'engine' | 'launcher' | 'incremental'> {
  /** Wevir 数据目录（绝对路径）；dsh 用其中的 `engines/dsh` 与 `engines/dsh-agents`（`dshPaths`）。 */
  home: string;
  /** 依次以 `--patch <文件>` 传给 dsh 的配置 overlay（T3.4 生成 Provider 配置）。之后可用 `setLaunchConfig` 换。 */
  patches?: readonly string[];
  /**
   * 额外注入 dsh 环境的变量（T3.4：`WEVIR_PROVIDER_<ID>_KEY`），不能覆盖固定注入的变量。之后可用
   * `setLaunchConfig` 换。
   */
  env?: Readonly<Record<string, string>>;
  /**
   * 增量流式旁路（T3.2a，ADR-0001 §3）。不给时 dsh 只有 stdin、stdout、stderr，只有 ACP 的已提交消息。
   * 给了则每次启动前确认 stream-tap 插件已装进 acp profile（`ensureStreamTapInstalled`），以
   * `--patch` 插入插件行，打开 fd 3 并设 `WEVIR_STREAM_FD=3`，把解码出的增量交给 `onEvent`。
   * 装不上时照常启动，只是没有旁路（`streamTapState` 为 `unavailable`）。
   */
  streamTap?: DshStreamTapOptions;
  /** 运行 dsh 的 Node，默认 `process.execPath`（开发模式用系统 Node，ADR-0002 未决事项 1）。 */
  nodePath?: string;
  /** dsh 可执行入口，默认 `resolveDshEntry()`；测试用假引擎替换。 */
  entry?: string;
  /** 环境变量的继承来源，默认 `process.env`。 */
  parentEnv?: NodeJS.ProcessEnv;
}

/**
 * stream-tap 旁路的选项：增量与告警的出口（`onEvent`、`onWarning`、`readyGraceMs`，通用 ACP 进程的旁路选项），
 * 加上插件的安装。告警：畸形行、插件装不上（`install_failed`）或没加载（`not_loaded`）。旁路的任何问题都只告警，
 * 不影响 dsh 进程。`readyGraceMs` 默认 `STREAM_TAP_READY_GRACE_MS`。
 */
export interface DshStreamTapOptions extends AcpIncrementalOptions {
  /** 插件目录，默认 `defaultStreamTapPluginDir()`（开发模式下即本包的 `stream-tap/`）；打包后由调用方给出。 */
  pluginDir?: string;
  installTimeoutMs?: number;
}

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

/**
 * 启动 dsh 的完整参数：`<node> <dsh 入口> --profile acp [--patch <overlay>]…`。
 * - cwd 是 `DSH_HOME`，绝不是用户工作区：环境里没有 Key 时 dsh 会读 `<进程 cwd>/.env`（T0.3 §6.3）。
 * - 环境按白名单构造（`buildDshEnv`）。
 * - stdin / stdout 走 ACP，stderr 只用于诊断；`streamFd` 时再开 fd 3（T3.2a）。
 * - POSIX 上 dsh 自成进程组：终端的 Ctrl-C 只到 Host，由 Host 按顺序退出；回收时 SIGTERM / SIGKILL
 *   发给整个进程组。Windows 上不分离（分离会给子进程开新控制台）。
 */
export function dshSpawnSpec(input: DshSpawnSpecInput): AcpSpawnSpec {
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

/**
 * dsh 的启动器：每次启动前建好 `DSH_HOME`、解析可执行入口、确认 stream-tap 插件已装好，再按当前的启动配置
 * （`--patch` 列表与额外环境）给出 `dshSpawnSpec`。
 */
class DshLauncher implements AcpLauncher {
  readonly paths: DshPaths;
  readonly #options: DshProcessOptions;
  patches: readonly string[];
  env: Readonly<Record<string, string>> | undefined;

  constructor(options: DshProcessOptions) {
    this.paths = dshPaths(options.home);
    this.#options = options;
    this.patches = options.patches ?? [];
    this.env = options.env;
  }

  async prepare(): Promise<AcpPreparedLaunch> {
    prepareDshHome(this.paths);
    const entry = this.#options.entry ?? resolveDshEntry().entry;
    const tapOverlay = await this.#prepareStreamTap(entry);
    return {
      incremental:
        tapOverlay !== undefined
          ? 'waiting'
          : this.#options.streamTap === undefined
            ? 'off'
            : 'unavailable',
      spawnSpec: () =>
        dshSpawnSpec({
          entry,
          paths: this.paths,
          nodePath: this.#options.nodePath,
          patches: tapOverlay === undefined ? this.patches : [...this.patches, tapOverlay],
          env: this.env,
          streamFd: tapOverlay !== undefined,
          parentEnv: this.#options.parentEnv,
        }),
    };
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
}

/**
 * 一个 dsh ACP 进程（ADR-0001 §2：一个 Host 一个 dsh 进程，承载全部会话）：通用的 `AcpProcess`（启动、
 * `initialize`、意外退出的上报与有限次数的自动重启、回收）按 `DSH_ENGINE` 与 dsh 的启动器运行。这里只多出 dsh 的
 * 目录（`paths`）、旁路状态的 dsh 名字（`streamTapState`）与启动配置（`setLaunchConfig`）。
 */
export class DshProcess extends AcpProcess {
  readonly paths: DshPaths;
  readonly #launcher: DshLauncher;

  constructor(options: DshProcessOptions) {
    const launcher = new DshLauncher(options);
    const { streamTap } = options;
    super({
      engine: DSH_ENGINE,
      launcher,
      ...(streamTap !== undefined && { incremental: streamTap }),
      onSessionUpdate: options.onSessionUpdate,
      onRequestPermission: options.onRequestPermission,
      clientInfo: options.clientInfo,
      initializeTimeoutMs: options.initializeTimeoutMs,
      restart: options.restart,
      disposeTimeouts: options.disposeTimeouts,
    });
    this.paths = launcher.paths;
    this.#launcher = launcher;
  }

  /** 当前（或最近一个）进程的增量流式旁路状态（T3.2a）；还没启动过或没有配置旁路时为 `off`。 */
  get streamTapState(): StreamTapState {
    return this.incrementalState;
  }

  /**
   * 换下一次 spawn 用的 `--patch` 列表与额外环境变量（T3.4：Provider overlay 与 Key）。不影响正在运行的进程；
   * 之后的任何启动（`start`、自动重启、`restart`）都用新配置。只给其中一项时另一项不变。dsh 不热加载 overlay，
   * 也读不到新的环境变量（T3.4 实测，ADR-0001 补记 5），运行中的进程要 `restart()` 才用上（`launchConfigStale`）。
   */
  setLaunchConfig(config: {
    patches?: readonly string[];
    env?: Readonly<Record<string, string>>;
  }): void {
    if (config.patches !== undefined) this.#launcher.patches = [...config.patches];
    if (config.env !== undefined) this.#launcher.env = { ...config.env };
    this.launchConfigChanged();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
