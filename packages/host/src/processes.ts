// 后台进程（domain-model §3.15）：会话里的 agent 经应用级工具在 Host 里起长时间运行的命令（开发服务器、监视构建、长测试），
// 不随引擎的这次命令调用或回合结束被杀；能列出、读输出、写 stdin、发信号、等它退出或输出某一行，退出或输出匹配时由 Host 把
// 通知作为消息发回会话（app-tools.ts，同回报）。Claude Code 的后台 Bash（run_in_background + BashOutput / KillShell）与
// Monitor 是参考，写法是 Wevir 自己的：只用 Node 内置模块，不开伪终端。
//
// 进程只在内存里登记，Host 退出时全部结束（SIGTERM，3 秒后 SIGKILL），删除会话时结束它的。stdout 与 stderr 按到达顺序写进
// `<数据目录>/tool-output/<会话 ID>/process-<ID>.log`（tool-output.ts），超过 `PROCESS_LOG_ROTATE_BYTES` 时换到 `.1`。
// 客户端经 `process.*`（0.69.0，process-output.ts）也看得到、停得了这些进程；`onChange` 报起来、退出、被停与输出变多。

import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  CheckId,
  SessionId,
  TurnId,
  VerificationRunId,
  VerificationTrigger,
} from '@wevir/protocol';
import { AppToolError } from './app-mcp.js';
import type { ToolOutputStore } from './tool-output.js';

/** 一个会话同时最多几个在跑的进程。 */
export const PROCESS_MAX_RUNNING = 16;
/** 一个会话记着最多几个进程（含已退出的，超出时丢最早退出的）。 */
export const PROCESS_MAX_KEPT = 50;
/** 日志超过这么多字节时换到 `.1`（只留一份旧的）。 */
export const PROCESS_LOG_ROTATE_BYTES = 20 * 1024 * 1024;
/** 结束时 SIGTERM 之后等多久再 SIGKILL。 */
export const PROCESS_KILL_GRACE_MS = 3000;
/** 通知与结果里带的最后几行。 */
export const PROCESS_TAIL_LINES = 20;
/** 读输出时一次最多读多少字节（更多的经 tool-output 落盘）。 */
export const PROCESS_READ_MAX_BYTES = 256 * 1024;
/** 同一个进程的输出变多时最多每隔这么久报一次 `onChange`。 */
export const PROCESS_CHANGE_THROTTLE_MS = 500;
/** `notifyPattern` 匹配后再攒这么久，一阵连着的匹配（报错的堆栈）合成一条通知。 */
export const PROCESS_NOTIFY_BATCH_MS = 1000;
/** 同一个进程两条匹配通知之间至少隔这么久，期间的匹配攒到下一条。 */
export const PROCESS_NOTIFY_INTERVAL_MS = 10_000;
/** 一个进程最多发几条匹配通知：默认与上限。 */
export const PROCESS_NOTIFY_DEFAULT_LIMIT = 10;
export const PROCESS_NOTIFY_MAX_LIMIT = 100;
/** 一条通知最多列几行匹配的、每行最多多少字符。 */
export const PROCESS_NOTIFY_MAX_LINES = 50;
export const PROCESS_NOTIFY_LINE_CHARS = 500;

export const PROCESS_SIGNALS = [
  'SIGINT',
  'SIGTERM',
  'SIGKILL',
  'SIGHUP',
  'SIGQUIT',
  'SIGUSR1',
  'SIGUSR2',
] as const;
export type ProcessSignal = (typeof PROCESS_SIGNALS)[number];

export interface ProcessInfo {
  id: string;
  sessionId: SessionId;
  name: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  startedAt: number;
  status: 'running' | 'exited';
  exitCode: number | null;
  signal: string | null;
  endedAt: number | undefined;
  /** 当前的日志文件。 */
  logPath: string;
  /** 从启动起写过的字节数（读输出的偏移量按它算）。 */
  bytes: number;
  /** agent 用 `wevir_process_kill` 结束的、或用户与 Host 停的（退出时不通知）。 */
  killed: boolean;
  /** 谁停的（`killed` 时有）。 */
  stoppedBy?: ProcessStopper;
  /** 起它时进行中的回合。 */
  turnId?: TurnId;
  /** 回合后验证的检查（verification/runner.ts 起的）。 */
  check?: ProcessCheck;
  /** 开发服务器预览（preview/service.ts 起的，0.84.0）。 */
  preview?: ProcessPreviewInfo;
  /** 启动失败（找不到 shell 等）的原因。 */
  error?: string;
}

