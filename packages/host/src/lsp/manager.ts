// SPDX-License-Identifier: MIT
// 改写自 sst/opencode packages/opencode/src/lsp/lsp.ts（按扩展名与项目根找服务器、同一根同一服务器只起一个、起动中的复用）
// 来源提交 e3c4eb242585dcd77be1a867391b7c25fd47ce52（v1.19.3）
// Copyright (c) 2025 opencode，MIT License
// 修改：不用 Effect；opencode 起不来的服务器整个实例期间不再试（`broken`），Wevir 改为 5 分钟内崩溃或起不来 3 次才停，过了窗口
// 再试；加上空闲关闭、同时运行的上限、Host 退出时回收；按会话记下引擎改过的文件（Codex 的 fileChange、其他引擎修改 / 写文件的
// 工具调用），交给已在运行的服务器并留给下一次 LSP 工具的结果。0.71.0 起：起服务器前读一次版本（跑不起来或过旧的不用）、记下每个
// 服务器的状态、能力、启动日志与最近一次诊断的时间（`lsp.status`），可以重启。
//
// 代码智能（LSP 工具，domain-model §3.15）：Host 里所有语言服务器的管理。

import path from 'node:path';
import type { LspInstallPlan, LspServerStatus } from '@wevir/protocol';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { capabilityNames, LspClient, loadLspProtocol } from './client.js';
import { outdatedReason, probeServer, type ServerSource, serverSource } from './probe.js';
import {
  BUILTIN_SERVERS,
  commonBinDirs,
  type InstallPlan,
  isMissing,
  type ServerLaunch,
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

/** 查找结果缓存多久（`lsp.status` 反复读时不每次都跑 `--version`）。 */
const RESOLVE_CACHE_MS = 30_000;
/** 每个服务器的启动日志留几行。 */
const LOG_LINES = 300;
/** 记着的服务器（种类 × 项目根）上限：超出时忘掉最久没用、没在运行的。 */
const ENTRIES_MAX = 200;

/** 为什么用不了：`unsupported` 没有这种文件的服务器，`missing` 没装或跑不起来，`outdated` 版本过旧，`failed` 起不来或崩溃，`closing` Host 在退出。 */
export type LspUnavailableState = 'unsupported' | 'missing' | 'outdated' | 'failed' | 'closing';

/** 用不了语言服务器：没有对应的服务器、没装、或崩溃太多次。消息给模型看。 */
export class LspUnavailableError extends Error {
  readonly state: LspUnavailableState;

  constructor(message: string, state: LspUnavailableState = 'failed') {
    super(message);
    this.state = state;
  }
}

/** 查找的结果：能用的启动方式，或没装 / 跑不起来 / 过旧的原因。 */
type Resolved =
  | { kind: 'ok'; launch: ServerLaunch; version?: string; source: ServerSource }
  | {
      kind: 'missing' | 'outdated';
      reason: string;
      launch?: ServerLaunch;
      version?: string;
      source?: ServerSource;
    };

interface Entry {
  spec: ServerSpec;
  root: string;
  client?: LspClient;
  starting?: Promise<LspClient>;
  failures: number[];
  lastError?: string;
  /** 最近一次启动用的：显示在状态里（运行中的以它为准，不看新的查找结果）。 */
  launched?: { launch: ServerLaunch; version?: string; source: ServerSource };
  startedAt?: number;
  diagnosticsAt?: number;
  capabilities?: string[];
  log: string[];
  touchedAt: number;
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
  /** 某个服务器的状态变了（起来、起不来、退出、关掉）。 */
  onChange?: (serverId: string, root: string) => void;
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
  readonly #resolved = new Map<string, { at: number; result: Resolved }>();
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

  get servers(): readonly ServerSpec[] {
    return this.#servers;
  }

  /** 交给语言服务器与安装命令的环境。 */
  get env(): NodeJS.ProcessEnv {
    return this.#env;
  }

  #entry(spec: ServerSpec, root: string): Entry {
    const key = `${spec.id}\0${root}`;
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = { spec, root, failures: [], log: [], touchedAt: Date.now() };
      this.#entries.set(key, entry);
      this.#forgetOld();
    }
    entry.touchedAt = Date.now();
    return entry;
  }

  #log(entry: Entry, line: string): void {
    for (const part of line.split('\n')) entry.log.push(`${new Date().toISOString()} ${part}`);
    if (entry.log.length > LOG_LINES) entry.log.splice(0, entry.log.length - LOG_LINES);
  }

  #notify(entry: Entry): void {
    this.#options.onChange?.(entry.spec.id, entry.root);
  }

  /** 查找服务器、读版本、对照最低版本。`cached` 时用 30 秒内的结果。 */
  async #resolve(spec: ServerSpec, root: string, cached: boolean): Promise<Resolved> {
    const key = `${spec.id}\0${root}`;
    const hit = this.#resolved.get(key);
    if (cached && hit !== undefined && Date.now() - hit.at < RESOLVE_CACHE_MS) return hit.result;
    const result = await this.#resolveNow(spec, root);
    this.#resolved.set(key, { at: Date.now(), result });
    return result;
  }

  async #resolveNow(spec: ServerSpec, root: string): Promise<Resolved> {
    const launch = await spec.resolve(root, this.#env);
    if (isMissing(launch)) return { kind: 'missing', reason: launch.missing };
    const [probe, source] = await Promise.all([
      probeServer(launch, this.#env),
      serverSource(launch.command, [root], this.#env.HOME ?? this.#env.USERPROFILE),
    ]);
    const version = probe.version;
    const known = { launch, source, ...(version !== undefined && { version }) };
    if (probe.error !== undefined) {
      return {
        kind: 'missing',
        reason: `${launch.label} at ${launch.command} does not run: ${probe.error}${spec.install === undefined ? '' : `\n${spec.install}`}`,
        ...known,
      };
    }
    const outdated = outdatedReason(launch, version);
    if (outdated !== undefined) return { kind: 'outdated', reason: outdated, ...known };
    return { kind: 'ok', ...known };
  }

  /**
   * 文件所在项目的语言服务器，没在运行就启动（会话目录 `cwd` 是项目根的上限）。用不了时抛 `LspUnavailableError`。
   */
  async client(file: string, cwd: string): Promise<LspClient> {
    if (this.#closed) throw new LspUnavailableError('Wevir is shutting down.', 'closing');
    const spec = this.spec(file);
    if (spec === undefined) {
      throw new LspUnavailableError(
        `No language server for ${path.extname(file) || path.basename(file)} files. Wevir supports ${this.languages}.`,
        'unsupported',
      );
    }
    const root = await spec.root(file, cwd);
    return this.#ensure(this.#entry(spec, root));
  }

  /** 这个服务器在运行就用它，否则启动（窗口内失败太多次时不启动）。 */
  async #ensure(entry: Entry): Promise<LspClient> {
    if (this.#closed) throw new LspUnavailableError('Wevir is shutting down.', 'closing');
    const spec = entry.spec;
    const root = entry.root;
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
        'failed',
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
    const resolved = await this.#resolve(entry.spec, entry.root, false);
    if (resolved.kind !== 'ok') {
      this.#log(entry, `${resolved.kind}: ${resolved.reason}`);
      this.#notify(entry);
      throw new LspUnavailableError(resolved.reason, resolved.kind);
    }
    const { launch } = resolved;
    await this.#makeRoom();
    entry.launched = {
      launch,
      source: resolved.source,
      ...(resolved.version !== undefined && { version: resolved.version }),
    };
    entry.capabilities = undefined;
    await loadLspProtocol();
    this.#log(
      entry,
      `start: ${[launch.command, ...launch.args].join(' ')} (${resolved.source}${resolved.version === undefined ? '' : `, ${resolved.version}`}) in ${entry.root}`,
    );
    const client = new LspClient({
      serverId: entry.spec.id,
      launch,
      root: entry.root,
      env: this.#env,
      ...(this.#options.watch !== undefined && { watch: this.#options.watch }),
      ...(this.#options.onWarning !== undefined && { onWarning: this.#options.onWarning }),
      onExit: ({ code, signal, stderr }) => {
        if (entry.client === client) entry.client = undefined;
        entry.diagnosticsAt = client.diagnosticsAt ?? entry.diagnosticsAt;
        entry.failures.push(Date.now());
        entry.lastError = `${launch.label} exited (${signal ?? `code ${code}`}).${tail(stderr)}`;
        this.#log(entry, `exited (${signal ?? `code ${code}`})${stderrLog(stderr)}`);
        this.#options.onWarning?.('语言服务器意外退出', {
          server: entry.spec.id,
          root: entry.root,
          code,
          signal,
        });
        this.#notify(entry);
      },
    });
    entry.startedAt = Date.now();
    this.#notify(entry);
    try {
      await client.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 进程还在（例如 initialize 超时）时算一次失败并关掉；已经退出的在 onExit 里算过了。
      if (!client.exited) {
        entry.failures.push(Date.now());
        entry.lastError = message;
        this.#log(entry, `failed: ${message}`);
        await client.shutdown().catch(() => {});
      }
      this.#notify(entry);
      throw new LspUnavailableError(
        `Could not start ${launch.label} for ${entry.root}: ${message}${entry.spec.install === undefined ? '' : `\n${entry.spec.install}`}`,
        'failed',
      );
    }
    if (this.#closed) {
      await client.shutdown().catch(() => {});
      throw new LspUnavailableError('Wevir is shutting down.', 'closing');
    }
    entry.client = client;
    entry.capabilities = capabilityNames(client.capabilities);
    this.#log(entry, `initialized: ${entry.capabilities.join(', ') || 'no capabilities'}`);
    this.#notify(entry);
    return client;
  }

  /** 关掉一个服务器（空闲、腾地方、重启时），记进它的日志。 */
  async #stop(entry: Entry, why: string): Promise<void> {
    const client = entry.client;
    if (client === undefined) return;
    entry.client = undefined;
    entry.diagnosticsAt = client.diagnosticsAt ?? entry.diagnosticsAt;
    this.#log(entry, `stopped (${why})${stderrLog(client.stderr)}`);
    await client.shutdown().catch(() => {});
    this.#notify(entry);
  }

  // ── 状态（0.71.0，lsp.status） ─────────────────────────────────────

  /** 一个服务器（种类 × 项目根）现在的状态；不启动服务器。`refresh` 时重新查找。 */
  async status(spec: ServerSpec, root: string, refresh = false): Promise<LspServerStatus> {
    const entry = this.#entries.get(`${spec.id}\0${root}`);
    const base = { serverId: spec.id, language: spec.language, root };
    const client = entry?.client !== undefined && !entry.client.exited ? entry.client : undefined;
    const diagnosticsAt = client?.diagnosticsAt ?? entry?.diagnosticsAt;
    const history = {
      ...(entry?.capabilities !== undefined && { capabilities: entry.capabilities }),
      ...(entry?.startedAt !== undefined && { startedAt: iso(entry.startedAt) }),
      ...(diagnosticsAt !== undefined && { lastDiagnosticsAt: iso(diagnosticsAt) }),
    };
    if (entry?.launched !== undefined && (client !== undefined || entry.starting !== undefined)) {
      return {
        ...base,
        state: client !== undefined ? 'running' : 'starting',
        ...launchInfo(entry.launched),
        ...history,
      };
    }
    const resolved = await this.#resolve(spec, root, !refresh);
    const info =
      resolved.launch === undefined ? {} : launchInfo({ ...resolved, launch: resolved.launch });
    if (resolved.kind !== 'ok') {
      const plans = await this.plans(spec, root);
      return {
        ...base,
        state: resolved.kind,
        reason: resolved.reason,
        ...info,
        ...(resolved.kind === 'outdated' &&
          resolved.launch?.minVersion !== undefined && { minVersion: resolved.launch.minVersion }),
        ...history,
        ...(plans.length > 0 && { plans: plans.map(publicPlan) }),
      };
    }
    const now = Date.now();
    const failures = (entry?.failures ?? []).filter((at) => now - at < LSP_FAILURE_WINDOW_MS);
    if (failures.length > 0 && entry?.lastError !== undefined) {
      const first = failures[0] ?? now;
      return {
        ...base,
        state: 'failed',
        reason: entry.lastError,
        ...info,
        ...history,
        failures: failures.length,
        ...(failures.length >= LSP_MAX_FAILURES && {
          retryAt: iso(first + LSP_FAILURE_WINDOW_MS),
        }),
      };
    }
    return { ...base, state: 'not_started', ...info, ...history };
  }

  /** 安装方案（`missing` / `outdated` 时有）。 */
  async plans(spec: ServerSpec, root: string): Promise<InstallPlan[]> {
    return (await spec.plans?.(root, this.#env).catch(() => [])) ?? [];
  }

  /** 启动日志：Wevir 记下的启动、退出与服务器的 stderr（在运行的服务器加上它现在的 stderr 末尾）。 */
  log(spec: ServerSpec, root: string): string {
    const entry = this.#entries.get(`${spec.id}\0${root}`);
    if (entry === undefined) return '';
    const client = entry.client;
    const live = client !== undefined && !client.exited ? stderrLog(client.stderr) : '';
    return `${entry.log.join('\n')}${live === '' ? '' : `\n(running)${live}`}`;
  }

  /** 重启：关掉在运行的，清掉崩溃计数与查找缓存，再起一次。起不来时不抛错，状态里看原因。 */
  async restart(spec: ServerSpec, root: string): Promise<void> {
    const entry = this.#entry(spec, root);
    await entry.starting?.catch(() => {});
    await this.#stop(entry, 'restart');
    entry.failures = [];
    entry.lastError = undefined;
    this.#resolved.delete(`${spec.id}\0${root}`);
    await this.#ensure(entry).catch(() => {});
  }

  /** 忘掉查找缓存（装完东西后）。 */
  forget(serverId: string, root: string): void {
    this.#resolved.delete(`${serverId}\0${root}`);
  }

  /**
   * 装完之后验证：重启这个服务器，同步一个文件、取一次诊断。起不来时抛 `LspUnavailableError`。
   */
  async verify(
    spec: ServerSpec,
    root: string,
    file: string,
    timeoutMs: number,
  ): Promise<{ server: string; diagnostics: number; timedOut: boolean }> {
    await this.restart(spec, root);
    const entry = this.#entry(spec, root);
    const client = entry.client;
    if (client === undefined || client.exited) {
      const resolved = await this.#resolve(spec, root, true);
      if (resolved.kind !== 'ok') throw new LspUnavailableError(resolved.reason, resolved.kind);
      throw new LspUnavailableError(
        entry.lastError ?? `${spec.language} language server did not start.`,
      );
    }
    await client.sync(file);
    const result = await client.diagnostics(file, timeoutMs);
    this.#log(
      entry,
      `checked ${path.relative(root, file) || file}: ${result.diagnostics.length} diagnostics${result.timedOut ? ' (timed out)' : ''}`,
    );
    this.#notify(entry);
    return {
      server: client.label,
      diagnostics: result.diagnostics.length,
      timedOut: result.timedOut,
    };
  }

  async #makeRoom(): Promise<void> {
    const max = this.#options.maxServers ?? LSP_MAX_SERVERS;
    const running = [...this.#entries.values()].filter(
      (entry) => entry.client !== undefined && !entry.client.exited,
    );
    running.sort((a, b) => (a.client?.usedAt ?? 0) - (b.client?.usedAt ?? 0));
    while (running.length >= max) {
      const oldest = running.shift();
      if (oldest?.client === undefined) break;
      await this.#stop(oldest, `more than ${max} servers running`);
    }
  }

  #closeIdle(idleMs: number): void {
    const now = Date.now();
    for (const entry of this.#entries.values()) {
      const client = entry.client;
      if (client !== undefined && now - client.usedAt >= idleMs) void this.#stop(entry, 'idle');
    }
    this.#forgetOld();
  }

  /** 记着的服务器多于上限时忘掉最久没碰、没在运行的（它们的日志与状态也一起忘掉）。 */
  #forgetOld(): void {
    if (this.#entries.size <= ENTRIES_MAX) return;
    const idle = [...this.#entries]
      .filter(([, entry]) => entry.client === undefined && entry.starting === undefined)
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (const [key] of idle.slice(0, this.#entries.size - ENTRIES_MAX)) {
      this.#entries.delete(key);
      this.#resolved.delete(key);
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

const iso = (ms: number) => new Date(ms).toISOString();

function launchInfo(value: {
  launch: ServerLaunch;
  version?: string;
  source?: ServerSource;
}): Partial<LspServerStatus> {
  return {
    name: value.launch.label,
    path: value.launch.command,
    ...(value.source !== undefined && { source: value.source }),
    ...(value.version !== undefined && { version: value.version }),
  };
}

/** 方案的显示：参数里有空格等的加引号。 */
export function planCommand(argv: readonly string[]): string {
  return argv
    .map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
    .join(' ');
}

export function publicPlan(plan: InstallPlan): LspInstallPlan {
  return {
    id: plan.id,
    scope: plan.scope,
    command: planCommand(plan.argv),
    ...(plan.cwd !== undefined && { cwd: plan.cwd }),
    runnable: plan.runnable,
  };
}

/** stderr 的末尾，一行一行进日志。 */
function stderrLog(stderr: string): string {
  const lines = stderr
    .trim()
    .split('\n')
    .slice(-40)
    .filter((line) => line !== '');
  return lines.length === 0 ? '' : `\n${lines.map((line) => `  | ${line}`).join('\n')}`;
}

function tail(stderr: string): string {
  const text = stderr.trim().split('\n').slice(-5).join('\n');
  return text === '' ? '' : `\nIts last output:\n${text}`;
}
