// SPDX-License-Identifier: MIT
// 改写自 sst/opencode packages/opencode/src/lsp/client.ts
// 来源提交 e3c4eb242585dcd77be1a867391b7c25fd47ce52（v1.19.3）
// Copyright (c) 2025 opencode，MIT License
// 修改：不用 Effect，写成一个类；照 opencode 的取舍：`initialize` 时限 45 秒、回 `workspace/configuration`（按 section 取设置）、
// 记下动态注册的拉取式诊断、推送与拉取的诊断合并去重、文档已打开时发整篇 didChange（增量同步的服务器也用覆盖全文的一段）、
// 推送的诊断等 150 ms 不再变化再取。Wevir 另外：版本从 1 起、文件在磁盘上已保存所以改完补发 didSave（rust-analyzer 等在保存时
// 才跑检查）、打开的文档有上限、服务器注册了文件监视时在 macOS / Windows 上递归监视项目根并转发 didChangeWatchedFiles
// （TypeScript 7 的服务器自己不监视文件）、记下 stderr 的末尾给崩溃时的错误、退出时先 shutdown 再 exit，不行再结束进程。
//
// 代码智能（LSP 工具，domain-model §3.15）：一个语言服务器进程与它的连接。

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { type FSWatcher, watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  Diagnostic,
  InitializeResult,
  ProtocolConnection,
  ServerCapabilities,
} from 'vscode-languageserver-protocol/node';
import { languageId, type ServerLaunch } from './servers.js';

type LspProtocol = typeof import('vscode-languageserver-protocol/node');

let protocol: LspProtocol | undefined;

/**
 * vscode-languageserver-protocol（CommonJS）在第一次起语言服务器时才加载：Host 启动时不必为没用到的 LSP 工具付出加载时间与内存。
 * 用 `import()` 而不是 `createRequire`：安装包里的 Host 打成一个 bundle，打包器只认得 `import()`，把它拆成按需加载的文件。
 */
export async function loadLspProtocol(): Promise<void> {
  protocol ??= (await import('vscode-languageserver-protocol/node')).default;
}

function lspProtocol(): LspProtocol {
  if (protocol === undefined) throw new Error('vscode-languageserver-protocol is not loaded yet');
  return protocol;
}

export type { Diagnostic };

/** `initialize` 的时限（opencode 的 INITIALIZE_TIMEOUT_MS）。 */
export const INITIALIZE_TIMEOUT_MS = 45_000;
/** 推送的诊断安静多久算出完（opencode 的 DIAGNOSTICS_DEBOUNCE_MS）。 */
const DIAGNOSTICS_DEBOUNCE_MS = 150;
/** 同时打开的文档上限，超出时关掉最久没用的。 */
const MAX_OPEN_DOCUMENTS = 300;
/** 文档大小上限（字节）：再大的文件不交给服务器。 */
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
/** 记下多少 stderr。 */
const STDERR_TAIL = 4000;
/** 一批文件变动最多转发几个；监视的去抖。 */
const WATCH_BATCH_MAX = 1000;
const WATCH_DEBOUNCE_MS = 200;
const SHUTDOWN_TIMEOUT_MS = 2000;

// LSP 规范的常量。
const FILE_CREATED = 1;
const FILE_CHANGED = 2;
const FILE_DELETED = 3;
const SYNC_NONE = 0;
const SYNC_INCREMENTAL = 2;

export class LspRequestError extends Error {}

/** `initialize` 结果里声明了的能力（0.71.0 的 `lsp.status`），按 LSP 的方法名去掉 `Provider`。 */
const CAPABILITY_NAMES: ReadonlyArray<[keyof ServerCapabilities, string]> = [
  ['definitionProvider', 'definition'],
  ['typeDefinitionProvider', 'typeDefinition'],
  ['implementationProvider', 'implementation'],
  ['referencesProvider', 'references'],
  ['hoverProvider', 'hover'],
  ['documentSymbolProvider', 'documentSymbol'],
  ['workspaceSymbolProvider', 'workspaceSymbol'],
  ['callHierarchyProvider', 'callHierarchy'],
  ['diagnosticProvider', 'pullDiagnostics'],
  ['completionProvider', 'completion'],
  ['signatureHelpProvider', 'signatureHelp'],
  ['renameProvider', 'rename'],
  ['codeActionProvider', 'codeAction'],
  ['documentFormattingProvider', 'formatting'],
  ['documentRangeFormattingProvider', 'rangeFormatting'],
  ['inlayHintProvider', 'inlayHint'],
  ['semanticTokensProvider', 'semanticTokens'],
  ['executeCommandProvider', 'executeCommand'],
];

