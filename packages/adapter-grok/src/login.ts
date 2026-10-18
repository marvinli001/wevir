// SPDX-License-Identifier: MIT
// 应用内登录（grok-event-mapping.md §2.5，ADR-0005 补记 14 的补充）：Wevir 不碰令牌，登录仍由 `grok login` 自己完成，凭据照旧
// 存在 `$GROK_HOME/auth.json`；Wevir 只替用户启动它、等它退出、读出它印的登录地址与码。
//
// 用设备码流程（`grok login --device-auth`，官方文档里给无头与远程环境的）而不是默认的浏览器回调（`--oauth`）：实测（grok
// 1.0.62，隔离的 `GROK_HOME`）`grok login` 自己打开浏览器——macOS 上直接调 NSWorkspace，不认 `BROWSER` 环境变量、不经 PATH
// 里的 `open`，也没有关掉它的开关（`SSH_CONNECTION` 等也不行），所以 claude 那种“把 `BROWSER` 指向小脚本拿地址”的办法走不通，
// 而回调流程（`--oauth`）印出的授权地址随后由桌面端再开一次，会同时开两个标签。设备码流程在标准输出里印
//
//   To sign in, open this URL in your browser:      ← 带 user_code 的地址，grok 自己开浏览器去它
//     https://accounts.x.ai/oauth2/device?user_code=XXXX-XXXX
//   (Could not open browser automatically — …)      ← 只在它打不开浏览器时才有（无桌面的 Linux、Launch Services 不可用）
//   Confirm this code in your browser:
//     XXXX-XXXX
//   Waiting for authorization...
//
// 用户在浏览器里确认后 grok 保存登录并退出 0。所以：Wevir 只在 grok 报“打不开浏览器”时才把地址放进 `login.authUrl`（桌面端
// 据此替它打开）；平常 grok 已经开了，`login` 里只带 `verificationUrl` 与 `userCode`。设备码流程不要求浏览器在本机，也不监听
// 本机端口，所以 Windows 与远程桌面同样可用。

import { type ChildProcess, spawn } from 'node:child_process';
import { needsShell } from './launch.js';

/** 等 grok 印出登录地址与码的时限。 */
export const LOGIN_URL_WAIT_MS = 20_000;
/** 地址出现后再等多久它的“打不开浏览器”提示（这行在地址之后、码之前）。 */
export const LOGIN_SETTLE_MS = 3_000;
/** 一次登录最长等多久（设备码 15 分钟内有效，grok 自己也会在过期时退出）。 */
export const LOGIN_TIMEOUT_MS = 16 * 60_000;
/** 停不下来的 grok 多久后改用强制结束。 */
const KILL_ESCALATION_MS = 3_000;
/** grok 退出后最多再等多久把剩下的输出读完。 */
const EXIT_FLUSH_MS = 200;

export type GrokLoginResult = { ok: true } | { ok: false; cancelled: boolean; message: string };

/** 进行中的一次 `grok login --device-auth`。 */
export interface GrokLoginFlow {
  /** 去这个网址登录（带着码）。 */
  verificationUrl: string;
  /** 要在浏览器里确认的码；grok 没印出来也没带在地址里时省略。 */
  userCode?: string;
  /** grok 自己已经打开了浏览器；false 时由 Wevir 的桌面端去打开 `verificationUrl`。 */
  browserOpened: boolean;
  /** grok 退出时兑现：0 退出是登录完成；被 `cancel` 停掉的 `cancelled`；其余带 grok 的最后几行输出。 */
  done: Promise<GrokLoginResult>;
  cancel(): void;
}

export interface StartGrokLoginInput {
  executablePath: string;
  env: NodeJS.ProcessEnv;
  urlWaitMs?: number;
  settleMs?: number;
  timeoutMs?: number;
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'gu');

/** 去掉终端控制序列与日志里的时间戳行，剩下给人看的输出。 */
function plain(output: string): string {
  return output.replace(ANSI, '');
}

