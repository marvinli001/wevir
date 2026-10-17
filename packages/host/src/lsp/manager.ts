// SPDX-License-Identifier: MIT
// 改写自 sst/opencode packages/opencode/src/lsp/lsp.ts（按扩展名与项目根找服务器、同一根同一服务器只起一个、起动中的复用）
// 来源提交 e3c4eb242585dcd77be1a867391b7c25fd47ce52（v1.19.3）
// Copyright (c) 2025 opencode，MIT License
// 修改：不用 Effect；opencode 起不来的服务器整个实例期间不再试（`broken`），Wevir 改为 5 分钟内崩溃或起不来 3 次才停，过了窗口
// 再试；加上空闲关闭、同时运行的上限、Host 退出时回收；按会话记下引擎改过的文件（Codex 的 fileChange、其他引擎修改 / 写文件的
// 工具调用），交给已在运行的服务器并留给下一次 LSP 工具的结果。
//
// 代码智能（LSP 工具，domain-model §3.15）：Host 里所有语言服务器的管理。

import path from 'node:path';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { LspClient } from './client.js';
import {
  BUILTIN_SERVERS,
  commonBinDirs,
  isMissing,
  type ServerSpec,
  serverFor,
} from './servers.js';

/** 空闲多久关掉一个服务器。 */
export const LSP_IDLE_MS = 10 * 60_000;
/** 同时运行的服务器上限，超出时关掉最久没用的。 */
export const LSP_MAX_SERVERS = 8;
/** 崩溃或起不来的次数上限与窗口：窗口内到了上限就不再重启，过了窗口再试。 */
export const LSP_MAX_FAILURES = 3;
export const LSP_FAILURE_WINDOW_MS = 5 * 60_000;
/** 一个会话记着的改动文件上限。 */
const CHANGED_MAX = 200;
/** 记着的进行中的改文件调用上限。 */
const PENDING_MAX = 500;
/** 改动交给服务器前的去抖。 */
const SYNC_DEBOUNCE_MS = 250;

/** 用不了语言服务器：没有对应的服务器、没装、或崩溃太多次。消息给模型看。 */
export class LspUnavailableError extends Error {}

interface Entry {
  spec: ServerSpec;
  root: string;
  client?: LspClient;
  starting?: Promise<LspClient>;
  failures: number[];
  lastError?: string;
}

export interface LspManagerOptions {
  /** 默认 `BUILTIN_SERVERS`；测试换成假服务器。 */
  servers?: readonly ServerSpec[];
  /** 交给服务器的环境；默认 Host 的环境去掉 `WEVIR_*`、PATH 补上常见的安装位置。 */
  env?: NodeJS.ProcessEnv;
  idleMs?: number;
  maxServers?: number;
  /** 测试用：不递归监视文件。 */
  watch?: boolean;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

/** 交给语言服务器的环境：不带 Wevir 自己的变量（令牌等），PATH 补上常见的安装位置（gopls 要找得到 go）。 */
export function serverEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('WEVIR_')) result[key] = value;
  }
  const pathKey = process.platform === 'win32' && result.PATH === undefined ? 'Path' : 'PATH';
  const dirs = (result[pathKey] ?? '').split(path.delimiter).filter((dir) => dir !== '');
  const home = env.HOME ?? env.USERPROFILE;
  result[pathKey] = [
    ...new Set([...dirs, ...(home === undefined ? commonBinDirs(env) : commonBinDirs(env, home))]),
  ].join(path.delimiter);
  return result;
}

