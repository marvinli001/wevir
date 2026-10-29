/**
 * 发布流水线（ADR-0007 补记 2 的第 3 步，.github/workflows/release.yml）的两个子命令：
 *
 *   node scripts/release.ts plan [<提交>]
 *     算出这次发布的通道与版本，写进 $GITHUB_OUTPUT（不在 Actions 里时打印）。GITHUB_REF_TYPE=tag 时是正式版，版本取
 *     tag `vX.Y.Z`；否则是开发版：上一个 `vX.Y.Z` tag 之后的 X.Y.(Z+1)-beta.N，N 是从那个 tag 到这个提交的 master
 *     提交数（--first-parent）；还没有 tag 时按 v0.0.0 算。master 被快进到一个以功能分支为第一父提交的合并时，
 *     first-parent 计数会变小，所以 N 至少取线路上已发布的同一预发布的号 + 1（读 PUBLISHED_DIRS 的公开清单）。
 *     提交正好是 tag 时 skip=true（那是正式版的事）。
 *
 *   node scripts/release.ts publish --channel dev|stable --version <版本> --dir <目录> [--only <线路>] [--skip-prune]
 *     <目录> 下每个子目录是一个平台（`darwin-arm64`、`darwin-x64`、`win32-x64`、`linux-x64`、`linux-arm64`，与 src/main/updates/feed.ts 的
 *     `<平台>-<架构>` 一致），里面是 electron-builder 的产物与签过名的清单（`<清单>.sig`，update-signing.ts sign）。
 *     上传到每条线路的 `desktop/<平台>-<架构>/`（GitHub 线路是 tag `desktop-updates` 的 Release，见 githubAssetName）：
 *       1. 安装包与 blockmap 传到所有线路；全球线路最先传，经 CDN 逐个下载核对，与本地一致才往下走（waitForCdn），
 *          再等 CDN_SETTLE_MS 让其他地区的存储副本跟上，这段时间里传其余线路（uploadInstallers）；S3 线路一次同时传
 *          几个文件，每次尝试按文件大小限时，挂住就杀掉重传（uploadTimeoutMs）；
 *       2. 都成功后核对每条线路上同通道的现有清单，版本不比这次低就整个停下（只许更高的版本覆盖）；
 *       3. 逐条线路写清单与 `.sig`，全球线路随后清 CDN 缓存（Bunny 的 S3 接口不收 Cache-Control）并同样核对；
 *       4. 清理：开发版与正式版各留最新的 KEEP_VERSIONS 个版本，再加上清单正引用的；以前的固定名字安装包也删掉。
 *          --skip-prune 时跳过，留给 prune 子命令（工作流先重建官网再清理）。
 *     安装包的名字都带版本，发出去就不再改写：Bunny 存储覆盖同名文件后，CDN 回源会在一段时间里拿到新旧混杂
 *     或不完整的内容（2026-10-16 固定名字的 dmg 就这样坏过），所以不再有覆盖写的安装包，下载页按清单链接。
 *     主线路是 GitHub Release 与 Cloudflare R2，Bunny（global）是后备（客户端主线路都不行时才用，见 feed.ts）；三条都传。
 *     线路的连接信息来自环境变量（见 MIRRORS），用 AWS CLI（GitHub 的 Ubuntu runner 自带）；GitHub 线路用 gh 与 GH_TOKEN。
 *
 *   node scripts/release.ts prune --dir <目录> [--only <线路>]
 *     只做 publish 的第 4 步，平台取 <目录> 下的子目录。
 *
 *   node scripts/release.ts cli --channel dev|stable --version <版本> --dir <目录> [--only <线路>]
 *     发命令行包（apps/cli/scripts/package.ts 的产物，平铺在 <目录> 里）：写校验和文件，传到每条线路的 `cli/`（GitHub 线路是 tag
 *     `cli` 的 Release），最后写安装脚本与通道文件 latest.txt / beta.txt，并清理旧版本。布局与顺序见 publishCli。
 *
 *   node scripts/release.ts android --channel dev|stable --version <版本> --dir <目录> [--only <线路>]
 *     发 Android 的 APK（apps/mobile/scripts/android-release.sh 的产物，release-dir.ts --android 放进 `<目录>/android/` 并签好清单
 *     `<通道>-android.yml`）：照 publish 的四步传到每条线路的 `android/`（GitHub 线路是 tag `android` 的 Release），清单的格式与
 *     签名同桌面端，下载页按它链接。版本与桌面端这次发布的相同。
 *
 *   node scripts/release.ts speech-models [--only <线路>]
 *     把听写的本机模型（packages/host/src/speech/install.ts 的 SENSE_VOICE_SMALL）从上游 sherpa-onnx 的 GitHub Release
 *     搬到三条线路：先下载并按写死的 sha256 核对，再传到 S3 线路的 `speech/<模型键>/<文件>` 与 GitHub 线路
 *     tag `speech-models` 的 Release（附件名 `<模型键>-<文件>`），最后逐个读回核对（GitHub 经公网地址，全球线路经 CDN 并先清缓存，R2 经 S3 接口）。
 *     只在换模型时跑（.github/workflows/speech-models.yml，手动触发）；同名文件整个重传，重跑无妨。
 *
 *   node scripts/release.ts office-engine [--only <线路>]
 *     把办公文档预览引擎（packages/host/src/office/engine.ts 的 OFFICE_ENGINE_PACKAGES，所有平台的包）从 npmjs 原样搬到
 *     三条线路：按写死的 sha512 核对，传到 S3 线路的 `office-engine/<文件>` 与 GitHub 线路 tag `office-engine` 的
 *     Release（文件名都是 npmMirrorAssetName），再像 speech-models 一样逐个读回核对。改了那张包表后跑一次
 *     （.github/workflows/office-engine.yml，手动触发）。
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  OFFICE_ENGINE_MIRRORS,
  OFFICE_ENGINE_PACKAGES,
  OFFICE_ENGINE_RELEASE_TAG,
} from '../../../packages/host/src/office/engine.ts';
import {
  SENSE_VOICE_SMALL,
  SPEECH_MIRRORS,
  SPEECH_RELEASE_TAG,
  type SpeechAsset,
  speechAssetPath,
} from '../../../packages/host/src/speech/install.ts';
import type { NpmClosurePackage } from '../../../packages/runtime-adapter/src/npm-closure.ts';
import { npmMirrorAssetName } from '../../../packages/runtime-adapter/src/npm-mirror.ts';

export type Channel = 'stable' | 'dev';

/** 每个平台目录里开发版、正式版各保留的版本数（不算清单正引用的）。 */
export const KEEP_VERSIONS = 2;

