// 真实 codex-app-server 的测试共用部分：二进制在不在、临时目录、安静的日志、建适配器。

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentEvent, isTurnTerminal } from '@wevir/runtime-adapter';
import { CodexAdapter, type CodexAdapterOptions } from '../codex-adapter.js';
import { CODEX_BIN_ENV, FETCH_CODEX_COMMAND, resolveCodexBinary } from '../paths.js';

/** 本机的 codex-app-server；没有时打印下载命令并返回 undefined（调用方据此跳过）。 */
export function codexBinaryOrSkip(suite: string): string | undefined {
  try {
    return resolveCodexBinary();
  } catch (error) {
    console.warn(
      `[${suite}] 跳过：${error instanceof Error ? error.message : String(error)}\n` +
        `  在仓库根目录运行 ${FETCH_CODEX_COMMAND}，或设 ${CODEX_BIN_ENV}。`,
    );
    return undefined;
  }
}

/** 把重试关掉：mock 不会 429，失败的用例不用等 Codex 重试（codex-notes §3.1）。 */
export const NO_RETRIES = Object.freeze({ request_max_retries: 0, stream_max_retries: 0 });

/** 一个测试用的临时根目录：数据目录（CODEX_HOME 在里面）与工作区，结束时整体删除。 */
export class TempDirs {
  readonly #roots: string[] = [];

  make(label: string): { root: string; home: string; workspace: string } {
    // realpath：macOS 的临时目录在 /var 下，Codex 报的路径是 /private/var/…
    const root = realpathSync(mkdtempSync(join(tmpdir(), `wevir-codex-${label}-`)));
    this.#roots.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    return { root, home, workspace };
  }

  cleanup(): void {
    for (const root of this.#roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
}

/** 收集告警的日志，不往终端打。 */
export function collectingLogger(): Required<NonNullable<CodexAdapterOptions['logger']>> & {
  warnings: string[];
  infos: string[];
  secrets: string[];
} {
  const warnings: string[] = [];
  const infos: string[] = [];
  const secrets: string[] = [];
  return {
    warnings,
    infos,
    secrets,
    warn: (message, fields) =>
      warnings.push(`${message}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}`),
    info: (message, fields) =>
      infos.push(`${message}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}`),
    addSecret: (value) => secrets.push(value),
  };
}

export function newAdapter(options: CodexAdapterOptions): CodexAdapter {
  return new CodexAdapter({ providerExtra: NO_RETRIES, logger: collectingLogger(), ...options });
}

/** 订阅一个会话，把事件收进数组（订阅结束时停止）。 */
export function collectEvents(adapter: CodexAdapter, engineSessionId: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const event of adapter.subscribe(engineSessionId)) events.push(event);
  })();
  return events;
}

/** 等 `events` 里第 `from` 条之后出现满足条件的事件，返回它。 */
export async function waitForEvent<T extends AgentEvent>(
  events: readonly AgentEvent[],
  match: (event: AgentEvent) => event is T,
  what: string,
  from = 0,
  ms = 30_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = events.slice(from).find(match);
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(`等待超时：${what}（已有 ${events.slice(from).map((e) => e.type)}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 发一条消息，等这个回合的终结事件；返回回合内的全部事件。 */
export async function runTurn(
  adapter: CodexAdapter,
  engineSessionId: string,
  text: string,
  events: AgentEvent[],
): Promise<AgentEvent[]> {
  const from = events.length;
  await adapter.send(engineSessionId, { content: [{ type: 'text', text }] });
  return finishTurn(events, from);
}

/** 等第 `from` 条之后的第一个终结事件，返回从 `from` 到它为止的事件。 */
export async function finishTurn(events: AgentEvent[], from: number): Promise<AgentEvent[]> {
  const terminal = await waitForEvent(events, isTurnTerminal, '回合终结事件', from);
  return events.slice(from, events.indexOf(terminal, from) + 1);
}

export function ofType<T extends AgentEvent['type']>(
  type: T,
): (event: AgentEvent) => event is Extract<AgentEvent, { type: T }> {
  return (event): event is Extract<AgentEvent, { type: T }> => event.type === type;
}
