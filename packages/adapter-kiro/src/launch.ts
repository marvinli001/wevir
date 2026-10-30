// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-grok/src/server/acpSupport.ts（`buildGrokAcpSpawnInput`、`grokAcpRuntimeProcessOwnership`）、packages/provider-grok/src/server/status.ts（`runGrokCliCommand`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：经 Wevir 的 GitHub Copilot 启动器改写；参数改为 kiro-cli acp，可执行文件与常见目录按 Kiro CLI。

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

/** 用户自己装官方 CLI 的命令（cli.kiro.dev）；设置里的“下载”（install.ts）读同一份发布清单，不随应用分发。 */
export function kiroInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'irm https://cli.kiro.dev/install.ps1 | iex'
    : 'curl -fsSL https://cli.kiro.dev/install | bash';
}

/** 终端里登录；设置里的“登录”（login.ts）替用户跑设备码登录。 */
export const KIRO_LOGIN_COMMAND = 'kiro-cli login';

/** 登录命令：Wevir 替用户装的 `kiro-cli` 不在 PATH 里要写全路径。 */
export function kiroLoginCommand(executablePath: string | undefined, managed: boolean): string {
  return managed && executablePath !== undefined ? `"${executablePath}" login` : KIRO_LOGIN_COMMAND;
}

/** 指定 `kiro-cli` 的路径（开发与测试用，优先于 `account.setPath`）。 */
export const KIRO_BIN_ENV = 'WEVIR_KIRO_BIN';

/** Kiro CLI 认的 API Key 环境变量（Pro 及以上的订阅可用）：没有浏览器登录时用它，设了就不能在 Wevir 里登出。 */
export const KIRO_API_KEY_ENV = 'KIRO_API_KEY';

export const KIRO_EXECUTABLE: ExternalExecutableSpec = Object.freeze({
  displayName: 'Kiro CLI',
  command: 'kiro-cli',
  envVar: KIRO_BIN_ENV,
  installHint: `用 \`${kiroInstallCommand()}\` 安装。`,
});

/**
 * PATH 之外也找的位置：官方脚本的 ~/.local/bin、`--global` 的 /usr/local/bin、macOS 的 DMG 装进 /Applications 的程序包
 * （清单的 `cliPath`）。Windows 的 MSI 装到哪里没有核对过，只找 PATH。
 */
export function commonKiroDirs(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') return [];
  return [
    path.posix.join(home, '.local', 'bin'),
    '/usr/local/bin',
    ...(platform === 'darwin' ? ['/Applications/Kiro CLI.app/Contents/MacOS'] : []),
  ];
}

export interface FindKiroOptions {
  /** `account.setPath` 指定的路径。 */
  customPath?: string | null;
  /** Wevir 自己装的 `kiro-cli`：用户的 PATH 与常见位置里都没有时才用，所以不会换掉用户自己装的。 */
  managedPath?: string | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * 找 `kiro-cli`：`WEVIR_KIRO_BIN` → 设置里填的路径（显式的必须有效，不换别处）→ PATH → 常见安装目录 → Wevir 自己装的。
 * 找不到时抛错（`resolveExternalExecutable` 的原文）。
 */
export function findKiro(options: FindKiroOptions = {}): ResolvedExecutable {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const optionsFor = {
    ...(options.customPath != null && { configuredPath: options.customPath }),
    env,
    platform,
    home,
  };
  if (env[KIRO_BIN_ENV]?.trim() || options.customPath?.trim()) {
    return resolveExternalExecutable(KIRO_EXECUTABLE, optionsFor);
  }
  let missing: unknown;
  for (const extraDirs of [[], commonKiroDirs(home, platform)]) {
    try {
      return resolveExternalExecutable(KIRO_EXECUTABLE, { ...optionsFor, extraDirs });
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
 * 交给 `kiro-cli` 的环境：照 T3 继承 Host 的环境（代理、`KIRO_API_KEY`、`KIRO_HOME` 等），PATH 前面加上 `kiro-cli` 所在的目录，
 * 后面补上存在而不在其中的常见目录（GUI 拉起的 Host 的 PATH 很短）。
 */
export function kiroEnv(
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
  for (const dir of commonKiroDirs(home, platform)) if (isDir(dir)) add(dir);
  const env: NodeJS.ProcessEnv = { ...parent, PATH: dirs.join(separator) };
  if (platform === 'win32') delete env.Path;
  return env;
}

/**
 * Wevir 装的那份的环境：`KIRO_NO_AUTO_UPDATE=1`（2.36.0 的程序里认的变量）让它不在启动时自更新，设置里显示的版本与登录用的
 * 程序才是 ACP 用的这一份；升级由 Wevir 重新下载。
 */
export function managedKiroEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, KIRO_NO_AUTO_UPDATE: '1' };
}

/** 首个账号的 API Key 环境变量有没有值（有就是用它登录，Wevir 不能登出）。 */
export function kiroApiKeyEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env[KIRO_API_KEY_ENV]?.trim());
}