// ---------- 版本 ----------

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** semver 的先后（只用到 X.Y.Z 与 X.Y.Z-pre）；不是合法版本时抛错。 */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (pa === null || pb === null) throw new Error(`not a version: ${pa === null ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  const [preA, preB] = [pa[4], pb[4]];
  if (preA === undefined || preB === undefined) {
    return preA === preB ? 0 : preA === undefined ? 1 : -1;
  }
  const idsA = preA.split('.');
  const idsB = preB.split('.');
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
    const [x, y] = [idsA[i], idsB[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return Math.sign(diff);
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 正式版的 tag（`vX.Y.Z`）对应的版本；不是这个形状时返回 undefined。 */
export function stableVersionOfTag(tag: string): string | undefined {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  return match?.[1];
}

/** 开发版的版本：上一个正式版之后的下一个补丁号的第 `commits` 个预发布。 */
export function devVersion(lastStable: string, commits: number): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(lastStable);
  if (match === null) throw new Error(`not a stable version: ${lastStable}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}-beta.${commits}`;
}

/**
 * 开发版的 N：first-parent 计数与线路上已发布的同一预发布（同一个 X.Y.(Z+1)-beta）的最大号 + 1 中取大的，
 * 免得 first-parent 线变短后算出比线上低的版本、发布时被“只许更高的版本覆盖”拦下。别的预发布的版本不算。
 */
export function devBuildNumber(
  lastStable: string,
  commits: number,
  published: readonly string[],
): number {
  const prefix = devVersion(lastStable, 0).replace(/0$/, '');
  let next = commits;
  for (const version of published) {
    if (!version.startsWith(prefix)) continue;
    const n = Number(version.slice(prefix.length));
    if (Number.isInteger(n) && n + 1 > next) next = n + 1;
  }
  return next;
}

// ---------- 发布目录 ----------

/** electron-builder 的通道名：正式版 latest，开发版 beta（与 feed.ts 的 channelNames 相同）。 */
export function channelName(channel: Channel): 'latest' | 'beta' {
  return channel === 'stable' ? 'latest' : 'beta';
}

/**
 * 平台目录（`darwin-arm64`）里这个通道的清单文件名（与 feed.ts 的 manifestFile 相同：Linux 的 arm64 带架构后缀）。
 * Android 的目录是 `android`（ANDROID_PLATFORM_DIR），清单 `<通道>-android.yml`。
 */
export function manifestFile(name: string, platformDir: string): string {
  if (platformDir === ANDROID_PLATFORM_DIR) return `${name}-android.yml`;
  if (platformDir.startsWith('darwin-')) return `${name}-mac.yml`;
  if (platformDir === 'linux-x64') return `${name}-linux.yml`;
  if (platformDir.startsWith('linux-')) return `${name}-${platformDir}.yml`;
  return `${name}.yml`;
}

/** 清单里的版本与列出的文件（相对路径）。只读这两样，不引 YAML 解析器。 */
export function readManifest(text: string): { version: string; files: string[] } {
  const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1];
  if (version === undefined) throw new Error('manifest has no version');
  const files = [...text.matchAll(/^\s*-?\s*url:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map(
    (match) => match[1] as string,
  );
  return { version, files: [...new Set(files)] };
}

/**
 * 安装包文件名里的版本（artifactName 是 `Wevir-<版本>-<mac|win|linux>-…`，Android 是 `Wevir-<版本>-android.apk`）；清单、签名等
 * 不是安装包的返回 undefined。
 */
export function versionOfFile(name: string): string | undefined {
  return /^Wevir-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(?:(?:mac|win|linux)-|android\.apk$)/.exec(
    name,
  )?.[1];
}

/**
 * 以前每次发布覆盖写的固定名字安装包（`Wevir-beta-mac-arm64.dmg`、`Wevir-latest-win-x64-setup.exe`）。
 * 已不再生成（见文件头），清理时删掉，免得旧链接一直拿到旧版本或坏掉的缓存。
 */
export function isLegacyAlias(name: string): boolean {
  return /^Wevir-(?:latest|beta)-(?:mac|win|linux)-/.test(name);
}

/**
 * 清理时要删的文件：开发版（预发布）与正式版分开算，各留最新的 `keep` 个，`referenced`（现有清单引用的版本）也留下；
 * 以前的固定名字安装包都删；清单、签名与认不出版本的文件不动。
 */
export function filesToPrune(
  names: readonly string[],
  referenced: ReadonlySet<string>,
  keep: number,
  versionOf: (name: string) => string | undefined = versionOfFile,
): string[] {
  const versions = [
    ...new Set(names.map(versionOf).filter((v): v is string => v !== undefined)),
  ].sort((a, b) => compareVersions(b, a));
  const newest = (prerelease: boolean) =>
    versions.filter((v) => v.includes('-') === prerelease).slice(0, keep);
  const kept = new Set([...referenced, ...newest(true), ...newest(false)]);
  return names.filter((name) => {
    if (isLegacyAlias(name)) return true;
    const version = versionOf(name);
    return version !== undefined && !kept.has(version);
  });
}

/** 一个平台目录里要上传的东西：安装包与 blockmap，以及这个通道的清单和签名。 */
export interface PlatformRelease {
  dir: string;
  manifest: string;
  /** 清单与 `.sig` 以外的文件。 */
  payload: string[];
}

/** 检查一个平台目录：清单是这个通道与版本的，列出的文件都在，签名在。 */
export function checkPlatformDir(
  platformDir: string,
  names: readonly string[],
  manifestText: string,
  channel: Channel,
  version: string,
): PlatformRelease {
  const manifest = manifestFile(channelName(channel), platformDir);
  if (!names.includes(manifest)) throw new Error(`${platformDir}: ${manifest} is missing`);
  if (!names.includes(`${manifest}.sig`))
    throw new Error(`${platformDir}: ${manifest}.sig is missing`);
  const info = readManifest(manifestText);
  if (info.version !== version) {
    throw new Error(`${platformDir}: ${manifest} has version ${info.version}, expected ${version}`);
  }
  for (const file of info.files) {
    if (!names.includes(file))
      throw new Error(`${platformDir}: ${file} listed in ${manifest} is missing`);
  }
  // 安装包（dmg、zip、exe、AppImage、deb）与它们的 blockmap，文件名里都带版本。
  const payload = names.filter((name) => versionOfFile(name) === version);
  return { dir: platformDir, manifest, payload };
}

// ---------- 线路 ----------

export interface Mirror {
  id: string;
  /** 客户端访问的根地址（feed.ts 的 UPDATE_MIRRORS）。 */
  publicUrl: string;
  /** 环境变量前缀，`<前缀>_S3_ENDPOINT` 等。 */
  env: string;
  /** 这条线路的 S3 接口收 Cache-Control（R2 收，Bunny 不收）：清单与签名写 no-cache，安装包按不变的文件长期缓存。 */
  cacheControl?: true;
}

/**
 * S3 线路。要 `<前缀>_S3_ENDPOINT`、`_S3_BUCKET`、`_S3_ACCESS_KEY_ID`、`_S3_SECRET_ACCESS_KEY`，可选 `_S3_REGION`。
 * 两条线路的桶都是公网地址的根，键是 `desktop/<平台>-<架构>/<文件>`：
 *   - r2：Cloudflare R2（自定义域名 dl.edgeweir.com），与 GitHub 线路同为主线路。接口
 *     `https://<账户 ID>.r2.cloudflarestorage.com`，区域 auto（us-east-1 是它的别名）；R2 强一致，不用经 CDN 核对。
 *   - global：Bunny Storage 的 S3 接口（拉取区 download.wevir.si），后备线路；设了 BUNNY_API_KEY 时经 CDN 核对并清缓存。
 */
export const MIRRORS: readonly Mirror[] = [
  { id: 'r2', publicUrl: 'https://dl.edgeweir.com', env: 'WEVIR_R2', cacheControl: true },
  { id: 'global', publicUrl: 'https://download.wevir.si', env: 'WEVIR_GLOBAL' },
];

interface MirrorTarget extends Mirror {
  bucket: string;
  awsEnv: NodeJS.ProcessEnv;
}

function mirrorTarget(mirror: Mirror, env: NodeJS.ProcessEnv): MirrorTarget {
  const read = (name: string, required = true): string => {
    const value = env[`${mirror.env}_${name}`]?.trim() ?? '';
    if (required && value === '') throw new Error(`${mirror.env}_${name} is not set`);
    return value;
  };
  return {
    ...mirror,
    bucket: read('S3_BUCKET'),
    awsEnv: {
      PATH: env.PATH,
      HOME: env.HOME,
      AWS_ACCESS_KEY_ID: read('S3_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: read('S3_SECRET_ACCESS_KEY'),
      AWS_ENDPOINT_URL: read('S3_ENDPOINT'),
      AWS_REGION: read('S3_REGION', false) || 'us-east-1',
      // AWS CLI 2.23 起默认给每个请求加 CRC32 校验，Bunny 只认 SHA256；只在接口要求时才算（R2 两样都认）。
      AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
      AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_PAGER: '',
    },
  };
}

/** 列表、删除等不传大文件的 aws 调用的上限。 */
const AWS_CALL_TIMEOUT_MS = 5 * 60_000;

/**
 * 上传一个文件的单次尝试最多等多久：按最低 2 MiB/s 算再加 1 分钟。Bunny 的 S3 接口时不时把一次 PutObject 挂住
 * 不回（2026-10-22 beta.387、beta.388 的发布里五个 200 多 MB 的安装包有两三个这样），正常时同样的文件 15–30 秒传完，
 * 重传一次也是这么快；以前固定等 15 分钟才重试，两三次挂住就把 1 小时的任务时限用完了。
 */
export function uploadTimeoutMs(bytes: number): number {
  return 60_000 + Math.ceil(bytes / (2 * 1024 * 1024)) * 1000;
}
const UPLOAD_ATTEMPTS = 4;
/** 一条 S3 线路同时传几个文件（GitHub 线路一次一个）。单个连接从 runner 到 Bunny 新加坡只有十几 MB/s。 */
const S3_UPLOAD_CONCURRENCY = 3;

function aws(mirror: MirrorTarget, args: readonly string[]): string {
  return execFileSync('aws', args, {
    env: mirror.awsEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: AWS_CALL_TIMEOUT_MS,
  });
}

/** 异步跑一个命令（上传时几条线路、几个文件同时传），超时就杀掉；失败时错误里带 stderr 的最后一行。 */
function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs },
      (error, _stdout, stderr) => {
        if (error === null) return resolve();
        const reason = error.killed
          ? `timed out after ${Math.round(timeoutMs / 1000)}s`
          : stderr.trim().split('\n').at(-1) || error.message;
        reject(new Error(reason));
      },
    );
  });
}

