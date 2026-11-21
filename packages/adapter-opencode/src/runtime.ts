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

import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppToolsEndpoint } from '@wevir/runtime-adapter';
import { appToolsPluginEntry, type OpenCodePluginEntry, writeAppToolsPlugin } from './app-tools.js';
import {
  compareVersions,
  findOpenCode,
  MINIMUM_OPENCODE_VERSION,
  OPENCODE_INSTALL_COMMAND,
  openCodeDatabaseEnv,
  openCodeEnv,
  probeOpenCodeVersion,
} from './executable.js';
import {
  type ManagedInstaller,
  OpenCodeInstaller,
  type OpenCodeInstallerOptions,
  openCodeInstallDirectory,
  openCodeInstallSupported,
} from './install.js';
import { errorMessage, loadOpenCodeSdk, type OpenCodeClient, type OpenCodeSdk } from './sdk.js';
import {
  type OpenCodeServerHandle,
  type ServerExit,
  ServerLedger,
  type StartServerOptions,
  startOpenCodeServer,
} from './server.js';
import { openCodeAuthPath } from './usage.js';
import { v2AppToolsPluginEntry, writeV2AppToolsPlugin } from './v2-app-tools.js';
import { createOpenCodeV2Client } from './v2-client.js';
import { MINIMUM_OPENCODE_V2_VERSION, openCodeV2DataHome, openCodeV2Env } from './v2-runtime.js';

/** 没人借用之后多久停掉服务器（T3 的 OPENCODE_SERVER_IDLE_TTL）。 */
export const SERVER_IDLE_TTL_MS = 30_000;

async function hasMigratedDatabase(env: NodeJS.ProcessEnv): Promise<boolean> {
  const database = env.OPENCODE_DB?.trim() || 'opencode.db';
  if (database === ':memory:') return false;
  const directories = [
    dirname(openCodeAuthPath(env)),
    ...(env.OPENCODE_DATA_DIR?.split(',') ?? []),
  ];
  const files = new Set(
    directories
      .map((directory) => directory.trim())
      .filter(Boolean)
      .map((directory) => resolve(directory, database)),
  );
  for (const file of files) {
    try {
      if (!(await stat(file)).isFile()) continue;
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        if (
          db
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name IN ('session_v2', 'credential')",
            )
            .get()
        ) {
          return true;
        }
      } finally {
        db.close();
      }
    } catch (error) {
      // A locked or unreadable database cannot safely be handed to the older CLI.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
  }
  return false;
}

/** 检测到的 `opencode`。 */
export interface OpenCodeInstallation {
  executablePath: string;
  version: string | undefined;
  /** 托管 1.x 与系统 2.x 共存时用的独立数据目录。 */
  dataHome?: string;
}

