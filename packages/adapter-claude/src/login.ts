// SPDX-License-Identifier: MIT
// 应用内登录（ADR-0005 补记 14 的补充）：Wevir 不碰令牌，登录仍由 `claude auth login` 自己完成，凭据照旧存在 claude 自己的
// 位置；Wevir 只替用户启动它、拿到要打开的登录地址、等它退出。
//
// `claude auth login` 打开浏览器用 `BROWSER` 环境变量（实测：它把带 `redirect_uri=http://localhost:<端口>/callback` 的授权地址
// 作为唯一的参数交给 `$BROWSER`，不加引号；标准输出里另印一个要手动粘贴代码的备用地址，那条走不通应用内的流程）。所以启动时
// 把 `BROWSER` 指向一个只会把地址写进文件的钩子：Wevir 从文件里读到地址，交给系统浏览器打开；用户在浏览器里同意后回调落在
// claude 临时监听的本机端口，claude 保存登录并退出，Wevir 再检测一次账号。
//
// 钩子按平台分两种：
// - macOS 与 Linux 是 POSIX shell 小脚本 `open-url.sh`。
// - Windows 是 `open-url.cmd`，它用 Host 自己的可执行文件以 Node 运行旁边的 `open-url.cjs`（`ELECTRON_RUN_AS_NODE=1`，同
//   Antigravity 的钩子）。实测 claude.exe 2.1.310 / 2.1.312（GitHub Actions 的 windows-latest）：它能直接启动 `.cmd`，地址原样
//   成为一个参数（`&` 不被 cmd 拆开，目录带空格或中文也一样）；`node -e "<源码>"` 写进 `.cmd` 或写成 `BROWSER` 的命令行都收
//   不到地址，所以脚本单独成文件。Node 的路径经环境变量 `WEVIR_LOGIN_NODE` 交给 `.cmd`，不写进文件（cmd 按 OEM 代码页读批处
//   理文件，用户名里有中文时路径会读坏）。脚本去掉参数两头的引号、取第一个 http(s) 参数，什么都不打开。启动前先用同一个
//   Node 跑一次脚本，核对它只把地址写进文件（每个可执行文件验一次）。
//
// Windows 上钩子用不了（核对失败，或 claude 在时限内没把地址交给钩子）时退回：不设 `BROWSER` 重新启动 `claude auth login`，
// 让 claude 自己打开默认浏览器（实测它会打开）。这时没有授权地址，Wevir 报 `signing_in` 不带 `authUrl`，等它退出 0 再检测。

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 钩子把地址写到这个环境变量指的文件里。 */
export const LOGIN_URL_ENV = 'WEVIR_LOGIN_URL_FILE';
/** Windows 的钩子用的 Node（Host 自己的可执行文件）。 */
export const LOGIN_NODE_ENV = 'WEVIR_LOGIN_NODE';
/** 等 claude 报出登录地址的时限。 */
export const LOGIN_URL_WAIT_MS = 15_000;
/** Windows 上等钩子收到地址的时限，过了就退回让 claude 自己开浏览器。 */
export const WINDOWS_HOOK_WAIT_MS = 10_000;
/** 一次登录最长等多久（用户在浏览器里同意前）。 */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

const SHIM_NAME = 'open-url.sh';
const SHIM = `#!/bin/sh\nprintf '%s\\n' "$1" > "$${LOGIN_URL_ENV}"\n`;

const WINDOWS_HOOK_NAME = 'open-url.cmd';
const WINDOWS_HOOK_SCRIPT_NAME = 'open-url.cjs';
const WINDOWS_HOOK = `@set "ELECTRON_RUN_AS_NODE=1"\r\n@"%${LOGIN_NODE_ENV}%" "%~dp0${WINDOWS_HOOK_SCRIPT_NAME}" %*\r\n`;
const WINDOWS_HOOK_SCRIPT = `// Wevir: records the sign-in address claude hands to BROWSER; opens nothing.
const url = process.argv
  .slice(2)
  .map((arg) => arg.replace(/^"+|"+$/g, ''))
  .find((arg) => /^https?:\\/\\//.test(arg));
const file = process.env.${LOGIN_URL_ENV};
if (url !== undefined && file) require('node:fs').writeFileSync(file, url + '\\n');
`;
const HOOK_PREFLIGHT_URL = 'https://example.invalid/wevir-claude-login-preflight?a=1&b=2';
const HOOK_PREFLIGHT_TIMEOUT_MS = 10_000;

/** 能不能在应用内登录：macOS 与 Linux 用 shell 小脚本，Windows 用 `.cmd` 钩子（用不了时让 claude 自己开浏览器）。 */
export function inAppLoginSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}

export type ClaudeLoginResult = { ok: true } | { ok: false; cancelled: boolean; message: string };

/** 进行中的一次 `claude auth login`。 */
export interface ClaudeLoginFlow {
  /** 要在浏览器里打开的授权地址；Windows 退回让 claude 自己开浏览器时没有。 */
  authUrl?: string;
  /** claude 退出时兑现：0 退出是登录完成；被 `cancel` 停掉的 `cancelled`；其余带 claude 的最后几行输出。 */
  done: Promise<ClaudeLoginResult>;
  cancel(): void;
}

