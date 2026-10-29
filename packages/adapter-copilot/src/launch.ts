// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-grok/src/server/acpSupport.ts（`buildGrokAcpSpawnInput`、`grokAcpRuntimeProcessOwnership`）、packages/provider-grok/src/server/status.ts（`runGrokCliCommand`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：经 Wevir 的 Devin 启动器改写；参数改为 copilot --acp --stdio，可执行文件、常见目录与账号隔离按 GitHub Copilot CLI。

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

/** 用户自己装官方 CLI 的命令（GitHub 文档）；设置里的“下载”（install.ts）取同一份 GitHub Release，不随应用分发。 */
export function copilotInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'winget install GitHub.Copilot'
    : 'curl -fsSL https://gh.io/copilot-install | bash';
}

/** 终端里登录；设置里的“登录”（login.ts）替用户跑设备码登录。 */
export const COPILOT_LOGIN_COMMAND = 'copilot login';

/** 登录命令：Wevir 替用户装的 `copilot` 不在 PATH 里要写全路径；添加的账号还要带上它自己的 `COPILOT_HOME`。 */
export function copilotLoginCommand(
  executablePath: string | undefined,
  managed: boolean,
  copilotHome?: string,
): string {
  const command =
    managed && executablePath !== undefined ? `"${executablePath}" login` : COPILOT_LOGIN_COMMAND;
  return copilotHome === undefined ? command : `COPILOT_HOME="${copilotHome}" ${command}`;
}

/** 指定 `copilot` 的路径（开发与测试用，优先于 `account.setPath`）。 */
export const COPILOT_BIN_ENV = 'WEVIR_COPILOT_BIN';

/** Copilot CLI 依次认的令牌环境变量（`copilot help environment`），设了就不看存下的登录。 */
export const COPILOT_TOKEN_ENVS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

export const COPILOT_EXECUTABLE: ExternalExecutableSpec = Object.freeze({
  displayName: 'GitHub Copilot CLI',
  command: 'copilot',
  envVar: COPILOT_BIN_ENV,
  installHint: `用 \`${copilotInstallCommand()}\` 安装。`,
});

/** PATH 之外也找的位置：官方脚本的 ~/.local/bin、Homebrew、npm 全局目录（Windows 是 WinGet 的链接目录与 npm）。 */
export function commonCopilotDirs(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    return [
      ...(env.LOCALAPPDATA
        ? [path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')]
        : []),
      ...(env.APPDATA ? [path.win32.join(env.APPDATA, 'npm')] : []),
      path.win32.join(home, 'scoop', 'shims'),
    ];
  }
  return [
    path.posix.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.posix.join(home, '.npm-global', 'bin'),
  ];
}

