// SPDX-License-Identifier: MIT
// 替用户装 Kiro CLI（设置 → 模型服务 → 订阅，domain-model §3.6 的 `account.install`）。官方的 install.sh 与 install.ps1 读同一份
// 清单：`<根>/stable/latest/manifest.json` 是 `{ version, packages: [{ os, architecture, variant, fileType, targetTriple, download,
// sha256, size }] }`，`download` 是相对 `<根>/stable/` 的路径。macOS 用不分架构的 `standalone` 压缩包，Linux 用 `headless` 的
// gnu 或 musl 压缩包（glibc 太旧或没有时用 musl，同官方脚本：x86_64 要 2.34，aarch64 要 2.39），包里是 `kirocli/bin/kiro-cli`。
// Windows 只发 MSI，不替用户装。这里照官方脚本做：取清单，下载本平台的压缩包并核对 sha256，用系统的 `tar` 解到临时目录，启动
// 它核对能跑，最后原子地写下指针才算装好。不运行包里的 install.sh（它装进 ~/.local/bin、改 shell 配置），不改 PATH。
//
// 目录（`directory` 下）：versions/<版本>/ 是装好的一个版本（整个压缩包的内容），active.json 是指向它的指针；下载与解包都在
// versions/.install-* 里进行，失败或取消不影响已装的版本。`WEVIR_KIRO_RELEASE_URL` 可以换成别的地址（镜像、测试）。

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/** 换掉官方下载地址的环境变量（发布频道的根，即 `latest/manifest.json` 所在目录的上一级，不带末尾的 `/`）。 */
export const KIRO_RELEASE_URL_ENV = 'WEVIR_KIRO_RELEASE_URL';
export const KIRO_RELEASE_URL = 'https://prod.download.cli.kiro.dev/stable';

const MANIFEST_TIMEOUT_MS = 15_000;
/** 多久收不到数据算下载卡住。 */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const VALIDATION_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 5 * 60_000;
const PROGRESS_INTERVAL_MS = 250;
/** 2.36.0 的压缩包约 160–260 MB，解开后约 420 MB，再留点余量。 */
const REQUIRED_FREE_SPACE = 1024 * 1024 * 1024;
const ACTIVE_FILE = 'active.json';
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u;

export function kiroReleaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env[KIRO_RELEASE_URL_ENV]?.trim().replace(/\/+$/u, '');
  return custom ? custom : KIRO_RELEASE_URL;
}

/** 本平台要下载的压缩包：清单里按这几项挑。 */
export interface KiroArchive {
  /** 清单的 `os`（`macos` / `linux`）。 */
  os: 'macos' | 'linux';
  /** 清单的 `architecture`（`universal` / `x86_64` / `aarch64`）。 */
  architecture: string;
  /** 清单的 `variant`（macOS 是 `standalone`，Linux 是 `headless`）。 */
  variant: string;
  /** 清单的 `targetTriple`（Linux 区分 gnu 与 musl）。 */
  targetTriple: string;
  format: 'tar.gz';
  /** 压缩包里可执行文件的相对路径。 */
  fileName: string;
}

/** Linux 的 gnu 构建要的最低 glibc（官方 install.sh 的 GLIBC_*_MIN_MINOR）。 */
const GLIBC_MIN: Readonly<Record<string, number>> = { x86_64: 34, aarch64: 39 };

/** 本机的 glibc 版本（`2.39` → 39）；musl 或读不到时 undefined。 */
export function glibcMinor(): number | undefined {
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  const version = report?.header?.glibcVersionRuntime;
  const match = typeof version === 'string' ? /^2\.(\d+)/u.exec(version) : null;
  return match === null ? undefined : Number(match[1]);
}

/**
 * 官方发布的平台：macOS（不分架构）与 Linux 的 x86_64 / aarch64。Windows 只有 MSI，返回 undefined。
 */
export function kiroArchive(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  glibc: () => number | undefined = glibcMinor,
): KiroArchive | undefined {
  const fileName = 'kirocli/bin/kiro-cli';
  if (platform === 'darwin') {
    return {
      os: 'macos',
      architecture: 'universal',
      variant: 'standalone',
      targetTriple: 'universal-apple-darwin',
      format: 'tar.gz',
      fileName,
    };
  }
  if (platform !== 'linux') return undefined;
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;
  if (cpu === undefined) return undefined;
  const minor = glibc();
  const musl = minor === undefined || minor < (GLIBC_MIN[cpu] as number);
  return {
    os: 'linux',
    architecture: cpu,
    variant: 'headless',
    targetTriple: `${cpu}-unknown-linux-${musl ? 'musl' : 'gnu'}`,
    format: 'tar.gz',
    fileName,
  };
}

