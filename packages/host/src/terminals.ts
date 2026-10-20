// 用户的交互终端（0.68.0，`terminal.*`，ADR-0010）：客户端在 Host 上开的 PTY（node-pty），跑用户的登录 shell。
//
// - 只由客户端开、只由客户端输入：不进应用级工具，Agent 看不到；与后台进程（processes.ts）不共享标识。
// - 输出原样转发（含控制序列）。每个终端在内存里留两份：最近的输出（按位置编号的环形缓冲，断线重连时补上中间那段），与一个不渲染的
//   终端模拟器（@xterm/headless）跟着解析，补不上时把它的屏幕、滚动缓冲与模式序列化成快照（@xterm/addon-serialize）。
// - 输入输出只在内存里：不写事件库、数据库、大输出目录，日志里不带它们。终端关闭或 Host 退出就没了。
// - 流控：一小段时间（16 ms）的输出合成一条通知；attach 的连接里有一条发送积压过多、或模拟器解析跟不上时暂停读 PTY
//   （程序随之在写终端时阻塞），消化后恢复。不丢输出。
// - 结束：POSIX 上先 SIGHUP 给 shell（shell 转给它的作业），宽限后 SIGKILL 这个终端会话里还在的进程；Windows 上 node-pty 结束
//   控制台里的进程树。Host 退出、会话删除、项目移除时一并结束。

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { constants, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import type {
  MethodParams,
  MethodResult,
  NotificationParams,
  SessionId,
  Terminal,
  TerminalId,
  WorkspaceId,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { HostError } from './errors.js';
import { newId } from './ids.js';

/** 每个项目同时在跑的终端最多几个。 */
export const TERMINALS_PER_WORKSPACE = 10;
/** 留多少最近的输出（UTF-16 码元）供重连补上。 */
export const TERMINAL_RING_CHARS = 1_000_000;
/** 快照里带多少行滚动缓冲。 */
export const TERMINAL_SCROLLBACK = 5000;
/** 合并输出的间隔。 */
const FLUSH_MS = 16;
/** 一条 `terminal.output` 最多多少字符（大的分几条）。 */
const OUTPUT_FRAME_CHARS = 256 * 1024;
/** 连接的发送积压超过它时暂停读 PTY，降到 `RESUME_BYTES` 以下再恢复。 */
const PAUSE_BYTES = 1024 * 1024;
const RESUME_BYTES = 256 * 1024;
/** 模拟器还没解析的输出超过它时也暂停。 */
const PARSE_BACKLOG_CHARS = 4 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 25;
/** 前台进程名在有输入输出之后多久查一次。 */
const FOREGROUND_POLL_MS = 250;
/** `terminal.close` 的 SIGHUP 之后等多久再 SIGKILL。 */
const CLOSE_GRACE_MS = 2000;

// ── 原生模块与模拟器（只写用到的部分；node-pty 是可选依赖） ──────────────────

interface Disposable {
  dispose(): void;
}

interface Pty {
  readonly pid: number;
  readonly process: string;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
      encoding: 'utf8';
    },
  ): Pty;
}

interface HeadlessTerminal {
  readonly buffer: { readonly active: { readonly type: 'normal' | 'alternate' } };
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  onTitleChange(listener: (title: string) => void): Disposable;
  loadAddon(addon: unknown): void;
  dispose(): void;
}

interface HeadlessModule {
  Terminal: new (options: {
    cols: number;
    rows: number;
    scrollback: number;
    allowProposedApi: boolean;
  }) => HeadlessTerminal;
}

interface SerializeAddon {
  serialize(options?: { scrollback?: number }): string;
}

interface SerializeModule {
  SerializeAddon: new () => SerializeAddon;
}

export interface TerminalModules {
  pty: PtyModule;
  headless: HeadlessModule;
  serialize: SerializeModule;
}

/**
 * 加载终端要的模块。node-pty 没装上（Linux 没有预编译、平台不支持）或加载失败时返回 undefined，Host 不声明 `user_terminal`。
 * npm 包里 macOS 的 `spawn-helper` 没有执行位（node-pty 1.1.0），没跑安装脚本时在这里补上。
 */
