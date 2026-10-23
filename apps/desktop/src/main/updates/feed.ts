// 自动更新的下载线路、更新清单的签名与选线路（ADR-0007 补记 2、4）。这里只有纯逻辑，网络请求经参数里的 `fetch` 注入，
// 不依赖 Electron，单元测试直接跑；electron-updater 的 provider 与状态机在 mirror-provider.ts 与 updater.ts。
//
// 发布目录（Wevir 自己的两条线路）：`<线路>/desktop/<平台>-<架构>/`，里面是 electron-builder 写的更新清单
// （`latest-mac.yml` / `beta-mac.yml`，Windows 是 `latest.yml` / `beta.yml`，Linux 是 `latest-linux.yml`、arm64 是
// `latest-linux-arm64.yml`）、每份清单的签名 `<清单>.sig`，以及清单里
// 列出的安装包与 blockmap（相对路径）。GitHub 线路是一个 Release（tag `desktop-updates`）的附件，附件没有目录：清单与签名
// 名字前加 `<平台>-<架构>-`，安装包与 blockmap 的名字本来就带平台与架构，照原名放，清单里的相对路径照样指得到。正式版只读 latest，开发版读 latest 与 beta、取版本高的：正式版发布后开发版用户
// 也会收到它，切回正式版时不降级（electron-updater 的 allowDowngrade 关着）。

import { createPublicKey, verify } from 'node:crypto';
import { load } from 'js-yaml';
import { compare, valid } from 'semver';
import type { UpdateChannel } from '../../shared/desktop-api.js';

/** 一条下载线路。Wevir 自己的线路只认自己的域名，后面换服务商只改 DNS；GitHub 线路是 Release 的下载地址。 */
export interface UpdateMirror {
  /** 稳定的 ID，记在状态里给界面显示（`github` / `r2` / `global`）。 */
  id: string;
  /** 线路的根地址，不带末尾的 `/`。 */
  url: string;
  /** `release`：GitHub Release 的附件，没有目录（见文件头）。不写时是 `desktop/<平台>-<架构>/` 的发布目录。 */
  layout?: 'release';
  /** 后备线路：主线路（没有这个标记的）都没给出可用的清单时才问它，下载时也排在主线路之后。 */
  fallback?: true;
}

/** GitHub 线路：仓库里 tag `desktop-updates` 的 Release，发布作业（scripts/release.ts）往里传。 */
export const GITHUB_MIRROR_URL =
  'https://github.com/marvinli001/wevir/releases/download/desktop-updates';

/**
 * 内置的线路。主线路是 GitHub Release 与 Cloudflare R2（自定义域名 dl.edgeweir.com），两条竞速、按速度选；Bunny CDN
 * （download.wevir.si）是后备，主线路都不行时才用（Bunny 流量贵）。2026-10-20 去掉了自建的 download2.wevir.si。
 */
export const UPDATE_MIRRORS: readonly UpdateMirror[] = [
  { id: 'github', url: GITHUB_MIRROR_URL, layout: 'release' },
  { id: 'r2', url: 'https://dl.edgeweir.com' },
  { id: 'global', url: 'https://download.wevir.si', fallback: true },
];

/**
 * 排查与本机验收用：`WEVIR_UPDATE_MIRRORS=global=http://127.0.0.1:8701,local2=http://127.0.0.1:8702` 换掉内置线路。
 * 地址里有 `/releases/download/` 的按 GitHub Release 的布局读；ID 后加 `?`（`global?=…`）是后备线路。清单照样要验签，
 * 换线路换不掉签名检查。格式不对时返回 undefined（用内置的）。
 */
export function mirrorsFromEnv(value: string | undefined): UpdateMirror[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const mirrors: UpdateMirror[] = [];
  for (const part of value.split(',')) {
    const match = /^\s*([a-z][a-z0-9-]*)(\??)=(https?:\/\/[^\s,]+?)\/?\s*$/.exec(part);
    if (match === null) return undefined;
    const url = match[3] as string;
    mirrors.push({
      id: match[1] as string,
      url,
      ...(url.includes('/releases/download/') && { layout: 'release' as const }),
      ...(match[2] === '?' && { fallback: true as const }),
    });
  }
  return mirrors.length > 0 ? mirrors : undefined;
}

