// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-opencode/src/server/versionProbe.ts（`opencode --version`、`classifyOpenCodeCliVersion`）、
// OpenCodeRuntime.ts（`MINIMUM_OPENCODE_VERSION`）、status.ts（没装时的判断）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS；T3 的桌面端读登录 shell 的环境，Wevir 改为在 PATH 之外再找常见的安装位置（同
// adapter-claude 的 executable.ts），并补进交给 opencode 的 PATH；2.x 不支持，按版本号认出来后提示。
//
// 找用户自己装的 `opencode`（opencode-event-mapping.md §2）：用户指定的路径 → `WEVIR_OPENCODE_BIN` → PATH → 常见的安装位置。
// 官方安装脚本放在 ~/.opencode/bin，npm / bun / Homebrew 各有自己的目录；桌面端拉起的 Host 继承的是 GUI 的短 PATH，所以这些
// 位置都要找一遍。

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 官方的安装命令之一（opencode 的 README：`npm i -g opencode-ai@latest`；另有 `curl -fsSL https://opencode.ai/install | bash`）。 */
export const OPENCODE_INSTALL_COMMAND = 'npm install -g opencode-ai';

/** 用户自己在终端里登录上游（Wevir 不登录，ADR-0005 补记 14）。 */
export const OPENCODE_LOGIN_COMMAND = 'opencode auth login';

/** 环境变量：指定 `opencode` 的路径（开发与测试用，优先于自动查找，低于 `account.setPath`）。 */
export const OPENCODE_BIN_ENV = 'WEVIR_OPENCODE_BIN';

/** 支持的最低版本（T3 的 `MINIMUM_OPENCODE_VERSION`：更早的服务器没有这里用到的权限与提问接口）。 */
export const MINIMUM_OPENCODE_VERSION = '1.14.19';

/** 版本探测的时限（T3 的 `OPENCODE_VERSION_PROBE_TIMEOUT` 是 4 秒；冷启动的 opencode 首次要解包，放宽到 10 秒）。 */
export const VERSION_TIMEOUT_MS = 10_000;

/** 不在 PATH 里时也找的位置（按常见程度排）。 */
export function commonOpenCodeDirs(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    const appData = env.APPDATA;
    const localAppData = env.LOCALAPPDATA;
    return [
      path.win32.join(home, '.opencode', 'bin'),
      ...(appData === undefined ? [] : [path.win32.join(appData, 'npm')]),
      path.win32.join(home, 'scoop', 'shims'),
      ...(localAppData === undefined
        ? []
        : [path.win32.join(localAppData, 'Microsoft', 'WinGet', 'Links')]),
      path.win32.join(home, '.bun', 'bin'),
    ];
  }
  return [
    path.posix.join(home, '.opencode', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.posix.join(home, '.local', 'bin'),
    path.posix.join(home, '.npm-global', 'bin'),
    path.posix.join(home, '.bun', 'bin'),
    path.posix.join(home, '.volta', 'bin'),
    path.posix.join(home, 'Library', 'pnpm'),
    path.posix.join(home, '.local', 'share', 'pnpm'),
    path.posix.join(home, '.local', 'share', 'mise', 'shims'),
  ];
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function executableNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? ['opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode']
    : ['opencode'];
}

export interface FindOpenCodeOptions {
  /** `account.setPath` 指定的路径，`~` 开头的按家目录展开。 */
  customPath?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (filePath: string) => boolean;
}

/**
 * 找 `opencode`：用户指定的路径（存在才用，不存在返回 undefined，不再自动找）→ `WEVIR_OPENCODE_BIN` → PATH →
 * `commonOpenCodeDirs`。找不到时 undefined。
 */
export function findOpenCode(options: FindOpenCodeOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const exists = options.exists ?? isFile;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  const custom = options.customPath?.trim();
  if (custom !== undefined && custom !== '') {
    const expanded =
      custom === '~' || custom.startsWith('~/') ? pathApi.join(home, custom.slice(1)) : custom;
    return exists(expanded) ? expanded : undefined;
  }
  const fromEnv = env[OPENCODE_BIN_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== '' && exists(fromEnv)) return fromEnv;

  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = [
    ...pathValue.split(platform === 'win32' ? ';' : ':').filter((dir) => dir !== ''),
    ...commonOpenCodeDirs(home, platform, env),
  ];
  for (const dir of dirs) {
    for (const name of executableNames(platform)) {
      const candidate = pathApi.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * 交给 `opencode` 的 PATH：原来的 PATH，前面加上 `opencode` 所在的目录，后面补上存在而不在其中的常见目录（opencode 的 bash
 * 工具跑的命令也要找得到用户的工具）。
 */
export function openCodePath(
  executable: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  isDir: (dir: string) => boolean = isDirectory,
): string {
  const separator = platform === 'win32' ? ';' : ':';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const current = (env.PATH ?? env.Path ?? '').split(separator).filter((dir) => dir !== '');
  const result: string[] = [];
  const add = (dir: string) => {
    if (!result.includes(dir)) result.push(dir);
  };
  if (executable !== undefined) add(pathApi.dirname(executable));
  for (const dir of current) add(dir);
  for (const dir of commonOpenCodeDirs(home, platform, env)) if (isDir(dir)) add(dir);
  return result.join(separator);
}

/** 交给 `opencode` 的环境：继承 Host 的（用户的上游 Key 等照常生效），补 PATH。 */
export function openCodeEnv(
  parent: NodeJS.ProcessEnv,
  executable: string | undefined,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...parent };
  env.PATH = openCodePath(executable, parent);
  if (process.platform === 'win32') delete env.Path;
  return env;
}

/**
 * 从 `opencode --version` 的输出里取版本号（T3 的 `classifyOpenCodeCliVersion`：1.x 打印 `1.18.32`，2.x 打印
 * `opencode v2.0.18`）。
 */
export function parseOpenCodeVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)?.[1];
}

/** 比较两个 `x.y.z` 版本（预发布后缀忽略）；左边小于右边返回负数。 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    (value.split(/[-+]/)[0] ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export type VersionProbe =
  | { ok: true; version: string | undefined }
  | { ok: false; reason: 'missing' | 'timeout' | 'failed'; message: string };

/** 跑一次 `opencode --version`（T3 的 `probeOpenCodeBinary`）。不经 shell。 */
export function probeOpenCodeVersion(
  executable: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number = VERSION_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<VersionProbe> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ['--version'],
      {
        env,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        ...(signal !== undefined && { signal }),
      },
      (error, stdout, stderr) => {
        const output = `${String(stdout)}\n${String(stderr)}`;
        if (error === null) {
          resolve({ ok: true, version: parseOpenCodeVersion(output) });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          resolve({ ok: false, reason: 'missing', message: `${executable} was not found` });
        } else if ((error as { killed?: boolean }).killed === true) {
          resolve({
            ok: false,
            reason: 'timeout',
            message: `\`opencode --version\` did not answer within ${timeoutMs} ms`,
          });
        } else {
          const text = output.trim();
          // T3 的 formatOpenCodeProbeError：macOS 隔离或签名问题给出处理办法。
          const hint = /quarantine/i.test(text)
            ? ' (macOS quarantine: run `xattr -d com.apple.quarantine "$(which opencode)"`)'
            : /invalid code signature|corrupted/i.test(text)
              ? ' (invalid code signature: reinstall OpenCode)'
              : '';
          resolve({
            ok: false,
            reason: 'failed',
            message: `\`opencode --version\` failed: ${text.slice(0, 500) || error.message}${hint}`,
          });
        }
      },
    );
  });
}
