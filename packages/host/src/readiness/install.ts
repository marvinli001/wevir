// 跑一次用户发起的项目安装（项目环境就绪，0.70.0）：Host 在用户的登录 shell 里起进程（同检查与后台进程，自成进程组），有超时与取消；
// 输出去掉控制序列、按行遮住凭据后才写进日志，日志与安装记录里都不出现凭据。失败时按输出归类（网络、仓库认证、权限、锁文件不一致、
// 版本不满足、命令找不到）。

import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { trackProcessGroup } from '@wevir/runtime-adapter';
import { childEnv, PROCESS_KILL_GRACE_MS, shellCommand, stripAnsi } from '../processes.js';

/** 一行太长时不等换行，攒到这么多就写。 */
const LINE_FLUSH_CHARS = 8192;
/** 日志最多写这么多字节，之后只计数不写。 */
export const INSTALL_LOG_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 遮住凭据：已知的值（Wevir 里存的、配置引用的环境变量的值）整串换掉；另外按样子遮 `_authToken=…`、`Authorization: Bearer …`、URL 里的
 * `用户名:口令@` 与常见令牌前缀。
 */
export class Redactor {
  readonly #values: string[];

  constructor(values: readonly string[]) {
    this.#values = [...new Set(values.filter((value) => value.length >= 4))].sort(
      (a, b) => b.length - a.length,
    );
  }

  redact(text: string): string {
    let result = text;
    for (const value of this.#values) result = result.split(value).join('***');
    return result
      .replace(
        /(_authToken|_auth|_password|npmAuthToken|token|password)(\s*[=:]\s*)("?)[^\s"']+/gi,
        '$1$2$3***',
      )
      .replace(/(authorization:\s*(?:bearer|basic|token)\s+)\S+/gi, '$1***')
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi, '$1***@')
      .replace(
        /\b(npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|pypi-[A-Za-z0-9_-]{20,})/g,
        '***',
      );
  }
}

/** 失败的归类（`InstallRun.reason`）。 */
export function classifyInstallFailure(exitCode: number | null, output: string): string {
  if (
    /ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE_CONFIG_MISMATCH|can only install packages when your package\.json and package-lock\.json[^\n]*in sync|lockfile would have been modified|Your lockfile needs to be updated|lockfile had changes, but lockfile is frozen|The lockfile at `?uv\.lock`? needs to be updated|pyproject\.toml changed significantly since poetry\.lock|lock file[^\n]*needs to be updated but --locked was passed|missing go\.sum entry|updates to go\.mod needed/i.test(
      output,
    )
  )
    return 'lockfile_mismatch';
  if (
    /\bE40[13]\b|ERR_PNPM_FETCH_40[13]|40[13] (Unauthorized|Forbidden)|authentication (required|failed)|Unable to authenticate|need auth|requires you to be logged in|Incorrect or missing password|invalid credentials|terminal prompts disabled/i.test(
      output,
    )
  )
    return 'registry_auth';
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|ERR_PNPM_META_FETCH_FAIL|ERR_SOCKET_TIMEOUT|socket hang up|Could not resolve host|Failed to connect|dial tcp|i\/o timeout|Temporary failure in name resolution|No route to host|Network is unreachable|failed to fetch|Failed to download|Connection refused|network (error|request failed)|ENOTCACHED|ERR_PNPM_NO_OFFLINE_TARBALL/i.test(
      output,
    )
  )
    return 'network';
  if (
    /\bEACCES\b|\bEPERM\b|Permission denied|operation not permitted|Read-only file system/i.test(
      output,
    )
  ) {
    return 'permission';
  }
  if (
    /ERR_PNPM_UNSUPPORTED_ENGINE|Unsupported engine|engine "node" is incompatible|requires a different Python|requires-python|go\.mod requires go >=|is not supported by the following package|requires rustc/i.test(
      output,
    )
  )
    return 'incompatible';
  if (
    exitCode === 127 ||
    /command not found|is not recognized as an internal or external command/i.test(output)
  ) {
    return 'not_found';
  }
  return 'exit_code';
}

