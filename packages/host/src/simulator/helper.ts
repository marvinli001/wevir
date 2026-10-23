// iOS 模拟器的原生 helper（0.122.0，`wevir-ios-simulator`）的客户端：Host 拉起它，控制通道是 stdin / stdout 上一行一个 JSON，画面是
// fd 3 上的二进制帧（`u32 streamId | u8 kind | u64 ptsMicros | u32 length | bytes`，大端）。stderr 只是日志。
//
// 有沙箱描述文件（helper 同目录的 `wevir-ios-simulator.sb`）时经 `sandbox-exec` 起，参数 `OUTPUT_DIR` 是 Host 给的输出目录（截图与
// 录像只写那里）；找不到描述文件时不用沙箱，记一条告警。helper 退出时在途请求都以 `sim_helper_unavailable` 失败，由上层决定重启。

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { SimulatorError } from './errors.js';

/** helper 旁边的沙箱描述文件名。 */
export const SIMULATOR_SANDBOX_PROFILE = 'wevir-ios-simulator.sb';
/** fd 3 上一帧的头：`u32 streamId | u8 kind | u64 ptsMicros | u32 length`。 */
export const HELPER_FRAME_HEADER_BYTES = 17;
/** 一帧的上限（防止坏数据让 Host 攒内存）。 */
export const HELPER_FRAME_MAX_BYTES = 32 * 1024 * 1024;
/** 等 `ready` 事件的上限。 */
export const HELPER_READY_TIMEOUT_MS = 15_000;
/** helper 意外退出时警告里带的 stderr 行数。 */
export const HELPER_STDERR_TAIL_LINES = 20;
/** 一个请求的默认上限。 */
export const HELPER_REQUEST_TIMEOUT_MS = 20_000;

/** fd 3 上的一帧。`wire` 是去掉 `streamId` 之后的整帧（`/simulator/stream` 上原样发出）。 */
export interface HelperFrame {
  streamId: number;
  kind: number;
  wire: Buffer;
}

export interface HelperReady {
  version?: string;
  xcode?: string;
  hidTransport?: string;
}

/** 没有 id 的事件（`ready` 之外的）。 */
export type HelperEvent =
  | { event: 'stream_ended'; udid: string; reason?: string; streamId?: number }
  | { event: 'orientation'; udid: string; orientation: string }
  | { event: string; [key: string]: unknown };

export interface SimulatorHelperOptions {
  /** helper 可执行文件（`WEVIR_IOS_SIMULATOR_BIN`）。 */
  bin: string;
  /** 截图与录像的输出目录（沙箱放行写入）。 */
  outputDir: string;
  onFrame: (frame: HelperFrame) => void;
  onEvent: (event: HelperEvent) => void;
  /** helper 退出了（不论原因）。`expected` 是 `stop()` 引起的；`stderr` 是最后几行日志。 */
  onExit: (info: {
    code: number | null;
    signal: string | null;
    expected: boolean;
    stderr: string[];
  }) => void;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  /** helper 的 stderr，一行一次（它的日志，含每 5 秒的码率统计，不是警告）。 */
  onLog?: (line: string) => void;
  /** 测试用：不用沙箱也不找描述文件。 */
  sandbox?: boolean;
  /** 默认 `HELPER_READY_TIMEOUT_MS`。 */
  readyTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 一个 helper 进程。用 `start()` 等到 `ready`，之后 `request()`；退出后这个对象作废，要新建一个。 */
export class SimulatorHelper {
  readonly #options: SimulatorHelperOptions;
  readonly #pending = new Map<number, Pending>();
  #child: ChildProcess | undefined;
  #nextId = 1;
  #exited = false;
  readonly #stderrTail: string[] = [];
  #stopping = false;
  #ready: HelperReady | undefined;
  #onReady: ((ready: HelperReady) => void) | undefined;
  /** stdout 里还没凑成一行的部分。 */
  #line = '';
  /** fd 3 里还没凑成一帧的部分。 */
  #frames: Buffer = Buffer.alloc(0);

  constructor(options: SimulatorHelperOptions) {
    this.#options = options;
  }

  get ready(): HelperReady | undefined {
    return this.#ready;
  }

  get exited(): boolean {
    return this.#exited;
  }