export type ProcessStopper = 'agent' | 'user' | 'host';

export interface ProcessPreviewInfo {
  /** 运行配置的名字。 */
  name: string;
  /** 会话目录：同一根目录、同名的只起一份。 */
  root: string;
  port?: number;
  url?: string;
  ready: boolean;
  startedBy: 'user' | 'agent';
}

export interface ProcessCheck {
  runId: VerificationRunId;
  checkId: CheckId;
  trigger: VerificationTrigger;
}

/** `onChange`：进程的最新状态，或它被忘掉了。 */
export type ProcessChange = { process: ProcessInfo } | { removed: ProcessInfo };

/** 退出或输出匹配时交给 app-tools 发回会话的通知。 */
export interface ProcessNotice {
  process: ProcessInfo;
  event: 'exit' | 'match';
  /** 上一条通知之后匹配 `notifyPattern` 的行（最多 `PROCESS_NOTIFY_MAX_LINES` 行；退出通知里是退出前还没发的）。 */
  matches?: ProcessMatches;
  /** 最后几行（去掉了终端控制序列）。 */
  tail: string;
}

export interface ProcessMatches {
  pattern: RegExp;
  lines: string[];
  /** 匹配的总行数（比 `lines` 多的没列）。 */
  count: number;
  /** `match`：之后还能发几条匹配通知（0 时不再发）；退出通知里没有。 */
  remaining?: number;
}

export interface StartOptions {
  command: string;
  cwd: string;
  name?: string;
  env?: Record<string, string>;
  /** 退出时通知（默认 true）。 */
  notifyOnExit?: boolean;
  /** 输出的行匹配时通知：一阵匹配合成一条，两条之间至少隔 `PROCESS_NOTIFY_INTERVAL_MS`。 */
  notifyPattern?: RegExp;
  /** 最多发几条匹配通知（默认 `PROCESS_NOTIFY_DEFAULT_LIMIT`）。 */
  notifyLimit?: number;
  turnId?: TurnId;
  check?: ProcessCheck;
  preview?: ProcessPreviewInfo;
}

export interface WaitResult {
  reason: 'exit' | 'match' | 'timeout' | 'aborted';
  line?: string;
}

export interface ProcessManagerOptions {
  output: ToolOutputStore;
  onNotice: (notice: ProcessNotice) => void;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  /** 默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 `process.platform`。 */
  platform?: NodeJS.Platform;
  /** 日志换文件的大小，默认 `PROCESS_LOG_ROTATE_BYTES`（测试用小值）。 */
  logRotateBytes?: number;
  /** 进程 ID 的前缀，默认 `p`（检查用 `v`，两个实例的 ID 不重）。 */
  idPrefix?: string;
  /** 一个会话记着最多几个进程，默认 `PROCESS_MAX_KEPT`。 */
  maxKept?: number;
  /** 忘掉已退出的进程时连日志一起删（检查的原始日志，输出另有一份）。 */
  deleteLogsOnForget?: boolean;
  /** 起来、退出、被停、输出变多（节流）与忘掉时调用。 */
  onChange?: (change: ProcessChange) => void;
  /** 匹配通知的攒批与间隔，默认 `PROCESS_NOTIFY_BATCH_MS` / `PROCESS_NOTIFY_INTERVAL_MS`（测试用小值）。 */
  notifyBatchMs?: number;
  notifyIntervalMs?: number;
}

interface Waiter {
  pattern: RegExp | undefined;
  resolve: (result: WaitResult) => void;
}

/** 输出匹配时的通知：攒着的行、发了几条。 */
interface Notify {
  pattern: RegExp;
  limit: number;
  sent: number;
  lines: string[];
  count: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastAt: number;
  /** 不带换行的这一段已经匹配过：它补齐成一行时不再算一次。 */
  partialMatched: boolean;
}

