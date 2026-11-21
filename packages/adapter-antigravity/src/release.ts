// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/provider/antigravityRelease.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8；1.4.5 的发布表照 ab8e488e10d883fa880b0ddcf01917b51839ab07
// Copyright (c) 2026 T3 Tools Inc.
// 修改：加下载地址的镜像前缀 WEVIR_ANTIGRAVITY_MIRROR（照 scripts/fetch-codex.sh 的 WEVIR_GITHUB_MIRROR）。
//
// Google 官方的 Antigravity ACP 运行体（`agy_acp_server.par` 加 `localharness_external`，PyInstaller 单文件）各平台的发布包：
// 地址来自 ACP Registry，sha256 与大小照 T3 钉的 1.4.5；Wevir 已下载核对 macOS arm64 包并实测会话元信息。

// 1.4.2–1.4.5 仍写 run-workflow/SKILL.md；所有会话请求都经 session-meta.ts 禁用 run_workflow。
export const ANTIGRAVITY_RELEASE_VERSION = '1.4.5';
export const ANTIGRAVITY_CLI_MINIMUM_VERSION = '1.5.1';
export const ANTIGRAVITY_CLI_MANIFEST_ORIGIN =
  'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';

/** 发布包所在的主机前缀；`WEVIR_ANTIGRAVITY_MIRROR` 替换它（大陆网络）。 */
export const ANTIGRAVITY_DOWNLOAD_ORIGIN = 'https://dl.google.com';
export const ANTIGRAVITY_CLI_DOWNLOAD_ORIGIN = 'https://storage.googleapis.com';

export interface AntigravityReleaseAsset {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly executable: { readonly name: string; readonly bytes: number };
  readonly harness: { readonly name: string; readonly bytes: number };
}

export interface AntigravityCliReleaseAsset {
  readonly version: string;
  readonly url: string;
  readonly sha512: string;
  readonly format: 'tar.gz' | 'executable';
}

const CLI_VERSION = /^\d+\.\d+\.\d+$/u;

export function compareAntigravityVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (leftParts[i] ?? 0) - (rightParts[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function isAntigravityCliVersion(version: string): boolean {
  return (
    CLI_VERSION.test(version) &&
    compareAntigravityVersions(version, ANTIGRAVITY_CLI_MINIMUM_VERSION) >= 0
  );
}

export function antigravityCliManifestUrl(
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): string | undefined {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    return undefined;
  }
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'x64' ? 'amd64' : arch;
  const suffix = platform === 'linux' && musl ? '_musl' : '';
  return `${ANTIGRAVITY_CLI_MANIFEST_ORIGIN}/manifests/${os}_${cpu}${suffix}.json`;
}

export function parseAntigravityCliRelease(
  data: unknown,
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): AntigravityCliReleaseAsset | undefined {
  if (!antigravityCliManifestUrl(platform, arch, musl) || !data || typeof data !== 'object') {
    return undefined;
  }
  const { version, url, sha512 } = data as Record<string, unknown>;
  if (
    typeof version !== 'string' ||
    !isAntigravityCliVersion(version) ||
    typeof sha512 !== 'string' ||
    !/^[\da-f]{128}$/iu.test(sha512) ||
    typeof url !== 'string'
  ) {
    return undefined;
  }
  const windows = platform === 'win32';
  const os = windows ? 'windows' : platform;
  const unixMusl = platform === 'linux' && musl;
  const folder = `${os}-${arch === 'arm64' ? 'arm' : 'x64'}${unixMusl ? '-musl' : ''}`;
  const file = `cli_${os === 'darwin' ? 'mac' : os}_${arch}${unixMusl ? '_musl' : ''}.${windows ? 'exe' : 'tar.gz'}`;
  const prefix = `${ANTIGRAVITY_CLI_DOWNLOAD_ORIGIN}/antigravity-public/antigravity-cli/${version}-`;
  const build = url.startsWith(prefix) ? /^\d+\//u.exec(url.slice(prefix.length))?.[0] : undefined;
  if (build === undefined || url !== `${prefix}${build}${folder}/${file}`) return undefined;
  return { version, url, sha512: sha512.toLowerCase(), format: windows ? 'executable' : 'tar.gz' };
}

export function antigravityCliExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'agy.exe' : 'agy';
}