/**
 * 整个文件重传是幂等的（PutObject、`gh release upload --clobber`），挂住或失败就重来，最多 UPLOAD_ATTEMPTS 次。
 * 每次的错误与用时都打出来，下次再慢能看出是哪条线路、哪种失败。
 */
async function withRetries(label: string, attempt: () => Promise<void>): Promise<void> {
  const started = Date.now();
  for (let n = 1; ; n++) {
    try {
      await attempt();
      break;
    } catch (error) {
      if (n >= UPLOAD_ATTEMPTS) throw new Error(`${label}: ${String(error)}`);
      console.log(`${label}: attempt ${n} failed (${String(error).split('\n')[0]}); retrying`);
    }
  }
  console.log(`${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

/** 对 `items` 逐个跑 `fn`，同时最多 `limit` 个；有一个失败就不再开始新的，等在跑的跑完后抛出第一个错误。 */
export async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (failure === undefined && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
}

/**
 * 清单与签名每次发布都改写，不许缓存，命令行包的通道文件与安装脚本（`CLI_MUTABLE_FILES`）也是；安装包、blockmap、命令行包与它的
 * 校验和文件的名字带版本，发出去就不再变。
 */
export function cacheControlOf(name: string): string {
  return name.endsWith('.yml') || name.endsWith('.sig') || CLI_MUTABLE_FILES.includes(name)
    ? 'no-cache'
    : 'public, max-age=31536000, immutable';
}

function contentType(name: string): string {
  if (name.endsWith('.yml')) return 'text/yaml; charset=utf-8';
  if (name.endsWith('.sig')) return 'text/plain; charset=utf-8';
  if (name.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (name.endsWith('.zip')) return 'application/zip';
  if (name.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (name.endsWith('.deb')) return 'application/vnd.debian.binary-package';
  if (name.endsWith('.AppImage')) return 'application/vnd.appimage';
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return 'application/gzip';
  // 通道文件、校验和与安装脚本按纯文本给，浏览器里能直接看。
  if (/\.(?:txt|sh|ps1)$/.test(name)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * 每个文件都用一次 PutObject 整个传（S3 单次上限 5 GB），不分片：Bunny 把分片上传的文件复制到其他地区的存储副本时
 * 会丢片或混进旧的分片（2026-10-16 悉尼副本上 beta.210 的 arm64 dmg 正好少了一个 8 MiB 的分片，CDN 清缓存后回源
 * 仍是坏的）。R2 也照这样传。Bunny 的 S3 接口不收 Cache-Control，清单靠写完后清 CDN 缓存。
 */
function upload(mirror: MirrorTarget, file: string, key: string): Promise<void> {
  const timeoutMs = uploadTimeoutMs(statSync(file).size);
  return withRetries(`[${mirror.id}] ${key}`, () => putObject(mirror, file, key, timeoutMs));
}

function putObject(
  mirror: MirrorTarget,
  file: string,
  key: string,
  timeoutMs: number,
): Promise<void> {
  const name = key.slice(key.lastIndexOf('/') + 1);
  // AWS CLI 自己的重试是静默的，会把一次挂住拖成很多次；这里只发一次请求，读超时 60 秒，重试由 withRetries 做并打出原因。
  const env = { ...mirror.awsEnv, AWS_MAX_ATTEMPTS: '1' };
  return run(
    'aws',
    [
      '--cli-connect-timeout',
      '30',
      '--cli-read-timeout',
      '60',
      's3api',
      'put-object',
      '--bucket',
      mirror.bucket,
      '--key',
      key,
      '--body',
      file,
      '--content-type',
      contentType(name),
      ...(mirror.cacheControl ? ['--cache-control', cacheControlOf(name)] : []),
      '--output',
      'json',
    ],
    env,
    timeoutMs,
  );
}

/** 线路上现有的文件；没有时返回 undefined（404），别的错误照抛。 */
function download(mirror: MirrorTarget, key: string): string | undefined {
  const result = spawnSync(
    'aws',
    ['s3', 'cp', `s3://${mirror.bucket}/${key}`, '-', '--only-show-errors'],
    {
      env: mirror.awsEnv,
      encoding: 'utf8',
      timeout: AWS_CALL_TIMEOUT_MS,
    },
  );
  if (result.error)
    throw new Error(`[${mirror.id}] reading ${key} failed: ${result.error.message}`);
  if (result.status === 0) return result.stdout;
  if (/\b404\b|NoSuchKey|Not Found/i.test(result.stderr)) return undefined;
  throw new Error(`[${mirror.id}] reading ${key} failed: ${result.stderr.trim()}`);
}

function list(mirror: MirrorTarget, prefix: string): string[] {
  const out = aws(mirror, [
    's3api',
    'list-objects-v2',
    '--bucket',
    mirror.bucket,
    '--prefix',
    prefix,
    '--output',
    'json',
  ]);
  if (out.trim() === '') return [];
  const contents = (JSON.parse(out) as { Contents?: { Key: string }[] }).Contents ?? [];
  return contents
    .map((item) => item.Key.slice(prefix.length))
    .filter((name) => name !== '' && !name.includes('/'));
}

/** 一条线路上的操作，`dir` 是平台目录（`darwin-arm64`），`name` 是目录里的文件名。 */
interface Line {
  id: string;
  /** 文件的公网地址（客户端与 CDN 核对用）。 */
  url(dir: string, name: string): string;
  upload(dir: string, name: string, file: string): Promise<void>;
  /** 安装包同时传几个（清单与签名总是一个一个按顺序写）。 */
  concurrency: number;
  /** 现有文件的内容；没有时返回 undefined。 */
  read(dir: string, name: string): string | undefined;
  list(dir: string): string[];
  remove(dir: string, name: string): void;
}

/** 桶里的键：`<root>/<dir>/<name>`，`dir` 为空时（命令行包）是 `<root>/<name>`。 */
function s3Key(root: string, dir: string, name: string): string {
  return [root, dir, name].filter((part) => part !== '').join('/');
}

function s3Line(mirror: MirrorTarget, root = 'desktop'): Line {
  const key = (dir: string, name: string) => s3Key(root, dir, name);
  return {
    id: mirror.id,
    url: (dir, name) => `${mirror.publicUrl}/${key(dir, name)}`,
    upload: (dir, name, file) => upload(mirror, file, key(dir, name)),
    concurrency: S3_UPLOAD_CONCURRENCY,
    read: (dir, name) => download(mirror, key(dir, name)),
    list: (dir) => list(mirror, `${s3Key(root, dir, '')}/`),
    remove: (dir, name) => {
      aws(mirror, ['s3api', 'delete-object', '--bucket', mirror.bucket, '--key', key(dir, name)]);
      console.log(`[${mirror.id}] deleted ${key(dir, name)}`);
    },
  };
}

// ---------- GitHub 线路 ----------

/** GitHub 线路的 Release（与 src/main/updates/feed.ts 的 GITHUB_MIRROR_URL 一致）：滚动的预发布，只放更新用的文件。 */
export const GITHUB_TAG = 'desktop-updates';
const GITHUB_REPO = 'marvinli001/wevir';

const MANIFEST_NAME = /^(?:latest|beta)(?:-mac|-linux(?:-arm64)?)?\.yml(?:\.sig)?$/;

/** 安装包与 blockmap 的名字里的平台目录：`Wevir-0.1.0-mac-arm64.zip` → `darwin-arm64`，`…-win-x64-setup.exe` → `win32-x64`。 */
export function platformDirOfFile(name: string): string | undefined {
  const match = /^Wevir-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-(mac|win|linux)-([0-9a-z_]+)[-.]/.exec(
    name,
  );
  if (match === null) return undefined;
  const os = { mac: 'darwin', win: 'win32', linux: 'linux' }[match[1] as 'mac' | 'win' | 'linux'];
  return `${os}-${match[2]}`;
}

/**
 * Release 的附件没有目录：清单与签名前加 `<平台目录>-`（`darwin-arm64-latest-mac.yml`），安装包与 blockmap 照原名，
 * 它们的名字本来就带平台与架构，清单里的相对路径与差分下载找旧 blockmap 的地址都照样对。
 */
export function githubAssetName(dir: string, name: string): string {
  if (MANIFEST_NAME.test(name)) return `${dir}-${name}`;
  if (platformDirOfFile(name) === dir) return name;
  throw new Error(`${dir}/${name} cannot be a release asset: its name does not carry ${dir}`);
}

