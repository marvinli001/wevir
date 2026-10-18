// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-grok/src/server/acpSupport.ts（`buildGrokAcpSpawnInput`、`grokAcpRuntimeProcessOwnership`）、packages/provider-grok/src/server/status.ts（`runGrokCliCommand`）、packages/provider-grok/src/server/driver.ts（npm 包名）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：从 Wevir 的 Grok 启动器复用可执行文件查找与进程环境；参数改为 codebuddy --acp，不在启动时选权限模式。

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

/** 用户自行安装官方 CLI；Wevir 不安装或分发它。 */
export const WORKBUDDY_INSTALL_COMMAND = 'npm install -g @tencent-ai/codebuddy-code';

/** 用户自己在终端里登录（ADR-0005 补记 14）。 */
export const WORKBUDDY_LOGIN_COMMAND = 'codebuddy';

/** 指定 `codebuddy` 的路径（开发与测试用，优先于 `account.setPath`）。 */
export const WORKBUDDY_BIN_ENV = 'WEVIR_WORKBUDDY_BIN';

export const WORKBUDDY_EXECUTABLE: ExternalExecutableSpec = Object.freeze({
  displayName: 'WorkBuddy / CodeBuddy',
  command: 'codebuddy',
  envVar: WORKBUDDY_BIN_ENV,
  installHint: `用 \`${WORKBUDDY_INSTALL_COMMAND}\` 安装。`,
});

/** PATH 之外也找的位置：npm、Homebrew、bun、Volta、pnpm 的全局目录与 ~/.local/bin。 */
export function commonWorkBuddyDirs(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    const appData = env.APPDATA;
    return [
      ...(appData === undefined ? [] : [path.win32.join(appData, 'npm')]),
      path.win32.join(home, '.local', 'bin'),
      path.win32.join(home, '.bun', 'bin'),
      path.win32.join(home, '.volta', 'bin'),
      ...(env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, 'pnpm')] : []),
      path.win32.join(home, 'scoop', 'shims'),
    ];
  }
  return [
    path.posix.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.posix.join(home, '.npm-global', 'bin'),
    path.posix.join(home, '.bun', 'bin'),
    path.posix.join(home, '.volta', 'bin'),
    path.posix.join(home, 'Library', 'pnpm'),
    path.posix.join(home, '.local', 'share', 'pnpm'),
  ];
}

export interface FindWorkBuddyOptions {
  /** `account.setPath` 指定的路径。 */
  customPath?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/** 找 `codebuddy`；找不到或指定的路径不对时抛错（`resolveExternalExecutable` 的原文）。 */
export function findWorkBuddy(options: FindWorkBuddyOptions = {}): ResolvedExecutable {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const optionsFor = {
    ...(options.customPath != null && { configuredPath: options.customPath }),
    env,
    platform,
    home,
  };
  // 显式设置必须有效，不能悄悄退回 PATH 或别名。
  if (env[WORKBUDDY_BIN_ENV]?.trim() || options.customPath?.trim()) {
    return resolveExternalExecutable(WORKBUDDY_EXECUTABLE, optionsFor);
  }
  let missing: unknown;
  for (const extraDirs of [[], commonWorkBuddyDirs(home, platform, env)]) {
    for (const command of ['codebuddy', 'cbc']) {
      try {
        return resolveExternalExecutable(
          { ...WORKBUDDY_EXECUTABLE, command },
          {
            ...optionsFor,
            extraDirs,
          },
        );
      } catch (error) {
        missing = error;
      }
    }
  }
  throw missing;
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 交给 `codebuddy` 的环境：照 T3 继承 Host 的环境（保留用户已有的 CODEBUDDY 登录环境），PATH 前面加上 `codebuddy` 所在的目录，后面补上
 * 存在而不在其中的常见目录（GUI 拉起的 Host 的 PATH 很短，`codebuddy` 跑的命令也要找得到用户的工具）。
 */
export function workbuddyEnv(
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
  for (const dir of commonWorkBuddyDirs(home, platform, parent)) if (isDir(dir)) add(dir);
  const env: NodeJS.ProcessEnv = { ...parent, PATH: dirs.join(separator) };
  // 完全访问仍保留 CLI 的高危命令询问，不继承关闭这道检查的开关。
  delete env.CODEBUDDY_IS_SANDBOX;
  if (platform === 'win32') delete env.Path;
  return env;
}

/** Windows 上 npm 装的是 `.cmd` 启动脚本，不经 shell 起不了（Node 20.12 起 `spawn EINVAL`）。 */
export function needsShell(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
}

export type WorkBuddyCommandResult =
  | { ok: true; stdout: string; stderr: string; code: number }
  | { ok: false; reason: 'missing' | 'timeout' | 'failed'; message: string };

/** 跑一次 `codebuddy <args>`（T3 的 `runGrokCliCommand`）：收集输出，非 0 退出也算跑完（`code`）。 */
export function runWorkBuddy(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WorkBuddyCommandResult> {
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
          resolve({ ok: false, reason: 'missing', message: 'CodeBuddy executable was not found' });
        } else if ((error as { killed?: boolean }).killed === true) {
          resolve({
            ok: false,
            reason: 'timeout',
            message: `\`codebuddy ${args.join(' ')}\` did not answer within ${timeoutMs} ms`,
          });
        } else if (typeof code === 'number') {
          resolve({ ok: true, stdout: out, stderr: err, code });
        } else {
          resolve({
            ok: false,
            reason: 'failed',
            message: `CodeBuddy command failed (${typeof code === 'string' ? code : 'unknown'})`,
          });
        }
      },
    );
  });
}

/** 从 `codebuddy --version` 的输出里取版本号（T3 的 `parseGenericCliVersion`）。 */
export function parseWorkBuddyVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)?.[1];
}

/** 一次启动要用的 `codebuddy` 与它的环境。 */
export interface WorkBuddyExecutable {
  path: string;
  env: NodeJS.ProcessEnv;
}

/**
 * 官方的 `codebuddy --acp` 进程的启动器（`AcpLauncher`）：每次启动前重新取可执行文件（用户可能刚换了路径或装上
 * WorkBuddy），工作目录是数据目录下的 engines/workbuddy（每个会话的 cwd 在 `session/new` 里给）。POSIX 上分离成自己的进程组，回收时
 * 连同它起的工具进程一起（T3 的 `ownDetachedProcessGroup`）。
 */
export class WorkBuddyLauncher implements AcpLauncher {
  readonly #workDir: string;
  readonly #resolve: () => Promise<WorkBuddyExecutable>;

  constructor(workDir: string, resolve: () => Promise<WorkBuddyExecutable>) {
    this.#workDir = workDir;
    this.#resolve = resolve;
  }

  async prepare(): Promise<AcpPreparedLaunch> {
    const executable = await this.#resolve();
    mkdirSync(this.#workDir, { recursive: true });
    return {
      incremental: 'off',
      spawnSpec: () => ({
        command: executable.path,
        args: ['--acp'],
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