export type Detection =
  | {
      ok: true;
      installation: OpenCodeInstallation;
      /** 用的是 Wevir 自己装的那份。 */
      managed: boolean;
    }
  | {
      ok: false;
      /** missing：找不到；unusable：找到了但跑不起来或版本不支持。 */
      reason: 'missing' | 'unusable';
      executablePath?: string;
      version?: string;
      message?: string;
      managed?: boolean;
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
  accountDataHome?: string;
  env?: NodeJS.ProcessEnv;
  sdk?: () => Promise<OpenCodeSdk>;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
  /**
   * Wevir 替用户装的 `opencode`（`<engineDir>/runtime`）。省略时按本平台建，本平台没有构建时没有；`null` 表示不能装
   * （测试）。
   */
  installer?: ManagedInstaller | null;
  /** 测试用：默认安装器的选项（registry 与 fetch、平台、AVX2 与 musl 的探测）。 */
  installerOptions?: Partial<OpenCodeInstallerOptions>;
  /** 测试用：替换可执行文件的查找（第二个参数是 Wevir 自己装的 `opencode`）、版本探测与起服务器。 */
  findExecutable?: (customPath: string | null, managedPath?: string) => string | undefined;
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
  #serverInstallation: OpenCodeInstallation | undefined;
  /** 应用级工具的引擎令牌（Host 监听之后给）；正在跑的服务器挂没挂上插件。 */
  #appTools: (() => AppToolsEndpoint | undefined) | undefined;
  #serverHasAppTools = false;
  #starting: Promise<OpenCodeServerHandle> | undefined;
  #leases = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;
  readonly installer: ManagedInstaller | undefined;

  constructor(options: OpenCodeRuntimeOptions) {
    this.#options = options;
    this.#ledger = new ServerLedger({
      engineDir: options.engineDir,
      ...(options.warn !== undefined && { warn: options.warn }),
    });
    this.installer =
      options.installer === undefined ? this.#defaultInstaller() : (options.installer ?? undefined);
  }

  get engineDir(): string {
    return this.#options.engineDir;
  }

  get v2DataHome(): string {
    return openCodeV2DataHome(this.#options.engineDir, this.#options.accountDataHome);
  }

  get customPath(): string | null {
    return this.#customPath;
  }

  get dataHome(): string | undefined {
    return this.#installation?.dataHome ?? this.#options.accountDataHome;
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

  /** 插件用的引擎令牌（Host 还没监听或没有应用级工具时 `undefined`）。 */
  appToolsEndpoint(): AppToolsEndpoint | undefined {
    return this.#appTools?.();
  }

  /** 二进制或应用级工具变了，空闲后换一个服务器。 */
  get #outdated(): boolean {
    return (
      (this.#server !== undefined &&
        !this.#serverHasAppTools &&
        this.#appTools?.() !== undefined) ||
      (this.#serverInstallation !== undefined &&
        this.#installation !== undefined &&
        (this.#serverInstallation.executablePath !== this.#installation.executablePath ||
          this.#serverInstallation.version !== this.#installation.version ||
          this.#serverInstallation.dataHome !== this.#installation.dataHome))
    );
  }

  /** 找 `opencode` 并跑 `--version`，选用对应大版本的客户端。 */
  async detect(): Promise<Detection> {
    const parentEnv = this.#options.env ?? process.env;
    const managed = await this.installer?.active();
    const find =
      this.#options.findExecutable ??
      ((customPath, managedPath) => findOpenCode({ customPath, env: parentEnv, managedPath }));
    const executablePath = find(this.#customPath, managed?.path);
    const isManaged = managed !== undefined && executablePath === managed.path;
    if (executablePath === undefined) {
      this.#installation = undefined;
      return {
        ok: false,
        reason: 'missing',
        ...(this.#customPath !== null && { message: `${this.#customPath} does not exist` }),
      };
    }
    const found = await this.#check(executablePath, isManaged);
    if (found.ok || isManaged || managed === undefined || this.#customPath !== null) return found;
    // 自己找到的不能用而 Wevir 装过 1.x：用 Wevir 的那份。
    const fallback = await this.#check(
      managed.path,
      true,
      !found.ok && found.version !== undefined && Number(found.version.split('.')[0]) >= 2,
    );
    return fallback.ok ? fallback : found;
  }

  /** 跑 `--version` 核对版本，能用就记下来。 */
  async #check(executablePath: string, isManaged: boolean, systemV2 = false): Promise<Detection> {
    const parentEnv = this.#options.env ?? process.env;
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
        managed: isManaged,
      };
    }
    const version = probe.version;
    const unsupported = unsupportedVersion(version, isManaged);
    if (unsupported !== undefined) {
      this.#installation = undefined;
      return {
        ok: false,
        reason: 'unusable',
        executablePath,
        ...(version !== undefined && { version }),
        message: unsupported,
        managed: isManaged,
      };
    }
    const dataHome = isManaged ? await this.#managedDataHome(parentEnv, systemV2) : undefined;
    const installation = { executablePath, version, ...(dataHome !== undefined && { dataHome }) };
    this.#installation = installation;
    if (this.#outdated) this.#scheduleIdleStop(0);
    return { ok: true, installation, managed: isManaged };
  }

  async #managedDataHome(env: NodeJS.ProcessEnv, systemV2: boolean): Promise<string | undefined> {
    const isolated = join(this.#options.accountDataHome ?? this.engineDir, 'data-v1');
    if (!systemV2 && !existsSync(isolated) && !(await hasMigratedDatabase(env))) return undefined;
    await mkdir(isolated, { recursive: true, mode: 0o700 });
    return isolated;
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
    let sdk: OpenCodeSdk;
    try {
      server = await this.#ensureServer(installation);
      if (isOpenCodeV2(server.version) !== isOpenCodeV2(installation.version)) {
        throw new Error('Close the active OpenCode sessions to switch server versions.');
      }
      sdk = isOpenCodeV2(server.version)
        ? { connect: createOpenCodeV2Client }
        : await this.#loadSdk();
    } catch (error) {
      this.#leases -= 1;
      if (this.#leases === 0) this.#scheduleIdleStop();
      throw error;
    }
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
    this.installer?.cancel();
    this.#abort.abort();
    this.#exitListeners.clear();
    this.#cancelIdleStop();
    const starting = this.#starting;
    await this.#stopServer();
    // 正在起的那个起来之后也停掉。
    await starting?.then((server) => server.stop()).catch(() => {});
  }

  /** 默认的安装器：下载的程序要能跑，`opencode --version` 有答复而且是支持的版本。 */
  #defaultInstaller(): ManagedInstaller | undefined {
    const extra = this.#options.installerOptions;
    if (!openCodeInstallSupported(extra?.platform, extra?.arch)) return undefined;
    return new OpenCodeInstaller({
      directory: openCodeInstallDirectory(this.#options.engineDir),
      ...extra,
      validate: async (file, _version, signal) => {
        const parentEnv = this.#options.env ?? process.env;
        const probe = await (this.#options.probeVersion ?? probeOpenCodeVersion)(
          file,
          openCodeEnv(parentEnv, file),
          undefined,
          signal,
        );
        if (!probe.ok) throw new Error(probe.message);
        const unsupported = unsupportedVersion(probe.version, true);
        if (unsupported !== undefined) throw new Error(unsupported);
      },
    });
  }

  async #ensureServer(installation: OpenCodeInstallation): Promise<OpenCodeServerHandle> {
    // Reap a server still pointing at the shared database before lending out the isolated one.
    if (installation.dataHome !== undefined) {
      const existing = this.#server ?? (await this.#starting);
      if (existing !== undefined && this.#serverInstallation?.dataHome !== installation.dataHome) {
        await existing.stop();
      }
    }
    if (this.#server !== undefined) return this.#server;
    this.#starting ??= this.#start(installation).finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #start(installation: OpenCodeInstallation): Promise<OpenCodeServerHandle> {
    await this.#ledger.reapOrphans();
    const v2 = isOpenCodeV2(installation.version);
    const sdk: OpenCodeSdk = v2 ? { connect: createOpenCodeV2Client } : await this.#loadSdk();
    const parentEnv = this.#options.env ?? process.env;
    const env = openCodeEnv(
      installation.dataHome === undefined
        ? parentEnv
        : openCodeDatabaseEnv(parentEnv, installation.dataHome),
      installation.executablePath,
    );
    const appTools = this.#appTools?.();
    let appToolsPlugin: OpenCodePluginEntry | undefined;
    if (!v2) {
      const url = writeAppToolsPlugin(this.#options.engineDir);
      appToolsPlugin = appTools ? appToolsPluginEntry(url, appTools) : [url, {}];
    }
    const server = await (this.#options.startServer ?? startOpenCodeServer)({
      executable: installation.executablePath,
      env: v2 ? openCodeV2Env(env, this.v2DataHome) : env,
      ...(v2 && { generation: 2 }),
      ledger: this.#ledger,
      ...(appToolsPlugin !== undefined && { appToolsPlugin }),
      ...(v2 &&
        appTools !== undefined && {
          v2AppToolsPlugin: v2AppToolsPluginEntry(
            writeV2AppToolsPlugin(this.#options.engineDir),
            appTools,
          ),
        }),
      signal: this.#abort.signal,
      verify: async (url, password) => {
        const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(5_000)]);
        const health = await sdk
          .connect({ baseUrl: url, directory: this.#options.engineDir, password })
          .health(signal);
        const unsupported = unsupportedVersion(health.version);
        if (unsupported !== undefined) throw new Error(unsupported);
        if (isOpenCodeV2(health.version) !== v2) {
          throw new Error(`OpenCode reported an unexpected server version: ${health.version}`);
        }
        return health.version;
      },
    });
    if (this.#disposed) {
      await server.stop();
      throw new Error('the OpenCode engine has been disposed');
    }
    this.#server = server;
    this.#serverInstallation = installation;
    this.#serverHasAppTools = appTools !== undefined;
    void server.exited.then((exit) => {
      if (this.#server !== server) return;
      this.#server = undefined;
      this.#serverInstallation = undefined;
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
    this.#serverInstallation = undefined;
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

export function isOpenCodeV2(version: string | undefined): boolean {
  return version?.startsWith('2.') === true;
}

/** 版本不能用的原因；能用时 undefined。 */
export function unsupportedVersion(
  version: string | undefined,
  managed = false,
): string | undefined {
  if (version === undefined) {
    return `Unable to determine the OpenCode version. Wevir requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`;
  }
  if (compareVersions(version, '2.0.0') >= 0 && managed) {
    return `OpenCode v${version} is outside the managed 1.x release line.`;
  }
  if (compareVersions(version, '3.0.0') >= 0) {
    return `OpenCode v${version} is not supported. Use a 1.x or 2.x CLI.`;
  }
  if (isOpenCodeV2(version) && compareVersions(version, MINIMUM_OPENCODE_V2_VERSION) < 0) {
    return `OpenCode v${version} is too old for the 2.x API. Upgrade to v${MINIMUM_OPENCODE_V2_VERSION} or newer.`;
  }
  if (compareVersions(version, MINIMUM_OPENCODE_VERSION) < 0) {
    return `OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`;
  }
  return undefined;
}
