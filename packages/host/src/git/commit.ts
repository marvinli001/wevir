// 跑一次 `git commit`（0.67.0，`git.commit`，ADR-0009）：用户平常的 Git 配置，钩子与签名照常，不加 `--no-verify`、不关签名。
// 提交说明从标准输入给（`-F -`），不弹编辑器、不弹凭据提示。失败时什么都不回滚；靠 trace2 的事件认出是哪个钩子失败，靠输出认出
// 签名、身份与索引锁的问题。

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_COMMIT_OUTPUT_MAX_LENGTH } from '@wevir/protocol';

/** 提交（含钩子与签名）的时限：到时先 SIGTERM，5 秒后 SIGKILL。 */
export const COMMIT_TIMEOUT_MS = 10 * 60_000;
const KILL_GRACE_MS = 5_000;

export interface CommitRun {
  exitCode: number | null;
  /** 标准输出与标准错误按到达的先后拼在一起，只留尾部。 */
  output: string;
  timedOut: boolean;
  /** 跑过的钩子与退出码，按先后。 */
  hooks: { name: string; code?: number }[];
  /** 非钩子的子进程（签名程序之类）退出码不为 0。 */
  childFailed: boolean;
}

/**
 * 继承 Host 的环境（PATH、HOME 找全局配置、SSH_AUTH_SOCK、GPG_TTY 等签名要用的），去掉会把 git 指到别处的 GIT_* 变量。git 的提示
 * 用英文（认得出失败原因），字符集保持用户的；不弹终端里的凭据提示。
 */
export function commitEnv(traceFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && value !== undefined) env[key] = value;
  }
  const all = env.LC_ALL;
  delete env.LC_ALL;
  if (all !== undefined && all !== '' && env.LC_CTYPE === undefined) env.LC_CTYPE = all;
  return {
    ...env,
    LC_MESSAGES: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_TRACE2_EVENT: traceFile,
  };
}

export async function runCommit(
  cwd: string,
  message: string,
  timeoutMs = COMMIT_TIMEOUT_MS,
): Promise<CommitRun> {
  const dir = await mkdtemp(join(tmpdir(), 'wevir-commit-'));
  const traceFile = join(dir, 'trace2.json');
  try {
    const { exitCode, output, timedOut } = await spawnCommit(
      cwd,
      message,
      commitEnv(traceFile),
      timeoutMs,
    );
    const trace = await readFile(traceFile, 'utf8').catch(() => '');
    return { exitCode, output, timedOut, ...parseTrace2(trace) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function spawnCommit(
  cwd: string,
  message: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((done) => {
    const posix = process.platform !== 'win32';
    // 单独的进程组：超时时连同钩子起的进程一起停下（Windows 上用 taskkill /T 结束整棵进程树）。
    const child = spawn('git', ['commit', '-F', '-'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: posix,
      windowsHide: true,
    });
    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > GIT_COMMIT_OUTPUT_MAX_LENGTH * 2) {
        output = output.slice(-GIT_COMMIT_OUTPUT_MAX_LENGTH);
      }
    };
    const signal = (name: NodeJS.Signals) => {
      try {
        if (child.pid === undefined) child.kill(name);
        else if (posix) process.kill(-child.pid, name);
        else {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on(
            'error',
            () => {},
          );
        }
      } catch {}
    };
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.stdin.on('error', () => {});
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      done({ exitCode, output: output.slice(-GIT_COMMIT_OUTPUT_MAX_LENGTH), timedOut });
    };
    child.on('error', (error) => {
      append(Buffer.from(`git commit: ${error.message}\n`));
      finish(null);
    });
    child.on('close', (code) => finish(code));
    child.stdin.end(message);
  });
}

interface Trace2Event {
  event?: string;
  sid?: string;
  child_id?: number;
  child_class?: string;
  hook_name?: string;
  code?: number;
}

/**
 * trace2 的事件（`GIT_TRACE2_EVENT`，每行一个 JSON）：只看最外层的 git（钩子里再跑的 git 也写进同一个文件，它们的 `sid` 带 `/`）。
 * `child_start` 的 `child_class: "hook"` 带 `hook_name`，`child_exit` 带退出码。
 */
export function parseTrace2(text: string): Pick<CommitRun, 'hooks' | 'childFailed'> {
  const events: Trace2Event[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line) as Trace2Event);
    } catch {}
  }
  const top = events.find((event) => event.sid !== undefined && !event.sid.includes('/'))?.sid;
  const hooks: CommitRun['hooks'] = [];
  const byChild = new Map<number, { hook?: CommitRun['hooks'][number] }>();
  let childFailed = false;
  for (const event of events) {
    if (event.sid !== top || event.child_id === undefined) continue;
    if (event.event === 'child_start') {
      if (event.child_class === 'hook' && event.hook_name !== undefined) {
        const hook = { name: event.hook_name };
        hooks.push(hook);
        byChild.set(event.child_id, { hook });
      } else {
        byChild.set(event.child_id, {});
      }
    } else if (event.event === 'child_exit') {
      const started = byChild.get(event.child_id);
      if (!started) continue;
      if (started.hook) {
        if (event.code !== undefined) started.hook.code = event.code;
      } else if (event.code !== undefined && event.code !== 0) {
        childFailed = true;
      }
    }
  }
  return { hooks, childFailed };
}

const IDENTITY =
  /Author identity unknown|Committer identity unknown|auto-detection is disabled|unable to auto-detect email address|empty ident name/i;
const INDEX_LOCKED = /index\.lock['"]?: File exists|Unable to create '[^']*index\.lock'/i;
const SIGNING =
  /failed to sign|gpg failed|signing failed|error: (?:gpg|ssh-keygen|x509)|couldn't sign/i;
const NOTHING = /nothing to commit|no changes added to commit|nothing added to commit/i;

/** 失败的原因。`hook` 是失败的钩子。 */
export function diagnoseCommit(run: CommitRun): { reason: string; hook?: string } {
  if (run.timedOut) return { reason: 'timed_out' };
  const hook = run.hooks.find((entry) => entry.code !== undefined && entry.code !== 0);
  if (hook) return { reason: 'hook_failed', hook: hook.name };
  if (IDENTITY.test(run.output)) return { reason: 'identity_missing' };
  if (INDEX_LOCKED.test(run.output)) return { reason: 'index_locked' };
  if (
    SIGNING.test(run.output) ||
    (run.childFailed && /failed to write commit object/i.test(run.output))
  ) {
    return { reason: 'signing_failed' };
  }
  if (NOTHING.test(run.output)) return { reason: 'nothing_staged' };
  return { reason: 'git_failed' };
}
