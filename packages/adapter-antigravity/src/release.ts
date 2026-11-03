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