  /** 拉起 helper，等它报 `ready`。起不来或超时时抛 `SimulatorError`（`sim_helper_unavailable`）。 */
  start(): Promise<HelperReady> {
    if (this.#child !== undefined) throw new Error('helper already started');
    const { file, args } = this.#command();
    const child = spawn(file, args, {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: this.#options.env ?? process.env,
    });
    this.#child = child;
    const stdout = child.stdout as Readable;
    const stderr = child.stderr as Readable;
    const frames = child.stdio[3] as Readable | null;
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => this.#stdout(chunk));
    stderr.setEncoding('utf8');
    stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue;
        this.#stderrTail.push(line);
        if (this.#stderrTail.length > HELPER_STDERR_TAIL_LINES) this.#stderrTail.shift();
        this.#options.onLog?.(line);
      }
    });
    frames?.on('data', (chunk: Buffer) => this.#fd3(chunk));
    frames?.on('error', () => {});
    (child.stdin as Writable).on('error', () => {});
    return new Promise<HelperReady>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#onReady = undefined;
        reject(new SimulatorError('sim_helper_unavailable', 'the simulator helper did not start'));
        this.stop();
      }, this.#options.readyTimeoutMs ?? HELPER_READY_TIMEOUT_MS);
      this.#onReady = (ready) => {
        clearTimeout(timer);
        resolve(ready);
      };
      child.once('error', (error) => {
        clearTimeout(timer);
        this.#onReady = undefined;
        reject(
          new SimulatorError(
            'sim_helper_unavailable',
            `the simulator helper could not start: ${error.message}`,
          ),
        );
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (this.#onReady !== undefined) {
          this.#onReady = undefined;
          reject(
            new SimulatorError(
              'sim_helper_unavailable',
              `the simulator helper exited before it was ready (${signal ?? `code ${code}`})`,
            ),
          );
        }
        this.#exit(code, signal);
      });
    });
  }

  /**
   * 发一个命令，等它的回答。`ok: false` 时抛 `SimulatorError`（helper 给的错误码）；helper 退出或超时时 `sim_helper_unavailable` /
   * `sim_timeout`。
   */
  request(
    cmd: string,
    params: Record<string, unknown> = {},
    timeoutMs = HELPER_REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const stdin = this.#child?.stdin;
    if (this.#exited || stdin == null || this.#ready === undefined) {
      return Promise.reject(
        new SimulatorError('sim_helper_unavailable', 'the simulator helper is not running'),
      );
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new SimulatorError('sim_timeout', `the simulator helper did not answer ${cmd}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      stdin.write(`${JSON.stringify({ ...params, id, cmd })}\n`);
    });
  }

  /** 结束 helper（SIGTERM，宽限后 SIGKILL）。 */
  stop(): void {
    const child = this.#child;
    if (child === undefined || this.#exited) return;
    this.#stopping = true;
    child.stdin?.end();
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (!this.#exited) child.kill('SIGKILL');
    }, 2000);
    timer.unref();
  }

  #command(): { file: string; args: string[] } {
    const { bin, outputDir } = this.#options;
    if (this.#options.sandbox === false) return { file: bin, args: [] };
    const profile = join(dirname(bin), SIMULATOR_SANDBOX_PROFILE);
    if (!existsSync(profile)) {
      this.#options.onWarning?.('ios simulator sandbox profile not found; running unsandboxed', {
        profile,
      });
      return { file: bin, args: [] };
    }
    return {
      file: '/usr/bin/sandbox-exec',
      args: ['-f', profile, '-D', `OUTPUT_DIR=${outputDir}`, '-D', `HELPER=${bin}`, bin],
    };
  }

  #stdout(chunk: string): void {
    this.#line += chunk;
    let index = this.#line.indexOf('\n');
    while (index >= 0) {
      const line = this.#line.slice(0, index).trim();
      this.#line = this.#line.slice(index + 1);
      if (line !== '') this.#message(line);
      index = this.#line.indexOf('\n');
    }
  }

  #message(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch {
      this.#options.onWarning?.('ios simulator helper wrote a line that is not JSON', {
        line: line.slice(0, 200),
      });
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok === true) {
        const result = message.result;
        pending.resolve(
          result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {},
        );
      } else {
        const error = (message.error ?? {}) as { code?: unknown; message?: unknown };
        pending.reject(
          new SimulatorError(
            typeof error.code === 'string' && error.code !== '' ? error.code : 'sim_unknown_error',
            typeof error.message === 'string' ? error.message : 'the simulator helper failed',
          ),
        );
      }
      return;
    }
    if (message.event === 'ready') {
      this.#ready = {
        ...(typeof message.version === 'string' && { version: message.version }),
        ...(typeof message.xcode === 'string' && { xcode: message.xcode }),
        ...(typeof message.hidTransport === 'string' && { hidTransport: message.hidTransport }),
      };
      this.#onReady?.(this.#ready);
      this.#onReady = undefined;
      return;
    }
    if (typeof message.event === 'string') this.#options.onEvent(message as HelperEvent);
  }

  #fd3(chunk: Buffer): void {
    this.#frames = this.#frames.length === 0 ? chunk : Buffer.concat([this.#frames, chunk]);
    let offset = 0;
    const buffer = this.#frames;
    while (buffer.length - offset >= HELPER_FRAME_HEADER_BYTES) {
      const length = buffer.readUInt32BE(offset + 13);
      if (length > HELPER_FRAME_MAX_BYTES) {
        this.#options.onWarning?.('ios simulator helper sent an oversized frame; stopping it', {
          length,
        });
        this.#frames = Buffer.alloc(0);
        this.stop();
        return;
      }
      const end = offset + HELPER_FRAME_HEADER_BYTES + length;
      if (buffer.length < end) break;
      this.#options.onFrame({
        streamId: buffer.readUInt32BE(offset),
        kind: buffer.readUInt8(offset + 4),
        wire: buffer.subarray(offset + 4, end),
      });
      offset = end;
    }
    this.#frames = offset === buffer.length ? Buffer.alloc(0) : buffer.subarray(offset);
  }

  #exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exited) return;
    this.#exited = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SimulatorError('sim_helper_unavailable', 'the simulator helper exited'));
    }
    this.#pending.clear();
    this.#options.onExit({ code, signal, expected: this.#stopping, stderr: [...this.#stderrTail] });
  }
}