/** 附件里属于平台目录 `dir` 的文件，按目录里的名字给出（githubAssetName 的反面）。 */
export function githubDirListing(assets: readonly string[], dir: string): string[] {
  return assets.flatMap((asset) => {
    if (asset.startsWith(`${dir}-`) && MANIFEST_NAME.test(asset.slice(dir.length + 1))) {
      return [asset.slice(dir.length + 1)];
    }
    return platformDirOfFile(asset) === dir ? [asset] : [];
  });
}

/** GitHub 线路用的 Release：tag、新建时的标题与说明，以及目录里的文件与附件名的对应。 */
interface GithubRelease {
  tag: string;
  title: string;
  notes: string;
  assetName(dir: string, name: string): string;
  dirListing(assets: readonly string[], dir: string): string[];
}

const DESKTOP_RELEASE: GithubRelease = {
  tag: GITHUB_TAG,
  title: 'Desktop update feed',
  notes:
    'Files for the in-app updater (manifests, installers and blockmaps of the newest builds). Download Wevir from the versioned releases or https://wevir.si.',
  assetName: githubAssetName,
  dirListing: githubDirListing,
};

interface GithubAsset {
  id: number;
  name: string;
  size: number;
  /** GitHub 算的 `sha256:<hex>`，旧附件可能没有。 */
  digest?: string | null;
}

function githubLine(env: NodeJS.ProcessEnv, release: GithubRelease = DESKTOP_RELEASE): Line {
  if (!env.GH_TOKEN?.trim() && !env.GITHUB_TOKEN?.trim()) throw new Error('GH_TOKEN is not set');
  const repo = env.GITHUB_REPOSITORY?.trim() || GITHUB_REPO;
  const gh = (args: readonly string[]) =>
    execFileSync('gh', args, {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: AWS_CALL_TIMEOUT_MS,
    });
  let releaseId: number | undefined;
  let assets: GithubAsset[] | undefined;
  const findRelease = (create: boolean): number | undefined => {
    if (releaseId !== undefined) return releaseId;
    const found = spawnSync(
      'gh',
      ['api', `repos/${repo}/releases/tags/${release.tag}`, '--jq', '.id'],
      {
        env,
        encoding: 'utf8',
        timeout: AWS_CALL_TIMEOUT_MS,
      },
    );
    if (found.error)
      throw new Error(`[github] reading release ${release.tag} failed: ${found.error.message}`);
    if (found.status === 0) {
      releaseId = Number(found.stdout.trim());
      return releaseId;
    }
    if (!/\b404\b|Not Found/i.test(found.stderr)) {
      throw new Error(`[github] reading release ${release.tag} failed: ${found.stderr.trim()}`);
    }
    if (!create) return undefined;
    // 预发布、不标 Latest：仓库的 Releases 页上“最新版本”仍是正式版的 vX.Y.Z。
    gh([
      'release',
      'create',
      release.tag,
      '--repo',
      repo,
      '--target',
      env.WEVIR_RELEASE_SHA?.trim() || env.GITHUB_SHA?.trim() || 'master',
      '--prerelease',
      '--latest=false',
      '--title',
      release.title,
      '--notes',
      release.notes,
    ]);
    console.log(`[github] created release ${release.tag}`);
    return findRelease(false);
  };
  const listAssets = (): GithubAsset[] => {
    if (assets !== undefined) return assets;
    const id = findRelease(false);
    if (id === undefined) return [];
    const out = gh([
      'api',
      '--paginate',
      `repos/${repo}/releases/${id}/assets?per_page=100`,
      '--jq',
      '.[] | {id, name, size, digest}',
    ]);
    assets = out
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as GithubAsset);
    return assets;
  };
  const asset = (dir: string, name: string) =>
    listAssets().find((a) => a.name === release.assetName(dir, name));
  return {
    id: 'github',
    url: (dir, name) =>
      `https://github.com/${repo}/releases/download/${release.tag}/${release.assetName(dir, name)}`,
    concurrency: 1,
    async upload(dir, name, file) {
      const assetName = release.assetName(dir, name);
      findRelease(true);
      // gh 用文件名做附件名：清单要换成带平台前缀的名字，先复制一份。
      const temp = assetName === name ? undefined : mkdtempSync(join(tmpdir(), 'wevir-release-'));
      const path = temp === undefined ? file : join(temp, assetName);
      if (temp !== undefined) copyFileSync(file, path);
      const size = statSync(file).size;
      try {
        await withRetries(`[github] ${assetName}`, () =>
          run(
            'gh',
            ['release', 'upload', release.tag, path, '--repo', repo, '--clobber'],
            env,
            uploadTimeoutMs(size),
          ),
        );
      } finally {
        if (temp !== undefined) rmSync(temp, { recursive: true, force: true });
      }
      assets = undefined;
      // 核对 GitHub 收到的大小与 sha256（GitHub 给附件算 digest）。
      const uploaded = asset(dir, name);
      if (uploaded === undefined || uploaded.size !== size) {
        throw new Error(
          `[github] ${assetName}: uploaded ${uploaded?.size ?? 'nothing'}, expected ${size} bytes`,
        );
      }
      const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
      if (uploaded.digest?.startsWith('sha256:') && uploaded.digest !== `sha256:${sha256}`) {
        throw new Error(
          `[github] ${assetName}: GitHub has ${uploaded.digest}, expected sha256:${sha256}`,
        );
      }
    },
    read(dir, name) {
      const found = asset(dir, name);
      if (found === undefined) return undefined;
      return gh([
        'api',
        '-H',
        'Accept: application/octet-stream',
        `repos/${repo}/releases/assets/${found.id}`,
      ]);
    },
    list: (dir) =>
      release.dirListing(
        listAssets().map((a) => a.name),
        dir,
      ),
    remove(dir, name) {
      const assetName = release.assetName(dir, name);
      gh(['release', 'delete-asset', release.tag, assetName, '--repo', repo, '--yes']);
      assets = undefined;
      console.log(`[github] deleted ${assetName}`);
    },
  };
}

/** `--only` 认的线路。 */
export const LINE_IDS: readonly string[] = [...MIRRORS.map((mirror) => mirror.id), 'github'];

