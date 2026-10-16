// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-opencode/src/server/OpenCodeServerOwner.ts（懒启动、借用计数、空闲 30 秒关掉、
// 服务器退出后下次重起）、versionProbe.ts（`makeOpenCodeRuntimeProbe`：成功的检测记住，失败的不记）、OpenCodeRuntime.ts
// （`verifyOpenCodeServerVersion`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Effect 的 Scope、Semaphore 与 Cache 换成普通的 Promise 与计数；账号检测与会话共用同一个服务器（T3 每个会话另起一个绑在
// 目录上的服务器，Wevir 一个 Host 只起一个，按目录分客户端）。
//
// 一个 Host 里 opencode 的运行环境（opencode-event-mapping.md §3）：找到的 `opencode` 与它的版本，和按需起的那个本机服务器。
// 服务器第一次读账号或建会话时才起；会话挂着、或正在读账号时借着它，都还回来 30 秒后停掉；意外退出时通知适配器（会话以
// engine.exited 脱开），下次要用时重起。

import type { AppToolsEndpoint } from '@wevir/runtime-adapter';
import { appToolsPluginEntry, writeAppToolsPlugin } from './app-tools.js';
import {
  compareVersions,
  findOpenCode,
  MINIMUM_OPENCODE_VERSION,
  OPENCODE_INSTALL_COMMAND,
  openCodeEnv,
  probeOpenCodeVersion,
} from './executable.js';
import { errorMessage, loadOpenCodeSdk, type OpenCodeClient, type OpenCodeSdk } from './sdk.js';
import {
  type OpenCodeServerHandle,
  type ServerExit,
  ServerLedger,
  type StartServerOptions,
  startOpenCodeServer,
} from './server.js';

/** 没人借用之后多久停掉服务器（T3 的 OPENCODE_SERVER_IDLE_TTL）。 */
export const SERVER_IDLE_TTL_MS = 30_000;

/** 检测到的 `opencode`。 */
export interface OpenCodeInstallation {
  executablePath: string;
  version: string | undefined;
}

export type Detection =
  | { ok: true; installation: OpenCodeInstallation }
  | {
      ok: false;
      /** missing：找不到；unusable：找到了但跑不起来或版本不支持。 */
      reason: 'missing' | 'unusable';
      executablePath?: string;
      version?: string;
      message?: string;
    };

/** 借来的服务器：用完 `release`。 */
export interface ServerLease {
  readonly server: OpenCodeServerHandle;
  client(directory: string): OpenCodeClient;
  release(): void;
}

export interface OpenCodeRuntimeOptions {
  /** `<数据目录>/engines/opencode`：台账与账号检测的工作目录。 */
  engineDir: string;
  env?: NodeJS.ProcessEnv;
  sdk?: () => Promise<OpenCodeSdk>;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
  /** 测试用：替换可执行文件的查找、版本探测与起服务器。 */
  findExecutable?: (customPath: string | null) => string | undefined;
  probeVersion?: typeof probeOpenCodeVersion;
  startServer?: (options: StartServerOptions) => Promise<OpenCodeServerHandle>;
  idleTtlMs?: number;
}