/** 某个平台与架构的发布目录：清单里的相对路径相对于它。GitHub 线路是 Release 的下载地址本身。 */
export function feedUrl(mirror: UpdateMirror, platform: NodeJS.Platform, arch: string): string {
  if (mirror.layout === 'release') return `${mirror.url}/`;
  return `${mirror.url}/desktop/${platform}-${arch}/`;
}

/** 清单 `file`（`latest-mac.yml` 等）在这条线路上的地址；签名是它后面加 `.sig`。 */
export function manifestUrl(
  mirror: UpdateMirror,
  platform: NodeJS.Platform,
  arch: string,
  file: string,
): string {
  if (mirror.layout === 'release') return `${mirror.url}/${platform}-${arch}-${file}`;
  return feedUrl(mirror, platform, arch) + file;
}

/** 通道读哪几份清单（electron-builder 的通道名：正式版 latest，开发版 beta）。 */
export function channelNames(channel: UpdateChannel): readonly string[] {
  return channel === 'dev' ? ['latest', 'beta'] : ['latest'];
}

/** electron-builder 的清单文件名：Linux 上 x64 以外的架构带后缀（`latest-linux-arm64.yml`）。 */
export function manifestFile(name: string, platform: NodeJS.Platform, arch: string): string {
  if (platform === 'darwin') return `${name}-mac.yml`;
  if (platform === 'linux')
    return arch === 'x64' ? `${name}-linux.yml` : `${name}-linux-${arch}.yml`;
  return `${name}.yml`;
}

/**
 * 校验清单的签名：`signature` 是 Ed25519 对清单原始字节的签名（base64，`<清单>.sig` 的内容），`publicKeys` 是内置的公钥
 * （SPKI DER 的 base64），任何一把验过就算通过，轮换时新旧两把都放进来。没有公钥时一律不通过。
 */
export function verifyManifest(
  manifest: Uint8Array,
  signature: string,
  publicKeys: readonly string[],
): boolean {
  const sig = Buffer.from(signature.trim(), 'base64');
  if (sig.length !== 64) return false;
  return publicKeys.some((key) => {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(key, 'base64'),
        format: 'der',
        type: 'spki',
      });
      return verify(null, manifest, publicKey, sig);
    } catch {
      return false;
    }
  });
}

/** 清单里用得到的部分（electron-updater 的 UpdateInfo）。 */
export interface ManifestInfo {
  version: string;
  files: { url: string; sha512: string; size?: number }[];
  releaseDate?: string;
  [key: string]: unknown;
}

/** 解析验过签的清单；缺版本、文件或校验值时报错。 */
export function parseManifest(text: string): ManifestInfo {
  const value = load(text) as Partial<ManifestInfo> | null;
  if (value === null || typeof value !== 'object')
    throw new Error('update manifest is not a mapping');
  if (typeof value.version !== 'string' || valid(value.version) === null) {
    throw new Error('update manifest has no valid version');
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error('update manifest lists no files');
  }
  for (const file of value.files) {
    if (typeof file?.url !== 'string' || typeof file.sha512 !== 'string') {
      throw new Error('update manifest has a file without url or sha512');
    }
    // 文件只能在发布目录里：相对路径，不许绝对地址或越级，下载走的线路就是取清单的那条。
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(file.url) ||
      file.url.startsWith('/') ||
      file.url.includes('..')
    ) {
      throw new Error(`update manifest points outside the release directory: ${file.url}`);
    }
  }
  return value as ManifestInfo;
}

/** 取一个地址的内容，网络错误或非 2xx 时抛错。 */
export type Fetcher = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: { cancel(): Promise<void> } | null;
}>;

/** 一条线路给出的结果。 */
export interface MirrorManifest {
  mirror: UpdateMirror;
  /** 这条线路上该通道版本最高的清单。 */
  info: ManifestInfo;
  /** 清单所在的发布目录。 */
  baseUrl: string;
  /** 取到并验完全部清单用的时间。 */
  latencyMs: number;
}

/** 为什么一条线路没有给出可用的清单。 */
export interface MirrorFailure {
  mirror: UpdateMirror;
  /** `empty`：这条线路上该通道的清单都不存在（还没发布过）。 */
  reason: 'network' | 'signature' | 'invalid' | 'empty';
  detail: string;
}

