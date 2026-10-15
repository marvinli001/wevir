// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/provider/AntigravityInstallation.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Effect 改写成普通 TS；目录换到 Wevir 的 `<数据目录>/engines/antigravity/runtime/<平台>-<架构>/`；下载请求不压缩
// （Accept-Encoding: identity），没下完的留在 downloads/ 里、下次用 Range 接着下；60 秒收不到数据算卡住；连不上时的说明
// 指向 WEVIR_ANTIGRAVITY_MIRROR 与手填路径（大陆网络）；进度经回调报字节数；不做 T3 的租约与删除（Wevir 没有删除运行体
// 的方法）；校验运行体（启动并核对 initialize）由调用方注入（process.ts 的 validateAntigravityRuntime）。
//
// 运行体的安装（domain-model §3.6 的 account.install，docs/architecture/antigravity-event-mapping.md §2）：
// versions/<sha256>/ 是装好的一个发布（两个可执行文件加 .install-complete.json），active.json 是指向它的原子指针，写下它才算
// 装好；下载与解包都在 versions/.install-* 里进行，失败或取消不影响已装的版本。

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  type AntigravityReleaseAsset,
  antigravityDownloadUrl,
  antigravityExecutableNames,
  resolveAntigravityReleaseAsset,
} from './release.js';
import { openZipArchive } from './zip.js';

const DOWNLOAD_TIMEOUT_MS = 45 * 60_000;
/** 多久收不到数据算下载卡住（含等响应头）。 */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const VALIDATION_TIMEOUT_MS = 90_000;
const PROGRESS_INTERVAL_MS = 250;
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;
const RECORD_MAX_BYTES = 8 * 1024;
const RELEASE_RECORD = '.install-complete.json';
const RELEASE_ID = /^[a-f0-9]{64}$/u;

/** 安装或解析失败。`message` 给人看（进 AccountState 的 lastError），`cause` 是原始错误。 */
export class AntigravityInstallationError extends Error {
  override readonly name = 'AntigravityInstallationError';
  readonly operation: string;
  constructor(operation: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.operation = operation;
  }
}

/** 安装被取消（`cancel` 或 dispose）。 */
export class AntigravityInstallCancelled extends Error {
  override readonly name = 'AntigravityInstallCancelled';
}

export interface AntigravityExecutable {
  readonly executablePath: string;
  readonly harnessPath: string;
  /** override：account.setPath 指定的；managed：Wevir 下载的；path：PATH 上找到的。 */
  readonly source: 'override' | 'managed' | 'path';
  /** Wevir 装的版本；别处来的不知道版本时为 null。 */
  readonly version: string | null;
  readonly managedVersionDirectory: string | null;
}

export interface InstallProgress {
  phase: 'downloading' | 'extracting' | 'verifying';
  completedBytes: number;
  totalBytes: number;
}

export interface AntigravityInstallationOptions {
  /** `<数据目录>/engines/antigravity`。 */
  directory: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** 测试换掉钉住的发布；null 表示本平台没有发布。 */
  releaseAsset?: AntigravityReleaseAsset | null;
  /** 启动解出的运行体并核对它是这个发布；抛错即校验失败。 */
  validate?: (
    executable: AntigravityExecutable,
    expectedVersion: string,
    signal: AbortSignal,
  ) => Promise<void>;
  fetch?: typeof fetch;
  idleTimeoutMs?: number;
  progressIntervalMs?: number;
}

interface InstalledRecord {
  releaseId: string;
  version: string;
  executable: { name: string; bytes: number };
  harness: { name: string; bytes: number };
}

export class AntigravityInstallation {
  /** `<数据目录>/engines/antigravity/runtime/<平台>-<架构>`。 */
  readonly managedDirectory: string;
  readonly releaseAsset: AntigravityReleaseAsset | null;
  readonly #options: AntigravityInstallationOptions;
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  readonly #names: { executable: string; harness: string };
  readonly #versions: string;
  readonly #downloads: string;
  readonly #activePath: string;
  #running: { controller: AbortController; done: Promise<AntigravityExecutable> } | undefined;

