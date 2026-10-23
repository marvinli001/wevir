// 电脑操作的原生 helper（apps/desktop/native/computer-use，Swift）：主进程按需拉起，stdin / stdout 每行一个 JSON。由主进程拉起，
// 系统的屏幕录制与辅助功能权限就算在 Wevir.app 上。helper 退出了下一个请求时重新拉起；在途的请求以失败结束。

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Log } from '../host-lifecycle.js';

export type HelperResult = Record<string, unknown>;

/** helper 回的错误：`code` 是协议的 `COMPUTER_ERROR_CODES` 之一。 */
export class HelperError extends Error {
  override readonly name = 'HelperError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 主进程里用到的 helper 接口（测试换成假的）。 */
export interface HelperLike {
  request(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<HelperResult>;
  onEvent(listener: (event: HelperResult) => void): () => void;
}

/** 环境变量：开发时指定别处构建的 helper。 */
export const COMPUTER_HELPER_ENV = 'WEVIR_COMPUTER_USE_BIN';
const BINARY = 'wevir-computer-use';

/**
 * helper 的位置：环境变量 → 安装包的资源目录（`computer-use/`，stage-resources.ts 准备）→ 开发时 `swift build -c release`
 * 的产物（相对 out/main/）。都没有时 `undefined`。
 */
export function resolveHelperBinary(
  options: { packaged: boolean; resourcesPath: string; env?: NodeJS.ProcessEnv } = {
    packaged: false,
    resourcesPath: '',
  },
): string | undefined {
  const fromEnv = (options.env ?? process.env)[COMPUTER_HELPER_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return existsSync(fromEnv) ? fromEnv : undefined;
  const candidates = options.packaged
    ? [join(options.resourcesPath, 'computer-use', BINARY)]
    : [
        fileURLToPath(
          new URL(`../../native/computer-use/.build/release/${BINARY}`, import.meta.url),
        ),
      ];
  return candidates.find((path) => existsSync(path));
}

interface Pending {
  resolve: (result: HelperResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ComputerHelper implements HelperLike {
  readonly #binary: () => string | undefined;
  readonly #log: Log;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(event: HelperResult) => void>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = '';
  #nextId = 0;

  constructor(options: { binary: () => string | undefined; log: Log }) {
    this.#binary = options.binary;
    this.#log = options.log;
  }

  onEvent(listener: (event: HelperResult) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  request(op: string, params: Record<string, unknown> = {}, timeoutMs = 20_000) {
    const child = this.#start();
    const id = ++this.#nextId;
    return new Promise<HelperResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new HelperError(
            'computer_timeout',
            `The computer use helper did not answer ${op} within ${Math.round(timeoutMs / 1000)} s.`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
    });
  }

  /** 应用退出时：关掉 helper。 */
  close(): void {
    this.#child?.stdin.end();
    this.#child?.kill();
    this.#child = undefined;
  }

  #start(): ChildProcessWithoutNullStreams {
    if (this.#child !== undefined) return this.#child;
    const binary = this.#binary();
    if (binary === undefined) {
      throw new HelperError(
        'computer_unsupported',
        'The computer use helper is not part of this Wevir build.',
      );
    }
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    this.#buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#read(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) =>
      this.#log('warn', 'computer use helper stderr', { text: chunk.slice(0, 2000) }),
    );
    const gone = (reason: string) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      for (const [id, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.reject(
          new HelperError('computer_unknown_error', `The computer use helper ${reason}.`),
        );
        this.#pending.delete(id);
      }
    };
    child.on('error', (error) => {
      this.#log('error', 'computer use helper failed to start', { error: String(error) });
      gone(`failed to start: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      if (this.#child === child) {
        this.#log('warn', 'computer use helper exited', { code, signal });
      }
      gone('exited');
    });
    return child;
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf('\n');
      if (line.trim() === '') continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.#log('warn', 'computer use helper wrote a malformed line');
        continue;
      }
      if (typeof message.id === 'number') {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) continue;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok === true) {
          pending.resolve((message.result ?? {}) as HelperResult);
        } else {
          const error = (message.error ?? {}) as { code?: unknown; message?: unknown };
          pending.reject(
            new HelperError(
              typeof error.code === 'string' ? error.code : 'computer_unknown_error',
              typeof error.message === 'string' ? error.message : 'The helper failed.',
            ),
          );
        }
        continue;
      }
      for (const listener of this.#listeners) listener(message);
    }
  }
}