async function fetchBytes(fetcher: Fetcher, url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetcher(url, { signal, headers: { 'cache-control': 'no-cache' } });
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status} for ${url}`), {
      status: response.status,
    });
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** 在一条线路上取该通道的全部清单与签名，逐个验签，返回版本最高的那份。 */
export async function readMirror(options: {
  mirror: UpdateMirror;
  channel: UpdateChannel;
  platform: NodeJS.Platform;
  arch: string;
  publicKeys: readonly string[];
  fetcher: Fetcher;
  signal: AbortSignal;
  now?: () => number;
}): Promise<MirrorManifest> {
  const now = options.now ?? Date.now;
  const started = now();
  const baseUrl = feedUrl(options.mirror, options.platform, options.arch);
  const read = await Promise.all(
    channelNames(options.channel).map(async (name) => {
      const file = manifestFile(name, options.platform, options.arch);
      const url = manifestUrl(options.mirror, options.platform, options.arch, file);
      let text: Uint8Array;
      try {
        text = await fetchBytes(options.fetcher, url, options.signal);
      } catch (error) {
        // 某个通道还没发布过时没有它的清单（开发版没发过预发布时没有 beta，没发过正式版时没有 latest）：当这一份不存在。
        if ((error as { status?: unknown }).status === 404) return undefined;
        throw error;
      }
      const signature = await fetchBytes(options.fetcher, `${url}.sig`, options.signal);
      if (!verifyManifest(text, Buffer.from(signature).toString('utf8'), options.publicKeys)) {
        throw Object.assign(new Error(`signature check failed for ${file}`), {
          reason: 'signature',
        });
      }
      try {
        return parseManifest(Buffer.from(text).toString('utf8'));
      } catch (error) {
        throw Object.assign(error as Error, { reason: 'invalid' });
      }
    }),
  );
  const manifests = read.filter((manifest) => manifest !== undefined);
  if (manifests.length === 0) {
    throw Object.assign(new Error(`no ${options.channel} release published at ${baseUrl}`), {
      reason: 'empty',
    });
  }
  const info = manifests.reduce((best, next) =>
    compare(next.version, best.version) > 0 ? next : best,
  );
  return { mirror: options.mirror, info, baseUrl, latencyMs: now() - started };
}

function failureOf(mirror: UpdateMirror, error: unknown): MirrorFailure {
  const reason = (error as { reason?: unknown })?.reason;
  return {
    mirror,
    reason:
      reason === 'signature' || reason === 'invalid' || reason === 'empty' ? reason : 'network',
    detail: error instanceof Error ? error.message : String(error),
  };
}

/**
 * 先同时问所有主线路，第一条给出验过签的清单的胜出；其余的继续在后台跑完（`rest`，选下载线路时要用）。主线路都不行时
 * 再同样问后备线路。每一批各有 `timeoutMs`。都失败时抛出 `UpdateFeedError`，带上每条线路的原因。
 */
export async function raceMirrors(options: {
  mirrors: readonly UpdateMirror[];
  read: (mirror: UpdateMirror, signal: AbortSignal) => Promise<MirrorManifest>;
  timeoutMs: number;
}): Promise<{ first: MirrorManifest; rest: Promise<MirrorManifest[]> }> {
  const failures: MirrorFailure[] = [];
  const tiers = [
    options.mirrors.filter((mirror) => mirror.fallback !== true),
    options.mirrors.filter((mirror) => mirror.fallback === true),
  ];
  for (const tier of tiers) {
    if (tier.length === 0) continue;
    const won = await raceTier(tier, options.read, options.timeoutMs, failures);
    if (won !== undefined) return won;
  }
  throw new UpdateFeedError(failures);
}

async function raceTier(
  mirrors: readonly UpdateMirror[],
  read: (mirror: UpdateMirror, signal: AbortSignal) => Promise<MirrorManifest>,
  timeoutMs: number,
  failures: MirrorFailure[],
): Promise<{ first: MirrorManifest; rest: Promise<MirrorManifest[]> } | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('update check timed out')), timeoutMs);
  const attempts = mirrors.map((mirror) =>
    read(mirror, controller.signal).catch((error: unknown) => {
      failures.push(failureOf(mirror, error));
      throw error;
    }),
  );
  try {
    const first = await Promise.any(attempts);
    const rest = Promise.allSettled(attempts).then((results) => {
      clearTimeout(timer);
      return results.flatMap((result) =>
        result.status === 'fulfilled' && result.value !== first ? [result.value] : [],
      );
    });
    return { first, rest };
  } catch {
    clearTimeout(timer);
    return undefined;
  }
}

/** 所有线路都没给出可用的清单。 */
export class UpdateFeedError extends Error {
  readonly failures: readonly MirrorFailure[];
  constructor(failures: readonly MirrorFailure[]) {
    super(
      `no update mirror answered: ${failures.map((f) => `${f.mirror.id} ${f.reason} (${f.detail})`).join('; ')}`,
    );
    this.name = 'UpdateFeedError';
    this.failures = failures;
  }
  /** 有线路的清单验签失败（可能被篡改），与单纯连不上分开报。 */
  get tampered(): boolean {
    return this.failures.some((failure) => failure.reason === 'signature');
  }
  /** 每条线路都连上了，只是该通道还没发布过版本：没有可更新的，不算错误。 */
  get empty(): boolean {
    return this.failures.length > 0 && this.failures.every((failure) => failure.reason === 'empty');
  }
}

/** 测速时每条线路取安装包开头的这么多字节（Range 请求，不用额外的测速文件）。 */
export const PROBE_BYTES = 256 * 1024;

/**
 * 在给出同一版本的线路之间选下载线路：各取安装包开头 `PROBE_BYTES` 字节，按吞吐（字节 / 毫秒）选最快的。只比延迟不准：
 * 大陆访问部分国外 CDN 首字节不慢，带宽却很低。测速都失败时用最先给出清单的那条。
 */
export async function pickDownloadMirror(options: {
  candidates: readonly MirrorManifest[];
  file: (candidate: MirrorManifest) => string;
  fetcher: Fetcher;
  timeoutMs: number;
  now?: () => number;
}): Promise<{ chosen: MirrorManifest; bytesPerMs: Map<string, number> }> {
  const now = options.now ?? Date.now;
  const [fallback] = options.candidates;
  if (fallback === undefined) throw new Error('no download mirror candidates');
  const bytesPerMs = new Map<string, number>();
  if (options.candidates.length === 1) return { chosen: fallback, bytesPerMs };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('probe timed out')), options.timeoutMs);
  await Promise.all(
    options.candidates.map(async (candidate) => {
      const started = now();
      try {
        const response = await options.fetcher(options.file(candidate), {
          signal: controller.signal,
          headers: { range: `bytes=0-${PROBE_BYTES - 1}` },
        });
        // 不认 Range 的服务器会回整个安装包：不读，直接取消，这条线路不参加比较。
        if (response.status !== 206) {
          await response.body?.cancel().catch(() => {});
          return;
        }
        const size = (await response.arrayBuffer()).byteLength;
        bytesPerMs.set(candidate.mirror.id, size / Math.max(1, now() - started));
      } catch {
        // 测不了的线路不参加比较。
      }
    }),
  );
  clearTimeout(timer);
  let chosen = fallback;
  for (const candidate of options.candidates) {
    const speed = bytesPerMs.get(candidate.mirror.id) ?? -1;
    if (speed > (bytesPerMs.get(chosen.mirror.id) ?? -1)) chosen = candidate;
  }
  return { chosen, bytesPerMs };
}

/**
 * 清单里给当前平台下载的那个文件：macOS 是 zip（Squirrel.Mac 只认 zip），Windows 是安装程序，Linux 是 AppImage（清单里还有
 * deb，应用里不下载它）。
 */
export function installerFile(info: ManifestInfo, platform: NodeJS.Platform): string {
  const files = info.files.map((file) => file.url);
  const pick =
    platform === 'darwin'
      ? files.find((url) => url.endsWith('.zip'))
      : platform === 'win32'
        ? files.find((url) => url.endsWith('.exe'))
        : platform === 'linux'
          ? files.find((url) => url.endsWith('.AppImage'))
          : files[0];
  if (pick === undefined) throw new Error(`update manifest has no installer for ${platform}`);
  return pick;
}
