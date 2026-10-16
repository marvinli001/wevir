// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/provider/Drivers/ClaudeExecutable.ts（Windows npm 启动脚本 → 包入口）、apps/server/src/provider/ClaudeProvider.ts（`claude --version`）、apps/web/src/onboarding/providerReadiness.logic.ts（安装命令）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS；T3 的桌面端读登录 shell 的环境，Wevir 改为在 PATH 之外再找常见的安装位置，并补进交给 claude 的 PATH。
//
// 找用户自己装的 `claude`（claude-event-mapping.md §2）：用户指定的路径 → PATH → 常见的安装位置。Host 由桌面端拉起时继承的
// 是 GUI 的 PATH（macOS 上只有 /usr/bin:/bin:/usr/sbin:/sbin），官方安装脚本放的 ~/.local/bin 与 Homebrew、npm、bun 的目录
// 都不在里面；T3 的桌面端为此读登录 shell 的环境，Wevir 不读，改为把这些位置一并找一遍，并补进交给 `claude` 的 PATH
// （它的 Bash 工具跑的命令也要找得到用户的工具）。

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 官方的安装命令（T3 的引导页同样给这两条）。 */
export const CLAUDE_INSTALL_COMMAND =
  process.platform === 'win32'
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash';

/** 用户自己在终端里登录（Wevir 不登录，ADR-0005 补记 14）。 */
export const CLAUDE_LOGIN_COMMAND = 'claude auth login';

/** 环境变量：指定 `claude` 的路径（开发与测试用，优先于自动查找，低于 `account.setPath`）。 */
export const CLAUDE_BIN_ENV = 'WEVIR_CLAUDE_BIN';

/** 版本探测的时限（T3 的 `DEFAULT_TIMEOUT_MS`）。 */
export const VERSION_TIMEOUT_MS = 10_000;

/** 不在 PATH 里时也找的位置（按常见程度排）。 */
export function commonClaudeDirs(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    const appData = env.APPDATA;
    return [
      path.win32.join(home, '.local', 'bin'),
      ...(appData === undefined ? [] : [path.win32.join(appData, 'npm')]),
      path.win32.join(home, '.bun', 'bin'),
      path.win32.join(home, 'scoop', 'shims'),
    ];
  }
  return [
    path.posix.join(home, '.local', 'bin'),
    path.posix.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.posix.join(home, '.npm-global', 'bin'),
    path.posix.join(home, '.bun', 'bin'),
    path.posix.join(home, '.volta', 'bin'),
    path.posix.join(home, 'Library', 'pnpm'),
    path.posix.join(home, '.local', 'share', 'pnpm'),
  ];
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function executableNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'] : ['claude'];
}

/**
 * Windows 上的 npm 启动脚本（.cmd / .bat / .ps1）：Node 不经 shell 起不了（Node 20.12 起 `spawn EINVAL`），SDK 的
 * `pathToClaudeCodeExecutable` 也就不能用它。
 */
export function isWindowsLauncherShim(filePath: string): boolean {
  return ['.cmd', '.bat', '.ps1'].includes(path.win32.extname(filePath).toLowerCase());
}

/**
 * npm 启动脚本旁边的包入口（T3 的 `resolveClaudeSdkExecutablePath`）：新版本带原生的 `bin/claude.exe`，旧版本只有 `cli.js`
 * （SDK 用 JS 运行时跑它）。找不到时原样返回。
 */
export function resolveWindowsShim(
  shimPath: string,
  exists: (filePath: string) => boolean = isFile,
): string {
  const dir = path.win32.dirname(shimPath);
  for (const entry of [
    ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'],
    ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'],
  ]) {
    const candidate = path.win32.join(dir, ...entry);
    if (exists(candidate)) return candidate;
  }
  return shimPath;
}

export interface FindClaudeOptions {
  /** `account.setPath` 指定的路径，`~` 开头的按家目录展开。 */
  customPath?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (filePath: string) => boolean;
}

/**
 * 找 `claude`：用户指定的路径（存在才用，不存在返回 undefined，不再自动找）→ `WEVIR_CLAUDE_BIN` → PATH → `commonClaudeDirs`。
 * Windows 上的 npm 启动脚本换成包入口。返回能交给 SDK 的路径；找不到时 undefined。
 */
export function findClaude(options: FindClaudeOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const exists = options.exists ?? isFile;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const finish = (found: string) =>
    platform === 'win32' && isWindowsLauncherShim(found)
      ? resolveWindowsShim(found, exists)
      : found;

  const custom = options.customPath?.trim();
  if (custom !== undefined && custom !== '') {
    const expanded =
      custom === '~' || custom.startsWith('~/') ? pathApi.join(home, custom.slice(1)) : custom;
    return exists(expanded) ? finish(expanded) : undefined;
  }
  const fromEnv = env[CLAUDE_BIN_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== '' && exists(fromEnv)) return finish(fromEnv);

  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = [
    ...pathValue.split(platform === 'win32' ? ';' : ':').filter((dir) => dir !== ''),
    ...commonClaudeDirs(home, platform, env),
  ];
  for (const dir of dirs) {
    for (const name of executableNames(platform)) {
      const candidate = pathApi.join(dir, name);
      if (exists(candidate)) return finish(candidate);
    }
  }
  return undefined;
}

/**
 * 交给 `claude` 的 PATH：原来的 PATH，前面加上 `claude` 所在的目录，后面补上存在而不在其中的常见目录（GUI 拉起的 Host 的
 * PATH 很短，`claude` 的 Bash 工具也要找得到用户的工具）。
 */
export function claudePath(
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
  if (executable !== undefined && !executable.endsWith('.js')) add(pathApi.dirname(executable));
  for (const dir of current) add(dir);
  for (const dir of commonClaudeDirs(home, platform, env)) if (isDir(dir)) add(dir);
  return result.join(separator);
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 从 `claude --version` 的输出里取版本号（如 `2.1.287 (Claude Code)` → `2.1.287`；T3 的 `parseGenericCliVersion`）。 */
export function parseClaudeVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)?.[1];
}

export type VersionProbe =
  | { ok: true; version: string | undefined }
  | { ok: false; reason: 'missing' | 'timeout' | 'failed'; message: string };

/**
 * 跑一次 `claude --version`（T3 的健康检查第一步）。`cli.js` 用 Host 自己的 Node 跑。不经 shell，Windows 的启动脚本已在
 * `findClaude` 里换成包入口。
 */
export function probeClaudeVersion(
  executable: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number = VERSION_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<VersionProbe> {
  const [command, args] = executable.endsWith('.js')
    ? [process.execPath, [executable, '--version']]
    : [executable, ['--version']];
  return new Promise((resolve) => {
    execFile(
      command,
      args,
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
          resolve({ ok: true, version: parseClaudeVersion(output) });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          resolve({ ok: false, reason: 'missing', message: `${executable} was not found` });
        } else if ((error as { killed?: boolean }).killed === true) {
          resolve({
            ok: false,
            reason: 'timeout',
            message: `\`claude --version\` did not answer within ${timeoutMs} ms`,
          });
        } else {
          resolve({
            ok: false,
            reason: 'failed',
            message: `\`claude --version\` failed: ${output.trim().slice(0, 500) || error.message}`,
          });
        }
      },
    );
  });
}
