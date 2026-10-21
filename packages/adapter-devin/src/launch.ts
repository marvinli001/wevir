// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-grok/src/server/acpSupport.ts（`buildGrokAcpSpawnInput`、`grokAcpRuntimeProcessOwnership`）、packages/provider-grok/src/server/status.ts（`runGrokCliCommand`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：经 Wevir 的 WorkBuddy 启动器改写；参数改为 devin acp，可执行文件与常见目录按 Devin CLI 的安装方式。

import { execFile } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  type AcpLauncher,
  type AcpPreparedLaunch,
  type ExternalExecutableSpec,
  type ResolvedExecutable,
  resolveExternalExecutable,
} from '@wevir/adapter-acp';

/** 用户自己装官方 CLI 的命令；设置里的“下载”（install.ts）照同一份官方清单装，不随应用分发。 */
export function devinInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'irm https://static.devin.ai/cli/setup.ps1 | iex'
    : 'curl -fsSL https://cli.devin.ai/install.sh | bash';
}

/** 终端里登录；设置里的“登录”（login.ts）替用户做同样的事（ADR-0005 补记 14）。 */
export const DEVIN_LOGIN_COMMAND = 'devin auth login';

/** 登录命令：Wevir 替用户装的 `devin` 不在 PATH 里，终端里要写全路径。 */
export function devinLoginCommand(executablePath: string | undefined, managed: boolean): string {
  return managed && executablePath !== undefined
    ? `"${executablePath}" auth login`
    : DEVIN_LOGIN_COMMAND;
}

/** 指定 `devin` 的路径（开发与测试用，优先于 `account.setPath`）。 */
export const DEVIN_BIN_ENV = 'WEVIR_DEVIN_BIN';

export const DEVIN_EXECUTABLE: ExternalExecutableSpec = Object.freeze({
  displayName: 'Devin CLI',
  command: 'devin',
  envVar: DEVIN_BIN_ENV,
  installHint: `用 \`${devinInstallCommand()}\` 安装。`,
});

