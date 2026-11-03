// SPDX-License-Identifier: MIT
// 安装包不带 `@cursor/sdk`（许可证是“All rights reserved”，Wevir 不再分发它），用户选用 Cursor 时由 Host 替用户从 npm registry
// 下载（`account.install`，accounts.ts）：SDK 与它的依赖、本平台的平台包（tree-sitter 的 `.node`、`rg` 与 `cursorsandbox`），版本
// 与 sha512 写死在 `CURSOR_SDK_PACKAGES`（与 pnpm-lock.yaml 一致，sdk-install.test.ts 核对）。下载、核对与目录布局
// （`<数据目录>/engines/cursor/sdk` 下的 versions/<版本>/node_modules 与 active.json）在 runtime-adapter 的 npm-closure.ts。
// 开发环境的 SDK 经 pnpm 装上，不走这里（engines.ts）。

import path from 'node:path';
import {
  type NpmClosureInstallation,
  type NpmClosureInstallEvent,
  NpmClosureInstaller,
  type NpmClosurePackage,
} from '@wevir/runtime-adapter/npm-closure';
import { cursorEngineDir } from './credentials.js';
import { CURSOR_SDK_VERSION } from './sdk.js';

/** 要下载的一个包；`os` / `cpu` 只在那个平台装（平台包）。integrity 来自 pnpm-lock.yaml。 */
export type CursorSdkPackage = NpmClosurePackage;

/** `@cursor/sdk` 的生产依赖闭包（pnpm-lock.yaml，钉 1.2.0）。1.0.38 起 `zod` 是 peer，由本包的依赖钉在 3.25.76，下载时照样带上。 */
export const CURSOR_SDK_PACKAGES: readonly CursorSdkPackage[] = Object.freeze([
  {
    name: '@cursor/sdk',
    version: CURSOR_SDK_VERSION,
    integrity:
      'sha512-Nqm2U0zTWrYEDCv3Rdwsfa1gYZWsg+JnY+I2F8BwWSAr3FNo0TZWwyHWoWngZgriF1w02fJ4gjJWaul9zysvgQ==',
  },
  {
    name: '@bufbuild/protobuf',
    version: '1.10.0',
    integrity:
      'sha512-QDdVFLoN93Zjg36NoQPZfsVH9tZew7wKDKyV5qRdj8ntT4wQCOradQjRaTdwMhWUYsgKsvCINKKm87FdEk96Ag==',
  },
  {
    name: '@connectrpc/connect',
    version: '1.7.0',
    integrity:
      'sha512-iNKdJRi69YP3mq6AePRT8F/HrxWCewrhxnLMNm0vpqXAR8biwzRtO6Hjx80C6UvtKJ5sFmffQT7I4Baecz389w==',
  },
  {
    name: '@connectrpc/connect-web',
    version: '1.7.0',
    integrity:
      'sha512-qyP0YOnUPRWwCc/VfsoydMJvkb7EyUPr2q9sHgBuJzbADjiqck1gKH5V5ZPzPhTLBvmz5UvG+wiZ5sMRQHU1MQ==',
  },
  {
    name: '@statsig/js-client',
    version: '3.31.0',
    integrity:
      'sha512-LFa5E0LjT6sTfZv3sNGoyRLSZ1078+agdgOA+Vm1ecjG+KbSOfBLTW7hMwimrJ29slRwbYDzbtKaPJo/R37N2g==',
  },
  {
    name: '@statsig/client-core',
    version: '3.31.0',
    integrity:
      'sha512-SuxQD6TmVszPG7FoMKwTk/uyBuVFk7XnxI3T/E0uyb7PL7GNjONtfsoh+NqBBVUJVse0CUeSFfgJPoZy1ZOslQ==',
  },
  {
    name: 'zod',
    version: '3.25.76',
    integrity:
      'sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==',
  },
  {
    name: '@cursor/sdk-darwin-arm64',
    version: CURSOR_SDK_VERSION,
    integrity:
      'sha512-UkZ/RdxKCpOQ85nRgzSq+g0h+gIw36/lCEvQvomhs5EkSFZW3OwbeEzkAU3UYglZ7t3RNHj3mc5C5cdDtHguvw==',
    os: 'darwin',
    cpu: 'arm64',
  },
  {
    name: '@cursor/sdk-darwin-x64',
    version: CURSOR_SDK_VERSION,
    integrity:
      'sha512-mJTFdX+qv9dHAm59tT7uq7ci7+BDvFoNk4gdF2zGp9SLULicY+FdFD64p1qLen1bX5Y2soZaX5mWBy7BfObjcg==',
    os: 'darwin',
    cpu: 'x64',
  },
  {
    name: '@cursor/sdk-linux-arm64',
    version: CURSOR_SDK_VERSION,
    integrity:
      'sha512-Rs+cd5snuhxMAHkpqRfEGPB1qAsfqSOYJh5SOHZTOWy2LkRVO62WHwd4x80C2emj+dosTV5WAcuF2kMKKcrDJg==',
    os: 'linux',
    cpu: 'arm64',
  },
  {
    name: '@cursor/sdk-linux-x64',
    version: CURSOR_SDK_VERSION,
    integrity:
      'sha512-ainsGAFtkWTBZrLABp82Hvfv7VB/FxmZHE42qMVotFTRDwOY2iduvhSig910bVxv+kw3S00Srmu/9CxklLwhbw==',
    os: 'linux',
    cpu: 'x64',
  },
  {
    name: '@cursor/sdk-win32-x64',
    version: CURSOR_SDK_VERSION,
    integrity:
      'sha512-p3rkyta6R/nXIukd3/ifJq32otkkGoUi41T2jxnHbPHMhzE2F8OuJQGBVmORuQLMr+bIGGVZmCxertgs4WgzcQ==',
    os: 'win32',
    cpu: 'x64',
  },
]);