interface Managed {
  info: ProcessInfo;
  child: ChildProcess | undefined;
  log: WriteStream | undefined;
  /** 当前日志文件从第几个字节开始（换过文件后大于 0）。 */
  logStart: number;
  /** 从第几个字节起算“当前日志文件写了多少”：换文件时攒下的输出不算，免得新文件一开就又超限、马上再换一次。 */
  rotateFrom: number;
  /** 写日志的队列：换文件时等前面的写完。 */
  writing: Promise<void>;
  /** 正在换文件时到达的输出：新文件开好后接着写，不丢。 */
  rotation: Buffer[] | undefined;
  decoder: StringDecoder;
  partial: string;
  /** 最后几行（已去掉控制序列）。 */
  tail: string[];
  notifyOnExit: boolean;
  notify: Notify | undefined;
  waiters: Set<Waiter>;
  exited: Promise<void>;
  /** 输出变多后待发的 `onChange`。 */
  changeTimer: ReturnType<typeof setTimeout> | undefined;
}

/** 终端控制序列（颜色、光标）：匹配与给模型看的文本里去掉。 */
const ANSI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要匹配 ESC 与 BEL。
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export class ProcessManager {
  readonly #options: ProcessManagerOptions;
  readonly #processes = new Map<string, Managed>();
  #nextId = 1;
  #closed = false;

  constructor(options: ProcessManagerOptions) {
    this.#options = options;
  }

  async start(sessionId: SessionId, options: StartOptions): Promise<ProcessInfo> {
    if (this.#closed) throw new AppToolError('Wevir is shutting down.');
    const running = this.list(sessionId).filter((info) => info.status === 'running').length;
    if (running >= PROCESS_MAX_RUNNING) {
      throw new AppToolError(
        `This session already has ${running} running background processes (the limit). Stop some with wevir_process_kill first.`,
      );
    }
    this.#forgetOld(sessionId);
    const id = `${this.#options.idPrefix ?? 'p'}${this.#nextId++}`;
    const dir = await this.#options.output.sessionDir(sessionId);
    const logPath = join(dir, `process-${id}.log`);
    const info: ProcessInfo = {
      id,
      sessionId,
      name: options.name?.trim() || options.command.slice(0, 60),
      command: options.command,
      cwd: options.cwd,
      pid: undefined,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      signal: null,
      endedAt: undefined,
      logPath,
      bytes: 0,
      killed: false,
      ...(options.turnId !== undefined && { turnId: options.turnId }),
      ...(options.check !== undefined && { check: options.check }),
      ...(options.preview !== undefined && { preview: { ...options.preview } }),
    };
    let markExited = () => {};
    const managed: Managed = {
      info,
      child: undefined,
      log: createWriteStream(logPath, { mode: 0o600 }),
      logStart: 0,
      rotateFrom: 0,
      writing: Promise.resolve(),
      rotation: undefined,
      decoder: new StringDecoder('utf8'),
      partial: '',
      tail: [],
      notifyOnExit: options.notifyOnExit !== false,
      notify:
        options.notifyPattern === undefined
          ? undefined
          : {
              pattern: options.notifyPattern,
              limit: options.notifyLimit ?? PROCESS_NOTIFY_DEFAULT_LIMIT,
              sent: 0,
              lines: [],
              count: 0,
              timer: undefined,
              lastAt: 0,
              partialMatched: false,
            },
      waiters: new Set(),
      exited: new Promise<void>((resolve) => {
        markExited = resolve;
      }),
      changeTimer: undefined,
    };
    managed.log?.on('error', (error) => {
      this.#options.onWarning?.('后台进程的日志写不进去', { id, error: String(error) });
      managed.log = undefined;
    });
    this.#processes.set(id, managed);

    const platform = this.#options.platform ?? process.platform;
    const { file, args } = shellCommand(options.command, platform, this.#env());
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: { ...childEnv(this.#env(), platform), ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        // POSIX 上自成进程组，结束时连它的子进程一起（`kill(-pid)`）。
        detached: platform !== 'win32',
        windowsHide: true,
        windowsVerbatimArguments: platform === 'win32',
      });
    } catch (error) {
      this.#finish(managed, null, null, error instanceof Error ? error.message : String(error));
      markExited();
      return { ...info };
    }
    managed.child = child;
    info.pid = child.pid;
    child.stdout?.on('data', (chunk: Buffer) => this.#data(managed, chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.#data(managed, chunk));
    child.stdin?.on('error', () => {});
    child.on('error', (error) => {
      // 启动失败（cwd 不存在、shell 找不到）时没有 exit 事件。
      if (child.pid === undefined) {
        this.#finish(managed, null, null, error.message);
        markExited();
      }
    });
    child.on('close', (code, signal) => {
      this.#finish(managed, code, signal);
      markExited();
    });
    this.#changed(managed);
    return { ...info };
  }

  /** 所有会话的进程（`process.list`）。 */
  listAll(): ProcessInfo[] {
    return [...this.#processes.values()].map((managed) => ({ ...managed.info }));
  }

  /** 按 ID 找，不看会话（`process.*`）；没有时 undefined。 */
  find(id: string): ProcessInfo | undefined {
    const managed = this.#processes.get(id);
    return managed === undefined ? undefined : { ...managed.info };
  }

  list(sessionId: SessionId): ProcessInfo[] {
    return [...this.#processes.values()]
      .filter((managed) => managed.info.sessionId === sessionId)
      .map((managed) => ({ ...managed.info }));
  }

  info(sessionId: SessionId, id: string): ProcessInfo {
    return { ...this.#get(sessionId, id).info };
  }

  /** 最后几行（去掉控制序列）。 */
  tail(sessionId: SessionId, id: string, lines = PROCESS_TAIL_LINES): string {
    const managed = this.#get(sessionId, id);
    return lastLines(managed, lines);
  }

  /**
   * 读输出：`since` 给了时读从这个偏移量（`bytes`）起新写的（最多 `PROCESS_READ_MAX_BYTES`），否则读当前日志文件。返回的文本
   * 去掉了控制序列，`next` 是下次的 `since`。早于当前日志文件的部分在 `.1` 里或已丢弃，`dropped` 说明。
   */
  async read(
    sessionId: SessionId,
    id: string,
    since?: number,
    until?: number,
  ): Promise<{
    text: string;
    from: number;
    next: number;
    dropped: number;
    more: boolean;
    start: number;
    bytes: number;
  }> {
    const managed = this.#get(sessionId, id);
    await managed.writing;
    await flush(managed.log);
    // 以文件里实际有的为准：写日志出过错（磁盘满、文件被删）时偏移量不再对得上，别读到文件之外。
    const size = (await stat(managed.info.logPath).catch(() => undefined))?.size ?? 0;
    const start = managed.logStart;
    const available = Math.min(managed.info.bytes, start + size);
    const end = until === undefined ? available : Math.max(start, Math.min(until, available));
    let from = Math.max(since ?? start, start);
    const dropped = since !== undefined && since < start ? start - since : 0;
    const base = { dropped, start, bytes: managed.info.bytes };
    if (end - from <= 0) return { text: '', from, next: end, more: false, ...base };
    const handle = await open(managed.info.logPath, 'r');
    try {
      // 从任意偏移量读起（客户端往前翻页）时可能落在半个 UTF-8 字符上：往后挪到下一个字符的开头。
      if (from > start) {
        const probe = Buffer.alloc(Math.min(3, end - from));
        const { bytesRead } = await handle.read(probe, 0, probe.length, from - start);
        let skip = 0;
        while (skip < bytesRead && ((probe[skip] ?? 0) & 0xc0) === 0x80) skip += 1;
        from += skip;
      }
      const length = Math.min(end - from, PROCESS_READ_MAX_BYTES);
      if (length <= 0) return { text: '', from, next: from, more: false, ...base };
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, from - start);
      const usable =
        from + bytesRead < available ? completeUtf8(buffer.subarray(0, bytesRead)) : bytesRead;
      return {
        text: stripAnsi(buffer.subarray(0, usable).toString('utf8')),
        from,
        next: from + usable,
        more: from + usable < end,
        ...base,
      };
    } finally {
      await handle.close();
    }
  }

  /** 写 stdin；`eof` 时之后关闭 stdin。 */
  write(sessionId: SessionId, id: string, input: string, eof: boolean): void {
    const managed = this.#get(sessionId, id);
    const stdin = managed.child?.stdin;
    if (managed.info.status !== 'running' || !stdin || stdin.destroyed || stdin.writableEnded) {
      throw new AppToolError(`Process ${id} is not running or its stdin is closed.`);
    }
    if (input !== '') stdin.write(input);
    if (eof) stdin.end();
  }

  /** 发信号（POSIX 发给整个进程组；Windows 上一律结束进程树）。`by` 记下是谁停的。 */
  signal(
    sessionId: SessionId,
    id: string,
    signal: ProcessSignal,
    by: ProcessStopper = 'agent',
  ): void {
    const managed = this.#get(sessionId, id);
    if (managed.info.status !== 'running') {
      throw new AppToolError(`Process ${id} has already exited.`);
    }
    if (signal === 'SIGKILL' || signal === 'SIGTERM' || signal === 'SIGINT') {
      managed.info.killed = true;
      managed.info.stoppedBy ??= by;
      this.#changed(managed);
    }
    this.#kill(managed, signal);
  }

  /** 更新预览的地址与就绪（preview/service.ts）。不是预览进程时什么都不做。 */
  setPreview(
    sessionId: SessionId,
    id: string,
    patch: Partial<Pick<ProcessPreviewInfo, 'url' | 'ready'>>,
  ): void {
    const managed = this.#get(sessionId, id);
    const current = managed.info.preview;
    if (current === undefined) return;
    const next = { ...current, ...patch };
    if (next.url === current.url && next.ready === current.ready) return;
    managed.info.preview = next;
    this.#changed(managed);
  }

  /** 记下谁要停它（检查的取消由 runner 发信号，先记下是用户要停的）。已退出时什么都不做。 */
  markStopped(sessionId: SessionId, id: string, by: ProcessStopper): void {
    const managed = this.#get(sessionId, id);
    if (managed.info.status !== 'running') return;
    managed.info.killed = true;
    managed.info.stoppedBy ??= by;
    this.#changed(managed);
  }

  /**
   * 等进程退出，或给了 `pattern` 时等输出里有一行匹配（之前已经输出的不算）。超时不结束进程。等到的事件不再另发通知。
   */
  wait(
    sessionId: SessionId,
    id: string,
    pattern: RegExp | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<WaitResult> {
    const managed = this.#get(sessionId, id);
    if (managed.info.status === 'exited') return Promise.resolve({ reason: 'exit' });
    return new Promise<WaitResult>((resolve) => {
      const done = (result: WaitResult) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        managed.waiters.delete(waiter);
        resolve(result);
      };
      const waiter: Waiter = { pattern, resolve: done };
      const timer = setTimeout(() => done({ reason: 'timeout' }), timeoutMs);
      const onAbort = () => done({ reason: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
      managed.waiters.add(waiter);
    });
  }

  /** 结束这些会话的进程并忘掉（删除会话）。 */
  async removeSessions(sessionIds: readonly SessionId[]): Promise<void> {
    const ids = new Set<string>(sessionIds);
    const ending: Promise<void>[] = [];
    for (const [key, managed] of this.#processes) {
      if (!ids.has(managed.info.sessionId)) continue;
      managed.notifyOnExit = false;
      this.#stopNotify(managed);
      ending.push(this.#end(managed));
      this.#processes.delete(key);
      this.#removed(managed);
    }
    await Promise.all(ending);
  }

  /** Host 退出：结束全部进程，不再通知。 */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(
      [...this.#processes.values()].map((managed) => {
        managed.notifyOnExit = false;
        this.#stopNotify(managed);
        return this.#end(managed);
      }),
    );
  }

  #get(sessionId: SessionId, id: string): Managed {
    const managed = this.#processes.get(id);
    if (managed === undefined || managed.info.sessionId !== sessionId) {
      throw new AppToolError(
        `No background process ${id} in this session. wevir_process_list shows this session's processes.`,
      );
    }
    return managed;
  }

  #env(): NodeJS.ProcessEnv {
    return this.#options.env ?? process.env;
  }

  /** SIGTERM，宽限期后 SIGKILL；等它退出。 */
  async #end(managed: Managed): Promise<void> {
    if (managed.info.status !== 'running') return;
    managed.info.killed = true;
    managed.info.stoppedBy ??= 'host';
    this.#kill(managed, 'SIGTERM');
    const timer = setTimeout(() => this.#kill(managed, 'SIGKILL'), PROCESS_KILL_GRACE_MS);
    await managed.exited;
    clearTimeout(timer);
  }

  #kill(managed: Managed, signal: ProcessSignal): void {
    const pid = managed.child?.pid;
    if (pid === undefined || managed.info.status !== 'running') return;
    const platform = this.#options.platform ?? process.platform;
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
        managed.child?.kill(signal);
      } catch {}
    }
  }

  #data(managed: Managed, chunk: Buffer): void {
    const { info } = managed;
    info.bytes += chunk.length;
    this.#writeLog(managed, chunk);
    if (managed.changeTimer === undefined && this.#options.onChange !== undefined) {
      managed.changeTimer = setTimeout(() => {
        managed.changeTimer = undefined;
        if (this.#processes.get(info.id) === managed) this.#changed(managed);
      }, PROCESS_CHANGE_THROTTLE_MS);
      managed.changeTimer.unref?.();
    }
    const text = managed.partial + managed.decoder.write(chunk);
    const lines = text.split(/\r?\n/);
    managed.partial = lines.pop() ?? '';
    for (const raw of lines) this.#line(managed, raw);
    // 不带换行的提示（“Press Enter to continue”）：只拿来匹配，不进最后几行。
    if (managed.partial !== '') this.#match(managed, stripAnsi(managed.partial), false);
  }

  #line(managed: Managed, raw: string): void {
    // 进度条用 \r 覆写同一行：只留最后一段。
    const line = stripAnsi(raw.slice(raw.lastIndexOf('\r') + 1));
    managed.tail.push(line);
    if (managed.tail.length > PROCESS_TAIL_LINES * 5) managed.tail.splice(0, PROCESS_TAIL_LINES);
    this.#match(managed, line, true);
  }

  #match(managed: Managed, line: string, complete: boolean): void {
    let delivered = false;
    for (const waiter of [...managed.waiters]) {
      if (waiter.pattern !== undefined && test(waiter.pattern, line)) {
        waiter.resolve({ reason: 'match', line });
        delivered = true;
      }
    }
    const notify = managed.notify;
    if (notify === undefined) return;
    if (!complete) {
      // 不带换行的提示每来一块数据就再试一次：匹配过一次就不再算，补齐成一行时也不算。
      if (notify.partialMatched || !test(notify.pattern, line)) return;
      notify.partialMatched = true;
    } else if (notify.partialMatched) {
      notify.partialMatched = false;
      return;
    } else if (!test(notify.pattern, line)) {
      return;
    }
    // 正被 wait 等着的行由 wait 交给 agent，不另通知。
    if (!delivered) this.#queueMatch(managed, notify, line);
  }

  /** 攒下一行匹配的：第一行之后再等 `notifyBatchMs`，且离上一条通知至少 `notifyIntervalMs`。 */
  #queueMatch(managed: Managed, notify: Notify, line: string): void {
    notify.count += 1;
    if (notify.lines.length < PROCESS_NOTIFY_MAX_LINES) {
      notify.lines.push(
        line.length > PROCESS_NOTIFY_LINE_CHARS
          ? `${line.slice(0, PROCESS_NOTIFY_LINE_CHARS)}…`
          : line,
      );
    }
    if (notify.timer !== undefined) return;
    const delay = Math.max(
      this.#options.notifyBatchMs ?? PROCESS_NOTIFY_BATCH_MS,
      notify.lastAt + (this.#options.notifyIntervalMs ?? PROCESS_NOTIFY_INTERVAL_MS) - Date.now(),
    );
    notify.timer = setTimeout(() => this.#flushMatches(managed), delay);
    notify.timer.unref?.();
  }

  #flushMatches(managed: Managed): void {
    const notify = managed.notify;
    if (notify === undefined) return;
    notify.timer = undefined;
    const matches = takeMatches(notify);
    if (matches === undefined || this.#processes.get(managed.info.id) !== managed) return;
    notify.sent += 1;
    notify.lastAt = Date.now();
    const remaining = Math.max(0, notify.limit - notify.sent);
    if (remaining === 0) managed.notify = undefined;
    this.#options.onNotice({
      process: { ...managed.info },
      event: 'match',
      matches: { ...matches, remaining },
      tail: lastLines(managed, PROCESS_TAIL_LINES),
    });
  }

  /** 不再发匹配通知，攒着的也不发了；返回攒着的。 */
  #stopNotify(managed: Managed): Omit<ProcessMatches, 'remaining'> | undefined {
    const notify = managed.notify;
    if (notify === undefined) return undefined;
    clearTimeout(notify.timer);
    managed.notify = undefined;
    return takeMatches(notify);
  }

  #writeLog(managed: Managed, chunk: Buffer): void {
    // 换文件的间隙里到达的输出先攒着，新文件开好后接着写（以前这段直接丢了，日志比 `bytes` 少 1–4 MB）。
    if (managed.rotation !== undefined) {
      managed.rotation.push(chunk);
      return;
    }
    const log = managed.log;
    if (log === undefined) return;
    log.write(chunk);
    if (
      managed.info.bytes - managed.rotateFrom <
      (this.#options.logRotateBytes ?? PROCESS_LOG_ROTATE_BYTES)
    ) {
      return;
    }
    // 换文件：当前的改名为 .1（覆盖更早的），新开一个。
    managed.logStart = managed.info.bytes;
    managed.log = undefined;
    const held: Buffer[] = [];
    managed.rotation = held;
    const path = managed.info.logPath;
    managed.writing = managed.writing.then(async () => {
      await new Promise<void>((resolve) => log.end(resolve));
      await rename(path, `${path}.1`).catch(() => {});
      const next = createWriteStream(path, { mode: 0o600 });
      next.on('error', () => {
        managed.log = undefined;
      });
      for (const chunk of held) next.write(chunk);
      // 换文件的间隙里到的输出已经在新文件里：从这里起重新算，不然下一次写入（哪怕一行）就再换一次，结尾全进了 .1。
      managed.rotateFrom = managed.info.bytes;
      managed.rotation = undefined;
      managed.log = next;
    });
  }

  #finish(
    managed: Managed,
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: string,
  ): void {
    const { info } = managed;
    if (info.status === 'exited') return;
    const rest = managed.partial + managed.decoder.end();
    managed.partial = '';
    if (rest !== '') this.#line(managed, rest);
    info.status = 'exited';
    info.exitCode = code;
    info.signal = signal;
    info.endedAt = Date.now();
    if (error !== undefined) info.error = error;
    // 退出时可能正在换文件：等换完再关新的那个。
    void managed.writing.then(() => managed.log?.end());
    let delivered = false;
    for (const waiter of [...managed.waiters]) {
      waiter.resolve({ reason: 'exit' });
      delivered = true;
    }
    // 还攒着的匹配：退出要通知时并进退出通知，不通知退出时单发一条；agent 等到了退出、或进程是被停的，就不发了。
    const matches = this.#stopNotify(managed);
    if (!info.killed && !delivered && !this.#closed) {
      if (managed.notifyOnExit) {
        this.#options.onNotice({
          process: { ...info },
          event: 'exit',
          ...(matches !== undefined && { matches }),
          tail: lastLines(managed, PROCESS_TAIL_LINES),
        });
      } else if (matches !== undefined) {
        this.#options.onNotice({
          process: { ...info },
          event: 'match',
          matches,
          tail: lastLines(managed, PROCESS_TAIL_LINES),
        });
      }
    }
    clearTimeout(managed.changeTimer);
    managed.changeTimer = undefined;
    // 退出时的最后一次：等日志写完，客户端读得到全部输出。
    void managed.writing.then(() => this.#changed(managed));
  }

  #changed(managed: Managed): void {
    if (this.#processes.get(managed.info.id) !== managed) return;
    try {
      this.#options.onChange?.({ process: { ...managed.info } });
    } catch (error) {
      this.#options.onWarning?.('进程的变化没发出去', { error: String(error) });
    }
  }

  #removed(managed: Managed): void {
    clearTimeout(managed.changeTimer);
    managed.changeTimer = undefined;
    try {
      this.#options.onChange?.({ removed: { ...managed.info } });
    } catch (error) {
      this.#options.onWarning?.('进程的变化没发出去', { error: String(error) });
    }
  }

  /** 已退出的进程超过 `PROCESS_MAX_KEPT` 时丢最早退出的（日志文件留着）。 */
  #forgetOld(sessionId: SessionId): void {
    const mine = [...this.#processes.values()].filter(
      (managed) => managed.info.sessionId === sessionId,
    );
    const exited = mine
      .filter((managed) => managed.info.status === 'exited')
      .sort((a, b) => (a.info.endedAt ?? 0) - (b.info.endedAt ?? 0));
    while (mine.length >= (this.#options.maxKept ?? PROCESS_MAX_KEPT) && exited.length > 0) {
      const oldest = exited.shift() as Managed;
      this.#processes.delete(oldest.info.id);
      mine.splice(mine.indexOf(oldest), 1);
      this.#removed(oldest);
      if (this.#options.deleteLogsOnForget) {
        const path = oldest.info.logPath;
        void oldest.writing
          .then(() => Promise.all([rm(path, { force: true }), rm(`${path}.1`, { force: true })]))
          .catch(() => {});
      }
    }
  }
}

