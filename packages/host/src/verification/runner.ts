// 跑一次检查（0.65.0，ADR-0008 决策 10）：Host 起进程，复用 `ProcessManager`（用户的 shell、自成进程组、去掉 `WEVIR_*` 的环境），
// 但用单独的实例，Agent 的进程工具看不到也停不了。有超时（SIGTERM，宽限后 SIGKILL）、取消与输出上限；结束后把输出（去掉控制序列）
// 存成 `<tool-output>/<会话 ID>/verification/<记录 ID>.log`，`verification.output` 从这里读，Host 重启后也在。放在会话的大输出目录
// 里：删除会话时随会话删、存储页算进会话的文件，同大输出一样七天后清掉（记录里的输出尾部一直在）。
//
// 检查的进程在“进程输出”里也看得到（0.69.0，ID `v<n>`）：原始日志留到进程记录被忘掉（每个会话留最近 `CHECK_PROCESSES_KEPT` 个），
// 客户端在检查跑完后也能按同一套偏移量读完。

import { mkdir, open, stat } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import type { SessionId, TurnId, VerificationRunId } from '@wevir/protocol';
import { VERIFICATION_OUTPUT_PAGE_MAX_BYTES } from '@wevir/protocol';
import {
  completeUtf8,
  PROCESS_KILL_GRACE_MS,
  type ProcessChange,
  type ProcessCheck,
  ProcessManager,
} from '../processes.js';
import { ToolOutputStore } from '../tool-output.js';

/** 一次检查的日志：到这个大小换一次文件，只留最后一段，开头算丢弃（`truncated`）。 */
export const VERIFICATION_LOG_ROTATE_BYTES = 8 * 1024 * 1024;
/** 每个会话留几个已结束的检查进程（连同原始日志）。 */
export const CHECK_PROCESSES_KEPT = 10;

export interface RunRequest {
  sessionId: SessionId;
  runId: VerificationRunId;
  command: string;
  /** 绝对路径。 */
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  check?: ProcessCheck;
  turnId?: TurnId;
  /** 进程的显示名（检查名），默认记录 ID。 */
  name?: string;
}

export interface RunResult {
  kind: 'exited' | 'timed_out' | 'cancelled' | 'spawn_failed';
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  /** 留下的输出（去掉了控制序列）。 */
  output: string;
  bytes: number;
  truncated: boolean;
  error?: string;
}

/** 检查进程的原始日志放在 `<会话 ID>/verification/processes/`，抄出输出后删掉。 */
class VerificationLogs extends ToolOutputStore {
  override async sessionDir(sessionId: SessionId): Promise<string> {
    const dir = join(this.dir, sessionId, 'verification', 'processes');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
}

export class CheckRunner {
  readonly #dir: string;
  readonly #processes: ProcessManager;

