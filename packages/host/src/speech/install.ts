// 听写的本机模型（0.92.0，domain-model §3.42）：用户在设置里点“下载”时，Host 下载 SenseVoice Small（int8）与 Silero VAD，
// 按写死的 sha256 核对，用系统的 tar 只解出要用的两个文件。照 adapter-devin 的安装器做：下载与解包都在
// `<目录>/.install-*` 里进行，完成后整个目录改名为 `<目录>/<模型键>/` 才算装好；失败或取消不留下半成品。
//
// 下载线路与桌面端的更新线路相同（apps/desktop/src/main/updates/feed.ts）：GitHub Release（tag `speech-models`）与
// Cloudflare R2 两条主线路竞速，先回应的那条下载；Bunny 是后备，最后才回到上游 sherpa-onnx 的 GitHub Release。
// 一条线路中途断了或内容对不上，就换下一条。文件由发布脚本从上游搬过去（apps/desktop/scripts/release.ts
// speech-models），sha256 写死，所以哪条线路下的都一样可信。`WEVIR_GITHUB_MIRROR` 替换 `https://github.com` 前缀
// （同 scripts/fetch-codex.sh）。

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { SpeechInstallProgress } from '@wevir/protocol';

/** 一个要下载的文件。`extract` 给出时它是压缩包，只解出这些条目（相对压缩包根）。 */
export interface SpeechAsset {
  url: string;
  sha256: string;
  size: number;
  /** 下载后的文件名；压缩包解出的条目放到模型目录时去掉开头的目录。 */
  fileName: string;
  extract?: readonly string[];
}

/** 本机模型：SenseVoice Small 的 int8 版（中、英、日、韩、粤）与 Silero VAD。 */
export interface SpeechModelSpec {
  /** 模型目录名，换模型时换它。 */
  key: string;
  /** 产品名，界面原样显示。 */
  name: string;
  assets: readonly SpeechAsset[];
  /** 装好后模型目录里必须有的文件。 */
  files: { model: string; tokens: string; vad: string };
}

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
const SENSE_VOICE_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09';

/** 大小与 sha256 取自 GitHub Release 的资产信息（2026-10-21），下载后逐个核对。 */
export const SENSE_VOICE_SMALL: SpeechModelSpec = {
  key: 'sense-voice-small-int8-2025-09-09',
  name: 'SenseVoice Small',
  assets: [
    {
      url: `${RELEASE}/${SENSE_VOICE_DIR}.tar.bz2`,
      sha256: '7305f7905bfcf77fa0b39388a313f3da35c68d971661a65475b56fb2162c8e63',
      size: 165_783_878,
      fileName: 'sense-voice.tar.bz2',
      extract: [`${SENSE_VOICE_DIR}/model.int8.onnx`, `${SENSE_VOICE_DIR}/tokens.txt`],
    },
    {
      url: `${RELEASE}/silero_vad.onnx`,
      sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
      size: 643_854,
      fileName: 'silero_vad.onnx',
    },
  ],
  files: { model: 'model.int8.onnx', tokens: 'tokens.txt', vad: 'silero_vad.onnx' },
};

/** 换掉 `https://github.com` 前缀的环境变量（同 scripts/fetch-codex.sh）。 */
export const GITHUB_MIRROR_ENV = 'WEVIR_GITHUB_MIRROR';

export function mirroredUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  const mirror = env[GITHUB_MIRROR_ENV]?.trim().replace(/\/+$/u, '');
  if (!mirror || !url.startsWith('https://github.com/')) return url;
  return `${mirror}${url.slice('https://github.com'.length)}`;
}

/** 听写模型的一条下载线路。 */
export interface SpeechMirror {
  id: string;
  /** 线路的根地址，不带末尾的 `/`。 */
  url: string;
  /** `release`：GitHub Release 的附件，没有目录，文件名前加模型键（见 speechAssetPath）。不写时是 `<根>/<模型键>/<文件>`。 */
  layout?: 'release';
  /** 后备线路：主线路都失败后才按顺序试。 */
  fallback?: true;
}

