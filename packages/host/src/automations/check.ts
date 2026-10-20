// 自动化的检查脚本（0.71.0，domain-model §3.26）：每次运行前 Host 先跑它，按退出码或输出有没有变决定这次唤不唤醒 Agent。
//
// 用户的登录 shell、自成进程组、去掉 `WEVIR_*` 的环境，同后台进程（processes.ts 的 `shellCommand` / `childEnv`）；不进
// “进程输出”，它不属于哪个会话。超时先 SIGTERM 整个进程组，宽限后 SIGKILL。输出只留末尾给人与 Agent 看；`output_changed`
// 比的是整段原始输出连同退出码的摘要，所以留下的末尾一样、前面变了也算变了。

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  AUTOMATION_CHECK_DEFAULT_TIMEOUT_SECONDS,
  AUTOMATION_CHECK_OUTPUT_MAX_LENGTH,
  type AutomationCheck,
  type AutomationCheckResult,
} from '@wevir/protocol';
import { childEnv, PROCESS_KILL_GRACE_MS, shellCommand, stripAnsi } from '../processes.js';

/** 输出最多留多少字节再去掉控制序列、截字符（够截出 `AUTOMATION_CHECK_OUTPUT_MAX_LENGTH` 个字符）。 */
const TAIL_BYTES = AUTOMATION_CHECK_OUTPUT_MAX_LENGTH * 4;

export interface CheckRequest {
  command: string;
  /** 绝对路径。 */
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 进程跑完的样子，还没下结论。 */
export interface CheckOutcome {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** 去掉控制序列后的末尾。 */
  output: string;
  truncated: boolean;
  /** 原始输出连同退出码的摘要（`output_changed` 比它）。 */
  fingerprint: string;
  /** 起不来（cwd 不在、shell 找不到）的原因。 */
  error?: string;
}

export type CheckExecutor = (request: CheckRequest) => Promise<CheckOutcome>;

export function checkTimeoutMs(check: AutomationCheck): number {
  return (check.timeoutSeconds ?? AUTOMATION_CHECK_DEFAULT_TIMEOUT_SECONDS) * 1000;
}

/** 跑一次检查脚本。 */
export const runCheck: CheckExecutor = (request) => {
  const started = Date.now();
  const platform = process.platform;
  const { file, args } = shellCommand(request.command, platform, process.env);
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let kept = 0;
  let dropped = false;
  let timedOut = false;
  let cancelled = false;

  return new Promise<CheckOutcome>((resolve) => {
    let settled = false;
    let child: ChildProcess;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      hash.update(`\0exit:${exitCode === null ? 'none' : exitCode}`);
      const text = stripAnsi(Buffer.concat(chunks).toString('utf8')).replace(/\r\n?/g, '\n');
      const chars = Array.from(text);
      const truncated = dropped || chars.length > AUTOMATION_CHECK_OUTPUT_MAX_LENGTH;
      resolve({
        exitCode,
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
        output: chars.slice(-AUTOMATION_CHECK_OUTPUT_MAX_LENGTH).join(''),
        truncated,
        fingerprint: hash.digest('hex'),
        ...(error !== undefined && { error }),
      });
    };
    const kill = (signal: NodeJS.Signals) => {
      const pid = child?.pid;
      if (pid === undefined) return;
      try {
        if (platform === 'win32') {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on(
            'error',
            () => {},
          );
        } else {
          process.kill(-pid, signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {}
      }
    };
    const stop = () => {
      kill('SIGTERM');
      timers.push(setTimeout(() => kill('SIGKILL'), PROCESS_KILL_GRACE_MS));
    };
    function onAbort() {
      cancelled = true;
      stop();
    }

    try {
      child = spawn(file, args, {
        cwd: request.cwd,
        env: childEnv(process.env, platform),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        windowsHide: true,
        windowsVerbatimArguments: platform === 'win32',
      });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }
    const onData = (chunk: Buffer) => {
      hash.update(chunk);
      chunks.push(chunk);
      kept += chunk.length;
      while (kept - (chunks[0]?.length ?? 0) >= TAIL_BYTES && chunks.length > 1) {
        kept -= chunks.shift()?.length ?? 0;
        dropped = true;
      }
      if (kept > TAIL_BYTES * 2) {
        // 一大块：只留它的末尾。
        const all = Buffer.concat(chunks);
        chunks.length = 0;
        chunks.push(all.subarray(all.length - TAIL_BYTES));
        kept = TAIL_BYTES;
        dropped = true;
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => {
      if (child.pid === undefined) finish(null, error.message);
    });
    child.on('close', (code) => finish(timedOut || cancelled ? null : code));
    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop();
      }, request.timeoutMs),
    );
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener('abort', onAbort, { once: true });
  });
};

/**
 * 按唤醒规则下结论。`baseline` 是上一次检查的摘要（`output_changed`）；返回的 `baseline` 是这次之后该记下的（失败时不动）。
 */
export function decide(
  check: AutomationCheck,
  outcome: CheckOutcome,
  baseline: string | undefined,
): { result: AutomationCheckResult; baseline: string | undefined } {
  const base = {
    exitCode: outcome.exitCode,
    ...(outcome.timedOut && { timedOut: true as const }),
    durationMs: outcome.durationMs,
    output: outcome.output,
    ...(outcome.truncated && { truncated: true as const }),
  };
  const failed = (error: string) => ({
    result: { decision: 'failed' as const, ...base, error },
    baseline,
  });
  if (outcome.error !== undefined) return failed(`The check could not start: ${outcome.error}`);
  if (outcome.timedOut) {
    return failed(`The check timed out after ${Math.round(checkTimeoutMs(check) / 1000)} s.`);
  }
  if (outcome.cancelled) return failed('The check was cancelled.');
  if (outcome.exitCode === null) return failed('The check was ended by a signal.');
  if (check.wake === 'exit_code') {
    if (outcome.exitCode === 0) return { result: { decision: 'wake', ...base }, baseline };
    if (outcome.exitCode === 1) return { result: { decision: 'silent', ...base }, baseline };
    return failed(`The check exited with code ${outcome.exitCode} (0 wakes the agent, 1 skips).`);
  }
  if (baseline === undefined) {
    return {
      result: {
        decision: 'silent',
        ...base,
        error: 'First check: its output is the baseline for the next ones.',
      },
      baseline: outcome.fingerprint,
    };
  }
  return {
    result: { decision: outcome.fingerprint === baseline ? 'silent' : 'wake', ...base },
    baseline: outcome.fingerprint,
  };
}
