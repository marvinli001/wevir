// SPDX-License-Identifier: MIT
// 按需下载一组钉死的 npm 包（一个主包与它的生产依赖闭包，加上本平台的平台包）装进数据目录，不经 npm：Cursor SDK（许可证不许
// 随包分发，adapter-cursor 的 sdk-install.ts）与 LibreOffice 预览引擎（每个平台 150–200 MB，host 的 office/install.ts）都用它。
// 版本与 sha512 写死在调用方的包表里（与 pnpm-lock.yaml 或上游的锁文件一致），不取 registry 给的元数据，所以从哪个 registry
// 下载都一样可信。
//
// 目录（`directory`）：versions/<主包版本>/node_modules/<包>/ 是 npm 的扁平布局（闭包里没有版本冲突），active.json 指向装好的
// 版本；下载与解出都在 versions/.install-* 里进行，全部核对通过才改名并写指针，失败或取消不留半截。registry 照 npm-package.ts 的
// `npmRegistries`（默认 npmjs 与 npmmirror，`WEVIR_NPM_REGISTRY` 可换）：先问谁有这个版本，先答的先用，一个包下载失败或校验不对
// 再换下一个。

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
} from './npm-package.js';

/** 要下载的一个包；`os` / `cpu` 只在那个平台装（平台包）。 */
export interface NpmClosurePackage {
  readonly name: string;
  readonly version: string;
  /** npm 的 integrity（sha512）。 */
  readonly integrity: string;
  readonly os?: NodeJS.Platform;
  readonly cpu?: string;
}

