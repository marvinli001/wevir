// SPDX-License-Identifier: MIT
// 安装包不带 `@cursor/sdk`（许可证是“All rights reserved”，Wevir 不再分发它），用户选用 Cursor 时由 Host 替用户从 npm registry
// 下载（`account.install`，accounts.ts）：SDK 与它的依赖、本平台的平台包（tree-sitter 的 `.node`、`rg` 与 `cursorsandbox`），版本
// 与 sha512 写死在 `CURSOR_SDK_PACKAGES`（与 pnpm-lock.yaml 一致，sdk-install.test.ts 核对），不取 registry 给的元数据，所以从哪个
// registry 下载都一样可信。开发环境的 SDK 经 pnpm 装上，不走这里（engines.ts）。
//
// 目录（`directory`，`<数据目录>/engines/cursor/sdk`）：versions/<版本>/node_modules/<包>/ 是 npm 的扁平布局（闭包里没有版本冲突），
// active.json 指向装好的版本；下载与解出都在 versions/.install-* 里进行，全部核对通过才改名并写指针，失败或取消不留半截。
// registry 照 runtime-adapter 的 `npmRegistries`（默认 npmjs 与 npmmirror，`WEVIR_NPM_REGISTRY` 可换）：先问谁有这个版本，先答的
// 先用，一个包下载失败或校验不对再换下一个。

import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import zlib from 'node:zlib';
import {
  NpmInstallCancelled,
  NpmInstallError,
  npmRegistries,
  readTar,
  type TarSink,
} from '@wevir/runtime-adapter/npm-package';
import { cursorEngineDir } from './credentials.js';
import { CURSOR_SDK_VERSION } from './sdk.js';

/** 要下载的一个包；`os` / `cpu` 只在那个平台装（平台包）。 */
export interface CursorSdkPackage {
  readonly name: string;
  readonly version: string;
  /** npm 的 integrity（sha512），来自 pnpm-lock.yaml。 */
  readonly integrity: string;
  readonly os?: NodeJS.Platform;
  readonly cpu?: string;
}

/** `@cursor/sdk` 的生产依赖闭包（pnpm-lock.yaml，钉 1.0.35）。 */
export const CURSOR_SDK_PACKAGES: readonly CursorSdkPackage[] = Object.freeze([
  {
    name: '@cursor/sdk',
    version: CURSOR_SDK_VERSION,
    integrity:
      'sha512-CJQR4ocRFm74N1miSqSSrhWyEbvTRIJGyMfHQvZlcBIYzLMXCVPmb1bV82L4NJ8mG9TyvbckEjERjbnzpG5akQ==',
  },
  {
    name: '@bufbuild/protobuf',
    version: '1.10.0',
    integrity:
      'sha512-QDdVFLoN93Zjg36NoQPZfsVH9tZew7wKDKyV5qRdj8ntT4wQCOradQjRaTdwMhWUYsgKsvCINKKm87FdEk96Ag==',
  },
  {
    name: '@connectrpc/connect',
    version: '1.7.0',
    integrity:
      'sha512-iNKdJRi69YP3mq6AePRT8F/HrxWCewrhxnLMNm0vpqXAR8biwzRtO6Hjx80C6UvtKJ5sFmffQT7I4Baecz389w==',
  },
  {
    name: '@connectrpc/connect-web',
    version: '1.7.0',
    integrity:
      'sha512-qyP0YOnUPRWwCc/VfsoydMJvkb7EyUPr2q9sHgBuJzbADjiqck1gKH5V5ZPzPhTLBvmz5UvG+wiZ5sMRQHU1MQ==',
  },
  {
    name: '@statsig/js-client',
    version: '3.31.0',
    integrity:
      'sha512-LFa5E0LjT6sTfZv3sNGoyRLSZ1078+agdgOA+Vm1ecjG+KbSOfBLTW7hMwimrJ29slRwbYDzbtKaPJo/R37N2g==',
  },
  {
    name: '@statsig/client-core',
    version: '3.31.0',
    integrity:
      'sha512-SuxQD6TmVszPG7FoMKwTk/uyBuVFk7XnxI3T/E0uyb7PL7GNjONtfsoh+NqBBVUJVse0CUeSFfgJPoZy1ZOslQ==',
  },
  {
    name: 'zod',
    version: '3.25.76',
    integrity:
      'sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==',
  },
  {
    name: '@cursor/sdk-darwin-arm64',
    version: CURSOR_SDK_VERSION,
    integrity:
      'sha512-q9/y2NHTGnE0iwMfJ+FIHmj2gDGDRy45fH3rF3SAFGEGzM4xh726r64n6hH4OQYwKhcMqhqxbPGBpXHd5lRW4A==',
    os: 'darwin',
    cpu: 'arm64',
  },
  {
    name: '@cursor/sdk-darwin-x64',
    version: CURSOR_SDK_VERSION,
    integrity:
      'sha512-0IGwzNr3Lq9IrcIRU4AlT7kTkwwVhRpQyjHqhvnKdgtn+WFYShr9gqTb44leihi/Cbf7a76yEdCgpfScBCPtxQ==',
    os: 'darwin',
    cpu: 'x64',
  },
  {
    name: '@cursor/sdk-linux-arm64',
    version: CURSOR_SDK_VERSION,
    integrity:
      'sha512-AAx2DBqOc21kIwKuHRLl+4bCbuU7Su/BWY+TzXMgMsxAOHvLDGg7SGVvHOMV4ENczbOEcO4zc3XDbmQB4x3rdw==',
    os: 'linux',
    cpu: 'arm64',
  },
  {
    name: '@cursor/sdk-linux-x64',
    version: CURSOR_SDK_VERSION,
    integrity:
      'sha512-3PABXvbT/Ue3jN+ytWcNDPBWptAiJv4qzxL0m2rma3e7kyx/Q1/8FYRYunIpX21HfPGgDSURlWztEov1xdZs3Q==',
    os: 'linux',
    cpu: 'x64',
  },
  {
    name: '@cursor/sdk-win32-x64',
    version: CURSOR_SDK_VERSION,
    integrity:
      'sha512-zADtORY6QRMCBTckxTieAKxcthRiefNNHxVhX2RtO3pQGa4iQwTrHjmjUw0nqCF6sJlCrQ58DTgkrz+BZhLEcw==',
    os: 'win32',
    cpu: 'x64',
  },
]);

