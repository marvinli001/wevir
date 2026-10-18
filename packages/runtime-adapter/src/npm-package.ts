// SPDX-License-Identifier: MIT
// 订阅引擎的运行体由 Wevir 替用户装（设置 → 模型服务 → 订阅，domain-model §3.6 的 `account.install`），不再让用户去终端里
// `npm install -g`。这些引擎（Claude、Grok、OpenCode…）都把各平台的原生程序发布成 npm 的平台包（`optionalDependencies` 里的
// `<包>-<系统>-<架构>`，tgz 里只有一个程序文件），所以这里不需要 npm：直接从 registry 取这个包的元数据与 tgz，核对 registry
// 给的 sha512，把要的那一个文件流式解出来放进数据目录，启动它核对能跑，最后原子地写下指针才算装好。
//
// 目录（`directory` 下）：versions/<版本>/<程序文件> 是装好的一个版本，active.json 是指向它的指针；下载与解出都在
// versions/.install-* 里进行，失败或取消不影响已装的版本。registry 默认并行问 registry.npmjs.org 与 registry.npmmirror.com，
// 先答的先用，下载失败再换另一个；`WEVIR_NPM_REGISTRY`（逗号分隔）可以换成别的。

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import zlib from 'node:zlib';

/** 换掉默认 registry 的环境变量，逗号分隔，按顺序是优先级（元数据谁先答用谁，下载失败换下一个）。 */
export const NPM_REGISTRY_ENV = 'WEVIR_NPM_REGISTRY';
export const DEFAULT_NPM_REGISTRIES: readonly string[] = Object.freeze([
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
]);

/** 用到的 registry 列表：`WEVIR_NPM_REGISTRY` 有值时用它，否则是默认两个。 */
export function npmRegistries(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = (env[NPM_REGISTRY_ENV] ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/u, ''))
    .filter((entry) => entry !== '');
  return fromEnv.length > 0 ? fromEnv : [...DEFAULT_NPM_REGISTRIES];
}

const METADATA_TIMEOUT_MS = 15_000;
/** 多久收不到数据算下载卡住。 */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const VALIDATION_TIMEOUT_MS = 60_000;
const PROGRESS_INTERVAL_MS = 250;
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;
const ACTIVE_FILE = 'active.json';

/** 装哪个包里的哪个文件。 */
export interface NpmPackageSpec {
  /** 平台包名，如 `@anthropic-ai/claude-code-darwin-arm64`。 */
  packageName: string;
  /** tgz 里要取的文件（相对包根，npm 包的顶层目录 `package/` 不写），如 `claude`、`bin/opencode`。 */
  entry: string;
  /** 装好后的文件名（可执行文件名，Windows 带 `.exe`）。 */
  fileName: string;
  /** `brotli`：包里存的是 brotli 压缩过的程序（Grok 的 `grok.br`），落盘前解开。 */
  decode?: 'brotli';
}

export interface NpmInstallProgress {
  phase: 'resolving' | 'downloading' | 'verifying';
  /** 已收到的 tgz 字节数。 */
  completedBytes: number;
  /** tgz 的总字节数；服务器没给时省略。 */
  totalBytes?: number;
}

/** 装好的程序。 */
export interface ManagedExecutable {
  path: string;
  version: string;
}

/** 安装失败。`message` 给人看（进账号状态的 `lastError`），`cause` 是原始错误。 */
export class NpmInstallError extends Error {
  override readonly name = 'NpmInstallError';
  readonly operation: 'resolve' | 'download' | 'verify' | 'install';
  constructor(
    operation: NpmInstallError['operation'],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.operation = operation;
  }
}

/** 安装被取消（`cancel` 或 dispose）。 */
export class NpmInstallCancelled extends Error {
  override readonly name = 'NpmInstallCancelled';
}

export interface NpmPackageInstallerOptions {
  /** 安装根目录（如 `<数据目录>/engines/claude/runtime`），不存在时建。 */
  directory: string;
  spec: NpmPackageSpec;
  registries?: readonly string[];
  /** 启动解出的程序并核对能跑；抛错即校验失败。 */
  validate?: (file: string, version: string, signal: AbortSignal) => Promise<void>;
  fetch?: typeof fetch;
  idleTimeoutMs?: number;
  progressIntervalMs?: number;
}

interface Resolved {
  registry: string;
  version: string;
  tarball: string;
  integrity: string;
  unpackedSize: number | undefined;
}

