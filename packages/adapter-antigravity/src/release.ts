// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/provider/antigravityRelease.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8；1.4.1 的发布表照 4432fbef71817c279290f86549be660af25005f2
// Copyright (c) 2026 T3 Tools Inc.
// 修改：加下载地址的镜像前缀 WEVIR_ANTIGRAVITY_MIRROR（照 scripts/fetch-codex.sh 的 WEVIR_GITHUB_MIRROR）。
//
// Google 官方的 Antigravity ACP 运行体（`agy_acp_server.par` 加 `localharness_external`，PyInstaller 单文件）各平台的发布包：
// 地址来自 ACP Registry，sha256 与大小照 T3 钉的 1.4.1，Wevir 在 2026-10-30 下载六个包重新核对过。

// 1.4.2 到 1.4.4 会往每个会话的工作区写 skills/system/run-workflow/SKILL.md，T3 因此钉在 1.4.1，Wevir 照钉。
export const ANTIGRAVITY_RELEASE_VERSION = '1.4.1';

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

// https://github.com/agentclientprotocol/registry/blob/c804c2a1d170990efeda771e4433aa31bcdc0123/antigravity-acp/agent.json（1.4.1 的条目没有 sha256）
const releaseAssets = new Map<string, AntigravityReleaseAsset>([
  [
    'darwin-arm64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-darwin-arm64.zip',
      sha256: 'f9bdd68291ae78c38d2141e63bc86b84e6cc7b9f60f71652c68435a7943deb17',
      archiveBytes: 112_737_434,
      executable: { name: 'agy_acp_server.par', bytes: 280_996_576 },
      harness: { name: 'localharness_external', bytes: 120_246_928 },
    },
  ],
  [
    'darwin-x64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-darwin-x86_64.zip',
      sha256: '27e31f096874704f14167b07ef9e84cc77134615ee41d024f7b1c957add85307',
      archiveBytes: 118_349_036,
      executable: { name: 'agy_acp_server.par', bytes: 285_186_624 },
      harness: { name: 'localharness_external', bytes: 124_910_048 },
    },
  ],
  [
    'linux-x64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.1-linux-x86_64.zip',
      sha256: '2e37012ceb2a5c7fc7309b6e6596234fb637ee3c62a5199f65d4cbe777871384',
      archiveBytes: 336_170_339,
      executable: { name: 'agy_acp_server.par', bytes: 930_826_753 },
      harness: { name: 'localharness_external', bytes: 131_187_512 },
    },
  ],
  [
    'linux-arm64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.1-linux-arm64.zip',
      sha256: '609336a1c97545487e3ddd55dbd153dc0f40f4e6534486cc1c5f4c0ebb85c2da',
      archiveBytes: 321_922_507,
      executable: { name: 'agy_acp_server.par', bytes: 933_416_796 },
      harness: { name: 'localharness_external', bytes: 124_895_000 },
    },
  ],
  [
    'win32-x64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.1-windows-x86_64.zip',
      sha256: '5f5b7d0328df17c128b2be338d4567b0d24e56ace8196e88794fec37d1372554',
      archiveBytes: 129_599_308,
      executable: { name: 'agy_acp_server.exe', bytes: 86_098_784 },
      harness: { name: 'localharness_external.exe', bytes: 146_036_888 },
    },
  ],
  [
    'win32-arm64',
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.1-windows-arm64.zip',
      sha256: '24c52bbc12aae20f55eb53d373669412d95a9c44fd59be4ea4e355918b91fbf7',
      archiveBytes: 132_507_344,
      executable: { name: 'agy_acp_server.exe', bytes: 93_197_744 },
      harness: { name: 'localharness_external.exe', bytes: 136_970_904 },
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