/** 包表里这个平台要装的：不带 `os` / `cpu` 的通用包，加上 `os` 与 `cpu` 都对得上的平台包。 */
export function closureFor(
  packages: readonly NpmClosurePackage[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): NpmClosurePackage[] {
  return packages.filter(
    (entry) =>
      (entry.os === undefined || entry.os === platform) &&
      (entry.cpu === undefined || entry.cpu === arch),
  );
}

/** 装好的闭包：`root` 下是 `node_modules/<主包>` 与它的依赖。 */
export interface NpmClosureInstallation {
  root: string;
  version: string;
}

/** 安装进度与结果（`onChange`）。 */
export type NpmClosureInstallEvent =
  | { type: 'progress'; completedBytes: number; totalBytes?: number }
  | { type: 'installed'; installation: NpmClosureInstallation }
  | { type: 'failed'; message: string }
  | { type: 'cancelled' };

export interface NpmClosureInstallerOptions {
  /** 安装根目录，不存在时建。 */
  directory: string;
  /** 给人看的名字，用在错误信息里（`The <label> …`），如 `Cursor SDK`。 */
  label: string;
  /** 主包：先问 registry 有没有它，装好后核对它的 `package.json` 版本；版本也是 versions/ 下的目录名。 */
  main: { readonly name: string; readonly version: string };
  /** 这个平台要装的包（含主包）；undefined 表示这个平台不能装。 */
  packages: readonly NpmClosurePackage[] | undefined;
  /** 解开后约占的空间：剩余空间不到它时不开始下载。 */
  requiredSpace: number;
  registries?: readonly string[];
  fetch?: typeof fetch;
  /** 多久收不到数据算下载卡住。 */
  idleTimeoutMs?: number;
  progressIntervalMs?: number;
}

const ACTIVE_FILE = 'active.json';
const LOOKUP_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const PROGRESS_INTERVAL_MS = 250;

/** 同一时刻只有一次安装，进度与结果经 `onChange` 告诉每个监听者。 */
export class NpmClosureInstaller {
  readonly directory: string;
  readonly #options: NpmClosureInstallerOptions;
  readonly #versions: string;
  readonly #listeners = new Set<(event: NpmClosureInstallEvent) => void>();
  #running: { controller: AbortController; done: Promise<NpmClosureInstallation> } | undefined;
  #progress: { completedBytes: number; totalBytes?: number } | undefined;
  #error: string | undefined;

  constructor(options: NpmClosureInstallerOptions) {
    this.#options = options;
    this.directory = options.directory;
    this.#versions = path.join(options.directory, 'versions');
  }

  /** 本平台能不能装。 */
  get supported(): boolean {
    return this.#options.packages !== undefined;
  }

  /** 这个平台要装的包。 */
  get packages(): readonly NpmClosurePackage[] {
    return this.#options.packages ?? [];
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
  async active(): Promise<NpmClosureInstallation | undefined> {
    const { main, packages } = this.#options;
    let version: unknown;
    try {
      const raw = await fsp.readFile(path.join(this.directory, ACTIVE_FILE), 'utf8');
      version = (JSON.parse(raw) as { version?: unknown }).version;
    } catch {
      return undefined;
    }
    if (version !== main.version || packages === undefined) return undefined;
    const root = path.join(this.#versions, version);
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
  install(): Promise<NpmClosureInstallation> {
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

  /** 删掉装好的全部版本与指针；正在安装时先取消并等它收尾。 */
  async uninstall(): Promise<void> {
    const running = this.#running;
    if (running !== undefined) {
      this.cancel();
      await running.done.catch(() => {});
    }
    this.#error = undefined;
    await fsp.rm(path.join(this.directory, ACTIVE_FILE), { force: true });
    await fsp.rm(this.#versions, { recursive: true, force: true });
  }

  onChange(listener: (event: NpmClosureInstallEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #finish(controller: AbortController): void {
    if (this.#running?.controller === controller) this.#running = undefined;
    this.#progress = undefined;
  }

  #emit(event: NpmClosureInstallEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // 监听器里的错误不影响别的监听器。
      }
    }
  }

  async #install(signal: AbortSignal): Promise<NpmClosureInstallation> {
    const { label, main, packages } = this.#options;
    if (packages === undefined) {
      throw new NpmInstallError(
        'resolve',
        `The ${label} has no build for ${process.platform}-${process.arch}.`,
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
            path.join(staging, 'node_modules', ...main.name.split('/'), 'package.json'),
            'utf8',
          ),
        ) as { version?: unknown };
        if (manifest.version !== main.version) {
          throw new NpmInstallError('verify', `The downloaded ${label} has the wrong version.`);
        }
        if (signal.aborted) throw signal.reason;
        const destination = path.join(this.#versions, main.version);
        await fsp.rm(destination, { recursive: true, force: true });
        await fsp.rename(staging, destination);
      } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
      await this.#activate(main.version);
      await this.#removeOtherVersions(main.version);
      return { root: path.join(this.#versions, main.version), version: main.version };
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason instanceof NpmInstallCancelled
          ? signal.reason
          : new NpmInstallCancelled('Installation cancelled.');
      }
      if (error instanceof NpmInstallError) throw error;
      throw new NpmInstallError(
        'install',
        `Could not install the ${label}. Check free disk space and directory access, then try again.`,
        { cause: error },
      );
    }
  }

  /** 同时问每个 registry 有没有主包的这个版本，先答的排前面；都答不了时报错。 */
  async #rankRegistries(signal: AbortSignal): Promise<string[]> {
    const { main } = this.#options;
    const registries = this.#options.registries ?? npmRegistries();
    const ranked: string[] = [];
    const lookups = registries.map(async (registry) => {
      const response = await (this.#options.fetch ?? fetch)(
        `${registry}/${encodeName(main.name)}/${main.version}`,
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
    entry: NpmClosurePackage,
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
    entry: NpmClosurePackage,
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
    const { label, requiredSpace } = this.#options;
    const available = await fsp
      .statfs(this.#versions, { bigint: true })
      .then((stats) => stats.bavail * stats.bsize)
      .catch(() => undefined);
    if (available !== undefined && available < BigInt(requiredSpace)) {
      throw new NpmInstallError(
        'download',
        `The ${label} needs at least ${Math.ceil(requiredSpace / 1024 / 1024)} MiB of free space to install.`,
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