function takeMatches(notify: Notify): Omit<ProcessMatches, 'remaining'> | undefined {
  if (notify.count === 0) return undefined;
  const matches = { pattern: notify.pattern, lines: notify.lines, count: notify.count };
  notify.lines = [];
  notify.count = 0;
  return matches;
}

function lastLines(managed: Managed, count: number): string {
  const lines =
    managed.partial === '' ? managed.tail : [...managed.tail, stripAnsi(managed.partial)];
  return lines.slice(-count).join('\n');
}

/** 截在半个 UTF-8 字符上时退回到这个字符之前：返回完整字符的字节数。 */
export function completeUtf8(buffer: Buffer): number {
  let back = 0;
  while (
    back < 3 &&
    back < buffer.length &&
    ((buffer[buffer.length - 1 - back] ?? 0) & 0xc0) === 0x80
  ) {
    back += 1;
  }
  const lead = buffer[buffer.length - 1 - back];
  if (lead === undefined || lead < 0xc0) return buffer.length;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
  return back + 1 < need ? buffer.length - back - 1 : buffer.length;
}

function test(pattern: RegExp, line: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(line);
}

/** 等已经交给日志流的字节落到文件里；流已经 `end()` 了（进程退出后）就等它 finish，不能再往里写。 */
function flush(log: WriteStream | undefined): Promise<void> {
  if (log === undefined || log.writableLength === 0) return Promise.resolve();
  if (log.writableEnded) {
    return new Promise((resolve) => {
      log.once('finish', () => resolve());
      log.once('error', () => resolve());
      log.once('close', () => resolve());
    });
  }
  return new Promise((resolve) => log.write('', () => resolve()));
}

