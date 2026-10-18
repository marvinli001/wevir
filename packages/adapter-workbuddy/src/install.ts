// SPDX-License-Identifier: MIT
// 替用户装 CodeBuddy（设置 → 模型服务 → 订阅，domain-model §3.6 的 `account.install`）。腾讯发布了不依赖 Node 的独立版本，
// 官方的 install.sh / install.ps1 从同一个 COS 地址取：`latest` 是纯文本的版本号，`download/<版本>/checksums.txt` 是 sha256
// 清单，`download/<版本>/codebuddy-code_<系统>_<架构>.tar.gz`（Windows 是 .zip）里是一个原生程序 `codebuddy` 加它旁边的
// `vendor/`（沙箱工具等）。npm 包要 Node 与一整棵依赖树，不用。这里照官方脚本做：取版本和清单，下载压缩包并核对 sha256，用
// 系统的 `tar`（macOS、Linux 自带；Windows 10 起的 `System32\tar.exe` 也解 zip）解到临时目录，启动它核对能跑，最后原子地写下
// 指针才算装好。不运行官方脚本最后那步 `codebuddy install`（它把程序装到 ~/.local/bin 并改 PATH）。
//
// 目录（`directory` 下）：versions/<版本>/ 是装好的一个版本（整个压缩包的内容），active.json 是指向它的指针；下载与解包都在
// versions/.install-* 里进行，失败或取消不影响已装的版本。`WEVIR_WORKBUDDY_RELEASE_URL` 可以换成别的地址（镜像、测试）。

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/** 换掉官方下载地址的环境变量（`latest` 与 `download/` 所在的目录，不带末尾的 `/`）。 */
export const WORKBUDDY_RELEASE_URL_ENV = 'WEVIR_WORKBUDDY_RELEASE_URL';
export const WORKBUDDY_RELEASE_URL =
  'https://acc-1258344699.cos.accelerate.myqcloud.com/@tencent-ai/codebuddy-code/releases';

const LATEST_TIMEOUT_MS = 15_000;
/** 多久收不到数据算下载卡住。 */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const VALIDATION_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 5 * 60_000;
const PROGRESS_INTERVAL_MS = 250;
/** 压缩包 70–85 MB，解开后约 180–250 MB，再留点余量。 */
const REQUIRED_FREE_SPACE = 640 * 1024 * 1024;
const ACTIVE_FILE = 'active.json';
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u;

export function workbuddyReleaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env[WORKBUDDY_RELEASE_URL_ENV]?.trim().replace(/\/+$/u, '');
  return custom ? custom : WORKBUDDY_RELEASE_URL;
}

/** 本平台要下载的压缩包。 */
export interface WorkBuddyArchive {
  /** 文件名，如 `codebuddy-code_Darwin_arm64.tar.gz`。 */
  name: string;
  format: 'tar.gz' | 'zip';
  /** 压缩包根目录里的可执行文件名（Windows 带 `.exe`）。 */
  fileName: string;
}

/** 是不是 musl 的 Linux（Alpine 等）：glibc 的 Node 在诊断报告里有 `glibcVersionRuntime`，musl 的没有。 */
function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return report?.header?.glibcVersionRuntime === undefined;
}

/**
 * 官方发布的压缩包：Darwin 与 Linux 是 arm64 / x86_64（Linux 另有 musl 版），Windows 只有 x86_64。本平台没有时 undefined。
 */
export function workbuddyArchive(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = isMusl(),
): WorkBuddyArchive | undefined {
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x86_64' : undefined;
  if (cpu === undefined) return undefined;
  if (platform === 'darwin') {
    return { name: `codebuddy-code_Darwin_${cpu}.tar.gz`, format: 'tar.gz', fileName: 'codebuddy' };
  }
  if (platform === 'linux') {
    return {
      name: `codebuddy-code_Linux_${cpu}${musl ? '_musl' : ''}.tar.gz`,
      format: 'tar.gz',
      fileName: 'codebuddy',
    };
  }
  if (platform === 'win32' && cpu === 'x86_64') {
    return { name: 'codebuddy-code_Windows_x86_64.zip', format: 'zip', fileName: 'codebuddy.exe' };
  }
  return undefined;
}

export interface WorkBuddyInstallProgress {
  phase: 'resolving' | 'downloading' | 'extracting' | 'verifying';
  /** 已收到的压缩包字节数。 */
  completedBytes: number;
  /** 压缩包的总字节数；服务器没给时省略。 */
  totalBytes?: number;
}

/** 装好的程序。 */
export interface ManagedWorkBuddy {
  path: string;
  version: string;
}

/** 安装失败。`message` 给人看（进账号状态的 `lastError`），`cause` 是原始错误。 */
export class WorkBuddyInstallError extends Error {
  override readonly name = 'WorkBuddyInstallError';
  readonly operation: 'resolve' | 'download' | 'verify' | 'install';
  constructor(
    operation: WorkBuddyInstallError['operation'],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.operation = operation;
  }
}

/** 安装被取消（`cancel` 或 dispose）。 */
export class WorkBuddyInstallCancelled extends Error {
  override readonly name = 'WorkBuddyInstallCancelled';
}

export interface WorkBuddyInstallerOptions {
  /** 安装根目录（`<数据目录>/engines/workbuddy/runtime`），不存在时建。 */
  directory: string;
  archive: WorkBuddyArchive;
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

/** 系统的 tar：Windows 用 System32 里的 bsdtar（也解 zip），别处用 PATH 上的。 */
function tarCommand(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  }
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

export class WorkBuddyInstaller {
  readonly directory: string;
  readonly archive: WorkBuddyArchive;
  readonly #options: WorkBuddyInstallerOptions;
  readonly #versions: string;
  #running: { controller: AbortController; done: Promise<ManagedWorkBuddy> } | undefined;