/** 听写模型在 GitHub 线路上的 Release（发布脚本往里传）。 */
export const SPEECH_RELEASE_TAG = 'speech-models';

/** 内置的线路，与 apps/desktop/src/main/updates/feed.ts 的 UPDATE_MIRRORS 是同样三处，模型放在 `speech/` 下。 */
export const SPEECH_MIRRORS: readonly SpeechMirror[] = [
  {
    id: 'github',
    url: `https://github.com/marvinli001/wevir/releases/download/${SPEECH_RELEASE_TAG}`,
    layout: 'release',
  },
  { id: 'r2', url: 'https://dl.edgeweir.com/speech' },
  { id: 'global', url: 'https://download.wevir.si/speech', fallback: true },
];

/** 文件在线路上相对根地址的路径：GitHub 线路是 `<模型键>-<文件>`，其余是 `<模型键>/<文件>`。 */
export function speechAssetPath(
  spec: SpeechModelSpec,
  asset: SpeechAsset,
  layout?: SpeechMirror['layout'],
): string {
  return layout === 'release' ? `${spec.key}-${asset.fileName}` : `${spec.key}/${asset.fileName}`;
}

/** 一个文件的下载地址：`primary` 同时请求、先回应的下载；都不行时按顺序试 `fallback`，最后是上游的地址。 */
export function speechSourcesOf(
  spec: SpeechModelSpec,
  asset: SpeechAsset,
  mirrors: readonly SpeechMirror[] = SPEECH_MIRRORS,
  env: NodeJS.ProcessEnv = process.env,
): { primary: string[]; fallback: string[] } {
  const urlOf = (mirror: SpeechMirror) =>
    mirroredUrl(`${mirror.url}/${speechAssetPath(spec, asset, mirror.layout)}`, env);
  return {
    primary: mirrors.filter((mirror) => mirror.fallback !== true).map(urlOf),
    fallback: [
      ...mirrors.filter((mirror) => mirror.fallback === true).map(urlOf),
      mirroredUrl(asset.url, env),
    ],
  };
}

export function downloadBytesOf(spec: SpeechModelSpec): number {
  return spec.assets.reduce((sum, asset) => sum + asset.size, 0);
}

/** 多久收不到数据算下载卡住。 */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 5 * 60_000;
const PROGRESS_INTERVAL_MS = 250;
/** 压缩包与解出的模型都在磁盘上的那一刻约 420 MB，再留点余量。 */
const REQUIRED_FREE_SPACE = 640 * 1024 * 1024;
const STAGING_PREFIX = '.install-';

/** 安装失败。`message` 给人看（进 `SpeechLocalStatus.error`）。 */
export class SpeechInstallError extends Error {
  override readonly name = 'SpeechInstallError';
}

/** 安装被取消。 */
export class SpeechInstallCancelled extends Error {
  override readonly name = 'SpeechInstallCancelled';
}

export interface SpeechModelPaths {
  dir: string;
  model: string;
  tokens: string;
  vad: string;
}

export interface SpeechInstallerOptions {
  /** 数据目录里的 `speech/`，不存在时建。 */
  directory: string;
  spec?: SpeechModelSpec;
  /** 下载线路（默认 SPEECH_MIRRORS）；上游的地址总是排在最后。 */
  mirrors?: readonly SpeechMirror[];
  fetch?: typeof fetch;
  /** 测试用：替换解包（默认用系统的 tar）。 */
  extract?: (
    archive: string,
    entries: readonly string[],
    destination: string,
    signal: AbortSignal,
  ) => Promise<void>;
  env?: NodeJS.ProcessEnv;
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

/** 系统的 tar：Windows 用 System32 里的 bsdtar（也解 bzip2），别处用 PATH 上的。 */
function tarCommand(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  }
  return existsSync('/usr/bin/tar') ? '/usr/bin/tar' : 'tar';
}

