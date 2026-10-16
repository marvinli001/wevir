// adapter-grok 测试共用：假 grok（fake-grok.mjs）、临时目录、按样本读录制的帧、收集事件。

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { GrokAdapter, type GrokAdapterOptions } from '../grok-adapter.js';

const FAKE_GROK_SCRIPT = fileURLToPath(new URL('./fake-grok.mjs', import.meta.url));
export const GROK_FIXTURES = fileURLToPath(new URL('./acp', import.meta.url));

// git 不一定保留可执行位（Windows 上检出、某些 CI），测试前补上。
chmodSync(FAKE_GROK_SCRIPT, 0o755);

/**
 * Windows 上起不了 .mjs（`spawn EFTYPE`）：在临时目录里放一个 `grok.cmd` 用当前的 Node 跑假 grok，与 npm 装的
 * `grok.cmd` 一样经 shell 启动（launch.ts 的 `needsShell`）。进程退出时删掉。
 */
function windowsLauncher(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wevir-grok-bin-'));
  const launcher = join(dir, 'grok.cmd');
  writeFileSync(launcher, `@"${process.execPath}" "${FAKE_GROK_SCRIPT}" %*\r\n`);
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return launcher;
}

/** 假 grok 的可执行文件（`WEVIR_GROK_BIN`）。 */
export const FAKE_GROK = process.platform === 'win32' ? windowsLauncher() : FAKE_GROK_SCRIPT;

/** 一组测试的临时目录，`remove` 在 afterAll 里调用。 */
export function tempRoot(name: string): { dir: (sub: string) => string; remove: () => void } {
  const root = mkdtempSync(join(tmpdir(), `wevir-grok-${name}-`));
  return {
    dir: (sub) => {
      const dir = join(root, sub);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    // 重试：Windows 上 .cmd 启动的假 grok 在 cmd.exe 被结束后才读到 EOF 退出，它的工作目录要稍后才放开。重试完还被占着
    // （runner 很忙时会有）就留给系统清理临时目录，不让清理失败把测试算成失败（同 adapter-codex 的 harness）。
    remove: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) {
        if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EBUSY') {
          throw error;
        }
      }
    },
  };
}

/** 驱动假 grok 的环境：`WEVIR_GROK_BIN` 指向它，其余 `FAKE_GROK_*` 由调用方给。 */
export function fakeGrokEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { XAI_API_KEY: _key, ...parent } = process.env;
  return { ...parent, WEVIR_GROK_BIN: FAKE_GROK, ...extra };
}

export interface Warning {
  message: string;
  fields?: Record<string, unknown>;
}

/** 接上假 grok 的适配器；进程的时限调短。 */
export function fakeGrokAdapter(
  home: string,
  env: NodeJS.ProcessEnv,
  warnings: Warning[] = [],
  options: Partial<GrokAdapterOptions> = {},
): GrokAdapter {
  return new GrokAdapter({
    home,
    env,
    logger: { warn: (message, fields) => warnings.push({ message, ...(fields && { fields }) }) },
    process: { initializeTimeoutMs: 10_000, restart: { baseDelayMs: 50 } },
    ...options,
  });
}

/** 录制的一个样本：每行一条。 */
export interface TranscriptEntry {
  type: string;
  frame?: {
    kind: 'request' | 'response' | 'notification';
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: unknown;
  };
}

export function readTranscript(name: string): TranscriptEntry[] {
  return readFileSync(join(GROK_FIXTURES, `${name}.ndjson`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TranscriptEntry);
}

/** 假 grok 收到的一条消息。 */
export interface LoggedMessage {
  id?: number;
  method?: string;
  // biome-ignore lint/suspicious/noExplicitAny: 测试按需读取任意形状的参数。
  params?: any;
  // biome-ignore lint/suspicious/noExplicitAny: 同上。
  result?: any;
}

/** 假 grok 收到的消息（`FAKE_GROK_LOG`）。 */
export function readLog(file: string): LoggedMessage[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** 订阅一个会话，边收边存。 */
export class EventCollector {
  readonly events: AgentEvent[] = [];
  #ended = false;
  readonly #waiters = new Set<() => void>();

  constructor(stream: AsyncIterable<AgentEvent>) {
    void (async () => {
      for await (const event of stream) {
        this.events.push(event);
        this.#wake();
      }
      this.#ended = true;
      this.#wake();
    })();
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** 等第 `from` 条之后满足条件的事件。 */
  async waitFor(
    match: (event: AgentEvent) => boolean,
    from = 0,
    timeoutMs = 10_000,
  ): Promise<{ event: AgentEvent; index: number }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.events.findIndex((event, i) => i >= from && match(event));
      if (index !== -1) return { event: this.events[index] as AgentEvent, index };
      if (this.#ended) throw new Error('订阅已结束');
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error(`等事件超时；已收到：${this.events.map((e) => e.type).join(', ')}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#waiters.add(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** 等第 `from` 条之后的回合终结事件，返回这个回合的事件。 */
  async turn(from = 0): Promise<AgentEvent[]> {
    const { index } = await this.waitFor(
      (event) =>
        event.type === 'turn.settled' ||
        event.type === 'turn.failed' ||
        event.type === 'engine.exited',
      from,
    );
    return this.events.slice(from, index + 1);
  }

  #wake(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }
}

export const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