export interface StartClaudeLoginInput {
  executablePath: string;
  env: Record<string, string | undefined>;
  /** 放钩子与地址文件的目录（建在数据目录的引擎目录下）。 */
  directory: string;
  urlWaitMs?: number;
  /** Windows 上等钩子收到地址的时限（默认 `WINDOWS_HOOK_WAIT_MS`）。 */
  hookWaitMs?: number;
  timeoutMs?: number;
  /** 默认 `process.platform`；测试用。 */
  platform?: NodeJS.Platform;
  /** Windows 钩子用的 Node；默认 Host 自己（`process.execPath`，Electron 里靠 `ELECTRON_RUN_AS_NODE=1`）。 */
  nodeExecutable?: string;
}

function tail(output: string): string {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.slice(-3).join(' ');
}

function writeIfChanged(file: string, content: string, mode?: number): void {
  let current: string | undefined;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== content) writeFileSync(file, content, mode === undefined ? undefined : { mode });
}

function writeShim(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, SHIM_NAME);
  writeIfChanged(file, SHIM, 0o755);
  chmodSync(file, 0o755);
  return file;
}

/** 写 Windows 的钩子（`.cmd` 与它运行的脚本），返回 `.cmd` 的路径。 */
export function writeWindowsLoginHook(directory: string): { hook: string; script: string } {
  mkdirSync(directory, { recursive: true });
  const hook = path.join(directory, WINDOWS_HOOK_NAME);
  const script = path.join(directory, WINDOWS_HOOK_SCRIPT_NAME);
  writeIfChanged(script, WINDOWS_HOOK_SCRIPT);
  writeIfChanged(hook, WINDOWS_HOOK);
  return { hook, script };
}

/** 验过的钩子 Node（可执行文件路径），整个 Host 进程内有效。 */
const verifiedHookNodes = new Set<string>();

/**
 * 钩子脚本必须只把地址写进文件并以 0 退出，标准输出什么都没有：否则它可能是别的程序（Host 的可执行文件没有以 Node 运行），
 * 会去开窗口或浏览器。核对失败抛错。
 */
async function verifyWindowsHook(
  node: string,
  script: string,
  directory: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  if (verifiedHookNodes.has(node)) return;
  const urlFile = path.join(directory, `${randomUUID()}.preflight`);
  try {
    const child = spawn(node, [script, HOOK_PREFLIGHT_URL], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1', [LOGIN_URL_ENV]: urlFile },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let stdout = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.byteLength;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('the sign-in hook did not finish'));
      }, HOOK_PREFLIGHT_TIMEOUT_MS);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    let written: string | undefined;
    try {
      written = readFileSync(urlFile, 'utf8');
    } catch {
      written = undefined;
    }
    if (code !== 0 || stdout !== 0 || written !== `${HOOK_PREFLIGHT_URL}\n`) {
      throw new Error('the sign-in hook could not be verified');
    }
    verifiedHookNodes.add(node);
  } finally {
    rmSync(urlFile, { force: true });
  }
}

/** 去掉环境里的 `BROWSER`（Windows 的变量名不分大小写，别名一起去掉）。 */
function withoutBrowser(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() !== 'BROWSER') next[key] = value;
  }
  return next;
}

interface LoginProcess {
  done: Promise<ClaudeLoginResult>;
  /** claude 已经退出（`done` 兑现了）。 */
  finished(): boolean;
  output(): string;
  spawnFailed(): boolean;
  cancel(): void;
}