function extractWithTar(
  archive: string,
  entries: readonly string[],
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  // 只解出列出的条目（名字是写死的，不会是绝对路径或带 `..`）。
  return new Promise((resolve, reject) => {
    execFile(
      tarCommand(),
      ['-xf', archive, '-C', destination, ...entries],
      { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, signal },
      (error, _stdout, stderr) => {
        if (error !== null) {
          const detail = String(stderr).trim().split(/\r?\n/u).slice(-2).join(' ');
          reject(new Error(detail === '' ? error.message : detail, { cause: error }));
          return;
        }
        resolve();
      },
    );
  });
}

/** 已收到回应头、正文还没读的一次下载。 */
interface OpenedDownload {
  url: string;
  response: Response;
  /** 用户取消与收不到数据的中止合在一起。 */
  signal: AbortSignal;
  /** 收到数据时重新计时。 */
  arm(): void;
  /** 收不到数据而中止时的原因。 */
  idleReason(): unknown;
  /** 不用这次下载了：停止计时、取消正文。 */
  close(): void;
  stop(): void;
}

export class SpeechModelInstaller {
  readonly directory: string;
  readonly spec: SpeechModelSpec;
  readonly #options: SpeechInstallerOptions;
  #running: { controller: AbortController; done: Promise<SpeechModelPaths> } | undefined;

  constructor(options: SpeechInstallerOptions) {
    this.#options = options;
    this.directory = options.directory;
    this.spec = options.spec ?? SENSE_VOICE_SMALL;
  }

  get installing(): boolean {
    return this.#running !== undefined;
  }

  pathsOf(dir: string = path.join(this.directory, this.spec.key)): SpeechModelPaths {
    return {
      dir,
      model: path.join(dir, this.spec.files.model),
      tokens: path.join(dir, this.spec.files.tokens),
      vad: path.join(dir, this.spec.files.vad),
    };
  }

  /** 装好的模型：三个文件都在时返回路径，否则 undefined。 */
  async installed(): Promise<SpeechModelPaths | undefined> {
    const paths = this.pathsOf();
    for (const file of [paths.model, paths.tokens, paths.vad]) {
      const ok = await fsp.stat(file).then(
        (stats) => stats.isFile() && stats.size > 0,
        () => false,
      );
      if (!ok) return undefined;
    }
    return paths;
  }

  /** 装好的模型占的字节数。 */
  async installedBytes(): Promise<number | undefined> {
    const paths = await this.installed();
    if (paths === undefined) return undefined;
    let total = 0;
    for (const file of [paths.model, paths.tokens, paths.vad]) total += (await fsp.stat(file)).size;
    return total;
  }

  /** 同一时刻只有一次安装，进行中时返回同一个 Promise。失败抛 `SpeechInstallError`，取消抛 `SpeechInstallCancelled`。 */
  install(onProgress: (progress: SpeechInstallProgress) => void): Promise<SpeechModelPaths> {
    if (this.#running !== undefined) return this.#running.done;
    const controller = new AbortController();
    const done = this.#install(onProgress, controller.signal).finally(() => {
      if (this.#running?.controller === controller) this.#running = undefined;
    });
    this.#running = { controller, done };
    return done;
  }

  cancel(): void {
    this.#running?.controller.abort(new SpeechInstallCancelled('Installation cancelled.'));
  }

  /** 删掉装好的模型（安装进行中时先取消）。 */
  async uninstall(): Promise<void> {
    const running = this.#running;
    if (running !== undefined) {
      this.cancel();
      await running.done.catch(() => {});
    }
    await fsp.rm(path.join(this.directory, this.spec.key), { recursive: true, force: true });
  }