async function purgeBunny(urls: readonly string[], apiKey: string, quiet = false): Promise<void> {
  for (const url of urls) {
    const response = await fetch(
      `https://api.bunny.net/purge?url=${encodeURIComponent(url)}&async=false`,
      {
        method: 'POST',
        headers: { AccessKey: apiKey },
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) throw new Error(`purging ${url} failed: HTTP ${response.status}`);
    if (!quiet) console.log(`[global] purged ${url}`);
  }
}

// ---------- CDN 核对 ----------

/** 经 CDN 核对一个文件最多等多久；Bunny 存储写完后，各地副本几分钟内才一致。 */
export const CDN_CHECK_TIMEOUT_MS = 20 * 60_000;
/** 两次核对之间的间隔。 */
export const CDN_RETRY_MS = 30_000;
/** 全球线路的安装包都核对过后，再等这么久让其他地区的存储副本跟上，然后清一次缓存才写清单。 */
export const CDN_SETTLE_MS = 3 * 60_000;

/** 文件的大小与 sha512（base64，与 electron-builder 清单的写法相同）。 */
export interface Digest {
  size: number;
  sha512: string;
}

async function digestOf(chunks: AsyncIterable<Uint8Array>): Promise<Digest> {
  const hash = createHash('sha512');
  let size = 0;
  for await (const chunk of chunks) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  return { size, sha512: hash.digest('base64') };
}

export function fileDigest(path: string): Promise<Digest> {
  return digestOf(createReadStream(path));
}

export interface CdnCheck {
  /** 下载公网地址，返回内容的大小与 sha512；HTTP 出错时抛错。 */
  fetchDigest(url: string): Promise<Digest>;
  purge(url: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

/**
 * 逐个清缓存、经 CDN 下载并核对，直到内容与本地一致；超过 `timeoutMs` 还对不上就抛错（这次发布停在写清单之前）。
 * 每次先清再取，CDN 就会重新回源，而不是一直给出第一次回源时缓存下来的半截或旧内容。
 */
export async function waitForCdn(
  files: readonly { url: string; expected: Digest }[],
  check: CdnCheck,
  timeoutMs = CDN_CHECK_TIMEOUT_MS,
): Promise<void> {
  const deadline = check.now() + timeoutMs;
  for (const { url, expected } of files) {
    for (let attempt = 1; ; attempt++) {
      await check.purge(url);
      let problem: string;
      try {
        const got = await check.fetchDigest(url);
        if (got.size === expected.size && got.sha512 === expected.sha512) {
          check.log(`[global] verified ${url}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
          break;
        }
        problem =
          got.size === expected.size
            ? 'content differs'
            : `${got.size} bytes, expected ${expected.size}`;
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      if (check.now() + CDN_RETRY_MS > deadline) {
        throw new Error(
          `${url} still does not match the upload after ${Math.round(timeoutMs / 60_000)} minutes (${problem})`,
        );
      }
      check.log(`[global] ${url}: ${problem}; retrying`);
      await check.sleep(CDN_RETRY_MS);
    }
  }
}

function bunnyCheck(apiKey: string): CdnCheck {
  return {
    async fetchDigest(url) {
      // 整个下载（含读完正文）的上限；超时与其他失败一样算这次没对上，在 CDN_CHECK_TIMEOUT_MS 之内重取。
      const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      return digestOf(response.body);
    },
    purge: (url) => purgeBunny([url], apiKey, true),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (line) => console.log(line),
  };
}

/**
 * 第 1 步：安装包传到所有线路。全球线路排最前：传完、经 CDN 核对过（`global.verify`）就开始等其他地区的存储副本
 * （CDN_SETTLE_MS），这段等待与其余线路的上传同时进行，等满后清一次缓存（`global.purge`）才返回。等待从核对完算起，
 * 与以前先传完所有线路再干等一样长，只是不再白等。其余线路之间同时传；没有 `global`（不是全球线路或没有 Bunny 密钥）时
 * 所有线路一起传。全球线路核对失败时其余线路一个也不传。
 */
export async function uploadInstallers<L extends { id: string }>(
  lines: readonly L[],
  steps: {
    upload(line: L): Promise<void>;
    global?: { verify(): Promise<void>; purge(): Promise<void> };
    sleep(ms: number): Promise<void>;
    log(line: string): void;
  },
): Promise<void> {
  const globalLine = steps.global && lines.find((line) => line.id === 'global');
  let settled: Promise<void> | undefined;
  if (globalLine && steps.global) {
    await steps.upload(globalLine);
    await steps.global.verify();
    steps.log(
      `[global] waiting ${CDN_SETTLE_MS / 1000}s for the other storage regions (the other lines upload meanwhile)`,
    );
    settled = steps.sleep(CDN_SETTLE_MS);
  }
  // 其余线路同时传（各自的 concurrency 决定一条线路里同时传几个）。
  await Promise.all(lines.filter((line) => line !== globalLine).map((line) => steps.upload(line)));
  if (settled !== undefined && steps.global) {
    await settled;
    await steps.global.purge();
  }
}

/** `<目录>` 下的平台子目录。 */
function platformDirs(dir: string): string[] {
  const dirs = readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
  if (dirs.length === 0) throw new Error(`${dir} has no platform directories`);
  return dirs;
}

/** 要传的线路：全部，或 `--only` 指定的那一条。默认是桌面端的发布目录，命令行包另给桶里的目录与 Release。 */
function selectLines(
  only: string | undefined,
  target: { root: string; release: GithubRelease } = {
    root: 'desktop',
    release: DESKTOP_RELEASE,
  },
): Line[] {
  const wanted = (id: string) => only === undefined || id === only;
  const lines: Line[] = [
    ...MIRRORS.filter((mirror) => wanted(mirror.id)).map((mirror) =>
      s3Line(mirrorTarget(mirror, process.env), target.root),
    ),
    ...(wanted('github') ? [githubLine(process.env, target.release)] : []),
  ];
  if (lines.length === 0) throw new Error(`unknown mirror ${only}; one of ${LINE_IDS.join(', ')}`);
  return lines;
}

async function publish(options: {
  channel: Channel;
  version: string;
  dir: string;
  only?: string;
  skipPrune?: boolean;
  /** 桶里的目录与 GitHub 线路的 Release；默认是桌面端的。 */
  target?: { root: string; release: GithubRelease };
}): Promise<void> {
  const releases: PlatformRelease[] = platformDirs(options.dir).map((platformDir) => {
    const names = readdirSync(join(options.dir, platformDir));
    const manifest = manifestFile(channelName(options.channel), platformDir);
    const text = names.includes(manifest)
      ? readFileSync(join(options.dir, platformDir, manifest), 'utf8')
      : '';
    return checkPlatformDir(platformDir, names, text, options.channel, options.version);
  });
  const mirrors = selectLines(options.only, options.target);

  // 只许更高的版本覆盖：哪条线路上已有不低于这次的清单，一份清单都不写。上传前查一次（免得白传），写清单前再查一次。
  const checkNewer = (): void => {
    for (const mirror of mirrors) {
      for (const release of releases) {
        const current = mirror.read(release.dir, release.manifest);
        if (current === undefined) continue;
        const existing = readManifest(current).version;
        if (compareVersions(existing, options.version) >= 0) {
          throw new Error(
            `[${mirror.id}] ${release.dir}/${release.manifest} is already ${existing}; not overwriting it with ${options.version}`,
          );
        }
      }
    }
  };
  checkNewer();

  // 1. 安装包先到所有线路。全球线路：经 CDN 取回每个安装包，与本地一致了才写清单；客户端与下载页只在清单出现后才会请求它们。
  const bunnyKey = process.env.BUNNY_API_KEY?.trim();
  const globalLine = mirrors.find((mirror) => mirror.id === 'global');
  const publicFiles = async (mirror: Line, release: PlatformRelease, names: string[]) =>
    Promise.all(
      names.map(async (name) => ({
        url: mirror.url(release.dir, name),
        expected: await fileDigest(join(options.dir, release.dir, name)),
      })),
    );
  if (globalLine && !bunnyKey) {
    console.warn('[global] BUNNY_API_KEY is not set: installers are not checked through the CDN');
  }
  let installers: { url: string; expected: Digest }[] = [];
  await uploadInstallers(mirrors, {
    upload: (mirror) =>
      forEachLimit(
        releases.flatMap((release) => release.payload.map((name) => ({ release, name }))),
        mirror.concurrency,
        ({ release, name }) =>
          mirror.upload(release.dir, name, join(options.dir, release.dir, name)),
      ),
    global:
      globalLine && bunnyKey
        ? {
            async verify() {
              installers = (
                await Promise.all(
                  releases.map((release) => publicFiles(globalLine, release, release.payload)),
                )
              ).flat();
              await waitForCdn(installers, bunnyCheck(bunnyKey));
            },
            purge: () =>
              purgeBunny(
                installers.map((file) => file.url),
                bunnyKey,
              ),
          }
        : undefined,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
  });

  // 2. 都传完了，再核对一次版本。
  checkNewer();

  // 3. 写清单与签名（先清单后签名，两次写之间只隔一个请求），全球线路再清 CDN 缓存并核对。
  for (const mirror of mirrors) {
    const written: string[] = [];
    for (const release of releases) {
      for (const name of [release.manifest, `${release.manifest}.sig`]) {
        await mirror.upload(release.dir, name, join(options.dir, release.dir, name));
        written.push(mirror.url(release.dir, name));
      }
    }
    if (mirror.id === 'global' && bunnyKey) {
      await purgeBunny(written, bunnyKey);
      const manifests = await Promise.all(
        releases.map((release) =>
          publicFiles(mirror, release, [release.manifest, `${release.manifest}.sig`]),
        ),
      );
      await waitForCdn(manifests.flat(), bunnyCheck(bunnyKey));
    }
  }

  // 4. 清理旧版本的安装包（--skip-prune 时由之后的 prune 子命令做）。
  if (!options.skipPrune)
    prune(
      mirrors,
      releases.map((release) => release.dir),
    );
}

function prune(mirrors: readonly Line[], platformDirs: readonly string[]): void {
  for (const mirror of mirrors) {
    for (const dir of platformDirs) {
      const names = mirror.list(dir);
      const referenced = new Set<string>();
      for (const channel of ['latest', 'beta'] as const) {
        const text = mirror.read(dir, manifestFile(channel, dir));
        if (text !== undefined) referenced.add(readManifest(text).version);
      }
      for (const name of filesToPrune(names, referenced, KEEP_VERSIONS)) mirror.remove(dir, name);
    }
  }
}

// ---------- 命令行包 ----------

/**
 * 命令行包（apps/cli/scripts/package.ts）在线路上的位置：S3 线路的 `cli/`，GitHub 线路是 tag `cli` 的 Release（滚动的预发布，同
 * desktop-updates）；都是平铺的，没有平台目录。apps/cli/scripts/install.sh 与 install.ps1 的 LINES 按这个布局读：
 *   wevir-cli-<版本>-<平台>-<架构>.tar.gz / .zip   名字带版本，发出去就不再变
 *   wevir-cli-<版本>-checksums.txt               这个版本所有包的 sha256（`sha256sum` 的格式），安装脚本据此核对
 *   latest.txt / beta.txt                         正式版 / 开发版通道的最新版本号，最后写，只许更高的版本覆盖
 *   install.sh / install.ps1                      安装脚本，随每次发布更新
 */
export const CLI_ROOT = 'cli';
export const CLI_GITHUB_TAG = 'cli';
/** 每次发布都改写的文件（不许缓存）。 */
export const CLI_MUTABLE_FILES: readonly string[] = [
  'latest.txt',
  'beta.txt',
  'install.sh',
  'install.ps1',
];

const CLI_RELEASE: GithubRelease = {
  tag: CLI_GITHUB_TAG,
  title: 'Command-line downloads',
  notes:
    'The Wevir command-line client with its own Node, for Linux, macOS and Windows: curl -fsSL https://dl.edgeweir.com/cli/install.sh | sh. Packages of the newest builds, their checksums and the channel files the install scripts read.',
  assetName: (_dir, name) => name,
  dirListing: (assets) => [...assets],
};

/** 通道的版本文件：正式版 latest.txt，开发版 beta.txt。 */
export function cliChannelFile(channel: Channel): string {
  return channel === 'stable' ? 'latest.txt' : 'beta.txt';
}

/** 命令行包与它的校验和文件名里的版本；别的文件返回 undefined。 */
export function versionOfCliFile(name: string): string | undefined {
  return /^wevir-cli-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(?:checksums\.txt|(?:linux|darwin|win32)-[0-9a-z]+\.(?:tar\.gz|zip))$/.exec(
    name,
  )?.[1];
}

/** 这个版本的校验和文件名。 */
export function cliChecksumsFile(version: string): string {
  return `wevir-cli-${version}-checksums.txt`;
}

/** `sha256sum` 格式的校验和文件：`<hex>  <文件名>`，按文件名排序。 */
export function checksumsText(files: readonly { name: string; sha256: string }[]): string {
  return [...files]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((file) => `${file.sha256}  ${file.name}\n`)
    .join('');
}

/** 一个目录（package.ts 的产物）里这个版本的命令行包；一个都没有、或混着别的版本时报错。 */
export function cliPackages(names: readonly string[], version: string): string[] {
  const packages = names.filter(
    (name) => versionOfCliFile(name) !== undefined && !name.endsWith('-checksums.txt'),
  );
  const other = packages.filter((name) => versionOfCliFile(name) !== version);
  if (other.length > 0) throw new Error(`not version ${version}: ${other.join(', ')}`);
  if (packages.length === 0) throw new Error(`no command-line packages for ${version}`);
  return packages.sort();
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * 发命令行包：`<目录>` 里是各平台的 `wevir-cli-<版本>-*`。写这个版本的校验和文件，连同 apps/cli/scripts/ 的安装脚本放进去，然后
 * 照桌面端的顺序：包与校验和先传到所有线路（全球线路经 CDN 核对，见 uploadInstallers），都成功后核对通道文件只许更高的版本覆盖，
 * 再写安装脚本与通道文件。正式版同时把开发版的通道推到不低于它的版本（开发版用户也装得到正式版）。最后清理旧版本（各通道留
 * KEEP_VERSIONS 个，再加通道文件正指着的）。
 */
async function publishCli(options: {
  channel: Channel;
  version: string;
  dir: string;
  only?: string;
}): Promise<void> {
  const { channel, version, dir } = options;
  const packages = cliPackages(readdirSync(dir), version);
  const checksums = cliChecksumsFile(version);
  writeFileSync(
    join(dir, checksums),
    checksumsText(packages.map((name) => ({ name, sha256: sha256Of(join(dir, name)) }))),
  );
  const scripts = fileURLToPath(new URL('../../cli/scripts/', import.meta.url));
  for (const name of ['install.sh', 'install.ps1'])
    copyFileSync(join(scripts, name), join(dir, name));
  const payload = [...packages, checksums];
  const lines = selectLines(options.only, { root: CLI_ROOT, release: CLI_RELEASE });

  // 要写的通道文件与版本：开发版只写 beta.txt；正式版写 latest.txt，beta.txt 低于它时也写。
  const pointers = (line: Line): string[] => {
    const files = [cliChannelFile(channel)];
    if (channel === 'stable') {
      const beta = line.read('', cliChannelFile('dev'))?.trim();
      if (beta === undefined || compareVersions(beta, version) < 0)
        files.push(cliChannelFile('dev'));
    }
    return files;
  };
  const checkNewer = (): void => {
    for (const line of lines) {
      const current = line.read('', cliChannelFile(channel))?.trim();
      if (current !== undefined && current !== '' && compareVersions(current, version) >= 0) {
        throw new Error(
          `[${line.id}] ${CLI_ROOT}/${cliChannelFile(channel)} is already ${current}; not overwriting it with ${version}`,
        );
      }
    }
  };
  checkNewer();

  const bunnyKey = process.env.BUNNY_API_KEY?.trim();
  const globalLine = lines.find((line) => line.id === 'global');
  if (globalLine && !bunnyKey) {
    console.warn('[global] BUNNY_API_KEY is not set: packages are not checked through the CDN');
  }
  const publicFiles = (line: Line, names: readonly string[]) =>
    Promise.all(
      names.map(async (name) => ({
        url: line.url('', name),
        expected: await fileDigest(join(dir, name)),
      })),
    );
  let uploaded: { url: string; expected: Digest }[] = [];
  await uploadInstallers(lines, {
    upload: (line) =>
      forEachLimit(payload, line.concurrency, (name) => line.upload('', name, join(dir, name))),
    global:
      globalLine && bunnyKey
        ? {
            async verify() {
              uploaded = await publicFiles(globalLine, payload);
              await waitForCdn(uploaded, bunnyCheck(bunnyKey));
            },
            purge: () =>
              purgeBunny(
                uploaded.map((file) => file.url),
                bunnyKey,
              ),
          }
        : undefined,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
  });

  checkNewer();
  const temp = mkdtempSync(join(tmpdir(), 'wevir-cli-release-'));
  try {
    for (const line of lines) {
      const written: string[] = [];
      for (const name of ['install.sh', 'install.ps1']) {
        await line.upload('', name, join(dir, name));
        written.push(name);
      }
      for (const name of pointers(line)) {
        const file = join(temp, name);
        writeFileSync(file, `${version}\n`);
        await line.upload('', name, file);
        written.push(name);
      }
      if (line.id === 'global' && bunnyKey) {
        const urls = written.map((name) => line.url('', name));
        await purgeBunny(urls, bunnyKey);
        await waitForCdn(
          await Promise.all(
            written.map(async (name) => ({
              url: line.url('', name),
              // 通道文件写在临时目录里，安装脚本在 <目录> 里。
              expected: await fileDigest(join(name.endsWith('.txt') ? temp : dir, name)),
            })),
          ),
          bunnyCheck(bunnyKey),
        );
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  pruneCli(lines);
}

function pruneCli(lines: readonly Line[]): void {
  for (const line of lines) {
    const referenced = new Set<string>();
    for (const channel of ['stable', 'dev'] as const) {
      const version = line.read('', cliChannelFile(channel))?.trim();
      if (version) referenced.add(version);
    }
    for (const name of filesToPrune(line.list(''), referenced, KEEP_VERSIONS, versionOfCliFile)) {
      line.remove('', name);
    }
  }
}

// ---------- Android ----------

/**
 * Android 的 APK 在线路上的位置：S3 线路的 `android/`，GitHub 线路是 tag `android` 的 Release（滚动的预发布，同 desktop-updates）。
 * 布局同桌面端的平台目录：
 *   Wevir-<版本>-android.apk          名字带版本，发出去就不再变
 *   latest-android.yml / beta-android.yml (+ .sig)   electron-builder 格式的清单与 Ed25519 签名（release-dir.ts --android）
 * publish 的 `<目录>` 下是一个平台目录 `android`；S3 线路的根为空，键就是 `android/<文件>`。
 */
export const ANDROID_PLATFORM_DIR = 'android';
export const ANDROID_GITHUB_TAG = 'android';

const ANDROID_RELEASE: GithubRelease = {
  tag: ANDROID_GITHUB_TAG,
  title: 'Android downloads',
  notes:
    'The Wevir Android app (APK) for remote access to Wevir on your computers. Packages of the newest builds and their signed manifests; download from https://wevir.si/download.',
  assetName: (_dir, name) => name,
  dirListing: (assets) => [...assets],
};

export const ANDROID_TARGET = { root: '', release: ANDROID_RELEASE } as const;

// ---------- plan ----------

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface ReleasePlan {
  channel: Channel;
  version: string;
  skip: boolean;
}

/** 开发版发布的平台目录（release.yml 的 build 矩阵）。plan 读它们在各线路上的公开清单。 */
export const PUBLISHED_DIRS = [
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'linux-x64',
  'linux-arm64',
] as const;

/** 各线路公开地址上开发版清单的版本。取不到（没有、网络出错）的跳过，发布时的覆盖检查仍会兜底。 */
async function publishedDevVersions(): Promise<string[]> {
  const versions: string[] = [];
  for (const mirror of MIRRORS) {
    for (const dir of PUBLISHED_DIRS) {
      const url = `${mirror.publicUrl}/desktop/${dir}/${manifestFile(channelName('dev'), dir)}`;
      try {
        const response = await fetch(url, {
          cache: 'no-store',
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) continue;
        versions.push(readManifest(await response.text()).version);
      } catch (error) {
        console.error(
          `release: could not read ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return versions;
}

async function plan(commit: string, env: NodeJS.ProcessEnv): Promise<ReleasePlan> {
  if (env.GITHUB_REF_TYPE === 'tag') {
    const tag = env.GITHUB_REF_NAME ?? '';
    const version = stableVersionOfTag(tag);
    if (version === undefined) throw new Error(`tag ${tag} is not vX.Y.Z`);
    return { channel: 'stable', version, skip: false };
  }
  let lastStable = '0.0.0';
  let commits: number;
  try {
    const tag = git([
      'describe',
      '--tags',
      '--abbrev=0',
      '--first-parent',
      '--match',
      'v[0-9]*.[0-9]*.[0-9]*',
      commit,
    ]);
    lastStable = stableVersionOfTag(tag) ?? lastStable;
    commits = Number(git(['rev-list', '--count', '--first-parent', `${tag}..${commit}`]));
  } catch {
    commits = Number(git(['rev-list', '--count', '--first-parent', commit]));
  }
  if (commits === 0) return { channel: 'dev', version: devVersion(lastStable, 0), skip: true };
  const n = devBuildNumber(lastStable, commits, await publishedDevVersions());
  return { channel: 'dev', version: devVersion(lastStable, n), skip: false };
}

// ---------- 听写模型 ----------

/** 下载上游的文件到 `file`，大小与 sha256 不对就抛错。 */
async function fetchUpstream(asset: SpeechAsset, file: string): Promise<void> {
  const response = await fetch(asset.url, {
    signal: AbortSignal.timeout(uploadTimeoutMs(asset.size)),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`downloading ${asset.url} failed: HTTP ${response.status}`);
  }
  const hash = createHash('sha256');
  let size = 0;
  const out = createWriteStream(file);
  for await (const chunk of response.body) {
    hash.update(chunk);
    size += chunk.byteLength;
    if (!out.write(chunk)) await once(out, 'drain');
  }
  await new Promise<void>((resolve, reject) =>
    out.end((error?: Error | null) => (error ? reject(error) : resolve())),
  );
  const sha256 = hash.digest('hex');
  if (size !== asset.size || sha256 !== asset.sha256) {
    throw new Error(
      `${asset.url}: got ${size} bytes sha256:${sha256}, expected ${asset.size} bytes sha256:${asset.sha256}`,
    );
  }
  console.log(`downloaded ${asset.url}`);
}

/** GitHub 线路上放这类文件的 Release：没有就建（预发布、不标 Latest，同 desktop-updates）。 */
/** Release 的标题与说明（这类 Release 不分目录，用不到 GithubRelease 的其余字段）。 */
type ReleaseInfo = Pick<GithubRelease, 'tag' | 'title' | 'notes'>;

function ensureRelease(repo: string, env: NodeJS.ProcessEnv, release: ReleaseInfo): void {
  const found = spawnSync('gh', ['release', 'view', release.tag, '--repo', repo, '--json', 'id'], {
    env,
    encoding: 'utf8',
    timeout: AWS_CALL_TIMEOUT_MS,
  });
  if (found.status === 0) return;
  if (!/not found/i.test(found.stderr)) {
    throw new Error(`[github] reading release ${release.tag} failed: ${found.stderr.trim()}`);
  }
  execFileSync(
    'gh',
    [
      'release',
      'create',
      release.tag,
      '--repo',
      repo,
      '--target',
      env.GITHUB_SHA?.trim() || 'master',
      '--prerelease',
      '--latest=false',
      '--title',
      release.title,
      '--notes',
      release.notes,
    ],
    { env, stdio: ['ignore', 'inherit', 'inherit'], timeout: AWS_CALL_TIMEOUT_MS },
  );
  console.log(`[github] created release ${release.tag}`);
}

/** 搬到三条线路的一个文件：S3 线路的键是 `key`，GitHub 线路的附件名是 `asset`，`url(线路)` 是 Host 下载它的地址。 */
interface MirroredFile {
  file: string;
  key: string;
  asset: string;
  url: (line: string) => string;
}

/** 搬文件要用的线路：S3 线路的连接信息与 GitHub 的令牌在下载之前就核对，缺了就不白下载。 */
interface MirrorLines {
  wanted: (id: string) => boolean;
  s3: MirrorTarget[];
  github: boolean;
  repo: string;
  env: NodeJS.ProcessEnv;
}

function mirrorLines(only: string | undefined): MirrorLines {
  if (!LINE_IDS.includes(only ?? 'github')) {
    throw new Error(`unknown mirror ${only}; one of ${LINE_IDS.join(', ')}`);
  }
  const wanted = (id: string) => only === undefined || id === only;
  const env = process.env;
  const s3 = MIRRORS.filter((mirror) => wanted(mirror.id)).map((mirror) =>
    mirrorTarget(mirror, env),
  );
  const github = wanted('github');
  if (github && !env.GH_TOKEN?.trim() && !env.GITHUB_TOKEN?.trim()) {
    throw new Error('GH_TOKEN is not set');
  }
  return { wanted, s3, github, repo: env.GITHUB_REPOSITORY?.trim() || GITHUB_REPO, env };
}

/**
 * 把下载好的文件传到所选线路（S3 线路一次 PutObject，GitHub 线路传到 `release` 并覆盖同名附件），再逐个读回核对：
 * GitHub 经公网地址（与 Host 下载时相同）；全球线路配了 BUNNY_API_KEY 时经 CDN（waitForCdn），否则与 R2 一样经 S3 接口
 * 读回：Cloudflare 对 runner 的数据中心地址回 403，R2 强一致，读桶即可。
 */
async function mirrorFiles(
  lines: MirrorLines,
  release: ReleaseInfo,
  files: readonly MirroredFile[],
): Promise<void> {
  const { s3, github, repo, env } = lines;
  for (const mirror of s3) {
    await forEachLimit(files, S3_UPLOAD_CONCURRENCY, ({ file, key }) => upload(mirror, file, key));
  }
  if (github) {
    ensureRelease(repo, env, release);
    const named = mkdtempSync(join(tmpdir(), 'wevir-mirror-gh-'));
    try {
      for (const { file, asset } of files) {
        // gh 用文件名做附件名：复制一份改名的。
        const path = join(named, asset);
        copyFileSync(file, path);
        await withRetries(`[github] ${asset}`, () =>
          run(
            'gh',
            ['release', 'upload', release.tag, path, '--repo', repo, '--clobber'],
            env,
            uploadTimeoutMs(statSync(file).size),
          ),
        );
        rmSync(path, { force: true });
      }
    } finally {
      rmSync(named, { recursive: true, force: true });
    }
  }

  const bunnyKey = env.BUNNY_API_KEY?.trim();
  const readBack = mkdtempSync(join(tmpdir(), 'wevir-mirror-check-'));
  try {
    for (const id of LINE_IDS.filter(lines.wanted)) {
      const checks = await Promise.all(
        files.map(async (entry) => ({
          entry,
          url: entry.url(id),
          expected: await fileDigest(entry.file),
        })),
      );
      if (id === 'global' && bunnyKey) {
        await waitForCdn(checks, bunnyCheck(bunnyKey));
        continue;
      }
      const target = s3.find((line) => line.id === id);
      for (const { entry, url, expected } of checks) {
        let got: Digest;
        if (target === undefined) {
          const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
          if (!response.ok || response.body === null) {
            throw new Error(`${url}: HTTP ${response.status}`);
          }
          got = await digestOf(response.body);
        } else {
          const copy = join(readBack, `${id}-${entry.asset}`);
          await run(
            'aws',
            ['s3', 'cp', `s3://${target.bucket}/${entry.key}`, copy, '--only-show-errors'],
            target.awsEnv,
            uploadTimeoutMs(expected.size),
          );
          got = await fileDigest(copy);
          rmSync(copy, { force: true });
        }
        if (got.size !== expected.size || got.sha512 !== expected.sha512) {
          throw new Error(
            `${url} does not match the upload (${got.size} bytes, expected ${expected.size})`,
          );
        }
        console.log(`[${id}] verified ${url}${target === undefined ? '' : ' (S3 API)'}`);
      }
    }
  } finally {
    rmSync(readBack, { recursive: true, force: true });
  }
}

/** Host 的下载线路（SPEECH_MIRRORS、OFFICE_ENGINE_MIRRORS）里 id 相同的那条。 */
function lineOf<T extends { id: string }>(mirrors: readonly T[], id: string): T {
  const mirror = mirrors.find((line) => line.id === id);
  if (mirror === undefined) throw new Error(`no ${id} line`);
  return mirror;
}

const SPEECH_RELEASE: ReleaseInfo = {
  tag: SPEECH_RELEASE_TAG,
  title: 'Speech models',
  notes:
    'On-device dictation models mirrored from k2-fsa/sherpa-onnx for the Wevir Host. Files are named <model key>-<file>; the Host checks each against a pinned sha256.',
};

async function publishSpeechModels(only: string | undefined): Promise<void> {
  const lines = mirrorLines(only);
  const spec = SENSE_VOICE_SMALL;
  const temp = mkdtempSync(join(tmpdir(), 'wevir-speech-'));
  try {
    const files = spec.assets.map((asset) => ({ asset, file: join(temp, asset.fileName) }));
    for (const { asset, file } of files) await fetchUpstream(asset, file);
    await mirrorFiles(
      lines,
      SPEECH_RELEASE,
      files.map(({ asset, file }) => ({
        file,
        key: `speech/${speechAssetPath(spec, asset)}`,
        asset: speechAssetPath(spec, asset, 'release'),
        url: (id) => {
          const mirror = lineOf(SPEECH_MIRRORS, id);
          return `${mirror.url}/${speechAssetPath(spec, asset, mirror.layout)}`;
        },
      })),
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// ---------- 办公文档预览引擎 ----------

const OFFICE_ENGINE_RELEASE: ReleaseInfo = {
  tag: OFFICE_ENGINE_RELEASE_TAG,
  title: 'Office preview engine',
  notes:
    'The LibreOffice preview engine (@deepseek-ai/libreoffice-kit, MPL-2.0) and its dependencies, mirrored unchanged from the npm registry for the Wevir Host. Files are named <package without @, / as ->-<version>.tgz; the Host checks each against a pinned sha512.',
};

/** npm 包从 npmjs 下载时最多等多久（最大的 Windows x64 引擎包约 75 MB）。 */
const NPM_FETCH_TIMEOUT_MS = uploadTimeoutMs(256 * 1024 * 1024);

/** 从 npmjs 下载一个包的 tgz 到 `file`，与写死的 integrity（sha512）不对就抛错。 */
async function fetchNpmPackage(
  entry: { name: string; version: string; integrity: string },
  file: string,
): Promise<void> {
  const base = entry.name.split('/').pop() as string;
  const url = `https://registry.npmjs.org/${entry.name}/-/${base}-${entry.version}.tgz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(NPM_FETCH_TIMEOUT_MS) });
  if (!response.ok || response.body === null) {
    throw new Error(`downloading ${url} failed: HTTP ${response.status}`);
  }
  const hash = createHash('sha512');
  const out = createWriteStream(file);
  for await (const chunk of response.body) {
    hash.update(chunk);
    if (!out.write(chunk)) await once(out, 'drain');
  }
  await new Promise<void>((resolve, reject) =>
    out.end((error?: Error | null) => (error ? reject(error) : resolve())),
  );
  const integrity = `sha512-${hash.digest('base64')}`;
  if (integrity !== entry.integrity) {
    throw new Error(`${url}: got ${integrity}, expected ${entry.integrity}`);
  }
  console.log(`downloaded ${url}`);
}

/** 镜像上的文件名要互不相同（npmMirrorAssetName 平铺后 `@a/b` 与 `a-b` 会撞）。 */
export function officeEngineAssets(): { entry: NpmClosurePackage; asset: string }[] {
  const seen = new Map<string, string>();
  return OFFICE_ENGINE_PACKAGES.map((entry) => {
    const asset = npmMirrorAssetName(entry);
    const other = seen.get(asset);
    if (other !== undefined) throw new Error(`${entry.name} and ${other} both mirror as ${asset}`);
    seen.set(asset, entry.name);
    return { entry, asset };
  });
}

async function publishOfficeEngine(only: string | undefined): Promise<void> {
  const lines = mirrorLines(only);
  const assets = officeEngineAssets();
  const temp = mkdtempSync(join(tmpdir(), 'wevir-office-engine-'));
  try {
    const files = assets.map(({ entry, asset }) => ({ entry, asset, file: join(temp, asset) }));
    await forEachLimit(files, 4, ({ entry, file }) => fetchNpmPackage(entry, file));
    await mirrorFiles(
      lines,
      OFFICE_ENGINE_RELEASE,
      files.map(({ asset, file }) => ({
        file,
        key: `office-engine/${asset}`,
        asset,
        url: (id) => `${lineOf(OFFICE_ENGINE_MIRRORS, id).url}/${asset}`,
      })),
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'plan') {
    const result = await plan(rest[0] ?? 'HEAD', process.env);
    const lines = `channel=${result.channel}\nversion=${result.version}\nskip=${result.skip}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
    process.stdout.write(lines);
    return;
  }
  if (command === 'publish') {
    const { values } = parseArgs({
      args: rest,
      options: {
        channel: { type: 'string' },
        version: { type: 'string' },
        dir: { type: 'string' },
        only: { type: 'string' },
        'skip-prune': { type: 'boolean' },
      },
    });
    const { channel, version, dir, only } = values;
    if ((channel !== 'stable' && channel !== 'dev') || version === undefined || dir === undefined) {
      throw new Error(
        'usage: release.ts publish --channel dev|stable --version <version> --dir <dir> [--only <mirror>] [--skip-prune]',
      );
    }
    await publish({ channel, version, dir, only, skipPrune: values['skip-prune'] });
    return;
  }
  if (command === 'prune') {
    const { values } = parseArgs({
      args: rest,
      options: { dir: { type: 'string' }, only: { type: 'string' } },
    });
    if (values.dir === undefined) {
      throw new Error('usage: release.ts prune --dir <dir> [--only <mirror>]');
    }
    prune(selectLines(values.only), platformDirs(values.dir));
    return;
  }
  if (command === 'cli') {
    const { values } = parseArgs({
      args: rest,
      options: {
        channel: { type: 'string' },
        version: { type: 'string' },
        dir: { type: 'string' },
        only: { type: 'string' },
      },
    });
    const { channel, version, dir, only } = values;
    if ((channel !== 'stable' && channel !== 'dev') || version === undefined || dir === undefined) {
      throw new Error(
        'usage: release.ts cli --channel dev|stable --version <version> --dir <dir> [--only <mirror>]',
      );
    }
    await publishCli({ channel, version, dir, only });
    return;
  }
  if (command === 'android') {
    const { values } = parseArgs({
      args: rest,
      options: {
        channel: { type: 'string' },
        version: { type: 'string' },
        dir: { type: 'string' },
        only: { type: 'string' },
      },
    });
    const { channel, version, dir, only } = values;
    if ((channel !== 'stable' && channel !== 'dev') || version === undefined || dir === undefined) {
      throw new Error(
        'usage: release.ts android --channel dev|stable --version <version> --dir <dir> [--only <mirror>]',
      );
    }
    const dirs = platformDirs(dir);
    if (dirs.length !== 1 || dirs[0] !== ANDROID_PLATFORM_DIR) {
      throw new Error(`${dir} must hold exactly one directory, ${ANDROID_PLATFORM_DIR}/`);
    }
    await publish({ channel, version, dir, only, target: ANDROID_TARGET });
    return;
  }
  if (command === 'speech-models' || command === 'office-engine') {
    const { values } = parseArgs({ args: rest, options: { only: { type: 'string' } } });
    await (command === 'speech-models' ? publishSpeechModels : publishOfficeEngine)(values.only);
    return;
  }
  console.error(
    'usage: release.ts plan [<commit>] | publish --channel dev|stable --version <v> --dir <dir> | prune --dir <dir> | cli --channel dev|stable --version <v> --dir <dir> | android --channel dev|stable --version <v> --dir <dir> | speech-models | office-engine [--only <mirror>]',
  );
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
