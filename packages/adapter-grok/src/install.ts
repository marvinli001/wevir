// SPDX-License-Identifier: MIT
// Wevir 替用户下载安装 `grok`（`account.install`，grok-event-mapping.md §2.4）：从 npm registry 取 `@xai-official/grok` 的
// 平台包（`@xai-official/grok-<darwin|linux|win32>-<x64|arm64>`），tgz 里只有一个 brotli 压缩的原生程序 `bin/grok.br`
// （Windows 是 `bin/grok.exe.br`）。主包的 `bin/grok` 只是 Node 启动脚本：把这个文件 brotli 解开、`chmod 755`，没有别的校验，
// 也不看版本；它的 postinstall 另外把程序放进 `~/.grok/bin` 并往 `~/.grok/config.toml` 写 `cli.installer = "npm"`，Wevir
// 都不做（装好的程序留在 Wevir 自己的目录，不动用户的 ~/.grok）。解压与校验和在 runtime-adapter 的 `NpmPackageInstaller`。
//
// 版本：平台包的 `latest` 标签停在 0.1.220（xAI 1.0 之后只给平台包打 `alpha` 标签），所以不能用安装器默认的 `<包>/latest`。
// 稳定版看主包 `@xai-official/grok` 的 `latest`（npmjs 上与 xAI 的 `x.ai/cli/stable` 一致）；npmmirror 上主包的 `latest`
// 停在 0.1.4，比平台包自己的 `latest` 标签还旧时不信，改问 `x.ai/cli/stable`。两处都没有时退回旧办法：平台包版本列表里
// 不带预发布后缀、且不是别的标签（`alpha`）指向的最大版本——这会挑到没打标签的旧 alpha（2026-10-29：稳定版 1.0.70，
// 旧办法挑出 1.0.72）。通过安装器的 `fetch` 注入点把 `<包>/latest` 的查询换成 `<包>/<挑出的版本>`，安装器本身不用改。

import type { NpmPackageSpec } from '@wevir/runtime-adapter/npm-package';

/** 平台包的名字前缀；主包是 `@xai-official/grok`。 */
export const GROK_PLATFORM_PACKAGE_PREFIX = '@xai-official/grok-';
const GROK_MAIN_PACKAGE = '@xai-official%2Fgrok';
/** xAI 的稳定版指针（`grok update` 查的也是它），内容是纯文本的版本号。 */
export const GROK_STABLE_URL = 'https://x.ai/cli/stable';
const STABLE_TIMEOUT_MS = 10_000;

/** xAI 发布了原生程序的平台（主包 `optionalDependencies` 的六个）。 */
const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);

/**
 * Wevir 替用户装 `grok` 时下载的 npm 平台包（tgz 里只有一个 brotli 压缩的程序）。本平台没有对应的包时 undefined（xAI 没有
 * musl 的 Linux 包，Alpine 上装出来的程序跑不起来，由安装后的 `--version` 核对报出）。
 */
export function grokNpmPackage(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): NpmPackageSpec | undefined {
  if (!SUPPORTED_PLATFORMS.has(`${platform}-${arch}`)) return undefined;
  const fileName = platform === 'win32' ? 'grok.exe' : 'grok';
  return {
    packageName: `${GROK_PLATFORM_PACKAGE_PREFIX}${platform}-${arch}`,
    entry: `bin/${fileName}.br`,
    fileName,
    decode: 'brotli',
  };
}

function semverParts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * 平台包的版本列表里要装的版本（见文件头）：`stable` 中第一个在列表里、不比平台包的 `latest` 标签旧的；都不是时退回旧办法。
 * 一个也挑不出时 undefined。
 */
export function pickGrokVersion(
  listing: unknown,
  stable: readonly (string | undefined)[] = [],
): string | undefined {
  if (typeof listing !== 'object' || listing === null) return undefined;
  const { 'dist-tags': tags, versions } = listing as {
    'dist-tags'?: Record<string, unknown>;
    versions?: Record<string, unknown>;
  };
  if (typeof versions !== 'object' || versions === null) return undefined;
  const latest = typeof tags?.latest === 'string' ? tags.latest : undefined;
  const floor = latest === undefined ? undefined : semverParts(latest);
  for (const version of stable) {
    if (version === undefined || !Object.hasOwn(versions, version)) continue;
    const parts = semverParts(version);
    if (parts !== undefined && (floor === undefined || compareVersions(parts, floor) >= 0)) {
      return version;
    }
  }
  const otherTagged = new Set(
    Object.entries(tags ?? {}).flatMap(([name, version]) =>
      name !== 'latest' && typeof version === 'string' && version !== latest ? [version] : [],
    ),
  );
  let best: { version: string; parts: [number, number, number] } | undefined;
  for (const version of Object.keys(versions)) {
    if (otherTagged.has(version)) continue;
    const parts = semverParts(version);
    if (parts === undefined) continue;
    if (best === undefined || compareVersions(parts, best.parts) > 0) best = { version, parts };
  }
  return best?.version;
}

/**
 * `NpmPackageInstaller` 的 `fetch`：把平台包的 `<registry>/<包>/latest` 查询换成“读版本列表、挑版本、取那个版本的描述”，别的
 * 请求原样转发。挑不出版本时抛错（安装器把它当作这个 registry 没答上来）。
 */
export function pinnedGrokFetch(
  packageName: string,
  base: typeof fetch = (input, init) => fetch(input, init),
  stableUrl: string = GROK_STABLE_URL,
): typeof fetch {
  const encoded = packageName.replace('/', '%2F');
  const suffix = `/${encoded}/latest`;
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith(suffix)) return base(input, init);
    const registry = url.slice(0, -suffix.length);
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'application/vnd.npm.install-v1+json');
    const listing = await base(`${registry}/${encoded}`, { ...init, headers });
    if (!listing.ok) return listing;
    const platform = await listing.json();
    const main = await mainLatest(registry, { ...init, headers }, base);
    const trusted = main !== undefined && pickGrokVersion(platform, [main]) === main;
    const version = pickGrokVersion(
      platform,
      trusted ? [main] : [await stablePointer(stableUrl, init, base)],
    );
    if (version === undefined) {
      throw new Error(`${new URL(registry).host} lists no stable version of ${packageName}`);
    }
    return base(`${registry}/${encoded}/${encodeURIComponent(version)}`, init);
  };
}

/** 同一 registry 上主包的 `latest` 标签；读不到时 undefined。 */
async function mainLatest(
  registry: string,
  init: RequestInit,
  base: typeof fetch,
): Promise<string | undefined> {
  try {
    const response = await base(`${registry}/${GROK_MAIN_PACKAGE}`, init);
    if (!response.ok) return undefined;
    const tags = ((await response.json()) as { 'dist-tags'?: { latest?: unknown } })['dist-tags'];
    return typeof tags?.latest === 'string' ? tags.latest : undefined;
  } catch (error) {
    if (init.signal?.aborted) throw error;
    return undefined;
  }
}

/** `x.ai/cli/stable` 给的版本；连不上或不是版本号时 undefined。 */
async function stablePointer(
  url: string,
  init: RequestInit | undefined,
  base: typeof fetch,
): Promise<string | undefined> {
  try {
    const timeout = AbortSignal.timeout(STABLE_TIMEOUT_MS);
    const response = await base(url, {
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
    if (!response.ok) return undefined;
    const version = (await response.text()).trim();
    return semverParts(version) === undefined ? undefined : version;
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    return undefined;
  }
}
