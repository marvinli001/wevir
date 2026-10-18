// SPDX-License-Identifier: MIT
// 应用内登录（ADR-0005 补记 14 的补充）：Wevir 不碰令牌，登录仍由 `claude auth login` 自己完成，凭据照旧存在 claude 自己的
// 位置；Wevir 只替用户启动它、拿到要打开的登录地址、等它退出。
//
// `claude auth login` 打开浏览器用 `BROWSER` 环境变量（实测：它把带 `redirect_uri=http://localhost:<端口>/callback` 的授权地址
// 作为第一个参数交给 `$BROWSER`；标准输出里另印一个要手动粘贴代码的备用地址，那条走不通应用内的流程）。所以启动时把 `BROWSER`
// 指向一个只会把地址写进文件的小脚本：Wevir 从文件里读到地址，交给系统浏览器打开；用户在浏览器里同意后回调落在 claude 临时
// 监听的本机端口，claude 保存登录并退出，Wevir 再检测一次账号。脚本是 POSIX shell，所以只在 macOS 与 Linux 上用；Windows 仍然
// 给命令，等在 Windows 上核对过 `BROWSER` 的行为再开。

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 小脚本把地址写到这个环境变量指的文件里。 */
export const LOGIN_URL_ENV = 'WEVIR_LOGIN_URL_FILE';
/** 等 claude 报出登录地址的时限。 */
export const LOGIN_URL_WAIT_MS = 15_000;
/** 一次登录最长等多久（用户在浏览器里同意前）。 */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

const SHIM_NAME = 'open-url.sh';
const SHIM = `#!/bin/sh\nprintf '%s\\n' "$1" > "$${LOGIN_URL_ENV}"\n`;

/** 能不能在应用内登录：小脚本是 shell 脚本，只有 macOS 与 Linux。 */
export function inAppLoginSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux';
}

export type ClaudeLoginResult = { ok: true } | { ok: false; cancelled: boolean; message: string };

/** 进行中的一次 `claude auth login`。 */
export interface ClaudeLoginFlow {
  /** 要在浏览器里打开的授权地址。 */
  authUrl: string;
  /** claude 退出时兑现：0 退出是登录完成；被 `cancel` 停掉的 `cancelled`；其余带 claude 的最后几行输出。 */
  done: Promise<ClaudeLoginResult>;
  cancel(): void;
}

export interface StartClaudeLoginInput {
  executablePath: string;
  env: Record<string, string | undefined>;
  /** 放小脚本与地址文件的目录（建在数据目录的引擎目录下）。 */
  directory: string;
  urlWaitMs?: number;
  timeoutMs?: number;
}

function tail(output: string): string {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.slice(-3).join(' ');
}

function writeShim(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, SHIM_NAME);
  let current: string | undefined;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== SHIM) writeFileSync(file, SHIM, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

/**
 * 启动 `claude auth login`，等它把授权地址交给 `BROWSER`。拿到地址就返回（登录还没完成，`done` 之后才兑现）；claude 在报出
 * 地址前就退出或超时，抛错，错误信息是它的最后几行输出。
 */
export async function startClaudeLogin(input: StartClaudeLoginInput): Promise<ClaudeLoginFlow> {
  const shim = writeShim(input.directory);
  const urlFile = path.join(input.directory, `${randomUUID()}.url`);
  const child: ChildProcess = spawn(input.executablePath, ['auth', 'login', '--claudeai'], {
    env: { ...input.env, BROWSER: shim, [LOGIN_URL_ENV]: urlFile },
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
  }, input.timeoutMs ?? LOGIN_TIMEOUT_MS);
  const cleanup = () => {
    clearTimeout(timeout);
    rmSync(urlFile, { force: true });
  };
  const done: Promise<ClaudeLoginResult> = exited.then((code) => {
    cleanup();
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

  const readUrl = (): string | undefined => {
    try {
      const line = readFileSync(urlFile, 'utf8').split(/\r?\n/u)[0]?.trim();
      return line !== undefined && /^https?:\/\//u.test(line) ? line : undefined;
    } catch {
      return undefined;
    }
  };
  const waitMs = input.urlWaitMs ?? LOGIN_URL_WAIT_MS;
  const deadline = Date.now() + waitMs;
  let finished = false;
  void done.then(() => {
    finished = true;
  });
  const flow = (authUrl: string): ClaudeLoginFlow => ({
    authUrl,
    done,
    cancel: () => {
      cancelled = true;
      child.kill('SIGTERM');
    },
  });
  while (!finished && Date.now() < deadline) {
    const authUrl = readUrl();
    if (authUrl !== undefined) return flow(authUrl);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  cancelled = true;
  child.kill('SIGTERM');
  const result = await done;
  const detail = tail(output);
  throw new Error(
    !result.ok && !result.cancelled && finished && !spawnError && detail !== ''
      ? result.message
      : `claude did not report a sign-in address within ${waitMs / 1000} s${detail === '' ? '' : `: ${detail}`}`,
  );
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