/** PATH 之外也找的位置：官方脚本的 ~/.local/bin（Windows 是 %LOCALAPPDATA%\devin\cli\bin）、Homebrew。 */
export function commonDevinDirs(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    return [
      ...(env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, 'devin', 'cli', 'bin')] : []),
      path.win32.join(home, '.local', 'bin'),
      path.win32.join(home, 'scoop', 'shims'),
    ];
  }
  return [path.posix.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

export interface FindDevinOptions {
  /** `account.setPath` 指定的路径。 */
  customPath?: string | null;
  /** Wevir 自己装的 `devin`：用户的 PATH 与常见位置里都没有时才用，所以不会换掉用户自己装的。 */
  managedPath?: string | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * 找 `devin`：`WEVIR_DEVIN_BIN` → 设置里填的路径（显式的必须有效，不换别处）→ PATH → 常见安装目录 → Wevir 自己装的。
 * 找不到时抛错（`resolveExternalExecutable` 的原文）。
 */
export function findDevin(options: FindDevinOptions = {}): ResolvedExecutable {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const optionsFor = {
    ...(options.customPath != null && { configuredPath: options.customPath }),
    env,
    platform,
    home,
  };
  // 显式设置必须有效，不能悄悄退回 PATH。
  if (env[DEVIN_BIN_ENV]?.trim() || options.customPath?.trim()) {
    return resolveExternalExecutable(DEVIN_EXECUTABLE, optionsFor);
  }
  let missing: unknown;
  for (const extraDirs of [[], commonDevinDirs(home, platform, env)]) {
    try {
      return resolveExternalExecutable(DEVIN_EXECUTABLE, { ...optionsFor, extraDirs });
    } catch (error) {
      missing = error;
    }
  }
  const managed = options.managedPath?.trim();
  if (managed !== undefined && managed !== '' && isFile(managed)) {
    return { path: managed, source: 'component' };
  }
  throw missing;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
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

/**
 * 交给 `devin` 的环境：照 T3 继承 Host 的环境（保留用户的 `WINDSURF_API_KEY`、代理等），PATH 前面加上 `devin` 所在的目录，
 * 后面补上存在而不在其中的常见目录（GUI 拉起的 Host 的 PATH 很短）。Devin 跑命令时自己再读一次登录 shell 的环境。
 */
export function devinEnv(
  parent: NodeJS.ProcessEnv,
  executable: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  isDir: (dir: string) => boolean = isDirectory,
): NodeJS.ProcessEnv {
  const separator = platform === 'win32' ? ';' : ':';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const current = (parent.PATH ?? parent.Path ?? '').split(separator).filter((dir) => dir !== '');
  const dirs: string[] = [];
  const add = (dir: string) => {
    if (!dirs.includes(dir)) dirs.push(dir);
  };
  add(pathApi.dirname(executable));
  for (const dir of current) add(dir);
  for (const dir of commonDevinDirs(home, platform, parent)) if (isDir(dir)) add(dir);
  const env: NodeJS.ProcessEnv = { ...parent, PATH: dirs.join(separator) };
  if (platform === 'win32') delete env.Path;
  return env;
}

/** Windows 上 `.cmd` 启动脚本不经 shell 起不了（Node 20.12 起 `spawn EINVAL`）；官方装的是 `devin.exe`，测试的假 CLI 是 `.cmd`。 */
export function needsShell(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
}

export type DevinCommandResult =
  | { ok: true; stdout: string; stderr: string; code: number }
  | { ok: false; reason: 'missing' | 'timeout' | 'failed'; message: string };

/** 跑一次 `devin <args>`（T3 的 `runGrokCliCommand`）：收集输出，非 0 退出也算跑完（`code`）。 */
export function runDevin(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<DevinCommandResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        env,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        shell: needsShell(executable),
        ...(signal !== undefined && { signal }),
      },
      (error, stdout, stderr) => {
        const out = String(stdout);
        const err = String(stderr);
        if (error === null) {
          resolve({ ok: true, stdout: out, stderr: err, code: 0 });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          resolve({ ok: false, reason: 'missing', message: 'Devin CLI executable was not found' });
        } else if ((error as { killed?: boolean }).killed === true) {
          resolve({
            ok: false,
            reason: 'timeout',
            message: `\`devin ${args.join(' ')}\` did not answer within ${timeoutMs} ms`,
          });
        } else if (typeof code === 'number') {
          resolve({ ok: true, stdout: out, stderr: err, code });
        } else {
          resolve({
            ok: false,
            reason: 'failed',
            message: `Devin CLI command failed (${typeof code === 'string' ? code : 'unknown'})`,
          });
        }
      },
    );
  });
}

/** 从 `devin --version` 的输出（`devin 3000.11.92 (7f4e64980e22)`）里取版本号。 */
export function parseDevinVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)?.[1];
}

/** 一次启动要用的 `devin` 与它的环境。 */
export interface DevinExecutable {
  path: string;
  env: NodeJS.ProcessEnv;
}

/**
 * 官方的 `devin acp` 进程的启动器（`AcpLauncher`）：每次启动前重新取可执行文件（用户可能刚换了路径或装上 Devin），工作目录是
 * 数据目录下的 engines/devin（每个会话的 cwd 在 `session/new` 里给）。POSIX 上分离成自己的进程组，回收时连同它起的工具进程
 * 一起（T3 的 `ownDetachedProcessGroup`）。
 */
export class DevinLauncher implements AcpLauncher {
  readonly #workDir: string;
  readonly #resolve: () => Promise<DevinExecutable>;

  constructor(workDir: string, resolve: () => Promise<DevinExecutable>) {
    this.#workDir = workDir;
    this.#resolve = resolve;
  }

  async prepare(): Promise<AcpPreparedLaunch> {
    const executable = await this.#resolve();
    mkdirSync(this.#workDir, { recursive: true });
    return {
      spawnSpec: () => ({
        command: executable.path,
        args: ['acp'],
        options: {
          cwd: this.#workDir,
          env: executable.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
          shell: needsShell(executable.path),
        },
      }),
    };
  }
}