/** 这个平台要装的包；SDK 没有这个平台的平台包时 undefined（不能装）。 */
export function cursorSdkPackages(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CursorSdkPackage[] | undefined {
  const own = CURSOR_SDK_PACKAGES.filter(
    (entry) => entry.os === undefined || (entry.os === platform && entry.cpu === arch),
  );
  return own.some((entry) => entry.os !== undefined) ? own : undefined;
}

/** 本平台能不能装 SDK。 */
export function cursorSdkInstallSupported(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return cursorSdkPackages(platform, arch) !== undefined;
}

/** 默认的安装目录：引擎目录下的 `sdk`（与登录铸的 `auth.json` 并列）。 */
export function cursorSdkDirectory(home: string): string {
  return path.join(cursorEngineDir(home), 'sdk');
}

/** 装好的 SDK：`root` 下是 `node_modules/@cursor/sdk` 与它的依赖。 */
export type CursorSdkInstallation = NpmClosureInstallation;

/** 安装进度与结果（`onChange`）。 */
export type CursorSdkInstallEvent = NpmClosureInstallEvent;

export interface CursorSdkInstallerOptions {
  /** 安装根目录（`cursorSdkDirectory`），不存在时建。 */
  directory: string;
  registries?: readonly string[];
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  /** 多久收不到数据算下载卡住。 */
  idleTimeoutMs?: number;
  progressIntervalMs?: number;
  /** 测试用：换掉要装的包（默认按平台从 `CURSOR_SDK_PACKAGES` 里选）。 */
  packages?: readonly CursorSdkPackage[];
}

/** 解开约 35 MB，留出余量。 */
const REQUIRED_SPACE = 128 * 1024 * 1024;

/** 一个 Host 一个（首个账号与添加的账号共用，engines.ts）：同一时刻只有一次安装，进度与结果经 `onChange` 告诉每个账号。 */
export class CursorSdkInstaller extends NpmClosureInstaller {
  constructor(options: CursorSdkInstallerOptions) {
    const { platform, arch, packages, ...rest } = options;
    super({
      ...rest,
      label: 'Cursor SDK',
      main: { name: '@cursor/sdk', version: CURSOR_SDK_VERSION },
      packages: packages ?? cursorSdkPackages(platform, arch),
      requiredSpace: REQUIRED_SPACE,
    });
  }
}

export { tarballUrl } from '@wevir/runtime-adapter/npm-closure';