  constructor(options: {
    dir: string;
    onWarning?: (message: string, fields?: Record<string, unknown>) => void;
    env?: NodeJS.ProcessEnv;
    onChange?: (change: ProcessChange) => void;
  }) {
    this.#dir = options.dir;
    this.#processes = new ProcessManager({
      output: new VerificationLogs(options.dir),
      onNotice: () => {},
      ...(options.onWarning !== undefined && { onWarning: options.onWarning }),
      ...(options.env !== undefined && { env: options.env }),
      ...(options.onChange !== undefined && { onChange: options.onChange }),
      logRotateBytes: VERIFICATION_LOG_ROTATE_BYTES,
      idPrefix: 'v',
      maxKept: CHECK_PROCESSES_KEPT,
      deleteLogsOnForget: true,
    });
  }

  /** 检查的进程（“进程输出”）。 */
  get processes(): ProcessManager {
    return this.#processes;
  }

  outputPath(sessionId: SessionId, runId: VerificationRunId): string {
    return join(this.#dir, sessionId, 'verification', `${runId}.log`);
  }

  async run(request: RunRequest): Promise<RunResult> {
    const started = Date.now();
    const info = await this.#processes.start(request.sessionId, {
      command: request.command,
      cwd: request.cwd,
      name: request.name ?? request.runId,
      notifyOnExit: false,
      ...(request.check !== undefined && { check: request.check }),
      ...(request.turnId !== undefined && { turnId: request.turnId }),
    });
    if (info.status === 'exited' && info.error !== undefined) {
      return {
        kind: 'spawn_failed',
        exitCode: null,
        signal: null,
        durationMs: Date.now() - started,
        output: '',
        bytes: 0,
        truncated: false,
        error: info.error,
      };
    }
    const waited = await this.#processes.wait(
      request.sessionId,
      info.id,
      undefined,
      request.timeoutMs,
      request.signal,
    );
    let kind: RunResult['kind'] = 'exited';
    if (waited.reason !== 'exit') {
      kind = waited.reason === 'timeout' ? 'timed_out' : 'cancelled';
      await this.#stop(request.sessionId, info.id);
    }
    const final = this.#processes.info(request.sessionId, info.id);
    const { output, bytes, truncated } = await this.#keep(
      request.sessionId,
      info.id,
      request.runId,
    );
    if (final?.error !== undefined && kind === 'exited' && final.pid === undefined)
      kind = 'spawn_failed';
    return {
      kind,
      exitCode: final?.exitCode ?? null,
      signal: final?.signal ?? null,
      durationMs: Date.now() - started,
      output,
      bytes,
      truncated,
      ...(final?.error !== undefined && { error: final.error }),
    };
  }

  /** SIGTERM 给整个进程组，宽限之后还在就 SIGKILL；等到它退出。 */
  async #stop(sessionId: SessionId, id: string): Promise<void> {
    const alive = () => this.#processes.info(sessionId, id)?.status === 'running';
    if (!alive()) return;
    try {
      this.#processes.signal(sessionId, id, 'SIGTERM', 'host');
    } catch {}
    const never = new AbortController().signal;
    await this.#processes.wait(sessionId, id, undefined, PROCESS_KILL_GRACE_MS, never);
    if (!alive()) return;
    try {
      this.#processes.signal(sessionId, id, 'SIGKILL', 'host');
    } catch {}
    await this.#processes.wait(sessionId, id, undefined, PROCESS_KILL_GRACE_MS, never);
  }

  /** 把进程日志里留着的输出抄成这条记录的日志（进程日志留到进程记录被忘掉）。 */
  async #keep(
    sessionId: SessionId,
    id: string,
    runId: VerificationRunId,
  ): Promise<{ output: string; bytes: number; truncated: boolean }> {
    const parts: string[] = [];
    let since: number | undefined;
    let truncated = false;
    try {
      for (;;) {
        const chunk = await this.#processes.read(sessionId, id, since);
        if (since === undefined && chunk.from > 0) truncated = true;
        parts.push(chunk.text);
        since = chunk.next;
        if (!chunk.more) break;
      }
    } catch {
      // 进程记录已经没了（删除会话）：没有输出可留。
    }
    const output = parts.join('');
    const path = this.outputPath(sessionId, runId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, 'w', 0o600);
    try {
      await file.writeFile(output);
    } finally {
      await file.close();
    }
    return { output, bytes: Buffer.byteLength(output), truncated };
  }

  /** `verification.output`：从 `offset` 起最多一页，不截在半个字符上。文件没有时是空的。 */
  async read(
    sessionId: SessionId,
    runId: VerificationRunId,
    offset = 0,
  ): Promise<{ text: string; from: number; next: number; more: boolean; bytes: number }> {
    const path = this.outputPath(sessionId, runId);
    const size = (await stat(path).catch(() => undefined))?.size ?? 0;
    const from = Math.min(offset, size);
    const length = Math.min(size - from, VERIFICATION_OUTPUT_PAGE_MAX_BYTES);
    if (length <= 0) return { text: '', from, next: from, more: false, bytes: size };
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, from);
      const usable =
        from + bytesRead < size ? completeUtf8(buffer.subarray(0, bytesRead)) : bytesRead;
      return {
        text: buffer.subarray(0, usable).toString('utf8'),
        from,
        next: from + usable,
        more: from + usable < size,
        bytes: size,
      };
    } finally {
      await handle.close();
    }
  }

  /** 删除会话：结束它还在跑的检查（输出随会话的大输出目录一起删）。 */
  async removeSessions(sessionIds: readonly SessionId[]): Promise<void> {
    await this.#processes.removeSessions(sessionIds);
  }

  close(): Promise<void> {
    return this.#processes.close();
  }
}

/**
 * 运行前的环境检查（决策 8）：目录不存在 `cwd_missing`；从检查目录往上最近的 `package.json` 声明了依赖、却在它和它上面的目录里都
 * 找不到 `node_modules`（也不是 Yarn PnP）时 `dependencies_missing`。都好时 undefined。
 */
export async function environmentPrecheck(cwd: string): Promise<string | undefined> {
  const info = await stat(cwd).catch(() => undefined);
  if (!info?.isDirectory()) return 'cwd_missing';
  const root = parse(cwd).root;
  let dir = cwd;
  let manifest: string | undefined;
  for (;;) {
    const text = await readText(join(dir, 'package.json'));
    if (text !== undefined) {
      manifest = dir;
      if (!declaresDependencies(text)) return undefined;
      break;
    }
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
  for (let up = manifest; ; up = dirname(up)) {
    if (await isDirectory(join(up, 'node_modules'))) return undefined;
    if (await exists(join(up, '.pnp.cjs'))) return undefined;
    if (up === root) return 'dependencies_missing';
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    const handle = await open(path, 'r');
    try {
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

function declaresDependencies(text: string): boolean {
  try {
    const manifest = JSON.parse(text) as Record<string, unknown>;
    return ['dependencies', 'devDependencies', 'optionalDependencies'].some((key) => {
      const value = manifest[key];
      return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
    });
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() === true;
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}