function tail(output: string): string {
  const lines = plain(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.slice(-3).join(' ');
}

export interface ParsedDeviceLogin {
  verificationUrl?: string;
  userCode?: string;
  /** grok 说它没能自己打开浏览器。 */
  browserFailed: boolean;
  /** 地址之后的内容都印完了（码和“等待授权”）。 */
  complete: boolean;
}

/** 从 `grok login --device-auth` 已有的输出里读出登录地址、码与“打不开浏览器”的提示。 */
export function parseDeviceLogin(output: string): ParsedDeviceLogin {
  const text = plain(output);
  const url =
    /open this URL[^\n]*\n\s*(https?:\/\/\S+)/iu.exec(text)?.[1] ??
    /(https?:\/\/\S+)/u.exec(text)?.[1];
  let queryCode: string | null = null;
  if (url !== undefined) {
    try {
      queryCode = new URL(url).searchParams.get('user_code');
    } catch {
      queryCode = null;
    }
  }
  const printedCode = /confirm this code[^\n]*\n\s*([A-Za-z0-9][A-Za-z0-9-]{3,})/iu.exec(text)?.[1];
  const userCode = printedCode ?? queryCode ?? undefined;
  return {
    ...(url !== undefined && { verificationUrl: url }),
    ...(userCode !== undefined && userCode !== '' && { userCode }),
    browserFailed: /could not open browser automatically/iu.test(text),
    complete: printedCode !== undefined || /waiting for authorization/iu.test(text),
  };
}

/** 结束 grok 和它起的子进程：POSIX 上整个进程组（npm 的 Node 启动脚本不会转发信号），Windows 上 `taskkill /T`。 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).once('error', () => child.kill());
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // 已经退出。
    }
  }
}

/**
 * 启动 `grok login --device-auth`，等它印出登录地址与码。拿到就返回（登录还没完成，`done` 之后才兑现）；grok 在印出地址前
 * 就退出或超时，抛错，错误信息是它的最后几行输出。
 */
export async function startGrokLogin(input: StartGrokLoginInput): Promise<GrokLoginFlow> {
  const child: ChildProcess = spawn(input.executablePath, ['login', '--device-auth'], {
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    shell: needsShell(input.executablePath),
  });
  let output = '';
  const collect = (data: Buffer) => {
    output = (output + data.toString('utf8')).slice(-8192);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let cancelled = false;
  let timedOut = false;
  let exited = false;
  let spawnError: Error | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    killTree(child, 'SIGTERM');
    escalation ??= setTimeout(() => {
      if (!exited) killTree(child, 'SIGKILL');
    }, KILL_ESCALATION_MS);
    escalation.unref();
  };
  const exit = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      resolve(null);
    });
    // 输出都读完（'close'）才算结束；孙进程占着管道不放时，'exit' 之后最多再等一会儿。
    child.once('close', (code) => resolve(code));
    child.once('exit', (code) => setTimeout(() => resolve(code), EXIT_FLUSH_MS).unref());
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, input.timeoutMs ?? LOGIN_TIMEOUT_MS);
  const done: Promise<GrokLoginResult> = exit.then((code) => {
    exited = true;
    clearTimeout(timeout);
    clearTimeout(escalation);
    if (cancelled) return { ok: false, cancelled: true, message: 'Sign-in was cancelled.' };
    if (code === 0) return { ok: true };
    if (timedOut) return { ok: false, cancelled: false, message: 'Sign-in timed out.' };
    if (spawnError !== undefined) {
      return {
        ok: false,
        cancelled: false,
        message: `Could not start grok: ${spawnError.message}`,
      };
    }
    return {
      ok: false,
      cancelled: false,
      message: tail(output) || `\`grok login\` exited with code ${code ?? 'unknown'}`,
    };
  });
  done.catch(() => {});
  let finished = false;
  void done.then(() => {
    finished = true;
  });

  const flow = (parsed: ParsedDeviceLogin & { verificationUrl: string }): GrokLoginFlow => ({
    verificationUrl: parsed.verificationUrl,
    ...(parsed.userCode !== undefined && { userCode: parsed.userCode }),
    browserOpened: !parsed.browserFailed,
    done,
    cancel: () => {
      cancelled = true;
      stop();
    },
  });
  const waitMs = input.urlWaitMs ?? LOGIN_URL_WAIT_MS;
  const settleMs = input.settleMs ?? LOGIN_SETTLE_MS;
  const deadline = Date.now() + waitMs;
  let urlSeenAt: number | undefined;
  for (;;) {
    const parsed = parseDeviceLogin(output);
    if (parsed.verificationUrl !== undefined) {
      urlSeenAt ??= Date.now();
      // 码与“等待授权”印出来时，“打不开浏览器”的提示（在它们之前）已经在了；一直不出现就不再等。grok 已经退出（登录秒失败）
      // 也返回：`done` 里有它的结果。
      if (parsed.complete || finished || Date.now() - urlSeenAt >= settleMs) {
        return flow({ ...parsed, verificationUrl: parsed.verificationUrl });
      }
    }
    if (finished || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  cancelled = true;
  stop();
  const result = await done;
  const detail = tail(output);
  throw new Error(
    spawnError !== undefined
      ? `Could not start grok: ${spawnError.message}`
      : !result.ok && !result.cancelled && finished && detail !== ''
        ? result.message
        : `grok did not report a sign-in address within ${waitMs / 1000} s${detail === '' ? '' : `: ${detail}`}`,
  );
}