export class OpenCodeRuntime {
  readonly #options: OpenCodeRuntimeOptions;
  readonly #ledger: ServerLedger;
  readonly #exitListeners = new Set<(exit: ServerExit) => void>();
  readonly #abort = new AbortController();
  #customPath: string | null = null;
  #installation: OpenCodeInstallation | undefined;
  #server: OpenCodeServerHandle | undefined;
  /** 应用级工具的引擎令牌（Host 监听之后给）；正在跑的服务器挂没挂上插件。 */
  #appTools: (() => AppToolsEndpoint | undefined) | undefined;
  #serverHasAppTools = false;
  #starting: Promise<OpenCodeServerHandle> | undefined;
  #leases = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(options: OpenCodeRuntimeOptions) {
    this.#options = options;
    this.#ledger = new ServerLedger({
      engineDir: options.engineDir,
      ...(options.warn !== undefined && { warn: options.warn }),
    });
  }

  get engineDir(): string {
    return this.#options.engineDir;
  }

  get customPath(): string | null {
    return this.#customPath;
  }

  /** 最近一次检测到的安装（会话直接用它）。 */
  get installation(): OpenCodeInstallation | undefined {
    return this.#installation;
  }

  /** 正在跑的服务器的版本。 */
  get serverVersion(): string | undefined {
    return this.#server?.version;
  }

  /** 正在跑的服务器的进程 ID（诊断与测试用）。 */
  get serverPid(): number | undefined {
    return this.#server?.pid;
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /** 换可执行文件：正在跑的服务器停掉，下次用到时用新的。 */
  async setCustomPath(path: string | null): Promise<void> {
    this.#customPath = path;
    this.#installation = undefined;
    await this.#stopServer();
  }

  /**
   * 应用级工具（app-tools.ts）：之后起的服务器挂上插件。已经在跑、没挂上的那个（Host 监听之前为读账号起的）没人借用时就停掉，
   * 下次用到时重起。
   */
  setAppTools(grant: () => AppToolsEndpoint | undefined): void {
    this.#appTools = grant;
    if (this.#server !== undefined && !this.#serverHasAppTools) this.#scheduleIdleStop(0);
  }

  /** 正在跑的服务器缺应用级工具，换一个起。 */
  get #outdated(): boolean {
    return (
      this.#server !== undefined && !this.#serverHasAppTools && this.#appTools?.() !== undefined
    );
  }

  /** 找 `opencode` 并跑 `--version`（T3 的版本探测；2.x 与太旧的版本不能用）。 */
  async detect(): Promise<Detection> {
    const parentEnv = this.#options.env ?? process.env;
    const find =
      this.#options.findExecutable ??
      ((customPath) => findOpenCode({ customPath, env: parentEnv }));
    const executablePath = find(this.#customPath);
    if (executablePath === undefined) {
      this.#installation = undefined;
      return {
        ok: false,
        reason: 'missing',
        ...(this.#customPath !== null && { message: `${this.#customPath} does not exist` }),
      };
    }
    const probe = await (this.#options.probeVersion ?? probeOpenCodeVersion)(
      executablePath,
      openCodeEnv(parentEnv, executablePath),
      undefined,
      this.#abort.signal,
    );
    if (!probe.ok) {
      this.#installation = undefined;
      return {
        ok: false,
        reason: probe.reason === 'missing' ? 'missing' : 'unusable',
        executablePath,
        message: probe.message,
      };
    }
    const version = probe.version;
    const unsupported = unsupportedVersion(version);
    if (unsupported !== undefined) {
      this.#installation = undefined;
      return {
        ok: false,
        reason: 'unusable',
        executablePath,
        ...(version !== undefined && { version }),
        message: unsupported,
      };
    }
    const installation = { executablePath, version };
    if (
      this.#installation !== undefined &&
      this.#installation.executablePath !== executablePath &&
      this.#server !== undefined
    ) {
      // 换了一个 opencode（升级、改了 PATH）：旧的服务器空闲时停掉，下次用新的起。
      this.#scheduleIdleStop(0);
    }
    this.#installation = installation;
    return { ok: true, installation };
  }

  /** 借服务器：没有在跑的就起一个（要先 `detect` 成功过）。 */
  async acquire(): Promise<ServerLease> {
    this.#alive();
    const installation = this.#installation;
    if (installation === undefined) {
      throw new Error(`opencode was not found; install it with \`${OPENCODE_INSTALL_COMMAND}\``);
    }
    if (this.#leases === 0 && this.#outdated) await this.#stopServer();
    this.#leases += 1;
    this.#cancelIdleStop();
    let server: OpenCodeServerHandle;
    try {
      server = await this.#ensureServer(installation);
    } catch (error) {
      this.#leases -= 1;
      if (this.#leases === 0) this.#scheduleIdleStop();
      throw error;
    }
    const sdk = await this.#loadSdk();
    let released = false;
    return {
      server,
      client: (directory) =>
        sdk.connect({ baseUrl: server.url, directory, password: server.password }),
      release: () => {
        if (released) return;
        released = true;
        this.#leases = Math.max(0, this.#leases - 1);
        if (this.#leases === 0) this.#scheduleIdleStop(this.#outdated ? 0 : undefined);
      },
    };
  }

  /** 服务器意外退出（`stop` 引起的不算）。返回退订函数。 */
  onServerExit(listener: (exit: ServerExit) => void): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abort.abort();
    this.#exitListeners.clear();
    this.#cancelIdleStop();
    const starting = this.#starting;
    await this.#stopServer();
    // 正在起的那个起来之后也停掉。
    await starting?.then((server) => server.stop()).catch(() => {});
  }

  async #ensureServer(installation: OpenCodeInstallation): Promise<OpenCodeServerHandle> {
    if (this.#server !== undefined) return this.#server;
    this.#starting ??= this.#start(installation).finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #start(installation: OpenCodeInstallation): Promise<OpenCodeServerHandle> {
    await this.#ledger.reapOrphans();
    const sdk = await this.#loadSdk();
    const parentEnv = this.#options.env ?? process.env;
    const appTools = this.#appTools?.();
    const appToolsPlugin =
      appTools === undefined
        ? undefined
        : appToolsPluginEntry(writeAppToolsPlugin(this.#options.engineDir), appTools);
    const server = await (this.#options.startServer ?? startOpenCodeServer)({
      executable: installation.executablePath,
      env: openCodeEnv(parentEnv, installation.executablePath),
      ledger: this.#ledger,
      ...(appToolsPlugin !== undefined && { appToolsPlugin }),
      signal: this.#abort.signal,
      verify: async (url, password) => {
        // T3 的 verifyOpenCodeServerVersion：5 秒内要答 `/global/health`，版本要够新。
        const health = await withTimeout(
          sdk.connect({ baseUrl: url, directory: this.#options.engineDir, password }).health(),
          5_000,
          'OpenCode health check',
        );
        const unsupported = unsupportedVersion(health.version);
        if (unsupported !== undefined) throw new Error(unsupported);
        return health.version;
      },
    });
    if (this.#disposed) {
      await server.stop();
      throw new Error('the OpenCode engine has been disposed');
    }
    this.#server = server;
    this.#serverHasAppTools = appToolsPlugin !== undefined;
    void server.exited.then((exit) => {
      if (this.#server !== server) return;
      this.#server = undefined;
      this.#cancelIdleStop();
      for (const listener of [...this.#exitListeners]) {
        try {
          listener(exit);
        } catch {
          // 监听器里抛错不影响别的监听器。
        }
      }
    });
    return server;
  }

  async #stopServer(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#cancelIdleStop();
    await server?.stop();
  }

  #scheduleIdleStop(delayMs: number = this.#options.idleTtlMs ?? SERVER_IDLE_TTL_MS): void {
    this.#cancelIdleStop();
    if (this.#server === undefined || this.#disposed) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (this.#leases === 0) void this.#stopServer();
    }, delayMs);
    this.#idleTimer.unref?.();
  }

  #cancelIdleStop(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  async #loadSdk(): Promise<OpenCodeSdk> {
    try {
      return await (this.#options.sdk ?? loadOpenCodeSdk)();
    } catch (error) {
      throw new Error(`OpenCode SDK failed to load: ${errorMessage(error)}`, { cause: error });
    }
  }

  #alive(): void {
    if (this.#disposed) throw new Error('the OpenCode engine has been disposed');
  }
}

/** 版本不能用的原因（2.x、太旧、读不出版本）；能用时 undefined。 */
export function unsupportedVersion(version: string | undefined): string | undefined {
  if (version === undefined) {
    return `Unable to determine the OpenCode version. Wevir requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`;
  }
  if (compareVersions(version, '2.0.0') >= 0) {
    return `OpenCode v${version} (2.x) is not supported yet; install the 1.x CLI with \`${OPENCODE_INSTALL_COMMAND}\`.`;
  }
  if (compareVersions(version, MINIMUM_OPENCODE_VERSION) < 0) {
    return `OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`;
  }
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
