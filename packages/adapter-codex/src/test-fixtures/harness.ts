// 真实 codex-app-server 的测试共用部分：二进制在不在、临时目录、安静的日志、建适配器。

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