/**
 * 跑命令的 shell：POSIX 上用用户的登录 shell（`$SHELL -lc`，同 Codex 的 shell 工具，PATH 与 rc 里的变量都有；不用交互式，
 * 免得 rc 里自动开 tmux 之类的），没有时 `/bin/sh`；Windows 用 `ComSpec`（`cmd.exe /d /s /c`）。
 */
export function shellCommand(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { file: string; args: string[] } {
  if (platform === 'win32') {
    return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`] };
  }
  const shell = env.SHELL;
  return {
    file: shell?.startsWith('/') ? shell : '/bin/sh',
    args: ['-lc', command],
  };
}

/**
 * 交给命令的环境：Host 的环境去掉 Wevir 自己的（`WEVIR_*`，同 Codex 的 shell_environment_policy）与 Electron 的
 * （`ELECTRON_RUN_AS_NODE` 会让用户的 Electron 应用当成 Node 跑），加上 `PYTHONUNBUFFERED=1`（不是终端时 Python 会攒着输出）。
 */
export function childEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = platform === 'win32' ? key.toUpperCase() : key;
    if (upper.startsWith('WEVIR_') || upper.startsWith('ELECTRON_')) continue;
    result[key] = value;
  }
  result.PYTHONUNBUFFERED = '1';
  return result;
}

/** 日志文件的大小（不存在时 0）。 */
export async function logSize(path: string): Promise<number> {
  return (await stat(path).catch(() => undefined))?.size ?? 0;
}