// https://github.com/agentclientprotocol/registry/blob/c804c2a1d170990efeda771e4433aa31bcdc0123/antigravity-acp/agent.json（1.4.5 的条目没有 sha256）
const releaseAssets = new Map<string, AntigravityReleaseAsset>([
  [
    'darwin-arm64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip',
      sha256: '886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f',
      archiveBytes: 97_923_855,
      executable: { name: 'agy_acp_server.par', bytes: 178_915_920 },
      harness: { name: 'localharness_external', bytes: 122_957_936 },
    },
  ],
  [
    'darwin-x64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-x86_64.zip',
      sha256: 'b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a',
      archiveBytes: 103_577_295,
      executable: { name: 'agy_acp_server.par', bytes: 183_127_600 },
      harness: { name: 'localharness_external', bytes: 127_612_208 },
    },
  ],
  [
    'linux-x64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-x86_64.zip',
      sha256: '923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b',
      archiveBytes: 321_783_181,
      executable: { name: 'agy_acp_server.par', bytes: 826_226_766 },
      harness: { name: 'localharness_external', bytes: 133_926_136 },
    },
  ],
  [
    'linux-arm64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-arm64.zip',
      sha256: '7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056',
      archiveBytes: 307_829_008,
      executable: { name: 'agy_acp_server.par', bytes: 831_194_025 },
      harness: { name: 'localharness_external', bytes: 127_512_832 },
    },
  ],
  [
    'win32-x64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-x86_64.zip',
      sha256: 'd24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50',
      archiveBytes: 100_423_655,
      executable: { name: 'agy_acp_server.exe', bytes: 55_839_864 },
      harness: { name: 'localharness_external.exe', bytes: 147_843_736 },
    },
  ],
  [
    'win32-arm64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-arm64.zip',
      sha256: 'ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c',
      archiveBytes: 102_703_121,
      executable: { name: 'agy_acp_server.exe', bytes: 62_293_488 },
      harness: { name: 'localharness_external.exe', bytes: 139_322_008 },
    },
  ],
]);

export function resolveAntigravityReleaseAsset(
  platform: NodeJS.Platform,
  arch: string,
): AntigravityReleaseAsset | null {
  return releaseAssets.get(`${platform}-${arch}`) ?? null;
}

/**
 * `WEVIR_ANTIGRAVITY_MIRROR` 替换归档所在的主机前缀，路径与官方相同。清单始终由 Google 提供。
 */
export function antigravityDownloadUrl(
  asset: Pick<AntigravityReleaseAsset, 'url'>,
  env: NodeJS.ProcessEnv,
): string {
  const mirror = env.WEVIR_ANTIGRAVITY_MIRROR?.trim().replace(/\/+$/u, '');
  if (!mirror) return asset.url;
  const origin = [ANTIGRAVITY_CLI_DOWNLOAD_ORIGIN, ANTIGRAVITY_DOWNLOAD_ORIGIN].find((value) =>
    asset.url.startsWith(`${value}/`),
  );
  return origin === undefined ? asset.url : `${mirror}${asset.url.slice(origin.length)}`;
}

/** 运行体自报的版本是否就是这个发布（1.1.1 起报 `agy_acp_server_<版本>`，T3 核对的 1.3.0 报裸版本号）。 */
export function matchesReleaseVersion(reported: string | undefined, expected: string): boolean {
  return reported === expected || reported === `agy_acp_server_${expected}`;
}

/** 各平台的可执行文件名。 */
export function antigravityExecutableNames(platform: NodeJS.Platform): {
  executable: string;
  harness: string;
} {
  return platform === 'win32'
    ? { executable: 'agy_acp_server.exe', harness: 'localharness_external.exe' }
    : { executable: 'agy_acp_server.par', harness: 'localharness_external' };
}