export interface InstallRunOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 交给进程的额外环境变量（凭据）。 */
  extraEnv: Record<string, string>;
  platform: NodeJS.Platform;
  logPath: string;
  timeoutMs: number;
  redactor: Redactor;
  /** 写进日志的字节数变了。 */
  onOutput?: (bytes: number) => void;
}

export interface InstallResult {
  kind: 'exited' | 'timed_out' | 'cancelled' | 'spawn_failed';
  exitCode: number | null;
  signal: string | null;
  /** 写进日志的字节数。 */
  bytes: number;
  /** 输出的尾部（已遮住凭据）。 */
  tail: string;
  error?: string;
}

export interface InstallProcess {
  readonly result: Promise<InstallResult>;
  cancel(): void;
  readonly bytes: number;
}

const TAIL_CHARS = 16_000;

export function startInstall(options: InstallRunOptions): InstallProcess {
  const log: WriteStream = createWriteStream(options.logPath, { mode: 0o600 });
  log.on('error', () => {});
  let bytes = 0;
  let tail = '';
  let pending = '';
  const decoder = new StringDecoder('utf8');
  const write = (text: string) => {
    const clean = options.redactor.redact(stripAnsi(text).replace(/\r(?!\n)/g, '\n'));
    tail = (tail + clean).slice(-TAIL_CHARS);
    const size = Buffer.byteLength(clean);
    if (bytes + size <= INSTALL_LOG_MAX_BYTES) log.write(clean);
    bytes += size;
    options.onOutput?.(bytes);
  };
  const onText = (text: string) => {
    pending += text;
    const cut = Math.max(pending.lastIndexOf('\n'), pending.lastIndexOf('\r'));
    if (cut >= 0) {
      write(pending.slice(0, cut + 1));
      pending = pending.slice(cut + 1);
    }
    if (pending.length >= LINE_FLUSH_CHARS) {
      write(pending);
      pending = '';
    }
  };

  const env = { ...childEnv(options.env, options.platform), ...options.extraEnv };
  const { file, args } = shellCommand(options.command, options.platform, env);
  let child: ChildProcess | undefined;
  let state: 'running' | 'timed_out' | 'cancelled' = 'running';
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    const pid = child?.pid;
    if (pid === undefined) return;
    try {
      if (options.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on(
          'error',
          () => {},
        );
      } else {
        process.kill(-pid, signal);
      }
    } catch {
      try {
        child?.kill(signal);
      } catch {}
    }
  };
  const stop = (reason: 'timed_out' | 'cancelled') => {
    if (state !== 'running') return;
    state = reason;
    kill('SIGTERM');
    killTimer = setTimeout(() => kill('SIGKILL'), PROCESS_KILL_GRACE_MS);
  };

  const result = new Promise<InstallResult>((resolve) => {
    const finish = (exitCode: number | null, signal: string | null, error?: string) => {
      const rest = pending + decoder.end();
      pending = '';
      if (rest !== '') write(rest);
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(timeout);
      log.end(() => {
        resolve({
          kind: error !== undefined ? 'spawn_failed' : state === 'running' ? 'exited' : state,
          exitCode,
          signal,
          bytes,
          tail,
          ...(error !== undefined && { error }),
        });
      });
    };
    const timeout = setTimeout(() => stop('timed_out'), options.timeoutMs);
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: options.platform !== 'win32',
        windowsHide: true,
        windowsVerbatimArguments: options.platform === 'win32',
      });
    } catch (error) {
      finish(null, null, error instanceof Error ? error.message : String(error));
      return;
    }
    if (options.platform !== 'win32') {
      trackProcessGroup(child, {
        kind: 'install',
        name: options.command.slice(0, 60),
        cwd: options.cwd,
      });
    }
    child.stdout?.on('data', (chunk: Buffer) => onText(decoder.write(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => onText(decoder.write(chunk)));
    let done = false;
    child.on('error', (error) => {
      if (child?.pid === undefined && !done) {
        done = true;
        finish(null, null, error.message);
      }
    });
    child.on('close', (code, signal) => {
      if (done) return;
      done = true;
      finish(code, signal);
    });
  });

  return {
    result,
    cancel: () => stop('cancelled'),
    get bytes() {
      return bytes;
    },
  };
}