export interface FindCopilotOptions {
  /** `account.setPath` 指定的路径。 */
  customPath?: string | null;
  /** Wevir 自己装的 `copilot`：用户的 PATH 与常见位置里都没有时才用，所以不会换掉用户自己装的。 */
  managedPath?: string | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * 找 `copilot`：`WEVIR_COPILOT_BIN` → 设置里填的路径（显式的必须有效，不换别处）→ PATH → 常见安装目录 → Wevir 自己装的。
 * 找不到时抛错（`resolveExternalExecutable` 的原文）。
 */
export function findCopilot(options: FindCopilotOptions = {}): ResolvedExecutable {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const optionsFor = {
    ...(options.customPath != null && { configuredPath: options.customPath }),
    env,
    platform,
    home,
  };
  if (env[COPILOT_BIN_ENV]?.trim() || options.customPath?.trim()) {
    return resolveExternalExecutable(COPILOT_EXECUTABLE, optionsFor);
  }
  let missing: unknown;
  for (const extraDirs of [[], commonCopilotDirs(home, platform, env)]) {
    try {
      return resolveExternalExecutable(COPILOT_EXECUTABLE, { ...optionsFor, extraDirs });
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
 * 添加的账号（0.63.0）的隔离：`copilotHome` 是它自己的 `COPILOT_HOME`（Copilot 在里面记登录过哪个账号、上次用的是哪个，令牌在
 * 系统钥匙串里按主机与账号名存）；`ghConfigDir` 是一个空的 GitHub CLI 配置目录，挡住 Copilot 没有登录时退回 `gh auth token`
 * 用上首个账号的 GitHub 登录。
 */
export interface CopilotAccountDirs {
  copilotHome: string;
  ghConfigDir: string;
}

/**
 * 交给 `copilot` 的环境：照 T3 继承 Host 的环境（代理、`COPILOT_GH_HOST` 等），PATH 前面加上 `copilot` 所在的目录，后面补上存在
 * 而不在其中的常见目录（GUI 拉起的 Host 的 PATH 很短）。添加的账号换掉 `COPILOT_HOME` 与 `GH_CONFIG_DIR`，并去掉令牌环境变量
 * （那是首个账号的事）。
 */
export function copilotEnv(
  parent: NodeJS.ProcessEnv,
  executable: string,
  account?: CopilotAccountDirs,
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
  for (const dir of commonCopilotDirs(home, platform, parent)) if (isDir(dir)) add(dir);
  const env: NodeJS.ProcessEnv = { ...parent, PATH: dirs.join(separator) };
  if (platform === 'win32') delete env.Path;
  if (account !== undefined) {
    for (const key of COPILOT_TOKEN_ENVS) delete env[key];
    env.COPILOT_HOME = account.copilotHome;
    env.GH_CONFIG_DIR = account.ghConfigDir;
  }
  return env;
}

/** 首个账号的令牌环境变量里有没有值（有就是用它登录，Wevir 不能登出）。 */
export function copilotTokenEnv(env: NodeJS.ProcessEnv): string | undefined {
  return COPILOT_TOKEN_ENVS.find((key) => env[key]?.trim());
}

/** Windows 上 `.cmd` 启动脚本不经 shell 起不了（Node 20.12 起 `spawn EINVAL`）；npm 装的是 `copilot.cmd`，测试的假 CLI 也是。 */
export function needsShell(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
}

export type CopilotCommandResult =
  | { ok: true; stdout: string; stderr: string; code: number }
  | { ok: false; reason: 'missing' | 'timeout' | 'failed'; message: string };

/** 跑一次 `copilot <args>`（T3 的 `runGrokCliCommand`）：收集输出，非 0 退出也算跑完（`code`）。 */
export function runCopilot(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CopilotCommandResult> {
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
          resolve({
            ok: false,
            reason: 'missing',
            message: 'GitHub Copilot CLI executable was not found',
          });
        } else if ((error as { killed?: boolean }).killed === true) {
          resolve({
            ok: false,
            reason: 'timeout',
            message: `\`copilot ${args.join(' ')}\` did not answer within ${timeoutMs} ms`,
          });
        } else if (typeof code === 'number') {
          resolve({ ok: true, stdout: out, stderr: err, code });
        } else {
          resolve({
            ok: false,
            reason: 'failed',
            message: `GitHub Copilot CLI command failed (${typeof code === 'string' ? code : 'unknown'})`,
          });
        }
      },
    );
  });
}

/** 从 `copilot --version` 的输出（`GitHub Copilot CLI 1.0.103.`）里取版本号。 */
export function parseCopilotVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output)?.[1];
}

/** 一次启动要用的 `copilot` 与它的环境。 */
export interface CopilotExecutable {
  path: string;
  env: NodeJS.ProcessEnv;
  /** `--acp` 进程的参数（`copilotAcpArgs`）；省略时按用户自己装的。 */
  args?: readonly string[];
}

/** `copilot` 作 ACP 服务的参数：stdio；Wevir 管下载与升级，不让它在后台自更新（自己装的照用户的设置）。 */
export function copilotAcpArgs(managed: boolean): string[] {
  return ['--acp', '--stdio', ...(managed ? ['--no-auto-update'] : [])];
}

/**
 * Wevir 装的那份的环境：`COPILOT_AUTO_UPDATE=false`（`copilot help environment`）让 `--version`、`login` 也不自更新、不改跑
 * 缓存里更新的版本，设置里显示的版本与登录用的程序才是 ACP 用的这一份。`--no-auto-update` 只能放在子命令前，环境变量都管。
 */
export function managedCopilotEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, COPILOT_AUTO_UPDATE: 'false' };
}

/**
 * 官方的 `copilot --acp` 进程的启动器（`AcpLauncher`）：每次启动前重新取可执行文件（用户可能刚换了路径或装上 Copilot），工作
 * 目录是数据目录下的引擎目录（每个会话的 cwd 在 `session/new` 里给）。POSIX 上分离成自己的进程组，回收时连同它起的工具进程
 * 一起（T3 的 `ownDetachedProcessGroup`）。
 */
export class CopilotLauncher implements AcpLauncher {
  readonly #workDir: string;
  readonly #resolve: () => Promise<CopilotExecutable>;

  constructor(workDir: string, resolve: () => Promise<CopilotExecutable>) {
    this.#workDir = workDir;
    this.#resolve = resolve;
  }

  async prepare(): Promise<AcpPreparedLaunch> {
    const executable = await this.#resolve();
    mkdirSync(this.#workDir, { recursive: true });
    return {
      spawnSpec: () => ({
        command: executable.path,
        args: [...(executable.args ?? copilotAcpArgs(false))],
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
