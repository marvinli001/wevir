// SPDX-License-Identifier: MIT
// 应用内登录：Wevir 不碰令牌，登录由 Kiro CLI 自己完成（AWS 的 OIDC 设备码，令牌存进它自己的 data.sqlite3）。ACP 没有登录方法
// （没登录时 `kiro-cli acp` 直接退出），所以这里起一次 `kiro-cli login --use-device-flow`。2.36.0 不论 Builder ID、Google 还是
// GitHub 都打印 “Confirm the following code in the browser” / “Code: XXXX-XXXX” / “Open this URL: https://view.awsapps.com/start/
// #/device?user_code=XXXX-XXXX”，然后等用户授权。成功时的输出与退出码没有账号核对过，按 0 退出算成功。

import { type ChildProcess, spawn } from 'node:child_process';
import { type KiroExecutable, needsShell } from './launch.js';

/** 一次登录最长等多久（AWS 的设备码 10 分钟左右过期，留点余量）。 */
export const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** 等它打印出设备码的时限（要先联网向 AWS 要码）。 */
export const DEVICE_CODE_TIMEOUT_MS = 30_000;

/**
 * 应用内登录的方式（`AccountState.loginOptions`，`account.login` 的 `option`）与对应的 `kiro-cli login` 参数。IAM Identity
 * Center 要填起始网址与区域，只给终端命令。
 */
export const KIRO_LOGIN_OPTIONS = [
  { id: 'builder-id', label: 'AWS Builder ID', args: ['--license', 'free'] },
  { id: 'google', label: 'Google', args: ['--social', 'google'] },
  { id: 'github', label: 'GitHub', args: ['--social', 'github'] },
] as const;
export type KiroLoginOption = (typeof KIRO_LOGIN_OPTIONS)[number]['id'];

export function isKiroLoginOption(value: string): value is KiroLoginOption {
  return KIRO_LOGIN_OPTIONS.some((option) => option.id === value);
}

export type KiroLoginResult = { ok: true } | { ok: false; cancelled: boolean; message: string };

/** 进行中的一次登录。 */
export interface KiroLoginFlow {
  verificationUrl: string;
  userCode: string;
  /** 进程退出时兑现：成功是登录完成；被 `cancel` 停掉的 `cancelled`；其余带 CLI 的说明。 */
  done: Promise<KiroLoginResult>;
  cancel(): void;
}

export interface StartKiroLoginInput {
  executable: KiroExecutable;
  /** 这个一次性进程的工作目录。 */
  directory: string;
  option?: KiroLoginOption;
  timeoutMs?: number;
  codeTimeoutMs?: number;
}

/** 去掉终端的控制序列（它边等边画进度条）。 */
function plain(output: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 要去掉的正是 ESC 开头的控制序列。
  return output.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '').replace(/\r/gu, '\n');
}

/** 从 `kiro-cli login --use-device-flow` 的输出里取网址与设备码。 */
export function parseDeviceCode(output: string): { url: string; code: string } | undefined {
  const text = plain(output);
  const url = /open this url:?\s+(https?:\/\/\S+)/i.exec(text)?.[1];
  const code =
    /\bcode:\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/i.exec(text)?.[1] ??
    (url === undefined ? undefined : /[?&]user_code=([A-Z0-9-]+)/i.exec(url)?.[1]);
  if (url === undefined || code === undefined) return undefined;
  return { url, code };
}

/** 输出里最后一行有内容的（失败原因），去掉进度条那几行。 */
function lastLine(output: string): string | undefined {
  return plain(output)
    .split('\n')
    .map((line) => line.replace(/^[▀-▟\s]+/u, '').trim())
    .filter((line) => line !== '' && !/^logging in\.*$/i.test(line))
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
export async function startKiroLogin(input: StartKiroLoginInput): Promise<KiroLoginFlow> {
  const option =
    KIRO_LOGIN_OPTIONS.find((entry) => entry.id === input.option) ?? KIRO_LOGIN_OPTIONS[0];
  const child = spawn(input.executable.path, ['login', ...option.args, '--use-device-flow'], {
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
      reject(new Error('Kiro CLI did not show a device code in time'));
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
          new Error(lastLine(output) ?? `\`kiro-cli login\` exited with code ${String(code)}`),
      );
    });
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    stop(child);
  }, input.timeoutMs ?? LOGIN_TIMEOUT_MS);
  timeout.unref?.();
  const done = exited.then(({ code: exitCode, error }): KiroLoginResult => {
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
