// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/provider/antigravityRelease.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：加下载地址的镜像前缀 WEVIR_ANTIGRAVITY_MIRROR（照 scripts/fetch-codex.sh 的 WEVIR_GITHUB_MIRROR）。
//
// Google 官方的 Antigravity ACP 运行体（`agy_acp_server.par` 加 `localharness_external`，PyInstaller 单文件）各平台的发布包：
// 地址来自 ACP Registry，sha256 与大小由 T3 在 2026-10-05 核对，Wevir 原样钉住（docs/architecture/antigravity-event-mapping.md §2）。

export const ANTIGRAVITY_RELEASE_VERSION = '1.3.0';

/** 发布包所在的主机前缀；`WEVIR_ANTIGRAVITY_MIRROR` 替换它（大陆网络）。 */
export const ANTIGRAVITY_DOWNLOAD_ORIGIN = 'https://dl.google.com';

export interface AntigravityReleaseAsset {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly executable: { readonly name: string; readonly bytes: number };
  readonly harness: { readonly name: string; readonly bytes: number };
}

// https://github.com/agentclientprotocol/registry/blob/dc55a34900fdd60e5e97c1cbd7825c5a1df673fc/antigravity-acp/agent.json
const releaseAssets = new Map<string, AntigravityReleaseAsset>([
  [
    'darwin-arm64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip',
      sha256: '7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88',
      archiveBytes: 111_456_962,
      executable: { name: 'agy_acp_server.par', bytes: 278_535_456 },
      harness: { name: 'localharness_external', bytes: 118_611_392 },
    },
  ],
  [
    'darwin-x64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-x86_64.zip',
      sha256: 'bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646',
      archiveBytes: 117_245_544,
      executable: { name: 'agy_acp_server.par', bytes: 282_840_688 },
      harness: { name: 'localharness_external', bytes: 124_175_392 },
    },
  ],
  [
    'linux-x64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-x86_64.zip',
      sha256: '9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96',
      archiveBytes: 333_727_150,
      executable: { name: 'agy_acp_server.par', bytes: 926_533_965 },
      harness: { name: 'localharness_external', bytes: 130_388_040 },
    },
  ],
  [
    'linux-arm64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-arm64.zip',
      sha256: '500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf',
      archiveBytes: 321_690_363,
      executable: { name: 'agy_acp_server.par', bytes: 930_848_992 },
      harness: { name: 'localharness_external', bytes: 123_224_968 },
    },
  ],
  [
    'win32-x64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-x86_64.zip',
      sha256: '65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9',
      archiveBytes: 124_509_787,
      executable: { name: 'agy_acp_server.exe', bytes: 81_437_336 },
      harness: { name: 'localharness_external.exe', bytes: 145_548_952 },
    },
  ],
  [
    'win32-arm64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-arm64.zip',
      sha256: '4a0f469720e9beb9438a979f543fdbfad5022ebe0992c052c590bd78b3144ca3',
      archiveBytes: 124_654_803,
      executable: { name: 'agy_acp_server.exe', bytes: 85_893_472 },
      harness: { name: 'localharness_external.exe', bytes: 135_640_216 },
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
 * 实际下载的地址：`WEVIR_ANTIGRAVITY_MIRROR` 设了时替换 `https://dl.google.com` 前缀（例如内网镜像，路径与官方相同）。
 * 内容由钉住的 sha256 校验，镜像给错文件只会校验失败，不会装上。
 */
export function antigravityDownloadUrl(
  asset: Pick<AntigravityReleaseAsset, 'url'>,
  env: NodeJS.ProcessEnv,
): string {
  const mirror = env.WEVIR_ANTIGRAVITY_MIRROR?.trim().replace(/\/+$/u, '');
  if (!mirror || !asset.url.startsWith(`${ANTIGRAVITY_DOWNLOAD_ORIGIN}/`)) return asset.url;
  return `${mirror}${asset.url.slice(ANTIGRAVITY_DOWNLOAD_ORIGIN.length)}`;
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