export function capabilityNames(capabilities: ServerCapabilities): string[] {
  return CAPABILITY_NAMES.flatMap(([key, name]) => {
    const value = capabilities[key];
    return value === undefined || value === null || value === false ? [] : [name];
  });
}

interface OpenDocument {
  version: number;
  text: string;
  usedAt: number;
  /** 上次读时的修改时间与大小：都没变就不再读文件。 */
  mtimeMs: number;
  size: number;
  /** 上次 didOpen / didChange 的时间：不带版本的推送要晚于它才算新的。 */
  changedAt: number;
}

interface Published {
  diagnostics: Diagnostic[];
  version: number | undefined;
  at: number;
}

interface DiagnosticRegistration {
  identifier?: string;
  workspaceDiagnostics?: boolean;
}

export interface DiagnosticsResult {
  diagnostics: Diagnostic[];
  /** 等到时限服务器还没给出结果：可能不全或是改动之前的。 */
  timedOut: boolean;
}

export interface LspClientOptions {
  /** `typescript` 这样的服务器种类。 */
  serverId: string;
  launch: ServerLaunch;
  root: string;
  env: NodeJS.ProcessEnv;
  /** 进程意外退出（不是 `shutdown` 关的）。 */
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => void;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  /** 测试用：不递归监视。 */
  watch?: boolean;
}