export function loadTerminalModules(
  onWarning: (message: string, fields?: Record<string, unknown>) => void,
): TerminalModules | undefined {
  const require = createRequire(import.meta.url);
  try {
    const pty = require('node-pty') as PtyModule;
    if (process.platform === 'darwin') {
      const root = dirname(require.resolve('node-pty/package.json'));
      for (const dir of ['build/Release', `prebuilds/darwin-${process.arch}`]) {
        const helper = join(root, dir, 'spawn-helper');
        if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
      }
    }
    return {
      pty,
      headless: require('@xterm/headless') as HeadlessModule,
      serialize: require('@xterm/addon-serialize') as SerializeModule,
    };
  } catch (error) {
    onWarning('the user terminal is unavailable: node-pty could not be loaded', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

// ── 服务 ────────────────────────────────────────────────────────────────

/** attach 的连接：发一条 `terminal.output`（连接已关闭时返回 false），与它此刻的发送积压。 */
export interface TerminalSink {
  send(params: NotificationParams<'terminal.output'>): boolean;
  backlog(): number;
}

export type TerminalChange = NotificationParams<'terminal.changed'>;

interface Chunk {
  offset: number;
  text: string;
}

interface Attachment {
  sink: TerminalSink;
  /** 这条连接收到哪儿了。 */
  next: number;
}

interface Managed {
  info: Omit<Terminal, 'clients'>;
  pty: Pty | undefined;
  emulator: HeadlessTerminal;
  serializer: SerializeAddon;
  /** 最近的输出，按位置排好；`start` 之前的已经丢掉。 */
  chunks: Chunk[];
  start: number;
  next: number;
  /** 模拟器已收下（不一定解析完）的位置与还没解析完的字符数。 */
  fed: number;
  parsing: number;
  attachments: Set<Attachment>;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  paused: boolean;
  pauseTimer: ReturnType<typeof setInterval> | undefined;
  foregroundTimer: ReturnType<typeof setTimeout> | undefined;
  /** `terminal.close` 之后：退出时忘掉。 */
  closing: boolean;
  killTimer: ReturnType<typeof setTimeout> | undefined;
  exited: Promise<void>;
  markExited: () => void;
  disposables: Disposable[];
}

export interface TerminalServiceOptions {
  storage: Storage;
  modules: TerminalModules;
  /** 默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 `process.platform`。 */
  platform?: NodeJS.Platform;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

export class TerminalService {
  readonly #storage: Storage;
  readonly #modules: TerminalModules;
  readonly #options: TerminalServiceOptions;
  readonly #platform: NodeJS.Platform;
  readonly #terminals = new Map<TerminalId, Managed>();
  readonly #listeners = new Set<(change: TerminalChange) => void>();
  #closed = false;

  constructor(options: TerminalServiceOptions) {
    this.#storage = options.storage;
    this.#modules = options.modules;
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
  }

  /** 调过 `terminal.*` 的连接收 `terminal.changed`。 */
  watch(listener: (change: TerminalChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(filter: MethodParams<'terminal.list'>): Terminal[] {
    return [...this.#terminals.values()]
      .filter(
        (managed) =>
          this.#visible(managed) &&
          (filter.workspaceId === undefined || managed.info.workspaceId === filter.workspaceId) &&
          (filter.sessionId === undefined || managed.info.sessionId === filter.sessionId),
      )
      .map((managed) => this.#public(managed))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(params: MethodParams<'terminal.create'>): Promise<Terminal> {
    if (this.#closed) throw new HostError('HOST_SHUTTING_DOWN', 'host is shutting down');
    const { workspaceId, sessionId, cols, rows } = params;
    const workspace = this.#storage.workspaces.get(workspaceId);
    if (!workspace || workspace.removedAt !== undefined) {
      throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
    }
    let sessionDir: string | undefined;
    if (sessionId !== undefined) {
      const record = this.#storage.sessions.get(sessionId);
      if (!record || record.workspaceId !== workspaceId) {
        throw new HostError('SESSION_NOT_FOUND', `session ${sessionId} not found`);
      }
      sessionDir = record.cwd;
    }
    const running = [...this.#terminals.values()].filter(
      (managed) => managed.info.workspaceId === workspaceId && managed.info.status === 'running',
    );
    if (running.length >= TERMINALS_PER_WORKSPACE) {
      throw invalid(['workspaceId'], `at most ${TERMINALS_PER_WORKSPACE} terminals per project`);
    }
    const cwd = params.cwd ?? sessionDir ?? workspace.rootPath;
    if (!isAbsolute(cwd) || !(await isDirectory(cwd))) {
      throw invalid(['cwd'], 'not an existing directory');
    }

    const env = terminalEnv(this.#options.env ?? process.env, this.#platform);
    const { file, args } = terminalShell(env, this.#platform);
    const emulator = new this.#modules.headless.Terminal({
      cols,
      rows,
      scrollback: TERMINAL_SCROLLBACK,
      allowProposedApi: true,
    });
    const serializer = new this.#modules.serialize.SerializeAddon();
    emulator.loadAddon(serializer);
    let markExited = () => {};
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const managed: Managed = {
      info: {
        id: newId('trm'),
        workspaceId,
        ...(sessionId !== undefined && { sessionId }),
        cwd,
        shell: file,
        title: '',
        cols,
        rows,
        status: 'running',
        exitCode: null,
        signal: null,
        createdAt: new Date().toISOString(),
      },
      pty: undefined,
      emulator,
      serializer,
      chunks: [],
      start: 0,
      next: 0,
      fed: 0,
      parsing: 0,
      attachments: new Set(),
      flushTimer: undefined,
      paused: false,
      pauseTimer: undefined,
      foregroundTimer: undefined,
      closing: false,
      killTimer: undefined,
      exited,
      markExited,
      disposables: [],
    };
    this.#terminals.set(managed.info.id, managed);
    managed.disposables.push(
      emulator.onTitleChange((title) => {
        const next = title.slice(0, 200);
        if (next === managed.info.title) return;
        managed.info.title = next;
        this.#changed(managed);
      }),
    );

    try {
      const pty = this.#modules.pty.spawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
        encoding: 'utf8',
      });
      managed.pty = pty;
      managed.info.pid = pty.pid;
      managed.disposables.push(
        pty.onData((data) => this.#output(managed, data)),
        pty.onExit(({ exitCode, signal }) => this.#exit(managed, exitCode, signal)),
      );
      this.#pollForeground(managed);
    } catch (error) {
      managed.info.status = 'exited';
      managed.info.endedAt = new Date().toISOString();
      managed.info.error = error instanceof Error ? error.message : String(error);
      managed.markExited();
    }
    this.#changed(managed);
    return this.#public(managed);
  }

  /**
   * `terminal.attach`：算出要补的那段（或快照），返回结果与 `start`。连接发出响应之后再调 `start` 登记，之后的输出从 `next` 起
   * 发给它；这样响应一定先于这条连接收到的第一条 `terminal.output`。
   */
  async attach(
    params: MethodParams<'terminal.attach'>,
    sink: TerminalSink,
  ): Promise<{ result: MethodResult<'terminal.attach'>; start: () => () => void }> {
    const managed = this.#find(params.terminalId);
    const { since } = params;
    let reset: boolean;
    let data: string;
    let next: number;
    if (since !== undefined && since >= managed.start && since <= managed.next) {
      reset = false;
      next = managed.next;
      data = this.#slice(managed, since, next);
    } else {
      reset = true;
      ({ data, next } = await this.#snapshot(managed));
    }
    const result = {
      terminal: { ...this.#public(managed), clients: managed.attachments.size + 1 },
      reset,
      data,
      next,
    };
    return {
      result,
      start: () => {
        if (!this.#terminals.has(managed.info.id)) return () => {};
        const attachment: Attachment = { sink, next };
        managed.attachments.add(attachment);
        this.#changed(managed);
        if (managed.next > next) this.#scheduleFlush(managed);
        return () => {
          if (!managed.attachments.delete(attachment)) return;
          if (this.#terminals.has(managed.info.id)) this.#changed(managed);
          this.#checkBackpressure(managed);
        };
      },
    };
  }

  input({ terminalId, data }: MethodParams<'terminal.input'>): void {
    const managed = this.#find(terminalId);
    if (managed.info.status !== 'running' || managed.pty === undefined) return;
    managed.pty.write(data);
    this.#pollForeground(managed);
  }

  resize({ terminalId, cols, rows }: MethodParams<'terminal.resize'>): void {
    const managed = this.#find(terminalId);
    if (managed.info.status !== 'running' || managed.pty === undefined) return;
    if (cols === managed.info.cols && rows === managed.info.rows) return;
    managed.pty.resize(cols, rows);
    managed.emulator.resize(cols, rows);
    managed.info.cols = cols;
    managed.info.rows = rows;
    this.#changed(managed);
  }

  /** `terminal.close`：已退出的马上忘掉；在跑的结束它，退出时忘掉。不等它退出。 */
  close({ terminalId }: MethodParams<'terminal.close'>): void {
    this.#end(this.#find(terminalId));
  }

  /** 会话删除时结束它们开的终端。 */
  removeSessions(sessionIds: readonly SessionId[]): void {
    const ids = new Set<string>(sessionIds);
    for (const managed of [...this.#terminals.values()]) {
      if (managed.info.sessionId !== undefined && ids.has(managed.info.sessionId)) {
        this.#end(managed);
      }
    }
  }

  /** 项目移除时结束它的终端。 */
  removeWorkspace(workspaceId: WorkspaceId): void {
    for (const managed of [...this.#terminals.values()]) {
      if (managed.info.workspaceId === workspaceId) this.#end(managed);
    }
  }

  /** Host 退出：全部结束，等它们退出（SIGHUP，宽限后 SIGKILL）。 */
  async dispose(): Promise<void> {
    this.#closed = true;
    const all = [...this.#terminals.values()];
    for (const managed of all) this.#end(managed, 500);
    await Promise.all(all.map((managed) => managed.exited));
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  #find(terminalId: TerminalId): Managed {
    const managed = this.#terminals.get(terminalId);
    if (managed === undefined || !this.#visible(managed)) {
      throw invalid(['terminalId'], 'not found');
    }
    return managed;
  }

  #visible(managed: Managed): boolean {
    const workspace = this.#storage.workspaces.get(managed.info.workspaceId);
    return workspace !== undefined && workspace.removedAt === undefined;
  }

  #public(managed: Managed): Terminal {
    return { ...managed.info, clients: managed.attachments.size };
  }

  #changed(managed: Managed): void {
    if (!this.#visible(managed)) return;
    this.#emit({ terminal: this.#public(managed) });
  }

  #emit(change: TerminalChange): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch {}
    }
  }

  #output(managed: Managed, data: string): void {
    if (data === '') return;
    managed.chunks.push({ offset: managed.next, text: data });
    managed.next += data.length;
    let kept = managed.next - (managed.chunks[0]?.offset ?? managed.next);
    while (kept > TERMINAL_RING_CHARS && managed.chunks.length > 1) {
      managed.chunks.shift();
      kept = managed.next - (managed.chunks[0]?.offset ?? managed.next);
    }
    managed.start = managed.chunks[0]?.offset ?? managed.next;
    managed.fed += data.length;
    managed.parsing += data.length;
    managed.emulator.write(data, () => {
      managed.parsing -= data.length;
    });
    this.#scheduleFlush(managed);
    this.#pollForeground(managed);
  }

  /** `from` 到 `to` 之间的输出（都在 `start` 之后）。 */
  #slice(managed: Managed, from: number, to: number): string {
    if (from >= to) return '';
    let text = '';
    for (const chunk of managed.chunks) {
      const end = chunk.offset + chunk.text.length;
      if (end <= from) continue;
      if (chunk.offset >= to) break;
      text += chunk.text.slice(
        Math.max(0, from - chunk.offset),
        Math.min(chunk.text.length, to - chunk.offset),
      );
    }
    return text;
  }

  /**
   * 快照：等模拟器解析完到此刻收下的输出（`write('', callback)` 的回调在它前面的输出都解析完之后同步调用），在回调里序列化，
   * 再接上这期间新到、模拟器还没解析的那段，合起来对应位置 `next`。
   */
  async #snapshot(managed: Managed): Promise<{ data: string; next: number }> {
    for (let attempt = 0; ; attempt++) {
      const marker = managed.fed;
      const snapshot = await new Promise<string>((resolve) => {
        managed.emulator.write('', () =>
          resolve(managed.serializer.serialize({ scrollback: TERMINAL_SCROLLBACK })),
        );
      });
      // 等的时候新到的输出多到挤掉了 marker 之后的那段：再来一次（只在极大的输出时发生）。
      if (marker >= managed.start || attempt >= 3) {
        const next = managed.next;
        return {
          data: snapshot + this.#slice(managed, Math.max(marker, managed.start), next),
          next,
        };
      }
    }
  }

  #scheduleFlush(managed: Managed): void {
    if (managed.flushTimer !== undefined) return;
    managed.flushTimer = setTimeout(() => {
      managed.flushTimer = undefined;
      this.#flush(managed);
    }, FLUSH_MS);
  }

  #flush(managed: Managed): void {
    for (const attachment of [...managed.attachments]) {
      // 落后到环形缓冲之外（暂停没拦住时）：从还留着的地方接着发，客户端看到位置对不上会重新 attach。
      let from = Math.max(attachment.next, managed.start);
      while (from < managed.next) {
        const to = Math.min(managed.next, from + OUTPUT_FRAME_CHARS);
        const sent = attachment.sink.send({
          terminalId: managed.info.id,
          offset: from,
          data: this.#slice(managed, from, to),
        });
        if (!sent) {
          managed.attachments.delete(attachment);
          break;
        }
        from = to;
        attachment.next = to;
      }
    }
    this.#checkBackpressure(managed);
  }

  #congested(managed: Managed, limit: number, parseLimit: number): boolean {
    if (managed.parsing > parseLimit) return true;
    for (const attachment of managed.attachments) {
      if (attachment.sink.backlog() > limit) return true;
    }
    return false;
  }

  #checkBackpressure(managed: Managed): void {
    if (managed.pty === undefined || managed.info.status !== 'running') return;
    if (!managed.paused) {
      if (!this.#congested(managed, PAUSE_BYTES, PARSE_BACKLOG_CHARS)) return;
      managed.paused = true;
      managed.pty.pause();
      managed.pauseTimer = setInterval(
        () => this.#checkBackpressure(managed),
        BACKPRESSURE_POLL_MS,
      );
      return;
    }
    if (this.#congested(managed, RESUME_BYTES, PARSE_BACKLOG_CHARS / 4)) return;
    managed.paused = false;
    clearInterval(managed.pauseTimer);
    managed.pauseTimer = undefined;
    managed.pty.resume();
  }

  /** 有输入输出之后过一会儿查一次前台进程名（node-pty 的 `process`：POSIX 上是终端前台进程组的进程）。 */
  #pollForeground(managed: Managed): void {
    if (managed.foregroundTimer !== undefined || managed.pty === undefined) return;
    managed.foregroundTimer = setTimeout(() => {
      managed.foregroundTimer = undefined;
      if (managed.info.status !== 'running' || managed.pty === undefined) return;
      let name: string | undefined;
      try {
        name = managed.pty.process.slice(0, 200) || undefined;
      } catch {
        name = undefined;
      }
      if (name === managed.info.foreground) return;
      if (name === undefined) delete managed.info.foreground;
      else managed.info.foreground = name;
      this.#changed(managed);
    }, FOREGROUND_POLL_MS);
  }

  #exit(managed: Managed, exitCode: number, signal: number | undefined): void {
    if (managed.info.status === 'exited') return;
    clearTimeout(managed.foregroundTimer);
    managed.foregroundTimer = undefined;
    clearTimeout(managed.killTimer);
    clearInterval(managed.pauseTimer);
    managed.pauseTimer = undefined;
    managed.paused = false;
    // 退出前最后的输出先发出去。
    clearTimeout(managed.flushTimer);
    managed.flushTimer = undefined;
    this.#flush(managed);
    managed.info.status = 'exited';
    managed.info.endedAt = new Date().toISOString();
    const name = signal ? signalName(signal) : undefined;
    managed.info.signal = name ?? null;
    managed.info.exitCode = name === undefined ? exitCode : null;
    delete managed.info.foreground;
    managed.markExited();
    if (managed.closing) this.#forget(managed);
    else this.#changed(managed);
  }

  /** 结束一个终端，退出时忘掉。 */
  #end(managed: Managed, graceMs = CLOSE_GRACE_MS): void {
    managed.closing = true;
    if (managed.info.status !== 'running' || managed.pty === undefined) {
      this.#forget(managed);
      return;
    }
    if (managed.killTimer !== undefined) return;
    const pty = managed.pty;
    if (this.#platform === 'win32') {
      try {
        pty.kill();
      } catch {}
    } else {
      // 暂停着时 shell 可能卡在写终端上，收不到 SIGHUP 之后的输出也要读走。
      if (managed.paused) pty.resume();
      try {
        pty.kill('SIGHUP');
      } catch {}
    }
    managed.killTimer = setTimeout(() => {
      if (managed.info.status !== 'running') return;
      killSession(pty.pid, this.#platform);
      try {
        pty.kill(this.#platform === 'win32' ? undefined : 'SIGKILL');
      } catch {}
    }, graceMs);
    managed.killTimer.unref?.();
  }

  #forget(managed: Managed): void {
    if (!this.#terminals.delete(managed.info.id)) return;
    clearTimeout(managed.flushTimer);
    clearTimeout(managed.foregroundTimer);
    clearTimeout(managed.killTimer);
    clearInterval(managed.pauseTimer);
    for (const disposable of managed.disposables) {
      try {
        disposable.dispose();
      } catch {}
    }
    managed.attachments.clear();
    managed.emulator.dispose();
    managed.chunks = [];
    this.#emit({ removed: { id: managed.info.id } });
  }
}

/** shell 的进程组以外的作业：SIGKILL 这个终端会话（shell 是会话首进程，会话 ID 就是它的 PID）里的所有进程。 */
function killSession(sid: number, platform: NodeJS.Platform): void {
  if (platform === 'win32') return;
  execFile('pgrep', ['-s', String(sid)], (error, stdout) => {
    if (error) return;
    for (const line of stdout.split('\n')) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  });
}

/**
 * 终端的环境：Host 的环境去掉 Wevir 自己的（`WEVIR_*`）与 Electron 的（`ELECTRON_*`），`TERM=xterm-256color`、
 * `COLORTERM=truecolor`。macOS 上从 Finder 启动时常常没有语言环境，那时补 `LC_CTYPE=UTF-8`，中文才不会显示成 `?`。
 */
export function terminalEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (value === undefined || upper.startsWith('WEVIR_') || upper.startsWith('ELECTRON_')) {
      continue;
    }
    result[key] = value;
  }
  result.TERM = 'xterm-256color';
  result.COLORTERM = 'truecolor';
  if (platform === 'darwin' && !result.LANG && !result.LC_ALL && !result.LC_CTYPE) {
    result.LC_CTYPE = 'UTF-8';
  }
  return result;
}

/**
 * 跑哪个 shell：POSIX 上是用户的登录 shell（`$SHELL -l`，没有时取账户的 shell，再没有用 `/bin/sh`）；Windows 上 PATH 里有 `pwsh`
 * 用它，否则 Windows PowerShell，再否则 `ComSpec`（cmd）。
 */
export function terminalShell(
  env: Record<string, string>,
  platform: NodeJS.Platform,
): { file: string; args: string[] } {
  if (platform === 'win32') {
    const pwsh = findOnPath('pwsh.exe', env);
    if (pwsh !== undefined) return { file: pwsh, args: ['-NoLogo'] };
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
    const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(powershell)) return { file: powershell, args: ['-NoLogo'] };
    return { file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: [] };
  }
  let shell = env.SHELL;
  if (shell === undefined || !shell.startsWith('/')) {
    try {
      shell = userInfo().shell ?? undefined;
    } catch {
      shell = undefined;
    }
  }
  return { file: shell?.startsWith('/') ? shell : '/bin/sh', args: ['-l'] };
}

function findOnPath(name: string, env: Record<string, string>): string | undefined {
  const path = env.PATH ?? env.Path ?? '';
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function signalName(signal: number): string | undefined {
  for (const [name, value] of Object.entries(constants.signals)) {
    if (value === signal) return name;
  }
  return undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function invalid(path: string[], message: string): HostError<'INVALID_PARAMS'> {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}