/** Windows 上 `.cmd` 启动脚本不经 shell 起不了（Node 20.12 起 `spawn EINVAL`）；测试的假 CLI 是 `kiro-cli.cmd`。 */
export function needsShell(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
}

export type KiroCommandResult =
  | { ok: true; stdout: string; stderr: string; code: number }
  | { ok: false; reason: 'missing' | 'timeout' | 'failed'; message: string };

/** 跑一次 `kiro-cli <args>`（T3 的 `runGrokCliCommand`）：收集输出，非 0 退出也算跑完（`code`）。 */
export function runKiro(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<KiroCommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
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
          resolve({ ok: false, reason: 'missing', message: 'Kiro CLI executable was not found' });
        } else if ((error as { killed?: boolean }).killed === true) {
          resolve({
            ok: false,
            reason: 'timeout',
            message: `\`kiro-cli ${args.join(' ')}\` did not answer within ${timeoutMs} ms`,
          });
        } else if (typeof code === 'number') {
          resolve({ ok: true, stdout: out, stderr: err, code });
        } else {
          resolve({
            ok: false,
            reason: 'failed',
            message: `Kiro CLI command failed (${typeof code === 'string' ? code : 'unknown'})`,
          });
        }
      },
    );
    // 这些命令都不读输入；交互式的提示（如没登录时的选单）读到 EOF 就退出，不会等下去。
    child.stdin?.end();
  });
}

/** 从 `kiro-cli --version` 的输出（`kiro-cli 2.36.0`）里取版本号。 */
export function parseKiroVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output)?.[1];
}

/** 一次启动要用的 `kiro-cli` 与它的环境。 */
export interface KiroExecutable {
  path: string;
  env: NodeJS.ProcessEnv;
}

/**
 * `kiro-cli` 作 ACP 服务的参数：固定用 v2 引擎（`acp` 的默认；用户在设置里改成 v3 时它换成别的扩展与 `set_config_option`，
 * Wevir 的映射按 v2 写）。
 */
export const KIRO_ACP_ARGS: readonly string[] = ['acp', '--agent-engine', 'v2'];

/**
 * 官方的 `kiro-cli acp` 进程的启动器（`AcpLauncher`）：每次启动前重新取可执行文件（用户可能刚换了路径或装上 Kiro），工作
 * 目录是数据目录下的引擎目录（每个会话的 cwd 在 `session/new` 里给）。POSIX 上分离成自己的进程组，回收时连同它起的工具进程
 * 一起（T3 的 `ownDetachedProcessGroup`）。
 */
export class KiroLauncher implements AcpLauncher {
  readonly #workDir: string;
  readonly #resolve: () => Promise<KiroExecutable>;

  constructor(workDir: string, resolve: () => Promise<KiroExecutable>) {
    this.#workDir = workDir;
    this.#resolve = resolve;
  }

  async prepare(): Promise<AcpPreparedLaunch> {
    const executable = await this.#resolve();
    mkdirSync(this.#workDir, { recursive: true });
    return {
      spawnSpec: () => ({
        command: executable.path,
        args: [...KIRO_ACP_ARGS],
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