/** 这个平台要装的包；SDK 没有这个平台的平台包时 undefined（不能装）。 */
export function cursorSdkPackages(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CursorSdkPackage[] | undefined {
  const own = CURSOR_SDK_PACKAGES.filter(
    (entry) => entry.os === undefined || (entry.os === platform && entry.cpu === arch),
  );
  return own.some((entry) => entry.os !== undefined) ? own : undefined;
}

/** 本平台能不能装 SDK。 */
export function cursorSdkInstallSupported(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return cursorSdkPackages(platform, arch) !== undefined;
}

/** 默认的安装目录：引擎目录下的 `sdk`（与登录铸的 `auth.json` 并列）。 */
export function cursorSdkDirectory(home: string): string {
  return path.join(cursorEngineDir(home), 'sdk');
}

/** 装好的 SDK：`root` 下是 `node_modules/@cursor/sdk` 与它的依赖。 */
export interface CursorSdkInstallation {
  root: string;
  version: string;
}

/** 安装进度与结果（`onChange`）。 */
export type CursorSdkInstallEvent =
  | { type: 'progress'; completedBytes: number; totalBytes?: number }
  | { type: 'installed'; installation: CursorSdkInstallation }
  | { type: 'failed'; message: string }
  | { type: 'cancelled' };

export interface CursorSdkInstallerOptions {
  /** 安装根目录（`cursorSdkDirectory`），不存在时建。 */
  directory: string;
  registries?: readonly string[];
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  /** 多久收不到数据算下载卡住。 */
  idleTimeoutMs?: number;
  progressIntervalMs?: number;
  /** 测试用：换掉要装的包（默认按平台从 `CURSOR_SDK_PACKAGES` 里选）。 */
  packages?: readonly CursorSdkPackage[];
}

const ACTIVE_FILE = 'active.json';
const LOOKUP_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const PROGRESS_INTERVAL_MS = 250;
/** 解开约 35 MB，留出余量。 */
const REQUIRED_SPACE = 128 * 1024 * 1024;

/**
 * 一个 Host 一个（首个账号与添加的账号共用，engines.ts）：同一时刻只有一次安装，进度与结果经 `onChange` 告诉每个账号。
 */
export class CursorSdkInstaller {
  readonly directory: string;
  readonly #options: CursorSdkInstallerOptions;
  readonly #versions: string;
  readonly #listeners = new Set<(event: CursorSdkInstallEvent) => void>();
  #running: { controller: AbortController; done: Promise<CursorSdkInstallation> } | undefined;
  #progress: { completedBytes: number; totalBytes?: number } | undefined;
  #error: string | undefined;

  constructor(options: CursorSdkInstallerOptions) {
    this.#options = options;
    this.directory = options.directory;
    this.#versions = path.join(options.directory, 'versions');
  }

  /** 本平台能不能装。 */
  get supported(): boolean {
    return this.#packages() !== undefined;
  }

  /** 正在安装时的进度（还不知道总大小时没有 `totalBytes`）。 */
  get installing(): { completedBytes: number; totalBytes?: number } | undefined {
    return this.#running === undefined ? undefined : (this.#progress ?? { completedBytes: 0 });
  }

  /** 上一次安装失败的原因；下一次安装开始或成功时清掉。 */
  get error(): string | undefined {
    return this.#error;
  }

  /** 装好的、正是钉住的版本：指针与包文件都在；否则 undefined（升级 Wevir 换了钉的版本时要重新装）。 */
  async active(): Promise<CursorSdkInstallation | undefined> {
    let version: unknown;
    try {
      const raw = await fsp.readFile(path.join(this.directory, ACTIVE_FILE), 'utf8');
      version = (JSON.parse(raw) as { version?: unknown }).version;
    } catch {
      return undefined;
    }
    if (version !== CURSOR_SDK_VERSION) return undefined;
    const root = path.join(this.#versions, version);
    const packages = this.#packages();
    if (packages === undefined) return undefined;
    for (const entry of packages) {
      try {
        await fsp.access(path.join(root, 'node_modules', entry.name, 'package.json'));
      } catch {
        return undefined;
      }
    }
    return { root, version };
  }

  /**
   * 下载安装钉住的版本（已装好时只是核对）。进行中时返回同一个 Promise。失败抛 `NpmInstallError`，取消抛 `NpmInstallCancelled`；
   * 结果同时经 `onChange` 发出。
   */
  install(): Promise<CursorSdkInstallation> {
    if (this.#running !== undefined) return this.#running.done;
    const controller = new AbortController();
    this.#error = undefined;
    this.#progress = { completedBytes: 0 };
    const done = this.#install(controller.signal).then(
      (installation) => {
        this.#finish(controller);
        this.#emit({ type: 'installed', installation });
        return installation;
      },
      (error: unknown) => {
        this.#finish(controller);
        if (error instanceof NpmInstallCancelled) {
          this.#emit({ type: 'cancelled' });
        } else {
          this.#error = error instanceof Error ? error.message : String(error);
          this.#emit({ type: 'failed', message: this.#error });
        }
        throw error;
      },
    );
    this.#running = { controller, done };
    this.#emit({ type: 'progress', completedBytes: 0 });
    return done;
  }

  cancel(): void {
    this.#running?.controller.abort(new NpmInstallCancelled('Installation cancelled.'));
  }

  onChange(listener: (event: CursorSdkInstallEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #finish(controller: AbortController): void {
    if (this.#running?.controller === controller) this.#running = undefined;
    this.#progress = undefined;
  }

  #emit(event: CursorSdkInstallEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // 监听器里的错误不影响别的监听器。
      }
    }
  }

  #packages(): readonly CursorSdkPackage[] | undefined {
    if (this.#options.packages !== undefined) return this.#options.packages;
    return cursorSdkPackages(
      this.#options.platform ?? process.platform,
      this.#options.arch ?? process.arch,
    );
  }

  async #install(signal: AbortSignal): Promise<CursorSdkInstallation> {
    const packages = this.#packages();
    if (packages === undefined) {
      throw new NpmInstallError(
        'resolve',
        `The Cursor SDK has no build for ${this.#options.platform ?? process.platform}-${this.#options.arch ?? process.arch}.`,
      );
    }
    try {
      await fsp.mkdir(this.#versions, { recursive: true });
      await this.#removeStaleStaging();
      const existing = await this.active();
      if (existing !== undefined) return existing;
      await this.#checkSpace();
      const registries = await this.#rankRegistries(signal);

      const staging = await fsp.mkdtemp(path.join(this.#versions, '.install-'));
      try {
        const sizes = new Map<string, number | undefined>();
        const received = new Map<string, number>();
        let reportedAt = 0;
        const report = (force: boolean) => {
          const now = Date.now();
          const interval = this.#options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
          if (!force && now - reportedAt < interval) return;
          reportedAt = now;
          let completedBytes = 0;
          for (const value of received.values()) completedBytes += value;
          // 每个包的大小都知道了才报总数（百分比不倒退）。
          let totalBytes: number | undefined = 0;
          for (const entry of packages) {
            const size = sizes.get(entry.name);
            totalBytes =
              size === undefined || totalBytes === undefined ? undefined : totalBytes + size;
          }
          this.#progress = {
            completedBytes,
            ...(totalBytes !== undefined && { totalBytes: Math.max(totalBytes, completedBytes) }),
          };
          this.#emit({ type: 'progress', ...this.#progress });
        };
        await Promise.all(
          packages.map((entry) =>
            this.#fetchPackage(entry, registries, staging, signal, {
              size: (bytes) => {
                sizes.set(entry.name, bytes);
                report(true);
              },
              received: (bytes) => {
                received.set(entry.name, bytes);
                report(false);
              },
            }),
          ),
        );
        report(true);
        const manifest = JSON.parse(
          await fsp.readFile(
            path.join(staging, 'node_modules', '@cursor', 'sdk', 'package.json'),
            'utf8',
          ),
        ) as { version?: unknown };
        if (manifest.version !== CURSOR_SDK_VERSION) {
          throw new NpmInstallError('verify', 'The downloaded Cursor SDK has the wrong version.');
        }
        if (signal.aborted) throw signal.reason;
        const destination = path.join(this.#versions, CURSOR_SDK_VERSION);
        await fsp.rm(destination, { recursive: true, force: true });
        await fsp.rename(staging, destination);
      } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
      await this.#activate(CURSOR_SDK_VERSION);
      await this.#removeOtherVersions(CURSOR_SDK_VERSION);
      return { root: path.join(this.#versions, CURSOR_SDK_VERSION), version: CURSOR_SDK_VERSION };
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason instanceof NpmInstallCancelled
          ? signal.reason
          : new NpmInstallCancelled('Installation cancelled.');
      }
      if (error instanceof NpmInstallError) throw error;
      throw new NpmInstallError(
        'install',
        'Could not install the Cursor SDK. Check free disk space and directory access, then try again.',
        { cause: error },
      );
    }
  }

  /** 同时问每个 registry 有没有这个版本，先答的排前面；都答不了时报错。 */
  async #rankRegistries(signal: AbortSignal): Promise<string[]> {
    const registries = this.#options.registries ?? npmRegistries();
    const ranked: string[] = [];
    const lookups = registries.map(async (registry) => {
      const response = await (this.#options.fetch ?? fetch)(
        `${registry}/${encodeName('@cursor/sdk')}/${CURSOR_SDK_VERSION}`,
        {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]),
        },
      );
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw new Error(`${hostOf(registry)} answered ${response.status}`);
      ranked.push(registry);
    });
    const settled = await Promise.allSettled(lookups);
    if (signal.aborted) throw signal.reason;
    if (ranked.length === 0) {
      const reasons = settled.flatMap((result) =>
        result.status === 'rejected' ? [reasonOf(result.reason)] : [],
      );
      throw new NpmInstallError(
        'resolve',
        `Could not reach the npm registry (${registries.map(hostOf).join(', ')}): ${reasons.join('; ')}. Check your network or proxy. WEVIR_NPM_REGISTRY can point to another registry.`,
      );
    }
    return ranked;
  }

  /** 按顺序从各 registry 下载一个包，边下边核对 sha512、边解开到 staging/node_modules/<包>；一个不行换下一个。 */
  async #fetchPackage(
    entry: CursorSdkPackage,
    registries: readonly string[],
    staging: string,
    signal: AbortSignal,
    progress: { size: (bytes: number | undefined) => void; received: (bytes: number) => void },
  ): Promise<void> {
    const target = path.join(staging, 'node_modules', ...entry.name.split('/'));
    const failures: string[] = [];
    for (const registry of registries) {
      try {
        await this.#download(entry, tarballUrl(registry, entry), target, signal, progress);
        return;
      } catch (error) {
        await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
        if (signal.aborted) throw signal.reason;
        progress.received(0);
        failures.push(`${hostOf(registry)}: ${reasonOf(error)}`);
      }
    }
    throw new NpmInstallError(
      'download',
      `Could not download ${entry.name}@${entry.version} (${failures.join('; ')}).`,
    );
  }

  async #download(
    entry: CursorSdkPackage,
    url: string,
    target: string,
    signal: AbortSignal,
    progress: { size: (bytes: number | undefined) => void; received: (bytes: number) => void },
  ): Promise<void> {
    const idle = new AbortController();
    const idleMs = this.#options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => idle.abort(new Error(`no data from ${hostOf(url)} for ${idleMs} ms`)),
        idleMs,
      );
    };
    const aborted = AbortSignal.any([signal, idle.signal]);
    // 中途失败时还开着的文件（Windows 上开着的删不掉）。
    const open = new Set<fsp.FileHandle>();
    try {
      arm();
      const response = await (this.#options.fetch ?? fetch)(url, {
        headers: { 'Accept-Encoding': 'identity' },
        signal: aborted,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`${hostOf(url)} answered ${response.status}`);
      }
      const length = Number(response.headers.get('content-length'));
      progress.size(Number.isFinite(length) && length > 0 ? length : undefined);
      const expected = integrityOf(entry.integrity);
      const hash = createHash(expected.algorithm);
      let received = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          received += chunk.length;
          arm();
          progress.received(received);
          callback(null, chunk);
        },
      });
      await fsp.mkdir(target, { recursive: true });
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream),
        counter,
        zlib.createGunzip(),
        (source: AsyncIterable<Buffer>) =>
          readTar(source, (item) => packageFile(target, item, open)),
        { signal: aborted },
      );
      if (hash.digest('base64') !== expected.digest) {
        throw new Error('the download did not match the checksum pinned in Wevir');
      }
    } catch (error) {
      if (idle.signal.aborted && !signal.aborted) throw idle.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      for (const handle of open) await handle.close().catch(() => {});
    }
  }

  async #checkSpace(): Promise<void> {
    const available = await fsp
      .statfs(this.#versions, { bigint: true })
      .then((stats) => stats.bavail * stats.bsize)
      .catch(() => undefined);
    if (available !== undefined && available < BigInt(REQUIRED_SPACE)) {
      throw new NpmInstallError(
        'download',
        `The Cursor SDK needs at least ${REQUIRED_SPACE / 1024 / 1024} MiB of free space to install.`,
      );
    }
  }

  /** 原子地写下指针：先写临时文件再改名。 */
  async #activate(version: string): Promise<void> {
    const pointer = path.join(this.directory, ACTIVE_FILE);
    const temporary = `${pointer}.${randomUUID()}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify({ version }), { mode: 0o600 });
    await fsp.rename(temporary, pointer);
  }

  async #removeStaleStaging(): Promise<void> {
    for (const entry of await fsp.readdir(this.#versions).catch(() => [])) {
      if (entry.startsWith('.install-')) {
        await fsp
          .rm(path.join(this.#versions, entry), { recursive: true, force: true })
          .catch(() => {});
      }
    }
  }

  /** 新版本启用后删掉别的版本（Windows 上还加载着的删不掉，忽略）。 */
  async #removeOtherVersions(keep: string): Promise<void> {
    for (const entry of await fsp.readdir(this.#versions).catch(() => [])) {
      if (entry !== keep && !entry.startsWith('.')) {
        await fsp
          .rm(path.join(this.#versions, entry), { recursive: true, force: true })
          .catch(() => {});
      }
    }
  }
}

/**
 * tgz 里的一个条目放到包目录下：去掉顶层目录（npm 包是 `package/`，npm 自己也是去掉第一段），只写普通文件；绝对路径、`..`
 * 与链接一律跳过，不会写到包目录外。可执行位照包里的（`rg` 等），Windows 上不管。
 */
async function packageFile(
  target: string,
  entry: { name: string; type: string; mode: number },
  open: Set<fsp.FileHandle>,
): Promise<TarSink | undefined> {
  if (entry.type !== 'file') return undefined;
  const parts = entry.name.split('/').slice(1);
  if (
    parts.length === 0 ||
    parts.some((part) => part === '' || part === '.' || part === '..' || /[\\:\0]/u.test(part))
  ) {
    return undefined;
  }
  const file = path.join(target, ...parts);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const handle = await fsp.open(file, 'w', (entry.mode & 0o111) !== 0 ? 0o755 : 0o644);
  open.add(handle);
  return {
    write: async (data) => {
      await handle.write(data);
    },
    end: async () => {
      open.delete(handle);
      await handle.close();
    },
  };
}

/** npm 的 tgz 地址：`<registry>/<包>/-/<不带作用域的名字>-<版本>.tgz`（npmjs 与 npmmirror 都是这样）。 */
export function tarballUrl(registry: string, entry: { name: string; version: string }): string {
  const base = entry.name.split('/').pop() as string;
  return `${registry}/${entry.name}/-/${base}-${entry.version}.tgz`;
}

function encodeName(name: string): string {
  return name.replace('/', '%2F');
}

function integrityOf(integrity: string): { algorithm: string; digest: string } {
  const dash = integrity.indexOf('-');
  return { algorithm: integrity.slice(0, dash), digest: integrity.slice(dash + 1) };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const detail = cause instanceof Error ? cause.message : undefined;
    return detail !== undefined && detail !== error.message
      ? `${error.message} (${detail})`
      : error.message;
  }
  return String(error);
}