/** 启动一次 `claude auth login --claudeai`，收集输出；`done` 在它退出时兑现，也负责超时。 */
function launch(
  executablePath: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
  onExit: () => void,
): LoginProcess {
  const child: ChildProcess = spawn(executablePath, ['auth', 'login', '--claudeai'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  const collect = (data: Buffer) => {
    output = (output + data.toString('utf8')).slice(-4096);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let cancelled = false;
  let timedOut = false;
  let finished = false;
  let spawnError: Error | undefined;
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      resolve(null);
    });
    child.once('exit', (code) => resolve(code));
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeoutMs);
  const done: Promise<ClaudeLoginResult> = exited.then((code) => {
    finished = true;
    clearTimeout(timeout);
    onExit();
    if (cancelled) return { ok: false, cancelled: true, message: 'Sign-in was cancelled.' };
    if (code === 0) return { ok: true };
    if (timedOut) return { ok: false, cancelled: false, message: 'Sign-in timed out.' };
    if (spawnError !== undefined) {
      return {
        ok: false,
        cancelled: false,
        message: `Could not start claude: ${spawnError.message}`,
      };
    }
    return {
      ok: false,
      cancelled: false,
      message: tail(output) || `\`claude auth login\` exited with code ${code ?? 'unknown'}`,
    };
  });
  done.catch(() => {});
  return {
    done,
    finished: () => finished,
    output: () => output,
    spawnFailed: () => spawnError !== undefined,
    cancel: () => {
      cancelled = true;
      child.kill('SIGTERM');
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readUrl(urlFile: string): string | undefined {
  try {
    const line = readFileSync(urlFile, 'utf8').split(/\r?\n/u)[0]?.trim();
    return line !== undefined && /^https?:\/\//u.test(line) ? line : undefined;
  } catch {
    return undefined;
  }
}

/** 等到 `ready` 有结果、claude 退出或超时；返回 `ready` 的结果，没有就 undefined。 */
async function waitFor<T>(
  run: LoginProcess,
  waitMs: number,
  ready: () => T | undefined,
): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  while (!run.finished() && Date.now() < deadline) {
    const value = ready();
    if (value !== undefined) return value;
    await sleep(50);
  }
  return run.finished() ? undefined : ready();
}

/** claude 没报地址就结束了（或等不到）：停掉它，抛出带它最后几行输出的错误。 */
async function fail(run: LoginProcess, waitMs: number, what: string): Promise<never> {
  const finished = run.finished();
  run.cancel();
  const result = await run.done;
  const detail = tail(run.output());
  throw new Error(
    !result.ok && !result.cancelled && finished && !run.spawnFailed() && detail !== ''
      ? result.message
      : `claude did not ${what} within ${waitMs / 1000} s${detail === '' ? '' : `: ${detail}`}`,
  );
}

const flowOf = (run: LoginProcess, authUrl?: string): ClaudeLoginFlow => ({
  ...(authUrl !== undefined && { authUrl }),
  done: run.done,
  cancel: run.cancel,
});

/**
 * 启动 `claude auth login`，等它把授权地址交给 `BROWSER`。拿到地址就返回（登录还没完成，`done` 之后才兑现）；claude 在报出
 * 地址前就退出或超时，抛错，错误信息是它的最后几行输出。Windows 上钩子用不了时退回让 claude 自己开浏览器，返回的流程没有
 * `authUrl`。
 */
export async function startClaudeLogin(input: StartClaudeLoginInput): Promise<ClaudeLoginFlow> {
  const platform = input.platform ?? process.platform;
  const timeoutMs = input.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const urlWaitMs = input.urlWaitMs ?? LOGIN_URL_WAIT_MS;
  const urlFile = path.join(input.directory, `${randomUUID()}.url`);
  const removeUrlFile = () => rmSync(urlFile, { force: true });

  if (platform !== 'win32') {
    const shim = writeShim(input.directory);
    const run = launch(
      input.executablePath,
      { ...input.env, BROWSER: shim, [LOGIN_URL_ENV]: urlFile },
      timeoutMs,
      removeUrlFile,
    );
    const authUrl = await waitFor(run, urlWaitMs, () => readUrl(urlFile));
    if (authUrl !== undefined) return flowOf(run, authUrl);
    return fail(run, urlWaitMs, 'report a sign-in address');
  }

  const node = input.nodeExecutable ?? process.execPath;
  let hook: string | undefined;
  try {
    const written = writeWindowsLoginHook(input.directory);
    await verifyWindowsHook(node, written.script, input.directory, input.env);
    hook = written.hook;
  } catch {
    hook = undefined;
  }
  if (hook !== undefined) {
    const hookWaitMs = input.hookWaitMs ?? WINDOWS_HOOK_WAIT_MS;
    const run = launch(
      input.executablePath,
      {
        ...withoutBrowser(input.env),
        BROWSER: hook,
        [LOGIN_NODE_ENV]: node,
        [LOGIN_URL_ENV]: urlFile,
      },
      timeoutMs,
      removeUrlFile,
    );
    const authUrl = await waitFor(run, hookWaitMs, () => readUrl(urlFile));
    if (authUrl !== undefined) return flowOf(run, authUrl);
    // claude 自己出错退出了（或起不来）：退回也一样会失败，直接报它的输出。
    if (run.finished()) return fail(run, hookWaitMs, 'report a sign-in address');
    run.cancel();
    await run.done;
  }

  // 退回：claude 自己开浏览器。等它印出备用地址（说明已经走到开浏览器那一步）或时限到；在那之前退出就是出错了。
  const run = launch(input.executablePath, withoutBrowser(input.env), timeoutMs, () => {});
  const opened = await waitFor(run, urlWaitMs, () =>
    /https?:\/\//u.test(run.output()) ? true : undefined,
  );
  if (opened === undefined && run.finished()) return fail(run, urlWaitMs, 'open the browser');
  return flowOf(run);
}

export type ClaudeCommandResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; message: string };

/** 跑一次 claude 的子命令（如 `auth logout`）等它退出；不经 shell。 */
export function runClaudeCommand(
  executablePath: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ClaudeCommandResult> {
  return new Promise((resolve) => {
    execFile(
      executablePath,
      [...args],
      {
        env,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        ...(signal !== undefined && { signal }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        resolve({
          ok: false,
          message:
            tail(`${String(stderr)}\n${String(stdout)}`) ||
            `\`claude ${args.join(' ')}\` failed: ${error.message}`,
        });
      },
    );
  });
}
