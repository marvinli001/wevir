// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-grok/src/server/acpSupport.ts（`buildGrokAcpSpawnInput`、`grokAcpRuntimeProcessOwnership`）、packages/provider-grok/src/server/status.ts（`runGrokCliCommand`）、packages/provider-grok/src/server/driver.ts（npm 包名）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：可执行文件经 `@wevir/adapter-acp` 的 `resolveExternalExecutable` 找（`WEVIR_GROK_BIN` → `account.setPath` → PATH →
// 常见的安装目录），PATH 补上这些目录；不设 T3 的 `GROK_OAUTH2_REFERRER`（Wevir 不在应用里登录）；启动器按
// `AcpLauncher` 给出 spawn 参数，工作目录是数据目录下的 engines/grok。
//
// 启动用户自己装的 `grok`（grok-event-mapping.md §1）。Wevir 不随包带 Grok，也不声明它的 npm 包（AGENTS.md 规则 2）；不设
// `GROK_HOME`，`grok` 用用户自己的 ~/.grok（登录、会话记录与设置都在那里，`session/resume` 也靠它）。

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
import type { PermissionMode } from '@wevir/runtime-adapter';
import { grokSpawnArgs } from './xai.js';

/** 用户自己安装（T3 的 maintenance 用的 npm 包；x.ai 另有安装脚本，会改 shell 配置，Wevir 不替用户跑）。 */
export const GROK_INSTALL_COMMAND = 'npm install -g @xai-official/grok';

/** 用户自己在终端里登录（ADR-0005 补记 14）。 */
export const GROK_LOGIN_COMMAND = 'grok login';

/** 指定 `grok` 的路径（开发与测试用，优先于 `account.setPath`）。 */
export const GROK_BIN_ENV = 'WEVIR_GROK_BIN';

/** 有它时 Grok 用 xAI API Key 认证（T3 的 `GROK_API_KEY_ENV`）；Wevir 只透传用户自己的环境变量，不存。 */
export const XAI_API_KEY_ENV = 'XAI_API_KEY';

export const GROK_EXECUTABLE: ExternalExecutableSpec = Object.freeze({
  displayName: 'Grok Build',
  command: 'grok',
  envVar: GROK_BIN_ENV,
  installHint: `用 \`${GROK_INSTALL_COMMAND}\` 安装。`,
});

/** PATH 之外也找的位置：npm、Homebrew、bun、Volta、pnpm 的全局目录与 ~/.local/bin、~/.grok/bin。 */
export function commonGrokDirs(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    const appData = env.APPDATA;
    return [
      ...(appData === undefined ? [] : [path.win32.join(appData, 'npm')]),
      path.win32.join(home, '.grok', 'bin'),
      path.win32.join(home, '.local', 'bin'),
      path.win32.join(home, '.bun', 'bin'),
      path.win32.join(home, 'scoop', 'shims'),
    ];
  }
  return [
    path.posix.join(home, '.grok', 'bin'),
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

export interface FindGrokOptions {
  /** `account.setPath` 指定的路径。 */
  customPath?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/** 找 `grok`；找不到或指定的路径不对时抛错（`resolveExternalExecutable` 的原文）。 */
export function findGrok(options: FindGrokOptions = {}): ResolvedExecutable {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  return resolveExternalExecutable(GROK_EXECUTABLE, {
    ...(options.customPath != null && { configuredPath: options.customPath }),
    extraDirs: commonGrokDirs(home, platform, env),
    env,
    platform,
    home,
  });
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 交给 `grok` 的环境：照 T3 继承 Host 的环境（用户的 `XAI_API_KEY` 照常生效），PATH 前面加上 `grok` 所在的目录，后面补上
 * 存在而不在其中的常见目录（GUI 拉起的 Host 的 PATH 很短，`grok` 跑的命令也要找得到用户的工具）。
 */
export function grokEnv(
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
  for (const dir of commonGrokDirs(home, platform, parent)) if (isDir(dir)) add(dir);
  const env: NodeJS.ProcessEnv = { ...parent, PATH: dirs.join(separator) };
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

export type GrokCommandResult =
  | { ok: true; stdout: string; stderr: string; code: number }
  | { ok: false; reason: 'missing' | 'timeout' | 'failed'; message: string };

/** 跑一次 `grok <args>`（T3 的 `runGrokCliCommand`）：收集输出，非 0 退出也算跑完（`code`）。 */
export function runGrok(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<GrokCommandResult> {
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
          resolve({ ok: false, reason: 'missing', message: `${executable} was not found` });
        } else if ((error as { killed?: boolean }).killed === true) {
          resolve({
            ok: false,
            reason: 'timeout',
            message: `\`grok ${args.join(' ')}\` did not answer within ${timeoutMs} ms`,
          });
        } else if (typeof code === 'number') {
          resolve({ ok: true, stdout: out, stderr: err, code });
        } else {
          resolve({
            ok: false,
            reason: 'failed',
            message: `\`grok ${args.join(' ')}\` failed: ${`${out}\n${err}`.trim().slice(0, 500) || error.message}`,
          });
        }
      },
    );
  });
}

/** 从 `grok --version` 的输出里取版本号（T3 的 `parseGenericCliVersion`）。 */
export function parseGrokVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)?.[1];
}

/** 一次启动要用的 `grok` 与它的环境。 */
export interface GrokExecutable {
  path: string;
  env: NodeJS.ProcessEnv;
}

/**
 * 一种权限模式的 `grok agent stdio` 进程的启动器（`AcpLauncher`）：每次启动前重新取可执行文件（用户可能刚换了路径或装上
 * Grok），工作目录是数据目录下的 engines/grok（每个会话的 cwd 在 `session/new` 里给）。POSIX 上分离成自己的进程组，回收时
 * 连同它起的工具进程一起（T3 的 `ownDetachedProcessGroup`）。
 */
export class GrokLauncher implements AcpLauncher {
  readonly #mode: PermissionMode;
  readonly #workDir: string;
  readonly #resolve: () => Promise<GrokExecutable>;

  constructor(mode: PermissionMode, workDir: string, resolve: () => Promise<GrokExecutable>) {
    this.#mode = mode;
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
        args: grokSpawnArgs(this.#mode),
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
