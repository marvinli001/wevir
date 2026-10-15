/**
 * 发布流水线（ADR-0007 补记 2 的第 3 步，.github/workflows/release.yml）的两个子命令：
 *
 *   node scripts/release.ts plan [<提交>]
 *     算出这次发布的通道与版本，写进 $GITHUB_OUTPUT（不在 Actions 里时打印）。GITHUB_REF_TYPE=tag 时是正式版，版本取
 *     tag `vX.Y.Z`；否则是开发版：上一个 `vX.Y.Z` tag 之后的 X.Y.(Z+1)-beta.N，N 是从那个 tag 到这个提交的 master
 *     提交数（--first-parent，master 只有一条线，N 只增不减）；还没有 tag 时按 v0.0.0 算。提交正好是 tag 时
 *     skip=true（那是正式版的事）。
 *
 *   node scripts/release.ts publish --channel dev|stable --version <版本> --dir <目录> [--only <线路>]
 *     <目录> 下每个子目录是一个平台（`darwin-arm64`、`darwin-x64`、`win32-x64`，与 src/main/updates/feed.ts 的
 *     `<平台>-<架构>` 一致），里面是 electron-builder 的产物与签过名的清单（`<清单>.sig`，update-signing.ts sign）。
 *     上传到每条线路的 `desktop/<平台>-<架构>/`：
 *       1. 安装包与 blockmap 传到所有线路；
 *       2. 都成功后核对每条线路上同通道的现有清单，版本不比这次低就整个停下（只许更高的版本覆盖）；
 *       3. 逐条线路写清单与 `.sig`，全球线路随后清 CDN 缓存（Bunny 的 S3 接口不收 Cache-Control）；
 *       4. 清理：开发版只留清单引用的与最新的 KEEP_PRERELEASES 个预发布版本，正式版的安装包都留着。
 *     线路的连接信息来自环境变量（见 MIRRORS），用 AWS CLI（GitHub 的 Ubuntu runner 自带）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export type Channel = 'stable' | 'dev';

/** 每个平台目录保留的预发布版本数（不算清单正引用的）。 */
export const KEEP_PRERELEASES = 3;

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

// ---------- 发布目录 ----------

/** electron-builder 的通道名：正式版 latest，开发版 beta（与 feed.ts 的 channelNames 相同）。 */
export function channelName(channel: Channel): 'latest' | 'beta' {
  return channel === 'stable' ? 'latest' : 'beta';
}