  constructor(options: WorkBuddyInstallerOptions) {
    this.#options = options;
    this.directory = options.directory;
    this.archive = options.archive;
    this.#versions = path.join(options.directory, 'versions');
  }

  get installing(): boolean {
    return this.#running !== undefined;
  }

  /** 已装好的程序：指针指向的版本，文件不在时 undefined。 */
  async active(): Promise<ManagedWorkBuddy | undefined> {
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
   * `WorkBuddyInstallError`，取消抛 `WorkBuddyInstallCancelled`；已装的版本不受影响。
   */
  install(onProgress: (progress: WorkBuddyInstallProgress) => void): Promise<ManagedWorkBuddy> {
    if (this.#running !== undefined) return this.#running.done;
    const controller = new AbortController();
    const done = this.#install(onProgress, controller.signal).finally(() => {
      if (this.#running?.controller === controller) this.#running = undefined;
    });
    this.#running = { controller, done };
    return done;
  }

  cancel(): void {
    this.#running?.controller.abort(new WorkBuddyInstallCancelled('Installation cancelled.'));
  }

  async #install(
    onProgress: (progress: WorkBuddyInstallProgress) => void,
    signal: AbortSignal,
  ): Promise<ManagedWorkBuddy> {
    const { archive } = this;
    const base = this.#options.releaseUrl ?? workbuddyReleaseUrl();
    try {
      onProgress({ phase: 'resolving', completedBytes: 0 });
      await fsp.mkdir(this.#versions, { recursive: true });
      await this.#removeStaleStaging();

      const { version, sha256 } = await this.#lookup(base, signal);
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
        const file = path.join(staging, archive.name);
        await this.#download(`${base}/download/${version}/${archive.name}`, file, sha256, {
          onProgress,
          signal,
        });
        onProgress({ phase: 'extracting', completedBytes: 0 });
        const files = path.join(staging, 'files');
        try {
          await (this.#options.extract ?? extractWithTar)(file, files, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          throw new WorkBuddyInstallError(
            'install',
            `Could not unpack the downloaded CodeBuddy: ${reasonOf(error)}`,
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
          throw new WorkBuddyInstallError(
            'verify',
            `${archive.name} does not contain ${archive.fileName}.`,
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
        throw signal.reason instanceof WorkBuddyInstallCancelled
          ? signal.reason
          : new WorkBuddyInstallCancelled('Installation cancelled.');
      }
      if (error instanceof WorkBuddyInstallError) throw error;
      throw new WorkBuddyInstallError(
        'install',
        'Could not install CodeBuddy. Check free disk space and directory access, then try again.',
        { cause: error },
      );
    }
  }

  /** 官方现在的最新版本，以及这个压缩包在清单里的 sha256。 */
  async #lookup(base: string, signal: AbortSignal): Promise<{ version: string; sha256: string }> {
    const get = async (url: string): Promise<string> => {
      const response = await (this.#options.fetch ?? fetch)(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(LATEST_TIMEOUT_MS)]),
      });
      if (!response.ok) throw new Error(`${hostOf(url)} answered ${response.status}`);
      return response.text();
    };
    try {
      const version = (await get(`${base}/latest`)).trim();
      if (!VERSION.test(version)) throw new Error(`${hostOf(base)} returned an unusable version`);
      const checksums = await get(`${base}/download/${version}/checksums.txt`);
      for (const line of checksums.split(/\r?\n/u)) {
        const [digest, name] = line.trim().split(/\s+/u);
        if (name === this.archive.name && /^[0-9a-f]{64}$/iu.test(digest ?? '')) {
          return { version, sha256: (digest as string).toLowerCase() };
        }
      }
      throw new Error(`${this.archive.name} is not in the release checksums`);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new WorkBuddyInstallError(
        'resolve',
        `Could not reach the CodeBuddy download (${hostOf(base)}): ${reasonOf(error)}. Check your network or proxy, or set a custom executable path. ${WORKBUDDY_RELEASE_URL_ENV} can point to another location.`,
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
      throw new WorkBuddyInstallError(
        'download',
        `CodeBuddy needs at least ${REQUIRED_FREE_SPACE / 1024 / 1024} MiB of free space to install.`,
      );
    }
  }

  /** 下载压缩包到 `file`，边下边算 sha256，和清单里的比。 */
  async #download(
    url: string,
    file: string,
    expected: string,
    context: { onProgress: (progress: WorkBuddyInstallProgress) => void; signal: AbortSignal },
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
        throw new WorkBuddyInstallError(
          'verify',
          'The downloaded CodeBuddy did not match the checksum from the release. Try again.',
        );
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof WorkBuddyInstallError) throw error;
      throw new WorkBuddyInstallError(
        'download',
        `Could not download CodeBuddy from ${hostOf(url)}: ${reasonOf(idle.signal.aborted ? idle.signal.reason : error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #validate(executable: ManagedWorkBuddy, signal: AbortSignal): Promise<void> {
    const validate = this.#options.validate;
    if (validate === undefined) return;
    const timeout = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
    try {
      await validate(executable.path, executable.version, AbortSignal.any([signal, timeout]));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new WorkBuddyInstallError(
        'verify',
        `The downloaded CodeBuddy ${executable.version} did not run: ${reasonOf(error)}`,
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