function filePath(uri: string): string | undefined {
  if (!uri.startsWith('file:')) return undefined;
  try {
    return path.normalize(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

export const fileUri = (file: string) => pathToFileURL(file).href;

function endPosition(text: string) {
  const lines = text.split(/\r\n|\r|\n/);
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function dedupe(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify([item.code, item.severity, item.message, item.source, item.range]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `workspace/configuration` 的一项：按 `a.b.c` 取设置，没有时 `null`（opencode 的 configurationValue）。 */
function configurationValue(settings: Record<string, unknown> | undefined, section?: string) {
  if (!section) return settings ?? null;
  const value = section.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object' || !(key in current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, settings);
  return value ?? null;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export class LspClient {
  readonly serverId: string;
  readonly root: string;
  readonly label: string;
  /** 最近一次使用（请求或同步文档）的时间。 */
  usedAt = Date.now();
  /** 最近一次取完诊断的时间（0.71.0 的 `lsp.status`）。 */
  diagnosticsAt: number | undefined;
  readonly #options: LspClientOptions;
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #connection: ProtocolConnection;
  readonly #documents = new Map<string, OpenDocument>();
  readonly #pushed = new Map<string, Published>();
  readonly #pulled = new Map<string, Diagnostic[]>();
  readonly #pushListeners = new Set<(file: string) => void>();
  readonly #registrations = new Map<string, DiagnosticRegistration>();
  #capabilities: ServerCapabilities = {};
  #stderr = '';
  #closing = false;
  #exited = false;
  #watcher: FSWatcher | undefined;
  #watchQueue = new Map<string, 'rename' | 'change'>();
  #watchTimer: NodeJS.Timeout | undefined;
  readonly #exit: Promise<void>;

  constructor(options: LspClientOptions) {
    this.#options = options;
    this.serverId = options.serverId;
    this.root = options.root;
    this.label = options.launch.label;
    const { command, args } = options.launch;
    // Windows 上 npm 装的是 .cmd 启动脚本，Node 不经 shell 起不了（参数是固定的，没有用户输入）。
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    this.#process = spawn(shell ? `"${command}"` : command, args, {
      cwd: options.root,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell,
    });
    this.#process.stderr.setEncoding('utf8');
    this.#process.stderr.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL);
    });
    // 写给已经退出的进程（EPIPE）不抛到 Host。
    this.#process.stdin.on('error', () => {});
    this.#exit = new Promise((done) => {
      const gone = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.#exited) return;
        this.#exited = true;
        this.#stopWatching();
        if (!this.#closing) this.#options.onExit({ code, signal, stderr: this.#stderr });
        done();
      };
      this.#process.once('exit', gone);
      // 起不来（找不到文件、没有权限）时只有 'error'，不一定有 'exit'。
      this.#process.once('error', (error) => {
        this.#stderr = `${this.#stderr}\n${error.message}`.slice(-STDERR_TAIL);
        if (this.#process.pid === undefined) gone(null, null);
      });
    });
    const { createProtocolConnection, StreamMessageReader, StreamMessageWriter } = lspProtocol();
    this.#connection = createProtocolConnection(
      new StreamMessageReader(this.#process.stdout),
      new StreamMessageWriter(this.#process.stdin),
    );
    this.#connection.onError(() => {});
    this.#handle();
    this.#connection.listen();
  }

  get stderr(): string {
    return this.#stderr;
  }

  get exited(): boolean {
    return this.#exited;
  }

  get capabilities(): ServerCapabilities {
    return this.#capabilities;
  }

  /** `initialize` 与 `initialized`；进程先退出或超时时抛错（带 stderr 的末尾）。 */
  async start(): Promise<void> {
    const rootUri = fileUri(this.root);
    const initialize = this.#connection.sendRequest<InitializeResult>('initialize', {
      processId: process.pid,
      clientInfo: { name: 'Wevir' },
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
      initializationOptions: this.#options.launch.initializationOptions ?? {},
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        window: { workDoneProgress: true },
        workspace: {
          configuration: true,
          workspaceFolders: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
          symbol: {},
          diagnostics: { refreshSupport: false },
        },
        textDocument: {
          synchronization: { didSave: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          implementation: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: {},
          publishDiagnostics: { versionSupport: true },
          diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
        },
      },
    });
    const result = await this.#guard(
      initialize,
      INITIALIZE_TIMEOUT_MS,
      () =>
        `${this.label} did not answer initialize within ${INITIALIZE_TIMEOUT_MS / 1000} s.${this.#stderrNote()}`,
      () => `${this.label} exited during startup.${this.#stderrNote()}`,
    );
    this.#capabilities = result.capabilities ?? {};
    await this.#connection.sendNotification('initialized', {});
    const settings = this.#options.launch.settings;
    if (settings !== undefined) {
      await this.#connection.sendNotification('workspace/didChangeConfiguration', { settings });
    }
  }

  #stderrNote(): string {
    const tail = this.#stderr.trim().split('\n').slice(-5).join('\n');
    return tail === '' ? '' : `\nIts last output:\n${tail}`;
  }

  #handle(): void {
    const connection = this.#connection;
    connection.onNotification('textDocument/publishDiagnostics', (params) => {
      const file = filePath(params.uri);
      if (file === undefined) return;
      this.#pushed.set(file, {
        diagnostics: params.diagnostics,
        version: typeof params.version === 'number' ? params.version : undefined,
        at: Date.now(),
      });
      for (const listener of [...this.#pushListeners]) listener(file);
    });
    connection.onRequest(
      'workspace/configuration',
      (params: { items?: Array<{ section?: string }> }) =>
        (params.items ?? []).map((item) =>
          configurationValue(this.#options.launch.settings, item.section),
        ),
    );
    connection.onRequest('workspace/workspaceFolders', () => [
      { uri: fileUri(this.root), name: path.basename(this.root) },
    ]);
    connection.onRequest('window/workDoneProgress/create', () => null);
    connection.onRequest('window/showMessageRequest', () => null);
    connection.onRequest('workspace/diagnostic/refresh', () => null);
    // 只读：服务器要求改文件时拒绝。
    connection.onRequest('workspace/applyEdit', () => ({ applied: false }));
    connection.onRequest('client/registerCapability', (params) => {
      for (const registration of params.registrations ?? []) {
        if (registration.method === 'textDocument/diagnostic') {
          this.#registrations.set(
            registration.id,
            (registration.registerOptions ?? {}) as DiagnosticRegistration,
          );
        } else if (registration.method === 'workspace/didChangeWatchedFiles') {
          this.#startWatching();
        }
      }
      return null;
    });
    connection.onRequest('client/unregisterCapability', (params) => {
      for (const registration of params.unregisterations ?? []) {
        this.#registrations.delete(registration.id);
      }
      return null;
    });
  }

  /** 发请求，超时取消并抛错；进程退出时抛错。 */
  async request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.#exited) throw new LspRequestError(`${this.label} is not running.`);
    this.usedAt = Date.now();
    const source = new (lspProtocol().CancellationTokenSource)();
    try {
      return await this.#guard(
        this.#connection.sendRequest<T>(method, params, source.token),
        timeoutMs,
        () => {
          source.cancel();
          return `${this.label} did not answer ${method} within ${Math.round(timeoutMs / 1000)} s (it may still be loading the project; try again).`;
        },
        () => `${this.label} exited.${this.#stderrNote()}`,
      );
    } catch (error) {
      if (error instanceof LspRequestError) throw error;
      throw new LspRequestError(
        `${this.label} failed ${method}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      source.dispose();
    }
  }

  /** 等 `promise`，超时或进程退出时以 `LspRequestError` 拒绝；先到的那个算数，不留没人接的拒绝。 */
  #guard<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timedOut: () => string,
    exited: () => string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (run: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run();
      };
      const timer = setTimeout(
        () => settle(() => reject(new LspRequestError(timedOut()))),
        timeoutMs,
      );
      promise.then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error)),
      );
      void this.#exit.then(() => settle(() => reject(new LspRequestError(exited()))));
    });
  }

  /**
   * 把文件的磁盘内容交给服务器：没打开的 didOpen，打开过、内容变了的 didChange（加 didSave）。返回文档版本与这次有没有变。
   * 修改时间与大小都没变时默认不再读文件；`compareText` 时照样读来比对（同样大小的改动可能落在同一个修改时间里）。
   * 文件不存在（被删了）时关掉文档，返回 `undefined`。
   */
  async sync(
    file: string,
    options: { compareText?: boolean } = {},
  ): Promise<{ version: number; changed: boolean } | undefined> {
    this.usedAt = Date.now();
    const info = await stat(file).catch(() => undefined);
    const document = this.#documents.get(file);
    if (!info?.isFile()) {
      if (document !== undefined) this.#close(file);
      return undefined;
    }
    if (info.size > MAX_DOCUMENT_BYTES) {
      throw new LspRequestError(
        `${file} is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB; Wevir does not send it to the language server.`,
      );
    }
    if (document !== undefined) {
      document.usedAt = Date.now();
      if (
        options.compareText !== true &&
        document.mtimeMs === info.mtimeMs &&
        document.size === info.size
      ) {
        return { version: document.version, changed: false };
      }
    }
    const text = await readFile(file, 'utf8');
    const uri = fileUri(file);
    if (document !== undefined) {
      document.mtimeMs = info.mtimeMs;
      document.size = info.size;
      if (document.text === text) return { version: document.version, changed: false };
      const syncKind = this.#syncKind();
      if (syncKind === SYNC_NONE) {
        this.#close(file);
        return this.sync(file);
      }
      const version = document.version + 1;
      const previous = document.text;
      document.version = version;
      document.text = text;
      document.changedAt = Date.now();
      await this.#connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges:
          syncKind === SYNC_INCREMENTAL
            ? [{ range: { start: { line: 0, character: 0 }, end: endPosition(previous) }, text }]
            : [{ text }],
      });
      await this.#didSave(uri, text);
      return { version, changed: true };
    }
    this.#evict();
    this.#pushed.delete(file);
    this.#pulled.delete(file);
    this.#documents.set(file, {
      version: 1,
      text,
      usedAt: Date.now(),
      mtimeMs: info.mtimeMs,
      size: info.size,
      changedAt: Date.now(),
    });
    await this.#connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId: languageId(file), version: 1, text },
    });
    return { version: 1, changed: true };
  }

  /** 打开过的文档里磁盘上变了的重新同步（命令行改的文件也算进去）。 */
  async refreshOpen(): Promise<void> {
    await Promise.all([...this.#documents.keys()].map((file) => this.sync(file).catch(() => {})));
  }

  isOpen(file: string): boolean {
    return this.#documents.has(file);
  }

  /** 告诉服务器这些文件在磁盘上变了（没打开的文件靠它）。 */
  async filesChanged(changes: Array<{ file: string; deleted?: boolean; created?: boolean }>) {
    if (this.#exited || changes.length === 0) return;
    await this.#connection.sendNotification('workspace/didChangeWatchedFiles', {
      changes: changes.map((change) => ({
        uri: fileUri(change.file),
        type: change.deleted ? FILE_DELETED : change.created ? FILE_CREATED : FILE_CHANGED,
      })),
    });
  }

  #syncKind(): number {
    const sync = this.#capabilities.textDocumentSync;
    if (typeof sync === 'number') return sync;
    return sync?.change ?? SYNC_NONE;
  }

  async #didSave(uri: string, text: string): Promise<void> {
    const sync = this.#capabilities.textDocumentSync;
    const save = typeof sync === 'object' ? sync.save : undefined;
    if (save === undefined || save === false) return;
    const includeText = typeof save === 'object' && save.includeText === true;
    await this.#connection.sendNotification('textDocument/didSave', {
      textDocument: { uri },
      ...(includeText && { text }),
    });
  }

  #close(file: string): void {
    this.#documents.delete(file);
    void this.#connection
      .sendNotification('textDocument/didClose', { textDocument: { uri: fileUri(file) } })
      .catch(() => {});
  }

  #evict(): void {
    if (this.#documents.size < MAX_OPEN_DOCUMENTS) return;
    let oldest: [string, OpenDocument] | undefined;
    for (const entry of this.#documents) {
      if (oldest === undefined || entry[1].usedAt < oldest[1].usedAt) oldest = entry;
    }
    if (oldest !== undefined) this.#close(oldest[0]);
  }

  /** 已知的诊断（推送与拉取合并），不等。 */
  known(file: string): Diagnostic[] | undefined {
    const pushed = this.#pushed.get(file)?.diagnostics;
    const pulled = this.#pulled.get(file);
    if (pushed === undefined && pulled === undefined) return undefined;
    return dedupe([...(pushed ?? []), ...(pulled ?? [])]);
  }

  #pullIdentifiers(): Array<string | undefined> | undefined {
    const provider = this.#capabilities.diagnosticProvider;
    const registered = [...this.#registrations.values()].filter(
      (registration) => registration.workspaceDiagnostics !== true,
    );
    if (provider === undefined && registered.length === 0) return undefined;
    return [
      undefined,
      ...new Set(registered.flatMap((registration) => registration.identifier ?? [])),
    ];
  }

  /**
   * 文件的诊断（先 `sync`）：支持拉取的服务器发 `textDocument/diagnostic`；只推送的等文档当前版本的推送（不带版本的要晚于
   * 最后一次改动），150 ms 不再变化再取。
   */
  async diagnostics(file: string, timeoutMs: number): Promise<DiagnosticsResult> {
    const deadline = Date.now() + timeoutMs;
    const identifiers = this.#pullIdentifiers();
    if (identifiers !== undefined) {
      const reports = await Promise.all(
        identifiers.map((identifier) =>
          this.request<{
            kind?: string;
            items?: Diagnostic[];
            relatedDocuments?: Record<string, { items?: Diagnostic[] }>;
          } | null>(
            'textDocument/diagnostic',
            {
              textDocument: { uri: fileUri(file) },
              ...(identifier !== undefined && { identifier }),
            },
            Math.max(1, deadline - Date.now()),
          ).catch(() => undefined),
        ),
      );
      const items: Diagnostic[] = [];
      let handled = false;
      for (const report of reports) {
        if (!report) continue;
        if (Array.isArray(report.items)) {
          items.push(...report.items);
          handled = true;
        }
        for (const [uri, related] of Object.entries(report.relatedDocuments ?? {})) {
          const relatedFile = filePath(uri);
          if (relatedFile !== undefined && Array.isArray(related.items)) {
            this.#pulled.set(relatedFile, related.items);
          }
        }
      }
      if (handled) {
        this.#pulled.set(file, dedupe(items));
        this.diagnosticsAt = Date.now();
        return { diagnostics: this.known(file) ?? [], timedOut: false };
      }
    }
    const fresh = await this.#waitForPush(file, Math.max(0, deadline - Date.now()));
    this.diagnosticsAt = Date.now();
    return { diagnostics: this.known(file) ?? [], timedOut: !fresh };
  }

  #waitForPush(file: string, timeoutMs: number): Promise<boolean> {
    const isFresh = () => {
      const hit = this.#pushed.get(file);
      if (hit === undefined) return false;
      const document = this.#documents.get(file);
      if (document === undefined) return true;
      if (hit.version !== undefined) return hit.version >= document.version;
      return hit.at >= document.changedAt;
    };
    return new Promise<boolean>((done) => {
      let debounce: NodeJS.Timeout | undefined;
      let finished = false;
      const finish = (fresh: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(debounce);
        clearTimeout(timeout);
        this.#pushListeners.delete(listener);
        done(fresh);
      };
      const schedule = () => {
        if (!isFresh()) return;
        clearTimeout(debounce);
        const at = this.#pushed.get(file)?.at ?? Date.now();
        debounce = setTimeout(
          () => finish(true),
          Math.max(0, DIAGNOSTICS_DEBOUNCE_MS - (Date.now() - at)),
        );
      };
      const listener = (changed: string) => {
        if (changed === file) schedule();
      };
      const timeout = setTimeout(() => finish(isFresh()), timeoutMs);
      this.#pushListeners.add(listener);
      void this.#exit.then(() => finish(isFresh()));
      schedule();
    });
  }

  // ── 文件监视 ─────────────────────────────────────────────────────

  /**
   * 服务器注册了 didChangeWatchedFiles：在原生支持递归监视的平台（macOS、Windows）监视项目根，转发变动（.git 里的不算）。
   * Linux 上 Node 的递归监视要逐个目录建 inotify，大仓库代价高，不开；那里靠引擎的文件改动事件与打开文档的重新同步。
   */
  #startWatching(): void {
    if (this.#watcher !== undefined || this.#options.watch === false || this.#exited) return;
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
    try {
      this.#watcher = watch(this.root, { recursive: true, persistent: false }, (event, name) => {
        if (name === null) return;
        const file = path.join(this.root, name.toString());
        if (file.split(path.sep).includes('.git')) return;
        if (this.#watchQueue.size >= WATCH_BATCH_MAX) return;
        this.#watchQueue.set(file, this.#watchQueue.get(file) === 'rename' ? 'rename' : event);
        clearTimeout(this.#watchTimer);
        this.#watchTimer = setTimeout(() => void this.#flushWatched(), WATCH_DEBOUNCE_MS);
      });
      this.#watcher.on('error', (error) => {
        this.#options.onWarning?.('语言服务器的文件监视出错，已停止', {
          root: this.root,
          error: error.message,
        });
        this.#stopWatching();
      });
    } catch (error) {
      this.#options.onWarning?.('没能监视项目根的文件变动', {
        root: this.root,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #flushWatched(): Promise<void> {
    const batch = [...this.#watchQueue];
    this.#watchQueue.clear();
    const changes = await Promise.all(
      batch.map(async ([file, event]) => {
        const info = await stat(file).catch(() => undefined);
        if (info?.isDirectory()) return undefined;
        if (info === undefined) return { file, deleted: true };
        return event === 'rename' ? { file, created: true } : { file };
      }),
    );
    await this.filesChanged(changes.filter((change) => change !== undefined)).catch(() => {});
  }

  #stopWatching(): void {
    clearTimeout(this.#watchTimer);
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  /** 先 `shutdown` 再 `exit`，2 秒内没退出就结束进程。 */
  async shutdown(): Promise<void> {
    if (this.#closing) return this.#exit;
    this.#closing = true;
    this.#stopWatching();
    if (!this.#exited) {
      await this.request('shutdown', null, SHUTDOWN_TIMEOUT_MS).catch(() => {});
      await this.#connection.sendNotification('exit').catch(() => {});
      const exited = await Promise.race([
        this.#exit.then(() => true),
        sleep(SHUTDOWN_TIMEOUT_MS).then(() => false),
      ]);
      if (!exited) {
        this.#process.kill('SIGKILL');
        await this.#exit;
      }
    }
    this.#connection.dispose();
  }
}