/** 平台目录（`darwin-arm64`）里这个通道的清单文件名。 */
export function manifestFile(name: string, platformDir: string): string {
  if (platformDir.startsWith('darwin-')) return `${name}-mac.yml`;
  if (platformDir.startsWith('linux-')) return `${name}-linux.yml`;
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

/** 安装包文件名里的版本（artifactName 是 `Wevir-<版本>-<mac|win|linux>-…`）；清单、签名等不是安装包的返回 undefined。 */
export function versionOfFile(name: string): string | undefined {
  return /^Wevir-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(?:mac|win|linux)-/.exec(name)?.[1];
}

/**
 * 清理时要删的文件：只删预发布版本的安装包，`referenced`（现有清单引用的版本）与最新的 `keep` 个预发布版本留下；
 * 正式版、清单、签名与认不出版本的文件都不动。
 */
export function filesToPrune(
  names: readonly string[],
  referenced: ReadonlySet<string>,
  keep: number,
): string[] {
  const prereleases = [
    ...new Set(names.map(versionOfFile).filter((v): v is string => v?.includes('-') === true)),
  ].sort((a, b) => compareVersions(b, a));
  const kept = new Set([...referenced, ...prereleases.slice(0, keep)]);
  return names.filter((name) => {
    const version = versionOfFile(name);
    return version?.includes('-') === true && !kept.has(version);
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
  // 安装包（dmg、zip、exe）与它们的 blockmap，文件名里都带版本。
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
  /** 这条线路的 S3 接口收不收 Cache-Control（Bunny 不收）。 */
  cacheControl: boolean;
  /**
   * 公网地址就是 S3 接口（path-style，`<地址>/<桶>/<键>`）：发布目录的 `desktop/` 是桶本身，桶名必须是 `desktop`，
   * 键里不再带 `desktop/`。否则桶是公网地址的根，键是 `desktop/<平台>-<架构>/<文件>`。
   */
  bucketIsDesktop: boolean;
}

/**
 * 两条线路。每条要 `<前缀>_S3_ENDPOINT`、`_S3_BUCKET`、`_S3_ACCESS_KEY_ID`、`_S3_SECRET_ACCESS_KEY`，可选 `_S3_REGION`。
 * 全球线路是 Bunny Storage 的 S3 接口（拉取区 download.wevir.si），设了 BUNNY_API_KEY 时写完清单清 CDN 缓存；
 * 优化线路是维护者自己的 RustFS，download2.wevir.si 就是它的 S3 接口，桶 `desktop` 可匿名读。
 */
export const MIRRORS: readonly Mirror[] = [
  {
    id: 'global',
    publicUrl: 'https://download.wevir.si',
    env: 'WEVIR_GLOBAL',
    cacheControl: false,
    bucketIsDesktop: false,
  },
  {
    id: 'optimized',
    publicUrl: 'https://download2.wevir.si',
    env: 'WEVIR_OPTIMIZED',
    cacheControl: true,
    bucketIsDesktop: true,
  },
];

interface MirrorTarget extends Mirror {
  bucket: string;
  /** 键的前缀：`desktop/`，或桶就是 `desktop` 时为空。 */
  root: string;
  awsEnv: NodeJS.ProcessEnv;
}

function mirrorTarget(mirror: Mirror, env: NodeJS.ProcessEnv): MirrorTarget {
  const read = (name: string, required = true): string => {
    const value = env[`${mirror.env}_${name}`]?.trim() ?? '';
    if (required && value === '') throw new Error(`${mirror.env}_${name} is not set`);
    return value;
  };
  const bucket = read('S3_BUCKET');
  if (mirror.bucketIsDesktop && bucket !== 'desktop') {
    throw new Error(
      `${mirror.env}_S3_BUCKET must be desktop: ${mirror.publicUrl}/desktop/ is the bucket`,
    );
  }
  return {
    ...mirror,
    bucket,
    root: mirror.bucketIsDesktop ? '' : 'desktop/',
    awsEnv: {
      PATH: env.PATH,
      HOME: env.HOME,
      AWS_ACCESS_KEY_ID: read('S3_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: read('S3_SECRET_ACCESS_KEY'),
      AWS_ENDPOINT_URL: read('S3_ENDPOINT'),
      AWS_REGION: read('S3_REGION', false) || 'us-east-1',
      // AWS CLI 2.23 起默认给每个请求加 CRC32 校验，Bunny 只认 SHA256；只在接口要求时才算。
      AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
      AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_PAGER: '',
    },
  };
}

function aws(mirror: MirrorTarget, args: readonly string[]): string {
  return execFileSync('aws', args, {
    env: mirror.awsEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function contentType(name: string): string {
  if (name.endsWith('.yml')) return 'text/yaml; charset=utf-8';
  if (name.endsWith('.sig')) return 'text/plain; charset=utf-8';
  if (name.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (name.endsWith('.zip')) return 'application/zip';
  if (name.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  return 'application/octet-stream';
}

function upload(mirror: MirrorTarget, file: string, key: string, noCache = false): void {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const args = [
    's3',
    'cp',
    file,
    `s3://${mirror.bucket}/${key}`,
    '--only-show-errors',
    '--content-type',
    contentType(name),
  ];
  if (noCache && mirror.cacheControl) args.push('--cache-control', 'no-cache');
  aws(mirror, args);
  console.log(`[${mirror.id}] ${key}`);
}

/** 线路上现有的文件；没有时返回 undefined（404），别的错误照抛。 */
function download(mirror: MirrorTarget, key: string): string | undefined {
  const result = spawnSync(
    'aws',
    ['s3', 'cp', `s3://${mirror.bucket}/${key}`, '-', '--only-show-errors'],
    {
      env: mirror.awsEnv,
      encoding: 'utf8',
    },
  );
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

async function purgeBunny(urls: readonly string[], apiKey: string): Promise<void> {
  for (const url of urls) {
    const response = await fetch(
      `https://api.bunny.net/purge?url=${encodeURIComponent(url)}&async=false`,
      {
        method: 'POST',
        headers: { AccessKey: apiKey },
      },
    );
    if (!response.ok) throw new Error(`purging ${url} failed: HTTP ${response.status}`);
    console.log(`[global] purged ${url}`);
  }
}

async function publish(options: {
  channel: Channel;
  version: string;
  dir: string;
  only?: string;
}): Promise<void> {
  const releases: PlatformRelease[] = readdirSync(options.dir)
    .filter((name) => statSync(join(options.dir, name)).isDirectory())
    .sort()
    .map((platformDir) => {
      const names = readdirSync(join(options.dir, platformDir));
      const manifest = manifestFile(channelName(options.channel), platformDir);
      const text = names.includes(manifest)
        ? readFileSync(join(options.dir, platformDir, manifest), 'utf8')
        : '';
      return checkPlatformDir(platformDir, names, text, options.channel, options.version);
    });
  if (releases.length === 0) throw new Error(`${options.dir} has no platform directories`);
  const mirrors = MIRRORS.filter(
    (mirror) => options.only === undefined || mirror.id === options.only,
  ).map((mirror) => mirrorTarget(mirror, process.env));
  if (mirrors.length === 0) throw new Error(`unknown mirror ${options.only}`);
  const keyOf = (mirror: MirrorTarget, release: PlatformRelease, name: string) =>
    `${mirror.root}${release.dir}/${name}`;

  // 只许更高的版本覆盖：哪条线路上已有不低于这次的清单，一份清单都不写。上传前查一次（免得白传），写清单前再查一次。
  const checkNewer = (): void => {
    for (const mirror of mirrors) {
      for (const release of releases) {
        const current = download(mirror, keyOf(mirror, release, release.manifest));
        if (current === undefined) continue;
        const existing = readManifest(current).version;
        if (compareVersions(existing, options.version) >= 0) {
          throw new Error(
            `[${mirror.id}] ${keyOf(mirror, release, release.manifest)} is already ${existing}; not overwriting it with ${options.version}`,
          );
        }
      }
    }
  };
  checkNewer();

  // 1. 安装包先到所有线路。
  for (const mirror of mirrors) {
    for (const release of releases) {
      for (const name of release.payload)
        upload(mirror, join(options.dir, release.dir, name), keyOf(mirror, release, name));
    }
  }

  // 2. 都传完了，再核对一次版本。
  checkNewer();

  // 3. 写清单与签名（先清单后签名，两次写之间只隔一个请求），再清 CDN 缓存。
  for (const mirror of mirrors) {
    const written: string[] = [];
    for (const release of releases) {
      for (const name of [release.manifest, `${release.manifest}.sig`]) {
        upload(mirror, join(options.dir, release.dir, name), keyOf(mirror, release, name), true);
        written.push(`${mirror.publicUrl}/desktop/${release.dir}/${name}`);
      }
    }
    const bunnyKey = process.env.BUNNY_API_KEY?.trim();
    if (mirror.id === 'global' && bunnyKey) await purgeBunny(written, bunnyKey);
  }

  // 4. 清理旧的开发版安装包。
  for (const mirror of mirrors) {
    for (const release of releases) {
      const prefix = `${mirror.root}${release.dir}/`;
      const names = list(mirror, prefix);
      const referenced = new Set<string>();
      for (const channel of ['latest', 'beta'] as const) {
        const text = download(mirror, prefix + manifestFile(channel, release.dir));
        if (text !== undefined) referenced.add(readManifest(text).version);
      }
      for (const name of filesToPrune(names, referenced, KEEP_PRERELEASES)) {
        aws(mirror, ['s3api', 'delete-object', '--bucket', mirror.bucket, '--key', prefix + name]);
        console.log(`[${mirror.id}] deleted ${prefix + name}`);
      }
    }
  }
}

// ---------- plan ----------

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface ReleasePlan {
  channel: Channel;
  version: string;
  skip: boolean;
}

function plan(commit: string, env: NodeJS.ProcessEnv): ReleasePlan {
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
  return { channel: 'dev', version: devVersion(lastStable, commits), skip: commits === 0 };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'plan') {
    const result = plan(rest[0] ?? 'HEAD', process.env);
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
      },
    });
    const { channel, version, dir, only } = values;
    if ((channel !== 'stable' && channel !== 'dev') || version === undefined || dir === undefined) {
      throw new Error(
        'usage: release.ts publish --channel dev|stable --version <version> --dir <dir> [--only <mirror>]',
      );
    }
    await publish({ channel, version, dir, only });
    return;
  }
  console.error(
    'usage: release.ts plan [<commit>] | publish --channel dev|stable --version <v> --dir <dir>',
  );
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