function integrityOf(integrity: string): { algorithm: string; digest: string } | undefined {
  for (const algorithm of ['sha512', 'sha384', 'sha256']) {
    for (const entry of integrity.split(/\s+/u)) {
      if (entry.startsWith(`${algorithm}-`)) {
        return { algorithm, digest: entry.slice(algorithm.length + 1).split('?')[0] ?? '' };
      }
    }
  }
  return undefined;
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

export class NpmPackageInstaller {
  readonly directory: string;
  readonly spec: NpmPackageSpec;
  readonly #options: NpmPackageInstallerOptions;
  readonly #versions: string;
  #running: { controller: AbortController; done: Promise<ManagedExecutable> } | undefined;

  constructor(options: NpmPackageInstallerOptions) {
    this.#options = options;
    this.directory = options.directory;
    this.spec = options.spec;
    this.#versions = path.join(options.directory, 'versions');
  }

  get installing(): boolean {
    return this.#running !== undefined;
  }

  /** 已装好的程序：指针指向的版本，文件不在时 undefined。 */
  async active(): Promise<ManagedExecutable | undefined> {
    let version: unknown;
    try {
      const raw = await fsp.readFile(path.join(this.directory, ACTIVE_FILE), 'utf8');
      version = (JSON.parse(raw) as { version?: unknown }).version;
    } catch {
      return undefined;
    }
    if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(version)) {
      return undefined;
    }
    const file = path.join(this.#versions, version, this.spec.fileName);
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
   * 装 registry 上最新的版本（已经是最新的就只是核对一遍）。同一时刻只有一次安装，进行中时返回同一个 Promise。失败抛
   * `NpmInstallError`，取消抛 `NpmInstallCancelled`；已装的版本不受影响。
   */
  install(onProgress: (progress: NpmInstallProgress) => void): Promise<ManagedExecutable> {
    if (this.#running !== undefined) return this.#running.done;
    const controller = new AbortController();
    const done = this.#install(onProgress, controller.signal).finally(() => {
      if (this.#running?.controller === controller) this.#running = undefined;
    });
    this.#running = { controller, done };
    return done;
  }

  cancel(): void {
    this.#running?.controller.abort(new NpmInstallCancelled('Installation cancelled.'));
  }

  async #install(
    onProgress: (progress: NpmInstallProgress) => void,
    signal: AbortSignal,
  ): Promise<ManagedExecutable> {
    const name = this.spec.fileName.replace(/\.exe$/u, '');
    try {
      onProgress({ phase: 'resolving', completedBytes: 0 });
      await fsp.mkdir(this.#versions, { recursive: true });
      await this.#removeStaleStaging();

      const registries = this.#options.registries ?? npmRegistries();
      const lookups = registries.map((registry) => this.#lookup(registry, signal));
      for (const lookup of lookups) lookup.catch(() => {});
      let first: Resolved;
      try {
        first = await Promise.any(lookups);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw new NpmInstallError(
          'resolve',
          `Could not reach the npm registry (${registries.map(hostOf).join(', ')}). Check your network or proxy, or set a custom executable path. ${NPM_REGISTRY_ENV} can point to another registry.`,
          { cause: error },
        );
      }

      const existing = path.join(this.#versions, first.version, this.spec.fileName);
      if (
        await fsp.stat(existing).then(
          (stats) => stats.isFile(),
          () => false,
        )
      ) {
        const installed = { path: existing, version: first.version };
        try {
          onProgress({ phase: 'verifying', completedBytes: 0 });
          await this.#validate(installed, signal);
          await this.#activate(first.version);
          return installed;
        } catch (error) {
          if (signal.aborted) throw error;
          // 装好的这一份坏了：重新下载换掉它。
          await fsp.rm(path.join(this.#versions, first.version), { recursive: true, force: true });
        }
      }

      await this.#checkSpace(first);
      let candidates: Resolved[] = [first];
      let failure: unknown;
      let staged: { staging: string; file: string } | undefined;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index] as Resolved;
        try {
          staged = await this.#downloadAndExtract(candidate, onProgress, signal);
          break;
        } catch (error) {
          if (signal.aborted) throw error;
          failure = error;
          // 第一个 registry 下载失败：等其余的元数据答完，同一个版本换着试。
          if (index === 0 && candidates.length === 1) {
            const settled = await Promise.allSettled(lookups);
            candidates = [
              first,
              ...settled.flatMap((result) =>
                result.status === 'fulfilled' &&
                result.value.registry !== first.registry &&
                result.value.version === first.version
                  ? [result.value]
                  : [],
              ),
            ];
          }
        }
      }
      if (staged === undefined) {
        throw failure instanceof NpmInstallError
          ? failure
          : new NpmInstallError('download', `Could not download ${name}: ${reasonOf(failure)}`, {
              cause: failure,
            });
      }

      const { staging, file } = staged;
      try {
        onProgress({ phase: 'verifying', completedBytes: 0 });
        await this.#validate({ path: file, version: first.version }, signal);
        const destination = path.join(this.#versions, first.version);
        await fsp.rm(destination, { recursive: true, force: true });
        await fsp.rename(staging, destination);
      } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
      await this.#activate(first.version);
      await this.#removeOtherVersions(first.version);
      return {
        path: path.join(this.#versions, first.version, this.spec.fileName),
        version: first.version,
      };
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason instanceof NpmInstallCancelled
          ? signal.reason
          : new NpmInstallCancelled('Installation cancelled.');
      }
      if (error instanceof NpmInstallError) throw error;
      throw new NpmInstallError(
        'install',
        `Could not install ${name}. Check free disk space and directory access, then try again.`,
        { cause: error },
      );
    }
  }

  /** 问一个 registry 这个包最新的版本、tgz 地址与校验和。 */
  async #lookup(registry: string, signal: AbortSignal): Promise<Resolved> {
    const url = `${registry}/${this.spec.packageName.replace('/', '%2F')}/latest`;
    const response = await (this.#options.fetch ?? fetch)(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(METADATA_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`${hostOf(registry)} answered ${response.status}`);
    const body = (await response.json()) as {
      version?: unknown;
      dist?: { tarball?: unknown; integrity?: unknown; unpackedSize?: unknown };
    };
    const { version, dist } = body;
    if (
      typeof version !== 'string' ||
      !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(version) ||
      typeof dist?.tarball !== 'string' ||
      typeof dist.integrity !== 'string' ||
      integrityOf(dist.integrity) === undefined
    ) {
      throw new Error(`${hostOf(registry)} returned an unusable package description`);
    }
    return {
      registry,
      version,
      tarball: dist.tarball,
      integrity: dist.integrity,
      unpackedSize: typeof dist.unpackedSize === 'number' ? dist.unpackedSize : undefined,
    };
  }

  async #checkSpace(resolved: Resolved): Promise<void> {
    const required = (resolved.unpackedSize ?? 0) + FREE_SPACE_MARGIN;
    const available = await fsp
      .statfs(this.#versions, { bigint: true })
      .then((stats) => stats.bavail * stats.bsize)
      .catch(() => undefined);
    if (available !== undefined && available < BigInt(required)) {
      throw new NpmInstallError(
        'download',
        `${this.spec.fileName.replace(/\.exe$/u, '')} needs at least ${Math.ceil(required / 1024 / 1024)} MiB of free space to install.`,
      );
    }
  }

  /** 下载 tgz，边下边核对 sha512、边解出要的那个文件到 staging 目录。 */
  async #downloadAndExtract(
    resolved: Resolved,
    onProgress: (progress: NpmInstallProgress) => void,
    signal: AbortSignal,
  ): Promise<{ staging: string; file: string }> {
    const { spec } = this;
    const name = spec.fileName.replace(/\.exe$/u, '');
    const staging = await fsp.mkdtemp(path.join(this.#versions, '.install-'));
    const file = path.join(staging, spec.fileName);
    const idle = new AbortController();
    const idleMs = this.#options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => idle.abort(new Error(`no data from ${hostOf(resolved.tarball)} for ${idleMs} ms`)),
        idleMs,
      );
    };
    try {
      arm();
      const response = await (this.#options.fetch ?? fetch)(resolved.tarball, {
        headers: { 'Accept-Encoding': 'identity' },
        signal: AbortSignal.any([signal, idle.signal]),
      });
      if (!response.ok || response.body === null) {
        throw new Error(`${hostOf(resolved.tarball)} answered ${response.status}`);
      }
      const total = Number(response.headers.get('content-length'));
      const totalBytes = Number.isFinite(total) && total > 0 ? total : undefined;
      const expected = integrityOf(resolved.integrity) as { algorithm: string; digest: string };
      const hash = createHash(expected.algorithm);
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

      const sink = createWriteStream(file, { mode: 0o755 });
      const output: Writable = spec.decode === 'brotli' ? zlib.createBrotliDecompress() : sink;
      if (output !== sink) output.pipe(sink);
      const written = new Promise<void>((resolve, reject) => {
        sink.once('finish', resolve);
        sink.once('error', reject);
        output.once('error', reject);
      });
      written.catch(() => {});
      const gunzip = zlib.createGunzip();
      const decoded = pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream),
        counter,
        gunzip,
        async (source: AsyncIterable<Buffer>) => {
          const found = await extractTarEntry(source, `package/${spec.entry}`, (data) =>
            writeChunk(output, data),
          );
          if (!found) {
            throw new NpmInstallError(
              'verify',
              `${resolved.tarball.split('/').pop()} does not contain ${spec.entry}.`,
            );
          }
        },
        { signal: AbortSignal.any([signal, idle.signal]) },
      );
      try {
        await decoded;
      } catch (error) {
        output.destroy();
        sink.destroy();
        throw error;
      }
      output.end();
      await written;
      report(true);
      if (hash.digest('base64') !== expected.digest) {
        throw new NpmInstallError(
          'verify',
          `The downloaded ${name} did not match the checksum from the npm registry. Try again.`,
        );
      }
      if (process.platform !== 'win32') await fsp.chmod(file, 0o755);
      return { staging, file };
    } catch (error) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (signal.aborted) throw signal.reason;
      if (error instanceof NpmInstallError) throw error;
      throw new NpmInstallError(
        'download',
        `Could not download ${name} from ${hostOf(resolved.tarball)}: ${reasonOf(idle.signal.aborted ? idle.signal.reason : error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #validate(executable: ManagedExecutable, signal: AbortSignal): Promise<void> {
    const validate = this.#options.validate;
    if (validate === undefined) return;
    const timeout = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
    try {
      await validate(executable.path, executable.version, AbortSignal.any([signal, timeout]));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new NpmInstallError(
        'verify',
        `The downloaded ${this.spec.fileName.replace(/\.exe$/u, '')} ${executable.version} did not run: ${reasonOf(error)}`,
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

function writeChunk(target: Writable, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    target.write(data, (error) =>
      error === null || error === undefined ? resolve() : reject(error),
    );
  });
}

function octal(field: Buffer): number {
  const text = field.toString('latin1').replace(/\0.*$/su, '').trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function cString(field: Buffer): string {
  return field.toString('utf8').replace(/\0.*$/su, '');
}

/** pax 扩展头（`<长度> <键>=<值>\n` 一行一条）里的 `path`。 */
function paxPath(data: Buffer): string | undefined {
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) return undefined;
    const length = Number.parseInt(data.subarray(offset, space).toString('latin1'), 10);
    if (!Number.isFinite(length) || length <= 0) return undefined;
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    if (record.startsWith('path=')) return record.slice(5);
    offset += length;
  }
  return undefined;
}

const MAX_HEADER_DATA = 1024 * 1024;

/**
 * 从（已解压的）tar 流里取出名为 `wanted` 的普通文件，数据块交给 `write`；其余条目一律跳过，所以不会写到别处。认 ustar 的
 * prefix、pax 的 `path` 与 GNU 的长名字。读完整个流才返回（校验和要覆盖所有字节）：流里有它返回 true，没有返回 false。
 */
export async function extractTarEntry(
  source: AsyncIterable<Uint8Array>,
  wanted: string,
  write: (data: Buffer) => Promise<void>,
): Promise<boolean> {
  let buffer: Buffer = Buffer.alloc(0);
  let remaining = 0;
  let padding = 0;
  let mode: 'skip' | 'capture' | 'meta' = 'skip';
  let meta: Buffer[] = [];
  let metaKind: 'x' | 'L' | undefined;
  let pendingName: string | undefined;
  let done = false;
  let ended = false;

  for await (const chunk of source) {
    if (ended) continue;
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
    while (!ended) {
      if (remaining > 0) {
        const take = Math.min(remaining, buffer.length);
        if (take === 0) break;
        const piece = buffer.subarray(0, take);
        if (mode === 'capture') await write(Buffer.from(piece));
        else if (mode === 'meta') meta.push(Buffer.from(piece));
        buffer = buffer.subarray(take);
        remaining -= take;
        if (remaining > 0) break;
        if (mode === 'capture') done = true;
        if (mode === 'meta') {
          const data = Buffer.concat(meta);
          meta = [];
          pendingName = metaKind === 'L' ? cString(data) : paxPath(data);
        }
        mode = 'skip';
        continue;
      }
      if (padding > 0) {
        const take = Math.min(padding, buffer.length);
        if (take === 0) break;
        buffer = buffer.subarray(take);
        padding -= take;
        if (padding > 0) break;
        continue;
      }
      if (buffer.length < 512) break;
      const header = buffer.subarray(0, 512);
      buffer = buffer.subarray(512);
      if (header.every((byte) => byte === 0)) {
        ended = true;
        break;
      }
      const size = octal(header.subarray(124, 136));
      const type = String.fromCharCode(header[156] ?? 0x30);
      padding = (512 - (size % 512)) % 512;
      remaining = size;
      if (type === 'x' || type === 'L') {
        if (size > MAX_HEADER_DATA) throw new Error('tar header data is too large');
        mode = 'meta';
        metaKind = type;
        continue;
      }
      if (type === 'g') {
        mode = 'skip';
        continue;
      }
      const prefix = cString(header.subarray(345, 500));
      const own = cString(header.subarray(0, 100));
      const name = pendingName ?? (prefix === '' ? own : `${prefix}/${own}`);
      pendingName = undefined;
      mode = !done && (type === '0' || type === '\0') && name === wanted ? 'capture' : 'skip';
      if (mode === 'capture' && size === 0) {
        done = true;
        mode = 'skip';
      }
    }
  }
  return done;
}
