// 测试共用：临时目录、进程内的 echo Host、假的进程 IO（可选伪 TTY）。只被 *.test.ts 引用。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { createLogger, type RunningHost, startHost } from '@wevir/host';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { EchoAdapter, type EchoAdapterOptions } from '@wevir/runtime-adapter/echo';
import { afterEach, beforeEach } from 'vitest';
import { runCli } from './cli.js';
import type { CliIO } from './context.js';
import { displayWidth } from './format.js';

/** 每个用例一个新的临时目录，结束时删除。 */
export function useTempDir(): () => string {
  let dir: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wevir-cli-'));
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  return () => {
    if (!dir) throw new Error('useTempDir() 只能在用例里取值');
    return dir;
  };
}

/** 进程内的 Host（EchoAdapter），与 `wevir host start --adapter echo` 写同样的 `run/host.json`。 */
export function startEchoHost(
  home: string,
  echo: EchoAdapterOptions = {},
  Adapter: new (options: EchoAdapterOptions) => EchoAdapter = EchoAdapter,
): Promise<RunningHost> {
  return startHost({
    home,
    adapter: new Adapter({ stepDelayMs: 1, ...echo }),
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
  });
}

/**
 * echo 的 `approve` 换成一条命令审批：`approve: <命令>` 里冒号之后是命令（模拟 Codex 等引擎的命令审批，Host 据此提议审批规则）。
 * 与 Host 的 session-manager.test.ts 里的同名类相同。
 */
export class ShellEchoAdapter extends EchoAdapter {
  override subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    const source = super.subscribe(engineSessionId);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of source) {
          if (event.type === 'tool.started' && event.toolName === 'echo_write') {
            const content = String((event.input as { content?: string }).content ?? '');
            const command = content.slice(content.indexOf(':') + 1).trim();
            yield {
              ...event,
              toolName: 'exec_command',
              display: { kind: 'shell', summary: command, command },
              input: { command },
            };
          } else {
            yield event;
          }
        }
      },
    };
  }
}

export interface FakeRun {
  /** 写进 stdin。 */
  stdin: PassThrough;
  /** 去掉控制字符后的 stdout。 */
  out(): string;
  err(): string;
  /** 模拟 SIGINT。 */
  interrupt(): void;
  /** 等 stdout 出现 `text`（从 `from` 个字符之后找），返回它之后的位置。 */
  waitFor(text: string | RegExp, from?: number, timeoutMs?: number): Promise<number>;
  exit: Promise<number>;
}

export interface FakeRunOptions {
  home: string;
  cwd?: string;
  /** stdin / stdout 是否假装成终端。 */
  tty?: boolean;
  env?: NodeJS.ProcessEnv;
  /** 命令行的语言（WEVIR_LANG），默认中文：断言按中文写，不受跑测试的机器的语言影响。 */
  lang?: 'zh' | 'en';
  /** 局域网 mDNS 发现；默认什么都找不到（测试不往局域网发查询）。 */
  browseMdns?: CliIO['browseMdns'];
}

/** 在进程内运行 `wevir <argv>`。 */
export function runFake(argv: string[], options: FakeRunOptions): FakeRun {
  const stdin = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
  };
  const stdout = new PassThrough() as PassThrough & { isTTY?: boolean; columns?: number };
  const stderr = new PassThrough();
  if (options.tty) {
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    stdout.isTTY = true;
    stdout.columns = 200;
  }
  let out = '';
  let err = '';
  stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  const interrupts = new Set<() => void>();
  const io: CliIO = {
    argv,
    env: { ...options.env, WEVIR_LANG: options.lang ?? 'zh', WEVIR_HOME: options.home },
    cwd: options.cwd ?? options.home,
    stdin,
    stdout,
    stderr,
    onInterrupt: (listener) => {
      interrupts.add(listener);
      return () => interrupts.delete(listener);
    },
    browseMdns: options.browseMdns ?? (async () => []),
  };
  // 终端上输入框被擦掉重画；按终端的效果还原屏幕，而不是简单去掉控制字符。
  const text = () => (options.tty ? screen(out) : stripVTControlCharacters(out));
  return {
    stdin,
    out: text,
    err: () => stripVTControlCharacters(err),
    interrupt: () => {
      for (const listener of interrupts) listener();
    },
    waitFor: async (pattern, from = 0, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const rest = text().slice(from);
        const match = typeof pattern === 'string' ? rest.indexOf(pattern) : rest.search(pattern);
        if (match >= 0) return from + match + 1;
        if (Date.now() > deadline) {
          throw new Error(
            `stdout 里没有等到 ${String(pattern)}：\n${text()}\n--- stderr ---\n${err}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    exit: runCli(io),
  };
}

/**
 * 极简的终端模拟：只处理 readline 与 LineConsole 用到的 CR、LF、CSI n G（光标到第 n 列）、CSI n A / B
 * （上下移动）与 CSI J（清到屏幕末尾），足以还原屏幕上最终显示的文字。颜色等其他序列忽略。
 */
export function screen(raw: string): string {
  const lines: string[][] = [[]];
  let row = 0;
  let col = 0;
  const line = () => {
    while (lines.length <= row) lines.push([]);
    return lines[row] as string[];
  };
  const CSI = new RegExp(`^${String.fromCharCode(0x1b)}\\[(\\d*)([A-Za-z])`);
  for (let i = 0; i < raw.length; ) {
    const csi = CSI.exec(raw.slice(i, i + 12));
    if (csi) {
      i += csi[0].length;
      const n = csi[1] === '' ? undefined : Number(csi[1]);
      if (csi[2] === 'G') col = (n ?? 1) - 1;
      else if (csi[2] === 'A') row = Math.max(0, row - (n ?? 1));
      else if (csi[2] === 'B') row += n ?? 1;
      else if (csi[2] === 'J') {
        line().splice(col);
        lines.splice(row + 1);
      }
      continue;
    }
    const char = String.fromCodePoint(raw.codePointAt(i) as number);
    i += char.length;
    if (char === '\r') col = 0;
    else if (char === '\n') {
      row += 1;
      col = 0;
      line();
    } else if (char !== '\x1b') {
      // 东亚宽字符占两列：第二列用空串占位。
      const cells = displayWidth(char) === 2 ? [char, ''] : [char];
      const current = line();
      while (current.length < col) current.push(' ');
      current.splice(col, cells.length, ...cells);
      col += cells.length;
    }
  }
  return lines.map((cells) => cells.join('')).join('\n');
}

/** 跑完一条命令，返回退出码与输出。 */
export async function run(
  argv: string[],
  options: FakeRunOptions & { input?: string },
): Promise<{ code: number; out: string; err: string }> {
  const fake = runFake(argv, options);
  fake.stdin.end(options.input ?? '');
  const code = await fake.exit;
  return { code, out: fake.out(), err: fake.err() };
}
