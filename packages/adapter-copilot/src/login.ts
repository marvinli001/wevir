// SPDX-License-Identifier: MIT
// 应用内登录：Wevir 不碰令牌，登录由 Copilot CLI 自己完成（它的 GitHub OAuth 应用，令牌存进系统钥匙串，没有钥匙串时它不写明文、
// 登录算失败）。1.0.103 的 ACP 只给终端登录（`authMethods` 里的 `copilot-login` 是 `terminal-auth`），所以这里起一次
// `copilot login --device-code`：它打印 “To authenticate, visit <网址> and enter code <码>”，自己把码复制进剪贴板并打开浏览器，
// 然后等用户授权；成功时打印 “Signed in successfully as …” 并以 0 退出，失败打印 “Login failed: …” 以 1 退出。

import { type ChildProcess, spawn } from 'node:child_process';
import { type CopilotExecutable, needsShell } from './launch.js';

/** 一次登录最长等多久（GitHub 的设备码 15 分钟过期）。 */
export const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** 等它打印出设备码的时限（要先联网向 GitHub 要码）。 */
export const DEVICE_CODE_TIMEOUT_MS = 30_000;

export type CopilotLoginResult = { ok: true } | { ok: false; cancelled: boolean; message: string };

/** 进行中的一次登录。 */
export interface CopilotLoginFlow {
  verificationUrl: string;
  userCode: string;
  /** 进程退出时兑现：成功是登录完成；被 `cancel` 停掉的 `cancelled`；其余带 CLI 的说明。 */
  done: Promise<CopilotLoginResult>;
  cancel(): void;
}

export interface StartCopilotLoginInput {
  executable: CopilotExecutable;
  /** 这个一次性进程的工作目录。 */
  directory: string;
  timeoutMs?: number;
  codeTimeoutMs?: number;
}

/** 从 `copilot login --device-code` 的输出里取网址与设备码。 */
export function parseDeviceCode(output: string): { url: string; code: string } | undefined {
  const match =
    /visit\s+(https?:\/\/\S+?)\s+and\s+enter\s+(?:the\s+)?code\s+([A-Z0-9]{4,}-[A-Z0-9]{4,})/i.exec(
      output,
    );
  if (match === null) return undefined;
  return { url: match[1] as string, code: match[2] as string };
}

/** 输出里最后一行有内容的（失败原因）。 */
function lastLine(output: string): string | undefined {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^waiting for authorization/i.test(line))
    .at(-1)
    ?.slice(0, 300);
}

function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      // 进程组没了就只杀它自己。
    }
  }
  child.kill('SIGTERM');
}

/**
 * 启动登录：等 CLI 打印出设备码就返回（登录还没完成，`done` 之后才兑现）。它起不来、先退出或时限内没给出码时抛错。
 */
export async function startCopilotLogin(input: StartCopilotLoginInput): Promise<CopilotLoginFlow> {
  const child = spawn(input.executable.path, ['login', '--device-code'], {
    cwd: input.directory,
    env: input.executable.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    shell: needsShell(input.executable.path),
  });
  let output = '';
  let cancelled = false;
  let timedOut = false;
  const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code }));
  });
  const code = await new Promise<{ url: string; code: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop(child);
      reject(new Error('GitHub Copilot CLI did not show a device code in time'));
    }, input.codeTimeoutMs ?? DEVICE_CODE_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const found = parseDeviceCode(output);
      if (found !== undefined) {
        clearTimeout(timer);
        resolve(found);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    void exited.then(({ code, error }) => {
      clearTimeout(timer);
      reject(
        error ??
          new Error(lastLine(output) ?? `\`copilot login\` exited with code ${String(code)}`),
      );
    });
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    stop(child);
  }, input.timeoutMs ?? LOGIN_TIMEOUT_MS);
  timeout.unref?.();
  const done = exited.then(({ code: exitCode, error }): CopilotLoginResult => {
    clearTimeout(timeout);
    if (cancelled) return { ok: false, cancelled: true, message: 'Sign-in was cancelled.' };
    if (timedOut) return { ok: false, cancelled: false, message: 'Sign-in timed out.' };
    if (error === undefined && exitCode === 0) return { ok: true };
    return {
      ok: false,
      cancelled: false,
      message: error?.message ?? lastLine(output) ?? `Sign-in failed (exit code ${exitCode})`,
    };
  });
  return {
    verificationUrl: code.url,
    userCode: code.code,
    done,
    cancel: () => {
      cancelled = true;
      stop(child);
    },
  };
}