export interface KiroInstallProgress {
  phase: 'resolving' | 'downloading' | 'extracting' | 'verifying';
  /** 已收到的压缩包字节数。 */
  completedBytes: number;
  /** 压缩包的总字节数；服务器没给时省略。 */
  totalBytes?: number;
}

/** 装好的程序。 */
export interface ManagedKiro {
  path: string;
  version: string;
}

/** 安装失败。`message` 给人看（进账号状态的 `lastError`），`cause` 是原始错误。 */
export class KiroInstallError extends Error {
  override readonly name = 'KiroInstallError';
  readonly operation: 'resolve' | 'download' | 'verify' | 'install';
  constructor(
    operation: KiroInstallError['operation'],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.operation = operation;
  }
}

/** 安装被取消（`cancel` 或 dispose）。 */
export class KiroInstallCancelled extends Error {
  override readonly name = 'KiroInstallCancelled';
}

export interface KiroInstallerOptions {
  /** 安装根目录（`<数据目录>/engines/kiro/runtime`），不存在时建。 */
  directory: string;
  archive: KiroArchive;
  /** 下载地址的根；省略时按环境变量。 */
  releaseUrl?: string;
  /** 启动解出的程序并核对能跑；抛错即校验失败。 */
  validate?: (file: string, version: string, signal: AbortSignal) => Promise<void>;
  /** 测试用：替换解包（默认用系统的 tar）。 */
  extract?: (archive: string, destination: string, signal: AbortSignal) => Promise<void>;
  fetch?: typeof fetch;
  idleTimeoutMs?: number;
  progressIntervalMs?: number;
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

/** 系统的 tar：macOS、Linux 自带。 */
function tarCommand(): string {
  return existsSync('/usr/bin/tar') ? '/usr/bin/tar' : 'tar';
}

function runTar(args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      tarCommand(),
      args,
      {
        timeout: EXTRACT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        signal,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = String(stderr).trim().split(/\r?\n/u).slice(-2).join(' ');
          reject(new Error(detail === '' ? error.message : detail, { cause: error }));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/** 条目名不能是绝对路径、带盘符或含 `..`：先列出来看，再解。 */
function unsafeEntry(entry: string): boolean {
  const name = entry.replace(/\\/gu, '/');
  return name.startsWith('/') || /^[A-Za-z]:/u.test(name) || name.split('/').includes('..');
}

async function extractWithTar(
  archive: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  const listing = (await runTar(['-tf', archive], signal)).split(/\r?\n/u).filter((l) => l !== '');
  const bad = listing.find(unsafeEntry);
  if (bad !== undefined) throw new Error(`the archive contains an unsafe path (${bad})`);
  await fsp.mkdir(destination, { recursive: true });
  await runTar(['-xf', archive, '-C', destination], signal);
}

export class KiroInstaller {
  readonly directory: string;
  readonly archive: KiroArchive;
  readonly #options: KiroInstallerOptions;
  readonly #versions: string;
  #running: { controller: AbortController; done: Promise<ManagedKiro> } | undefined;

  constructor(options: KiroInstallerOptions) {
    this.#options = options;
    this.directory = options.directory;
    this.archive = options.archive;
    this.#versions = path.join(options.directory, 'versions');
  }

  get installing(): boolean {
    return this.#running !== undefined;
  }

  /** 已装好的程序：指针指向的版本，文件不在时 undefined。 */
  async active(): Promise<ManagedKiro | undefined> {
    let version: unknown;
    try {
      const raw = await fsp.readFile(path.join(this.directory, ACTIVE_FILE), 'utf8');
      version = (JSON.parse(raw) as { version?: unknown }).version;
    } catch {
      return undefined;
    }
    if (typeof version !== 'string' || !VERSION.test(version)) return undefined;
    const file = path.join(this.#versions, version, this.archive.fileName);
    try {
      await fsp.access(
        file,
        process.platform === 'win32' ? fsp.constants.F_OK : fsp.constants.X_OK,
      );
    } catch {
      return undefined;
    }
    return { path: file, version };
  }

  /**
   * 装官方现在的最新版（已经是最新的就只是核对一遍）。同一时刻只有一次安装，进行中时返回同一个 Promise。失败抛
   * `KiroInstallError`，取消抛 `KiroInstallCancelled`；已装的版本不受影响。
   */
  install(onProgress: (progress: KiroInstallProgress) => void): Promise<ManagedKiro> {
    if (this.#running !== undefined) return this.#running.done;
    const controller = new AbortController();
    const done = this.#install(onProgress, controller.signal).finally(() => {
      if (this.#running?.controller === controller) this.#running = undefined;
    });
    this.#running = { controller, done };
    return done;
  }

  cancel(): void {
    this.#running?.controller.abort(new KiroInstallCancelled('Installation cancelled.'));
  }

  async #install(
    onProgress: (progress: KiroInstallProgress) => void,
    signal: AbortSignal,
  ): Promise<ManagedKiro> {
    const { archive } = this;
    const base = this.#options.releaseUrl ?? kiroReleaseUrl();
    try {
      onProgress({ phase: 'resolving', completedBytes: 0 });
      await fsp.mkdir(this.#versions, { recursive: true });
      await this.#removeStaleStaging();

      const { version, url, sha256 } = await this.#lookup(base, signal);
      const existing = path.join(this.#versions, version, archive.fileName);
      if (
        await fsp.stat(existing).then(
          (stats) => stats.isFile(),
          () => false,
        )
      ) {
        const installed = { path: existing, version };
        try {
          onProgress({ phase: 'verifying', completedBytes: 0 });
          await this.#validate(installed, signal);
          await this.#activate(version);
          return installed;
        } catch (error) {
          if (signal.aborted) throw error;
          // 装好的这一份坏了：重新下载换掉它。
          await fsp.rm(path.join(this.#versions, version), { recursive: true, force: true });
        }
      }

      await this.#checkSpace();
      const staging = await fsp.mkdtemp(path.join(this.#versions, '.install-'));
      try {
        const file = path.join(staging, `bundle.${archive.format}`);
        await this.#download(url, file, sha256, {
          onProgress,
          signal,
        });
        onProgress({ phase: 'extracting', completedBytes: 0 });
        const files = path.join(staging, 'files');
        try {
          await (this.#options.extract ?? extractWithTar)(file, files, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          throw new KiroInstallError(
            'install',
            `Could not unpack the downloaded Kiro CLI: ${reasonOf(error)}`,
            { cause: error },
          );
        }
        await fsp.rm(file, { force: true });
        const binary = path.join(files, archive.fileName);
        const found = await fsp.stat(binary).then(
          (stats) => stats.isFile(),
          () => false,
        );
        if (!found) {
          throw new KiroInstallError(
            'verify',
            `The Kiro CLI bundle for ${archive.targetTriple} does not contain ${archive.fileName}.`,
          );
        }
        if (process.platform !== 'win32') await fsp.chmod(binary, 0o755);
        onProgress({ phase: 'verifying', completedBytes: 0 });
        await this.#validate({ path: binary, version }, signal);
        const destination = path.join(this.#versions, version);
        await fsp.rm(destination, { recursive: true, force: true });
        await fsp.rename(files, destination);
      } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
      await this.#activate(version);
      await this.#removeOtherVersions(version);
      return { path: path.join(this.#versions, version, archive.fileName), version };
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason instanceof KiroInstallCancelled
          ? signal.reason
          : new KiroInstallCancelled('Installation cancelled.');
      }
      if (error instanceof KiroInstallError) throw error;
      throw new KiroInstallError(
        'install',
        'Could not install Kiro CLI. Check free disk space and directory access, then try again.',
        { cause: error },
      );
    }
  }

  /** 官方现在的版本，以及本平台压缩包的地址与 sha256。 */
  async #lookup(
    base: string,
    signal: AbortSignal,
  ): Promise<{ version: string; url: string; sha256: string }> {
    const url = `${base}/latest/manifest.json`;
    const { archive } = this;
    try {
      const response = await (this.#options.fetch ?? fetch)(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(MANIFEST_TIMEOUT_MS)]),
      });
      if (!response.ok) throw new Error(`${hostOf(url)} answered ${response.status}`);
      const manifest = (await response.json()) as { version?: unknown; packages?: unknown };
      const version = manifest.version;
      if (typeof version !== 'string' || !VERSION.test(version)) {
        throw new Error(`${hostOf(url)} returned an unusable version`);
      }
      const entry = (Array.isArray(manifest.packages) ? manifest.packages : [])
        .filter(
          (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
        )
        .find(
          (item) =>
            item.os === archive.os &&
            item.architecture === archive.architecture &&
            item.variant === archive.variant &&
            item.targetTriple === archive.targetTriple &&
            item.fileType === 'tarGz',
        );
      const download = typeof entry?.download === 'string' ? entry.download : undefined;
      const sha256 = typeof entry?.sha256 === 'string' ? entry.sha256 : undefined;
      if (
        download === undefined ||
        download.startsWith('/') ||
        download.split('/').includes('..') ||
        /^[a-z]+:/iu.test(download)
      ) {
        throw new Error(`the manifest has no bundle for ${archive.targetTriple}`);
      }
      if (sha256 === undefined || !/^[0-9a-f]{64}$/iu.test(sha256)) {
        throw new Error(`the manifest has no checksum for ${archive.targetTriple}`);
      }
      const bundle = `${base}/${download.split('/').map(encodeURIComponent).join('/')}`;
      return { version, url: bundle, sha256: sha256.toLowerCase() };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new KiroInstallError(
        'resolve',
        `Could not reach the Kiro CLI download (${hostOf(base)}): ${reasonOf(error)}. Check your network or proxy, or set a custom executable path. ${KIRO_RELEASE_URL_ENV} can point to another location.`,
        { cause: error },
      );
    }
  }

  async #checkSpace(): Promise<void> {
    const available = await fsp
      .statfs(this.#versions, { bigint: true })
      .then((stats) => stats.bavail * stats.bsize)
      .catch(() => undefined);
    if (available !== undefined && available < BigInt(REQUIRED_FREE_SPACE)) {
      throw new KiroInstallError(
        'download',
        `Kiro CLI needs at least ${REQUIRED_FREE_SPACE / 1024 / 1024} MiB of free space to install.`,
      );
    }
  }

  /** 下载压缩包到 `file`，边下边算 sha256，和清单里的比。 */
  async #download(
    url: string,
    file: string,
    expected: string,
    context: { onProgress: (progress: KiroInstallProgress) => void; signal: AbortSignal },
  ): Promise<void> {
    const { onProgress, signal } = context;
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
    try {
      arm();
      const response = await (this.#options.fetch ?? fetch)(url, {
        headers: { 'Accept-Encoding': 'identity' },
        signal: AbortSignal.any([signal, idle.signal]),
      });
      if (!response.ok || response.body === null) {
        throw new Error(`${hostOf(url)} answered ${response.status}`);
      }
      const total = Number(response.headers.get('content-length'));
      const totalBytes = Number.isFinite(total) && total > 0 ? total : undefined;
      const hash = createHash('sha256');
      let received = 0;
      let reportedAt = 0;
      const interval = this.#options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
      const report = (force: boolean) => {
        const now = Date.now();
        if (!force && now - reportedAt < interval) return;
        reportedAt = now;
        onProgress({
          phase: 'downloading',
          completedBytes: received,
          ...(totalBytes !== undefined && { totalBytes }),
        });
      };
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          received += chunk.length;
          arm();
          report(false);
          callback(null, chunk);
        },
      });
      report(true);
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream),
        counter,
        createWriteStream(file, { mode: 0o600 }),
        { signal: AbortSignal.any([signal, idle.signal]) },
      );
      report(true);
      if (hash.digest('hex') !== expected) {
        throw new KiroInstallError(
          'verify',
          'The downloaded Kiro CLI did not match the checksum from the release. Try again.',
        );
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof KiroInstallError) throw error;
      throw new KiroInstallError(
        'download',
        `Could not download Kiro CLI from ${hostOf(url)}: ${reasonOf(idle.signal.aborted ? idle.signal.reason : error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #validate(executable: ManagedKiro, signal: AbortSignal): Promise<void> {
    const validate = this.#options.validate;
    if (validate === undefined) return;
    const timeout = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
    try {
      await validate(executable.path, executable.version, AbortSignal.any([signal, timeout]));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new KiroInstallError(
        'verify',
        `The downloaded Kiro CLI ${executable.version} did not run: ${reasonOf(error)}`,
        { cause: error },
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

  /** 新版本启用后删掉别的版本（Windows 上还有进程在用的删不掉，忽略）。 */
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