  async #install(
    onProgress: (progress: SpeechInstallProgress) => void,
    signal: AbortSignal,
  ): Promise<SpeechModelPaths> {
    const existing = await this.installed();
    if (existing !== undefined) return existing;
    try {
      await fsp.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.#removeStaleStaging();
      await this.#checkSpace();
      const staging = await fsp.mkdtemp(path.join(this.directory, STAGING_PREFIX));
      try {
        const files = path.join(staging, 'model');
        await fsp.mkdir(files);
        const totalBytes = downloadBytesOf(this.spec);
        let before = 0;
        for (const asset of this.spec.assets) {
          const file = path.join(staging, asset.fileName);
          const offset = before;
          await this.#download(asset, file, signal, (received) =>
            onProgress({ phase: 'downloading', completedBytes: offset + received, totalBytes }),
          );
          before += asset.size;
          if (asset.extract === undefined) {
            await fsp.rename(file, path.join(files, asset.fileName));
            continue;
          }
          onProgress({ phase: 'extracting', completedBytes: before, totalBytes });
          const unpacked = path.join(staging, 'unpacked');
          await fsp.mkdir(unpacked, { recursive: true });
          try {
            await (this.#options.extract ?? extractWithTar)(file, asset.extract, unpacked, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            throw new SpeechInstallError(
              `Could not unpack the downloaded speech model: ${reasonOf(error)}`,
              { cause: error },
            );
          }
          await fsp.rm(file, { force: true });
          for (const entry of asset.extract) {
            await fsp.rename(path.join(unpacked, entry), path.join(files, path.basename(entry)));
          }
          await fsp.rm(unpacked, { recursive: true, force: true });
        }
        onProgress({ phase: 'verifying', completedBytes: totalBytes, totalBytes });
        const paths = this.pathsOf(files);
        for (const file of [paths.model, paths.tokens, paths.vad]) {
          const ok = await fsp.stat(file).then(
            (stats) => stats.isFile() && stats.size > 0,
            () => false,
          );
          if (!ok) {
            throw new SpeechInstallError(
              `The downloaded speech model does not contain ${path.basename(file)}.`,
            );
          }
        }
        const destination = path.join(this.directory, this.spec.key);
        await fsp.rm(destination, { recursive: true, force: true });
        await fsp.rename(files, destination);
      } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
      await this.#removeOtherModels();
      return this.pathsOf();
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason instanceof SpeechInstallCancelled
          ? signal.reason
          : new SpeechInstallCancelled('Installation cancelled.');
      }
      if (error instanceof SpeechInstallError) throw error;
      throw new SpeechInstallError(
        `Could not install the speech model: ${reasonOf(error)}. Check free disk space and directory access, then try again.`,
        { cause: error },
      );
    }
  }

  async #checkSpace(): Promise<void> {
    const available = await fsp
      .statfs(this.directory, { bigint: true })
      .then((stats) => stats.bavail * stats.bsize)
      .catch(() => undefined);
    if (available !== undefined && available < BigInt(REQUIRED_FREE_SPACE)) {
      throw new SpeechInstallError(
        `The speech model needs at least ${REQUIRED_FREE_SPACE / 1024 / 1024} MiB of free space to install.`,
      );
    }
  }

  /** 下载到 `file`，边下边算 sha256，与写死的值比；一条线路失败就换下一条，都失败时错误里列出每条的原因。 */
  async #download(
    asset: SpeechAsset,
    file: string,
    signal: AbortSignal,
    onReceived: (bytes: number) => void,
  ): Promise<void> {
    const sources = speechSourcesOf(this.spec, asset, this.#options.mirrors, this.#options.env);
    const failures: string[] = [];
    const failed = new Set<string>();
    const fail = (url: string, error: unknown) => {
      if (signal.aborted) throw signal.reason;
      failed.add(url);
      failures.push(`${hostOf(url)}: ${reasonOf(error)}`);
    };
    let opened = await this.#race(sources.primary, signal, fail);
    const rest = [
      ...sources.primary.filter((url) => url !== opened?.url && !failed.has(url)),
      ...sources.fallback,
    ];
    for (;;) {
      if (opened !== undefined) {
        try {
          await this.#save(opened, asset, file, signal, onReceived);
          return;
        } catch (error) {
          fail(opened.url, error);
        }
      }
      const next = rest.shift();
      if (next === undefined) break;
      opened = await this.#open(next, signal).catch((error: unknown) => {
        fail(next, error);
        return undefined;
      });
    }
    throw new SpeechInstallError(
      `Could not download the speech model (${failures.join('; ')}). Check your network or proxy; ${GITHUB_MIRROR_ENV} can point to a GitHub mirror.`,
    );
  }

  /** 同时请求几条主线路，返回先回应 2xx 的那条，其余的取消；都失败时返回 undefined（原因经 `fail` 记下）。 */
  async #race(
    urls: readonly string[],
    signal: AbortSignal,
    fail: (url: string, error: unknown) => void,
  ): Promise<OpenedDownload | undefined> {
    const attempts = urls.map((url) => {
      const loser = new AbortController();
      const opened = this.#open(url, AbortSignal.any([signal, loser.signal])).catch(
        (error: unknown) => {
          if (!loser.signal.aborted) fail(url, error);
          throw error;
        },
      );
      return { url, loser, opened };
    });
    const winner = await Promise.any(attempts.map((attempt) => attempt.opened)).catch(
      () => undefined,
    );
    if (signal.aborted) throw signal.reason;
    for (const { url, loser, opened } of attempts) {
      if (url === winner?.url) continue;
      loser.abort(new Error('another mirror answered first'));
      opened.then(
        (response) => response.close(),
        () => {},
      );
    }
    return winner;
  }

  /** 发出请求，等到回应头；`idle` 从这时起计时，收不到数据就中止。 */
  async #open(url: string, signal: AbortSignal): Promise<OpenedDownload> {
    const idleMs = this.#options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const idle = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new Error(`no data for ${idleMs} ms`)), idleMs);
    };
    const stop = () => clearTimeout(timer);
    const combined = AbortSignal.any([signal, idle.signal]);
    try {
      arm();
      const response = await (this.#options.fetch ?? fetch)(url, {
        headers: { 'Accept-Encoding': 'identity' },
        signal: combined,
      });
      if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`answered ${response.status}`);
      }
      return {
        url,
        response,
        signal: combined,
        arm,
        idleReason: () => (idle.signal.aborted ? idle.signal.reason : undefined),
        close: () => {
          stop();
          response.body?.cancel().catch(() => {});
        },
        stop,
      };
    } catch (error) {
      stop();
      throw idle.signal.aborted ? idle.signal.reason : error;
    }
  }

  /** 把回应的正文写到 `file`，边写边算 sha256；大小或 sha256 不对时抛错。 */
  async #save(
    opened: OpenedDownload,
    asset: SpeechAsset,
    file: string,
    signal: AbortSignal,
    onReceived: (bytes: number) => void,
  ): Promise<void> {
    const hash = createHash('sha256');
    let received = 0;
    let reportedAt = 0;
    const interval = this.#options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        received += chunk.length;
        opened.arm();
        const now = Date.now();
        if (now - reportedAt >= interval) {
          reportedAt = now;
          onReceived(received);
        }
        callback(null, chunk);
      },
    });
    try {
      onReceived(0);
      await pipeline(
        Readable.fromWeb(opened.response.body as unknown as WebReadableStream),
        counter,
        createWriteStream(file, { mode: 0o600 }),
        { signal: opened.signal },
      );
      onReceived(received);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw opened.idleReason() ?? error;
    } finally {
      opened.stop();
    }
    if (received !== asset.size || hash.digest('hex') !== asset.sha256) {
      throw new Error('the file did not match the expected checksum');
    }
  }

  async #removeStaleStaging(): Promise<void> {
    for (const entry of await fsp.readdir(this.directory).catch(() => [])) {
      if (entry.startsWith(STAGING_PREFIX)) {
        await fsp
          .rm(path.join(this.directory, entry), { recursive: true, force: true })
          .catch(() => {});
      }
    }
  }

  /** 装好后删掉别的模型目录（以前的版本）。 */
  async #removeOtherModels(): Promise<void> {
    for (const entry of await fsp.readdir(this.directory).catch(() => [])) {
      if (entry !== this.spec.key && !entry.startsWith('.')) {
        await fsp
          .rm(path.join(this.directory, entry), { recursive: true, force: true })
          .catch(() => {});
      }
    }
  }
}