/** `dir` 是 `root` 或在它里面。 */
export function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class LspManager {
  readonly #servers: readonly ServerSpec[];
  readonly #options: LspManagerOptions;
  readonly #env: NodeJS.ProcessEnv;
  readonly #entries = new Map<string, Entry>();
  /** 会话 → 引擎改过、还没报给它的文件（绝对路径 → 时间）。 */
  readonly #changed = new Map<string, Map<string, number>>();
  /** `<会话>\0<工具调用>` → 那次修改 / 写文件调用的文件。 */
  readonly #pending = new Map<string, string[]>();
  readonly #syncTimers = new Map<string, NodeJS.Timeout>();
  readonly #sweep: NodeJS.Timeout;
  #closed = false;

  constructor(options: LspManagerOptions = {}) {
    this.#options = options;
    this.#servers = options.servers ?? BUILTIN_SERVERS;
    this.#env = options.env ?? serverEnv();
    const idleMs = options.idleMs ?? LSP_IDLE_MS;
    this.#sweep = setInterval(() => this.#closeIdle(idleMs), Math.min(60_000, idleMs));
    this.#sweep.unref();
  }

  /** 支持的语言（写进错误）。 */
  get languages(): string {
    return this.#servers.map((spec) => spec.language).join(', ');
  }

  spec(file: string): ServerSpec | undefined {
    return serverFor(this.#servers, file);
  }

  /**
   * 文件所在项目的语言服务器，没在运行就启动（会话目录 `cwd` 是项目根的上限）。用不了时抛 `LspUnavailableError`。
   */
  async client(file: string, cwd: string): Promise<LspClient> {
    if (this.#closed) throw new LspUnavailableError('Wevir is shutting down.');
    const spec = this.spec(file);
    if (spec === undefined) {
      throw new LspUnavailableError(
        `No language server for ${path.extname(file) || path.basename(file)} files. Wevir supports ${this.languages}.`,
      );
    }
    const root = await spec.root(file, cwd);
    const key = `${spec.id}\0${root}`;
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = { spec, root, failures: [] };
      this.#entries.set(key, entry);
    }
    if (entry.client !== undefined && !entry.client.exited) return entry.client;
    if (entry.starting !== undefined) return entry.starting;
    const now = Date.now();
    entry.failures = entry.failures.filter((at) => now - at < LSP_FAILURE_WINDOW_MS);
    if (entry.failures.length >= LSP_MAX_FAILURES) {
      const retryIn = Math.ceil(
        (LSP_FAILURE_WINDOW_MS - (now - (entry.failures[0] ?? now))) / 60_000,
      );
      throw new LspUnavailableError(
        `The ${spec.language} language server for ${root} failed ${entry.failures.length} times in the last ${LSP_FAILURE_WINDOW_MS / 60_000} minutes; Wevir will try again in about ${retryIn} min.${entry.lastError === undefined ? '' : `\n${entry.lastError}`}`,
      );
    }
    const starting = this.#start(entry);
    entry.starting = starting;
    try {
      return await starting;
    } finally {
      if (entry.starting === starting) entry.starting = undefined;
    }
  }

  /** 已经在运行、管着这个文件的服务器（不启动）。 */
  async runningClient(file: string, cwd: string): Promise<LspClient | undefined> {
    const spec = this.spec(file);
    if (spec === undefined) return undefined;
    const client = this.#entries.get(`${spec.id}\0${await spec.root(file, cwd)}`)?.client;
    return client !== undefined && !client.exited ? client : undefined;
  }

  /** 项目根在会话目录里的、在运行的服务器。 */
  running(cwd: string): LspClient[] {
    return [...this.#entries.values()].flatMap((entry) =>
      entry.client !== undefined && !entry.client.exited && isInside(cwd, entry.root)
        ? [entry.client]
        : [],
    );
  }

  async #start(entry: Entry): Promise<LspClient> {
    const launch = await entry.spec.resolve(entry.root, this.#env);
    if (isMissing(launch)) throw new LspUnavailableError(launch.missing);
    await this.#makeRoom();
    const client = new LspClient({
      serverId: entry.spec.id,
      launch,
      root: entry.root,
      env: this.#env,
      ...(this.#options.watch !== undefined && { watch: this.#options.watch }),
      ...(this.#options.onWarning !== undefined && { onWarning: this.#options.onWarning }),
      onExit: ({ code, signal, stderr }) => {
        if (entry.client === client) entry.client = undefined;
        entry.failures.push(Date.now());
        entry.lastError = `${launch.label} exited (${signal ?? `code ${code}`}).${tail(stderr)}`;
        this.#options.onWarning?.('语言服务器意外退出', {
          server: entry.spec.id,
          root: entry.root,
          code,
          signal,
        });
      },
    });
    try {
      await client.start();
    } catch (error) {
      // 进程还在（例如 initialize 超时）时算一次失败并关掉；已经退出的在 onExit 里算过了。
      if (!client.exited) {
        entry.failures.push(Date.now());
        entry.lastError = error instanceof Error ? error.message : String(error);
        await client.shutdown().catch(() => {});
      }
      throw new LspUnavailableError(
        `Could not start ${launch.label} for ${entry.root}: ${error instanceof Error ? error.message : String(error)}${entry.spec.install === undefined ? '' : `\n${entry.spec.install}`}`,
      );
    }
    if (this.#closed) {
      await client.shutdown().catch(() => {});
      throw new LspUnavailableError('Wevir is shutting down.');
    }
    entry.client = client;
    return client;
  }

  async #makeRoom(): Promise<void> {
    const max = this.#options.maxServers ?? LSP_MAX_SERVERS;
    const running = [...this.#entries.values()].filter(
      (entry) => entry.client !== undefined && !entry.client.exited,
    );
    running.sort((a, b) => (a.client?.usedAt ?? 0) - (b.client?.usedAt ?? 0));
    while (running.length >= max) {
      const oldest = running.shift();
      const client = oldest?.client;
      if (oldest === undefined || client === undefined) break;
      oldest.client = undefined;
      await client.shutdown().catch(() => {});
    }
  }

  #closeIdle(idleMs: number): void {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      const client = entry.client;
      if (client !== undefined && now - client.usedAt >= idleMs) {
        entry.client = undefined;
        void client.shutdown().catch(() => {});
      }
      if (
        entry.client === undefined &&
        entry.starting === undefined &&
        entry.failures.length === 0
      ) {
        this.#entries.delete(key);
      }
    }
  }

  // ── 引擎改过的文件 ───────────────────────────────────────────────

  /**
   * 会话的引擎事件（Host 落库前）：修改 / 写文件的工具调用成功结束时，记下它动过的文件，交给已在运行的服务器（不为此启动服务器）。
   */
  observe(sessionId: string, cwd: string, event: AgentEvent, realCwd: string = cwd): void {
    if (this.#closed) return;
    if (event.type === 'tool.started' || event.type === 'tool.updated') {
      const display = event.display;
      if (display === undefined || (display.kind !== 'edit' && display.kind !== 'write')) return;
      const paths = display.paths ?? [];
      if (paths.length === 0) return;
      const key = `${sessionId}\0${event.toolCallId}`;
      this.#pending.delete(key);
      this.#pending.set(
        key,
        paths.map((file) => {
          const absolute = path.resolve(cwd, file);
          return realCwd !== cwd && isInside(cwd, absolute)
            ? path.join(realCwd, path.relative(cwd, absolute))
            : absolute;
        }),
      );
      if (this.#pending.size > PENDING_MAX) {
        const oldest = this.#pending.keys().next().value;
        if (oldest !== undefined) this.#pending.delete(oldest);
      }
      return;
    }
    if (event.type !== 'tool.finished') return;
    const key = `${sessionId}\0${event.toolCallId}`;
    const files = this.#pending.get(key);
    this.#pending.delete(key);
    if (files === undefined || event.status !== 'completed') return;
    let changed = this.#changed.get(sessionId);
    if (changed === undefined) {
      changed = new Map();
      this.#changed.set(sessionId, changed);
    }
    for (const file of files) {
      changed.delete(file);
      changed.set(file, Date.now());
    }
    while (changed.size > CHANGED_MAX) {
      const oldest = changed.keys().next().value;
      if (oldest === undefined) break;
      changed.delete(oldest);
    }
    clearTimeout(this.#syncTimers.get(sessionId));
    const timer = setTimeout(() => {
      this.#syncTimers.delete(sessionId);
      void this.#syncChanged(sessionId, realCwd);
    }, SYNC_DEBOUNCE_MS);
    timer.unref();
    this.#syncTimers.set(sessionId, timer);
  }

  /** 改过的文件交给在运行的服务器：打开着的重新同步，没打开的发 didChangeWatchedFiles。 */
  async #syncChanged(sessionId: string, cwd: string): Promise<void> {
    const files = [...(this.#changed.get(sessionId)?.keys() ?? [])];
    for (const file of files) {
      const client = await this.runningClient(file, cwd).catch(() => undefined);
      if (client === undefined) continue;
      if (client.isOpen(file)) await client.sync(file).catch(() => {});
      else await client.filesChanged([{ file }]).catch(() => {});
    }
  }

  /** 引擎改过、还没报给这个会话的文件（旧的在前），取走。 */
  takeChanged(sessionId: string): string[] {
    const files = [...(this.#changed.get(sessionId)?.keys() ?? [])];
    this.#changed.delete(sessionId);
    return files;
  }

  /** 这些文件已经报过了。 */
  reported(sessionId: string, files: readonly string[]): void {
    const changed = this.#changed.get(sessionId);
    if (changed === undefined) return;
    for (const file of files) changed.delete(file);
    if (changed.size === 0) this.#changed.delete(sessionId);
  }

  /** Host 退出：关掉所有服务器。 */
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#sweep);
    for (const timer of this.#syncTimers.values()) clearTimeout(timer);
    this.#syncTimers.clear();
    const clients = [...this.#entries.values()].flatMap((entry) => {
      const client = entry.client;
      entry.client = undefined;
      return client === undefined ? [] : [client];
    });
    const starting = [...this.#entries.values()].flatMap((entry) =>
      entry.starting === undefined ? [] : [entry.starting],
    );
    await Promise.all([
      ...clients.map((client) => client.shutdown().catch(() => {})),
      // 正在启动的在 #start 里看到 #closed 后自己关掉。
      ...starting.map((promise) => promise.catch(() => {})),
    ]);
  }
}

function tail(stderr: string): string {
  const text = stderr.trim().split('\n').slice(-5).join('\n');
  return text === '' ? '' : `\nIts last output:\n${text}`;
}