  constructor(options: AntigravityInstallationOptions) {
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
    this.#arch = options.arch ?? process.arch;
    this.releaseAsset =
      options.releaseAsset === undefined
        ? resolveAntigravityReleaseAsset(this.#platform, this.#arch)
        : options.releaseAsset;
    this.#names = antigravityExecutableNames(this.#platform);
    this.managedDirectory = path.join(
      options.directory,
      'runtime',
      `${this.#platform}-${this.#arch}`,
    );
    this.#versions = path.join(this.managedDirectory, 'versions');
    this.#downloads = path.join(this.managedDirectory, 'downloads');
    this.#activePath = path.join(this.managedDirectory, 'active.json');
  }

  /** 正在安装。 */
  get installing(): boolean {
    return this.#running !== undefined;
  }

  /**
   * 找运行体：指定的路径 → Wevir 装的（active.json）→ PATH 上的 `agy_acp_server.par`。可执行文件与同目录的
   * `localharness_external` 都要在、可执行。找不到抛 `AntigravityInstallationError`（operation `resolve`）。
   */
  async resolve(customPath?: string | null): Promise<AntigravityExecutable> {
    try {
      const override = customPath?.trim();
      if (override) {
        const candidates =
          path.isAbsolute(override) || override.includes('/') || override.includes('\\')
            ? [path.resolve(override)]
            : this.#pathCandidates(override);
        for (const candidate of candidates) {
          const selected = await this.#fromExternal(candidate, 'override');
          if (selected) return selected;
        }
        throw new AntigravityInstallationError(
          'resolve',
          'The custom Antigravity executable or its localharness_external sibling is missing or not executable.',
        );
      }
      if (await exists(this.#activePath)) {
        const active = await this.#readRecord<{ releaseId: string }>(this.#activePath);
        if (typeof active.releaseId !== 'string' || !RELEASE_ID.test(active.releaseId)) {
          throw invalidRecord();
        }
        return await this.#completedRelease(active.releaseId);
      }
      for (const candidate of this.#pathCandidates(this.#names.executable)) {
        const selected = await this.#fromExternal(candidate, 'path');
        if (selected) return selected;
      }
      throw new AntigravityInstallationError(
        'resolve',
        this.releaseAsset
          ? 'Antigravity is not installed.'
          : `Google does not publish an Antigravity runtime for ${this.#platform}-${this.#arch}. Set a custom executable path.`,
      );
    } catch (error) {
      if (error instanceof AntigravityInstallationError) throw error;
      throw new AntigravityInstallationError(
        'resolve',
        'Could not read the Antigravity installation. Reinstall it or set a custom executable path.',
        { cause: error },
      );
    }
  }

  /**
   * 下载、校验、解包、核对并启用钉住的发布。进度经 `onProgress` 报告。同一时刻只有一次安装，进行中时返回同一个
   * Promise。失败抛 `AntigravityInstallationError`，取消抛 `AntigravityInstallCancelled`；已装的版本不受影响。
   */
  install(onProgress: (progress: InstallProgress) => void): Promise<AntigravityExecutable> {
    if (this.#running !== undefined) return this.#running.done;
    const asset = this.releaseAsset;
    if (asset === null) {
      return Promise.reject(
        new AntigravityInstallationError(
          'start',
          `Google does not publish an Antigravity runtime for ${this.#platform}-${this.#arch}. Set a custom executable path.`,
        ),
      );
    }
    const controller = new AbortController();
    const done = this.#install(asset, onProgress, controller.signal).finally(() => {
      if (this.#running?.controller === controller) this.#running = undefined;
    });
    this.#running = { controller, done };
    return done;
  }

  /** 取消进行中的安装（没下完的部分留着，下次接着下）。 */
  cancel(): void {
    this.#running?.controller.abort(new AntigravityInstallCancelled('Installation cancelled.'));
  }

  async #install(
    asset: AntigravityReleaseAsset,
    onProgress: (progress: InstallProgress) => void,
    signal: AbortSignal,
  ): Promise<AntigravityExecutable> {
    const destination = path.join(this.#versions, asset.sha256);
    const report = (phase: InstallProgress['phase'], completedBytes: number) =>
      onProgress({ phase, completedBytes, totalBytes: asset.archiveBytes });
    try {
      await fsp.mkdir(this.#versions, { recursive: true });
      await fsp.mkdir(this.#downloads, { recursive: true });
      await this.#removeStaleStaging();

      if (await exists(destination)) {
        const existing = await this.#completedRelease(asset.sha256);
        if (existing.version !== asset.version) {
          throw new AntigravityInstallationError(
            'verify',
            'The existing managed release has the wrong version. Remove it before reinstalling.',
          );
        }
        report('verifying', asset.archiveBytes);
        await this.#validate(existing, asset.version, signal);
        await this.#activate(asset);
        return existing;
      }

      const required =
        asset.archiveBytes + asset.executable.bytes + asset.harness.bytes + FREE_SPACE_MARGIN;
      const available = await fsp
        .statfs(this.#versions, { bigint: true })
        .then((stats) => stats.bavail * stats.bsize)
        .catch(() => undefined);
      if (available !== undefined && available < BigInt(required)) {
        throw new AntigravityInstallationError(
          'download',
          `Antigravity needs at least ${Math.ceil(required / 1024 / 1024)} MiB of free space to install.`,
        );
      }

      const archivePath = path.join(this.#downloads, `${asset.sha256}.zip.part`);
      await this.#download(asset, archivePath, (bytes) => report('downloading', bytes), signal);

      report('extracting', asset.archiveBytes);
      const staging = await fsp.mkdtemp(path.join(this.#versions, '.install-'));
      try {
        const pairDirectory = path.join(staging, 'runtime');
        await fsp.mkdir(pairDirectory);
        await this.#extract(asset, archivePath, pairDirectory, signal);
        if (this.#platform !== 'win32') {
          await fsp.chmod(path.join(pairDirectory, asset.executable.name), 0o755);
          await fsp.chmod(path.join(pairDirectory, asset.harness.name), 0o755);
        }
        report('verifying', asset.archiveBytes);
        await this.#validate(
          {
            executablePath: path.join(pairDirectory, asset.executable.name),
            harnessPath: path.join(pairDirectory, asset.harness.name),
            source: 'managed',
            version: asset.version,
            managedVersionDirectory: pairDirectory,
          },
          asset.version,
          signal,
        );
        const record: InstalledRecord = {
          releaseId: asset.sha256,
          version: asset.version,
          executable: asset.executable,
          harness: asset.harness,
        };
        await fsp.writeFile(path.join(pairDirectory, RELEASE_RECORD), JSON.stringify(record), {
          flag: 'wx',
          mode: 0o600,
        });
        try {
          await fsp.rename(pairDirectory, destination);
        } catch (cause) {
          // 别的安装抢先放好了同一个发布：核对它是同一版本。
          const existing = await this.#completedRelease(asset.sha256).catch(() => undefined);
          if (existing?.version !== asset.version) {
            throw new AntigravityInstallationError(
              'activate',
              'Could not publish the Antigravity runtime. The previous release is unchanged. Try again.',
              { cause },
            );
          }
        }
      } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
      await fsp.rm(archivePath, { force: true }).catch(() => {});
      await this.#activate(asset);
      return await this.#completedRelease(asset.sha256);
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason instanceof AntigravityInstallCancelled
          ? signal.reason
          : new AntigravityInstallCancelled('Installation cancelled.');
      }
      if (error instanceof AntigravityInstallationError) throw error;
      throw new AntigravityInstallationError(
        'install',
        'Could not install Antigravity. Check free disk space and directory access, then try again.',
        { cause: error },
      );
    }
  }

  /**
   * 下载发布包到 `archivePath`：已有没下完的部分时用 Range 接着下（服务器不支持就从头来），边下边算 sha256，下完核对
   * 大小与 sha256，不对就删掉重来。
   */
  async #download(
    asset: AntigravityReleaseAsset,
    archivePath: string,
    onBytes: (bytes: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const url = antigravityDownloadUrl(asset, this.#options.env ?? process.env);
    let offset = await fsp
      .stat(archivePath)
      .then((stats) => stats.size)
      .catch(() => 0);
    if (offset > asset.archiveBytes) {
      await fsp.rm(archivePath, { force: true });
      offset = 0;
    }
    let hash = createHash('sha256');
    if (offset > 0) {
      const handle = await fsp.open(archivePath, 'r');
      try {
        for await (const chunk of handle.createReadStream({ start: 0, end: offset - 1 })) {
          hash.update(chunk as Buffer);
        }
      } finally {
        await handle.close();
      }
    }
    if (offset < asset.archiveBytes) {
      ({ bytes: offset, hash } = await this.#fetchInto(
        url,
        asset,
        archivePath,
        offset,
        hash,
        onBytes,
        signal,
      ));
    }
    if (offset !== asset.archiveBytes || hash.digest('hex') !== asset.sha256) {
      await fsp.rm(archivePath, { force: true });
      throw new AntigravityInstallationError(
        'download',
        'The Antigravity download failed its size or SHA-256 check. Nothing was installed. Try again.',
      );
    }
    onBytes(asset.archiveBytes);
  }

  /**
   * 发请求并把响应体追加到文件；返回文件的总字节数与整个文件的 hash（服务器不支持 Range、从头下时是新算的）。
   */
  async #fetchInto(
    url: string,
    asset: AntigravityReleaseAsset,
    archivePath: string,
    offset: number,
    hash: ReturnType<typeof createHash>,
    onBytes: (bytes: number) => void,
    signal: AbortSignal,
  ): Promise<{ bytes: number; hash: ReturnType<typeof createHash> }> {
    const idleMs = this.#options.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
    const idle = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(new Error('stalled')), idleMs);
    };
    const combined = AbortSignal.any([
      signal,
      idle.signal,
      AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    ]);
    const fetchImpl = this.#options.fetch ?? fetch;
    const host = safeHost(url);
    touch();
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: {
            // dl.google.com 在客户端接受时会 gzip 压缩；Range 只对不压缩的表示有意义。
            'accept-encoding': 'identity',
            ...(offset > 0 && { range: `bytes=${offset}-` }),
          },
          redirect: 'follow',
          signal: combined,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw networkError(host, error, idle.signal.aborted);
      }
      const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
      const identity = encoding === undefined || encoding === '' || encoding === 'identity';
      let start = offset;
      if (offset > 0 && response.status === 206 && identity) {
        if (!matchesContentRange(response.headers.get('content-range'), offset, asset)) {
          await response.body?.cancel().catch(() => {});
          await fsp.rm(archivePath, { force: true });
          throw new AntigravityInstallationError(
            'download',
            'The download server returned an unexpected range. Try again.',
          );
        }
      } else if (response.status === 200) {
        start = 0;
      } else if (response.status === 416) {
        await response.body?.cancel().catch(() => {});
        await fsp.rm(archivePath, { force: true });
        throw new AntigravityInstallationError(
          'download',
          'The partial Antigravity download was rejected by the server. Try again.',
        );
      } else {
        await response.body?.cancel().catch(() => {});
        throw new AntigravityInstallationError(
          'download',
          `Downloading Antigravity from ${host} failed with HTTP ${response.status}.${mirrorHint(host)}`,
        );
      }
      const expected = asset.archiveBytes - start;
      const length = response.headers.get('content-length');
      if (identity && length !== null && Number(length) !== expected) {
        await response.body?.cancel().catch(() => {});
        throw new AntigravityInstallationError(
          'download',
          'The Antigravity download size did not match the pinned release.',
        );
      }
      if (response.body === null) {
        throw new AntigravityInstallationError('download', 'The download server sent no data.');
      }
      if (start === 0) await fsp.writeFile(archivePath, '', { mode: 0o600 });
      const handle = await fsp.open(archivePath, constants.O_WRONLY | constants.O_APPEND);
      let written = start;
      let lastProgress = 0;
      // 服务器不支持 Range、从头下时，旧的部分已经算进 hash，换一个新的。
      const digest = start === 0 && offset > 0 ? createHash('sha256') : hash;
      try {
        for await (const chunk of response.body) {
          touch();
          written += chunk.byteLength;
          if (written > asset.archiveBytes) {
            throw new AntigravityInstallationError(
              'download',
              'The Antigravity download exceeded the pinned release size.',
            );
          }
          digest.update(chunk);
          await handle.write(chunk);
          const now = Date.now();
          if (now - lastProgress >= (this.#options.progressIntervalMs ?? PROGRESS_INTERVAL_MS)) {
            lastProgress = now;
            onBytes(written);
          }
        }
      } catch (error) {
        if (signal.aborted || error instanceof AntigravityInstallationError) throw error;
        throw networkError(host, error, idle.signal.aborted);
      } finally {
        await handle.close();
      }
      return { bytes: written, hash: digest };
    } finally {
      clearTimeout(idleTimer);
    }
  }

  async #extract(
    asset: AntigravityReleaseAsset,
    archivePath: string,
    pairDirectory: string,
    signal: AbortSignal,
  ): Promise<void> {
    const archive = await openZipArchive(archivePath).catch((cause: unknown) => {
      throw new AntigravityInstallationError('extract', 'Could not open the verified archive.', {
        cause,
      });
    });
    try {
      if (archive.entryCount !== 2) {
        throw new AntigravityInstallationError(
          'extract',
          'The archive must contain exactly the Antigravity executable and its harness.',
        );
      }
      const seen = new Set<string>();
      for (;;) {
        signal.throwIfAborted();
        const entry = await archive.next();
        if (entry === null) break;
        const expected = [asset.executable, asset.harness].find(
          (file) => file.name === entry.fileName,
        );
        const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (
          !expected ||
          seen.has(entry.fileName) ||
          entry.fileName.includes('/') ||
          entry.fileName.includes('\\') ||
          (unixType !== 0 && unixType !== 0o100000) ||
          (entry.externalFileAttributes & 0x10) !== 0 ||
          (entry.generalPurposeBitFlag & 1) !== 0 ||
          ![0, 8].includes(entry.compressionMethod) ||
          entry.uncompressedSize !== expected.bytes
        ) {
          throw new AntigravityInstallationError(
            'extract',
            'The archive contains an unexpected, unsafe, or incorrectly sized member.',
          );
        }
        seen.add(entry.fileName);
        const readable = await archive.openEntry(entry);
        let extracted = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            extracted += chunk.byteLength;
            if (extracted > expected.bytes) {
              callback(
                new AntigravityInstallationError(
                  'extract',
                  'An archive member exceeded its pinned size.',
                ),
              );
              return;
            }
            callback(null, chunk);
          },
        });
        const handle = await fsp.open(path.join(pairDirectory, entry.fileName), 'wx', 0o700);
        try {
          await pipeline(readable, counter, handle.createWriteStream(), { signal });
        } finally {
          await handle.close().catch(() => {});
        }
        if (extracted !== expected.bytes) {
          throw new AntigravityInstallationError('extract', 'An archive member was truncated.');
        }
      }
      if (!seen.has(asset.executable.name) || !seen.has(asset.harness.name)) {
        throw new AntigravityInstallationError(
          'extract',
          'The archive is missing the Antigravity executable or its harness.',
        );
      }
    } catch (error) {
      if (error instanceof AntigravityInstallationError || signal.aborted) throw error;
      throw new AntigravityInstallationError(
        'extract',
        'Could not extract the Antigravity runtime.',
        {
          cause: error,
        },
      );
    } finally {
      await archive.close();
    }
  }

  async #validate(
    executable: AntigravityExecutable,
    expectedVersion: string,
    signal: AbortSignal,
  ): Promise<void> {
    const validate = this.#options.validate;
    if (validate === undefined) return;
    const timeout = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
    try {
      await validate(executable, expectedVersion, AbortSignal.any([signal, timeout]));
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof AntigravityInstallationError) throw error;
      throw new AntigravityInstallationError(
        'verify',
        timeout.aborted
          ? 'The downloaded Antigravity runtime did not answer in time.'
          : 'The downloaded Antigravity runtime could not start in this environment.',
        { cause: error },
      );
    }
  }

  /** 写 active.json（先写临时文件再 rename，原子）。写下它才算装好。 */
  async #activate(asset: AntigravityReleaseAsset): Promise<void> {
    const temporary = path.join(this.managedDirectory, `active.json.${randomUUID()}.tmp`);
    try {
      await fsp.writeFile(temporary, JSON.stringify({ releaseId: asset.sha256 }), {
        flag: 'wx',
        mode: 0o600,
      });
      await fsp.rename(temporary, this.#activePath);
    } catch (cause) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      throw new AntigravityInstallationError(
        'activate',
        'Could not activate Antigravity. The previous runtime is unchanged. Check for locked files and try again.',
        { cause },
      );
    }
  }

  async #removeStaleStaging(): Promise<void> {
    const entries = await fsp.readdir(this.#versions).catch(() => [] as string[]);
    for (const entry of entries) {
      if (entry.startsWith('.install-')) {
        await fsp.rm(path.join(this.#versions, entry), { recursive: true, force: true });
      }
    }
  }

  async #readRecord<T>(filePath: string): Promise<T> {
    const stats = await fsp.stat(filePath);
    if (!stats.isFile() || stats.size > RECORD_MAX_BYTES) throw invalidRecord();
    try {
      return JSON.parse(await fsp.readFile(filePath, 'utf8')) as T;
    } catch (cause) {
      throw new AntigravityInstallationError(
        'resolve',
        'The managed runtime record is invalid. Reinstall Antigravity.',
        { cause },
      );
    }
  }

  async #completedRelease(releaseId: string): Promise<AntigravityExecutable> {
    const directory = path.join(this.#versions, releaseId);
    const record = await this.#readRecord<Partial<InstalledRecord>>(
      path.join(directory, RELEASE_RECORD),
    ).catch(() => undefined);
    if (
      record === undefined ||
      record.releaseId !== releaseId ||
      record.executable?.name !== this.#names.executable ||
      record.harness?.name !== this.#names.harness ||
      !Number.isSafeInteger(record.executable.bytes) ||
      record.executable.bytes <= 0 ||
      !Number.isSafeInteger(record.harness.bytes) ||
      record.harness.bytes <= 0 ||
      typeof record.version !== 'string' ||
      !record.version.trim() ||
      !(await this.#isExecutableFile(
        path.join(directory, this.#names.executable),
        record.executable.bytes,
      )) ||
      !(await this.#isExecutableFile(
        path.join(directory, this.#names.harness),
        record.harness.bytes,
      ))
    ) {
      throw new AntigravityInstallationError(
        'resolve',
        'The managed Antigravity runtime is incomplete. Reinstall it.',
      );
    }
    return {
      executablePath: path.join(directory, this.#names.executable),
      harnessPath: path.join(directory, this.#names.harness),
      source: 'managed',
      version: record.version,
      managedVersionDirectory: directory,
    };
  }

  async #fromExternal(
    candidate: string,
    source: 'override' | 'path',
  ): Promise<AntigravityExecutable | null> {
    if (!(await this.#isExecutableFile(candidate))) return null;
    const executablePath = await fsp.realpath(candidate);
    const directory = path.dirname(executablePath);
    const harnessPath = path.join(directory, this.#names.harness);
    if (!(await this.#isExecutableFile(harnessPath))) return null;
    const realVersions = await fsp.realpath(this.#versions).catch(() => undefined);
    if (
      realVersions !== undefined &&
      path.dirname(directory) === realVersions &&
      RELEASE_ID.test(path.basename(directory))
    ) {
      const installed = await this.#completedRelease(path.basename(directory));
      return { ...installed, executablePath, harnessPath, source };
    }
    return { executablePath, harnessPath, source, version: null, managedVersionDirectory: null };
  }

  async #isExecutableFile(filePath: string, bytes?: number): Promise<boolean> {
    const stats = await fsp.stat(filePath).catch(() => undefined);
    return (
      stats?.isFile() === true &&
      (bytes === undefined || stats.size === bytes) &&
      (this.#platform === 'win32' || (stats.mode & 0o111) !== 0)
    );
  }

  #pathCandidates(binary: string): string[] {
    const env = this.#options.env ?? process.env;
    const pathValue =
      this.#platform === 'win32'
        ? Object.entries(env).findLast(([key]) => key.toUpperCase() === 'PATH')?.[1]
        : env.PATH;
    return (pathValue ?? '')
      .split(this.#platform === 'win32' ? ';' : ':')
      .map((directory) => directory.trim().replace(/^"|"$/gu, ''))
      .filter((directory) => directory.length > 0)
      .map((directory) => path.resolve(directory, binary));
  }
}

function invalidRecord(): AntigravityInstallationError {
  return new AntigravityInstallationError(
    'resolve',
    'The managed runtime record is invalid. Reinstall Antigravity.',
  );
}

async function exists(filePath: string): Promise<boolean> {
  return fsp
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** `Content-Range: bytes <offset>-<total-1>/<total>`。 */
function matchesContentRange(
  value: string | null,
  offset: number,
  asset: AntigravityReleaseAsset,
): boolean {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value?.trim() ?? '');
  return (
    match !== null &&
    Number(match[1]) === offset &&
    Number(match[2]) === asset.archiveBytes - 1 &&
    Number(match[3]) === asset.archiveBytes
  );
}

function mirrorHint(host: string): string {
  return host === 'dl.google.com'
    ? ' dl.google.com is often unreachable from mainland China: set WEVIR_ANTIGRAVITY_MIRROR to a mirror of https://dl.google.com, or install the runtime yourself and set a custom executable path.'
    : '';
}

/** 连不上、断线、卡住 → 给人看的说明（大陆网络的情况写明出路）。没下完的部分留着，下次接着下。 */
function networkError(
  host: string,
  error: unknown,
  stalled: boolean,
): AntigravityInstallationError {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code =
    typeof cause?.code === 'string'
      ? cause.code
      : typeof (error as { code?: unknown } | null)?.code === 'string'
        ? (error as { code: string }).code
        : undefined;
  const what = stalled
    ? `The download from ${host} stalled`
    : `Could not reach ${host}${code === undefined ? '' : ` (${code})`}`;
  return new AntigravityInstallationError(
    'download',
    `${what}. The partial download is kept and resumes on retry.${mirrorHint(host)}`,
    { cause: error },
  );
}
