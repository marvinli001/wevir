// SPDX-License-Identifier: MIT
// 改写自 sst/opencode packages/opencode/src/tool/lsp.ts 与 tool/lsp.txt（操作的选择、1 起的行列、调用层次先 prepare 再取第一项）、
// packages/opencode/src/lsp/diagnostic.ts（诊断一行一条、每个文件有上限）
// 来源提交 e3c4eb242585dcd77be1a867391b7c25fd47ce52（v1.19.3）
// Copyright (c) 2025 opencode，MIT License
// 修改：opencode 是一个 `lsp` 工具带 operation、回 LSP 的原始 JSON；Wevir 按操作分成几个应用级工具，结果写成“相对路径:行:列 + 那一行”
// 的文本；位置可以给列，也可以给这一行上的符号名；加上诊断工具（指定文件或这个会话里引擎改过的文件，等服务器出结果有时限）；其他
// LSP 工具的结果末尾附上这个会话改过的文件里的错误；文件限会话文件夹内。说明文字是 Wevir 自己的。
//
// 代码智能（LSP 工具，domain-model §3.15）：经应用级工具（app-mcp.ts 的 `AppTool`）给会话里的 agent。

import { realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionId } from '@wevir/protocol';
import type { AgentEvent } from '@wevir/runtime-adapter';
import type { Storage } from '@wevir/storage';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  MarkedString,
  Range,
  SymbolInformation,
  WorkspaceSymbol,
} from 'vscode-languageserver-protocol';
import { type AppTool, AppToolError, type AppToolResult } from './app-mcp.js';
import {
  objectSchema,
  optionalEnum,
  optionalInt,
  optionalString,
  requiredString,
} from './app-tools.js';
import { fileUri, type LspClient, LspRequestError, MAX_DOCUMENT_BYTES } from './lsp/client.js';
import { isInside, type LspManager, LspUnavailableError } from './lsp/manager.js';

/** 位置类请求的时限：第一次请求时服务器可能还在加载项目。 */
const REQUEST_TIMEOUT_MS = 60_000;
/** 诊断的默认与最长等待。 */
export const DIAGNOSTICS_DEFAULT_MS = 15_000;
export const DIAGNOSTICS_MAX_MS = 120_000;
/** 附在其他 LSP 工具结果后面的改动文件诊断最多等多久。 */
const FEEDBACK_TIMEOUT_MS = 4_000;
/** 每个文件最多列几条诊断（opencode 的 MAX_PER_FILE 是 20，只列错误）。 */
const DIAGNOSTICS_PER_FILE = 50;
/** 一次诊断最多几个文件。 */
const DIAGNOSTICS_MAX_FILES = 50;
/** 引用、符号等的默认与最多条数。 */
const REFERENCES_DEFAULT = 200;
const REFERENCES_MAX = 2000;
const SYMBOLS_DEFAULT = 50;
const SYMBOLS_MAX = 500;
const DOCUMENT_SYMBOLS_MAX = 1000;
const CALLS_MAX = 300;
/** 上下文行与悬停的长度上限。 */
const CONTEXT_CHARS = 160;
const HOVER_CHARS = 6000;

/** LSP 工具的名字（都只读，不用批准；runtime-adapter 的 `APP_TOOLS_NO_APPROVAL` 也列了）。 */
export const LSP_TOOLS = [
  'lsp_definition',
  'lsp_references',
  'lsp_hover',
  'lsp_document_symbols',
  'lsp_workspace_symbols',
  'lsp_call_hierarchy',
  'lsp_diagnostics',
] as const;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const POSITION_PROPERTIES = {
  path: {
    type: 'string',
    description: "File in this session's folder, relative to it or absolute.",
  },
  line: { type: 'integer', minimum: 1, description: '1-based line number.' },
  column: {
    type: 'integer',
    minimum: 1,
    description: '1-based column of the symbol (UTF-16 code units). Give column or symbol.',
  },
  symbol: {
    type: 'string',
    description: 'Name of the symbol on that line, used instead of column (first match).',
  },
};

const SYMBOL_KINDS = [
  '',
  'file',
  'module',
  'namespace',
  'package',
  'class',
  'method',
  'property',
  'field',
  'constructor',
  'enum',
  'interface',
  'function',
  'variable',
  'constant',
  'string',
  'number',
  'boolean',
  'array',
  'object',
  'key',
  'null',
  'enum member',
  'struct',
  'event',
  'operator',
  'type parameter',
];
const SEVERITIES = ['', 'error', 'warning', 'info', 'hint'];

const kindName = (kind: number) => SYMBOL_KINDS[kind] ?? 'symbol';
/** 文档大纲不展开的种类：method、constructor、function、variable、constant（SymbolKind 6、9、12、13、14）。 */
const LOCAL_SCOPES = new Set([6, 9, 12, 13, 14]);

export interface LspToolsOptions {
  storage: Storage;
  lsp: LspManager;
}

interface Point {
  file: string;
  line: number;
  character: number;
}

/** 一次调用里读过的文件的行（给结果配上下文）。 */
class Lines {
  readonly #cache = new Map<string, Promise<string[] | undefined>>();
  readonly #cwd: string;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  get(file: string): Promise<string[] | undefined> {
    let lines = this.#cache.get(file);
    if (lines === undefined) {
      lines = isInside(this.#cwd, file) ? readLines(file) : Promise.resolve(undefined);
      this.#cache.set(file, lines);
    }
    return lines;
  }
}

async function readLines(file: string): Promise<string[] | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_DOCUMENT_BYTES) return undefined;
  const text = await readFile(file, 'utf8').catch(() => undefined);
  return text?.split(/\r\n|\r|\n/);
}

/** LSP 工具：交给 `AppTools`；`observe` 收会话的引擎事件。 */
export class LspTools {
  readonly tools: AppTool[];
  readonly #options: LspToolsOptions;
  readonly #realCwds = new Map<string, string>();

  constructor(options: LspToolsOptions) {
    this.#options = options;
    this.tools = [
      this.#definitionTool(),
      this.#referencesTool(),
      this.#hoverTool(),
      this.#documentSymbolsTool(),
      this.#workspaceSymbolsTool(),
      this.#callHierarchyTool(),
      this.#diagnosticsTool(),
    ];
  }

  /** 会话的引擎事件（Host 落库前）：记下引擎改过的文件。 */
  observe(sessionId: SessionId, event: AgentEvent): void {
    if (
      event.type !== 'tool.started' &&
      event.type !== 'tool.updated' &&
      event.type !== 'tool.finished'
    ) {
      return;
    }
    // 在 Host 的事件处理里调用：出错只能吞掉，不能挡住事件落库。
    try {
      const cwd = this.#options.storage.sessions.get(sessionId)?.cwd;
      if (cwd !== undefined) this.#options.lsp.observe(sessionId, cwd, event, this.#realCwd(cwd));
    } catch {}
  }

  /** 会话目录的真实路径（工具与服务器都用真实路径；会话目录经符号链接时，引擎报的路径要换过来）。 */
  #realCwd(cwd: string): string {
    let real = this.#realCwds.get(cwd);
    if (real === undefined) {
      try {
        real = realpathSync.native(cwd);
      } catch {
        real = cwd;
      }
      this.#realCwds.set(cwd, real);
    }
    return real;
  }

  // ── 工具 ───────────────────────────────────────────────────────────

  #definitionTool(): AppTool {
    return {
      name: 'lsp_definition',
      title: 'Go to definition',
      description:
        'Find where the symbol at a position is defined, using the language server of the file. kind "type" finds ' +
        'the definition of its type, "implementation" the implementations of an interface or abstract method. ' +
        'Results are path:line:column with the source line.',
      inputSchema: objectSchema(
        {
          ...POSITION_PROPERTIES,
          kind: { type: 'string', enum: ['definition', 'type', 'implementation'] },
        },
        ['path', 'line'],
      ),
      annotations: READ_ONLY,
      call: (args, { sessionId }) =>
        this.#run(sessionId, async ({ cwd, lines }) => {
          const kind =
            optionalEnum(args, 'kind', ['definition', 'type', 'implementation']) ?? 'definition';
          const { client, point, label } = await this.#position(args, cwd, lines);
          const method =
            kind === 'type'
              ? 'textDocument/typeDefinition'
              : kind === 'implementation'
                ? 'textDocument/implementation'
                : 'textDocument/definition';
          const result = await client.request<Location | Location[] | LocationLink[] | null>(
            method,
            positionParams(point),
            REQUEST_TIMEOUT_MS,
          );
          const targets = locations(result);
          if (targets.length === 0) return `No ${kind} found for ${label} (${client.label}).`;
          const body = await formatPoints(targets, cwd, lines);
          return `${targets.length === 1 ? kind[0]?.toUpperCase() + kind.slice(1) : `${targets.length} results`} for ${label}:\n${body}`;
        }),
    };
  }

  #referencesTool(): AppTool {
    return {
      name: 'lsp_references',
      title: 'Find references',
      description:
        'Find every reference to the symbol at a position across the project, using the language server (more ' +
        'complete than text search: follows imports, re-exports and renames, skips same-named symbols). Use it ' +
        'before renaming or changing a signature. Results are path:line:column with the source line.',
      inputSchema: objectSchema(
        {
          ...POSITION_PROPERTIES,
          includeDeclaration: { type: 'boolean', description: 'Default true.' },
          limit: { type: 'integer', minimum: 1, maximum: REFERENCES_MAX },
        },
        ['path', 'line'],
      ),
      annotations: READ_ONLY,
      call: (args, { sessionId }) =>
        this.#run(sessionId, async ({ cwd, lines }) => {
          const limit = optionalInt(args, 'limit', 1, REFERENCES_MAX) ?? REFERENCES_DEFAULT;
          const { client, point, label } = await this.#position(args, cwd, lines);
          const result = await client.request<Location[] | null>(
            'textDocument/references',
            {
              ...positionParams(point),
              context: { includeDeclaration: args.includeDeclaration !== false },
            },
            REQUEST_TIMEOUT_MS,
          );
          const refs = locations(result);
          if (refs.length === 0) return `No references found for ${label} (${client.label}).`;
          const files = new Set(refs.map((ref) => ref.file)).size;
          const shown = refs.slice(0, limit);
          const body = await formatPoints(shown, cwd, lines);
          const more =
            refs.length > shown.length
              ? `\n… ${refs.length - shown.length} more (raise limit, up to ${REFERENCES_MAX}).`
              : '';
          return `${refs.length} references to ${label} in ${files} file${files === 1 ? '' : 's'}:\n${body}${more}`;
        }),
    };
  }

  #hoverTool(): AppTool {
    return {
      name: 'lsp_hover',
      title: 'Hover',
      description:
        'Type, signature and documentation of the symbol at a position, as the editor shows on hover.',
      inputSchema: objectSchema(POSITION_PROPERTIES, ['path', 'line']),
      annotations: READ_ONLY,
      call: (args, { sessionId }) =>
        this.#run(sessionId, async ({ cwd, lines }) => {
          const { client, point, label } = await this.#position(args, cwd, lines);
          const result = await client.request<Hover | null>(
            'textDocument/hover',
            positionParams(point),
            REQUEST_TIMEOUT_MS,
          );
          const text = result === null ? '' : hoverText(result.contents).trim();
          if (text === '') return `No hover information for ${label} (${client.label}).`;
          return `${label}:\n${truncate(text, HOVER_CHARS)}`;
        }),
    };
  }

  #documentSymbolsTool(): AppTool {
    return {
      name: 'lsp_document_symbols',
      title: 'Document symbols',
      description:
        'Outline of a file from the language server: classes, functions, methods, variables and so on, nested, ' +
        'each with its line:column.',
      inputSchema: objectSchema({ path: POSITION_PROPERTIES.path }, ['path']),
      annotations: READ_ONLY,
      call: (args, { sessionId }) =>
        this.#run(sessionId, async ({ cwd }) => {
          const file = await sessionFile(cwd, requiredString(args, 'path'));
          const client = await this.#client(file, cwd);
          await client.sync(file);
          const result = await client.request<DocumentSymbol[] | SymbolInformation[] | null>(
            'textDocument/documentSymbol',
            { textDocument: { uri: fileUri(file) } },
            REQUEST_TIMEOUT_MS,
          );
          const rows: string[] = [];
          const walk = (symbols: DocumentSymbol[], depth: number) => {
            for (const symbol of symbols) {
              if (rows.length >= DOCUMENT_SYMBOLS_MAX) return;
              const at = symbol.selectionRange.start;
              const detail = symbol.detail ? ` — ${oneLine(symbol.detail)}` : '';
              rows.push(
                `${'  '.repeat(depth)}${kindName(symbol.kind)} ${symbol.name}${detail}  ${at.line + 1}:${at.character + 1}`,
              );
              // 函数、方法与变量里面的是局部变量和回调，大纲里不要。
              if (symbol.children && !LOCAL_SCOPES.has(symbol.kind))
                walk(symbol.children, depth + 1);
            }
          };
          const symbols = result ?? [];
          if (symbols.length > 0 && 'selectionRange' in (symbols[0] as object)) {
            walk(symbols as DocumentSymbol[], 0);
          } else {
            for (const symbol of (symbols as SymbolInformation[]).slice(0, DOCUMENT_SYMBOLS_MAX)) {
              const at = symbol.location.range.start;
              const container = symbol.containerName ? ` (in ${symbol.containerName})` : '';
              rows.push(
                `${kindName(symbol.kind)} ${symbol.name}${container}  ${at.line + 1}:${at.character + 1}`,
              );
            }
          }
          const name = displayPath(cwd, file);
          if (rows.length === 0) return `No symbols in ${name} (${client.label}).`;
          const more =
            rows.length >= DOCUMENT_SYMBOLS_MAX
              ? `\n… stopped at ${DOCUMENT_SYMBOLS_MAX} symbols.`
              : '';
          return `Symbols in ${name}:\n${rows.join('\n')}${more}`;
        }),
    };
  }

  #workspaceSymbolsTool(): AppTool {
    return {
      name: 'lsp_workspace_symbols',
      title: 'Workspace symbols',
      description:
        'Search the project for symbols (classes, functions, types…) by name, using the language servers. ' +
        "path picks the language: any file of that language in this session's folder; without it, the servers " +
        "already running for this session are searched. Only symbols in this session's folder unless " +
        'includeExternal is true (dependencies, standard library).',
      inputSchema: objectSchema(
        {
          query: { type: 'string', description: 'Name or part of it.' },
          path: POSITION_PROPERTIES.path,
          limit: { type: 'integer', minimum: 1, maximum: SYMBOLS_MAX },
          includeExternal: { type: 'boolean' },
        },
        ['query'],
      ),
      annotations: READ_ONLY,
      call: (args, { sessionId }) =>
        this.#run(sessionId, async ({ cwd }) => {
          const query = requiredString(args, 'query');
          const limit = optionalInt(args, 'limit', 1, SYMBOLS_MAX) ?? SYMBOLS_DEFAULT;
          const pathArg = optionalString(args, 'path');
          let clients: LspClient[];
          if (pathArg !== undefined) {
            const file = await sessionFile(cwd, pathArg);
            const client = await this.#client(file, cwd);
            await client.sync(file);
            clients = [client];
          } else {
            clients = this.#options.lsp.running(cwd);
            if (clients.length === 0) {
              throw new AppToolError(
                'No language server is running for this session yet. Pass path (any file of the language to search) to start one.',
              );
            }
          }
          const results = await Promise.all(
            clients.map((client) =>
              client.request<SymbolInformation[] | WorkspaceSymbol[] | null>(
                'workspace/symbol',
                { query },
                REQUEST_TIMEOUT_MS,
              ),
            ),
          );
          const external = args.includeExternal === true;
          let skipped = 0;
          const rows = results.flatMap((symbols) =>
            (symbols ?? []).flatMap((symbol) => {
              const location = symbol.location;
              const file = filePathOf(location.uri);
              if (!external && (file === undefined || !isInside(cwd, file))) {
                skipped += 1;
                return [];
              }
              const at = 'range' in location ? location.range.start : undefined;
              const where =
                file === undefined
                  ? location.uri
                  : `${displayPath(cwd, file)}${at === undefined ? '' : `:${at.line + 1}:${at.character + 1}`}`;
              const container = symbol.containerName ? ` (in ${symbol.containerName})` : '';
              return [`${kindName(symbol.kind)} ${symbol.name}${container}  ${where}`];
            }),
          );
          const outside =
            skipped > 0
              ? `\n(${skipped} outside this folder left out; includeExternal shows them.)`
              : '';
          if (rows.length === 0)
            return `No symbols match "${query}" in this session's folder.${outside}`;
          const shown = rows.slice(0, limit);
          const more =
            rows.length > shown.length
              ? `\n… ${rows.length - shown.length} more (raise limit).`
              : '';
          return `${rows.length} symbol${rows.length === 1 ? '' : 's'} matching "${query}":\n${shown.join('\n')}${more}${outside}`;
        }),
    };
  }

  #callHierarchyTool(): AppTool {
    return {
      name: 'lsp_call_hierarchy',
      title: 'Call hierarchy',
      description:
        'Callers ("incoming") or callees ("outgoing") of the function or method at a position, with each call site.',
      inputSchema: objectSchema(
        {
          ...POSITION_PROPERTIES,
          direction: { type: 'string', enum: ['incoming', 'outgoing'] },
        },
        ['path', 'line', 'direction'],
      ),
      annotations: READ_ONLY,
      call: (args, { sessionId }) =>
        this.#run(sessionId, async ({ cwd, lines }) => {
          const direction = optionalEnum(args, 'direction', ['incoming', 'outgoing']);
          if (direction === undefined)
            throw new AppToolError('direction must be incoming or outgoing.');
          const { client, point, label } = await this.#position(args, cwd, lines);
          const items = await client.request<CallHierarchyItem[] | null>(
            'textDocument/prepareCallHierarchy',
            positionParams(point),
            REQUEST_TIMEOUT_MS,
          );
          const item = items?.[0];
          if (item === undefined) return `No function or method at ${label} (${client.label}).`;
          const itemFile = filePathOf(item.uri);
          const rows: string[] = [];
          if (direction === 'incoming') {
            const calls = await client.request<CallHierarchyIncomingCall[] | null>(
              'callHierarchy/incomingCalls',
              { item },
              REQUEST_TIMEOUT_MS,
            );
            for (const call of (calls ?? []).slice(0, CALLS_MAX)) {
              const from = filePathOf(call.from.uri);
              rows.push(
                `${kindName(call.from.kind)} ${call.from.name}  ${await where(cwd, from, call.from.selectionRange, lines, false)}`,
              );
              for (const range of call.fromRanges) {
                rows.push(`    call at ${await where(cwd, from, range, lines, true)}`);
              }
            }
          } else {
            const calls = await client.request<CallHierarchyOutgoingCall[] | null>(
              'callHierarchy/outgoingCalls',
              { item },
              REQUEST_TIMEOUT_MS,
            );
            for (const call of (calls ?? []).slice(0, CALLS_MAX)) {
              const to = filePathOf(call.to.uri);
              rows.push(
                `${kindName(call.to.kind)} ${call.to.name}  ${await where(cwd, to, call.to.selectionRange, lines, false)}`,
              );
              for (const range of call.fromRanges) {
                rows.push(`    called at ${await where(cwd, itemFile, range, lines, true)}`);
              }
            }
          }
          const name = `${kindName(item.kind)} ${item.name}`;
          if (rows.length === 0) {
            return `No ${direction === 'incoming' ? 'callers' : 'calls'} found for ${name} (${client.label}).`;
          }
          return `${direction === 'incoming' ? 'Callers of' : 'Calls made by'} ${name}:\n${rows.join('\n')}`;
        }),
    };
  }

  #diagnosticsTool(): AppTool {
    return {
      name: 'lsp_diagnostics',
      title: 'Diagnostics',
      description:
        'Type errors and other problems the language server reports for files, read from disk as they are now. ' +
        'Without paths: the files this session changed since the last LSP result. Call it after editing code to ' +
        'catch errors right away; it waits up to timeoutMs for the server. severity "error" lists only errors, ' +
        '"warning" (default) errors and warnings, "all" everything.',
      inputSchema: objectSchema({
        paths: {
          type: 'array',
          items: { type: 'string' },
          maxItems: DIAGNOSTICS_MAX_FILES,
          description: "Files in this session's folder.",
        },
        severity: { type: 'string', enum: ['error', 'warning', 'all'] },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: DIAGNOSTICS_MAX_MS },
      }),
      annotations: READ_ONLY,
      call: (args, { sessionId }) =>
        this.#run(
          sessionId,
          async ({ cwd }) => {
            const severity =
              optionalEnum(args, 'severity', ['error', 'warning', 'all']) ?? 'warning';
            const timeoutMs =
              optionalInt(args, 'timeoutMs', 1000, DIAGNOSTICS_MAX_MS) ?? DIAGNOSTICS_DEFAULT_MS;
            const lsp = this.#options.lsp;
            let files: string[];
            if (args.paths !== undefined) {
              if (
                !Array.isArray(args.paths) ||
                args.paths.some((item) => typeof item !== 'string')
              ) {
                throw new AppToolError('paths must be an array of strings.');
              }
              files = await Promise.all(
                (args.paths as string[])
                  .slice(0, DIAGNOSTICS_MAX_FILES)
                  .map((item) => sessionFile(cwd, item)),
              );
              lsp.reported(sessionId, files);
            } else {
              const changed = await existingFiles(cwd, lsp.takeChanged(sessionId));
              files = changed
                .filter((file) => lsp.spec(file) !== undefined)
                .slice(-DIAGNOSTICS_MAX_FILES);
              if (files.length === 0) {
                return changed.length === 0
                  ? 'No files changed in this session since the last LSP result. Pass paths to check specific files.'
                  : `None of the changed files has a supported language (${lsp.languages}).`;
              }
            }
            const reports = await Promise.all(
              files.map((file) => this.#fileDiagnostics(file, cwd, timeoutMs)),
            );
            return formatDiagnostics(cwd, reports, severity);
          },
          { feedback: false },
        ),
    };
  }

  // ── 帮手 ───────────────────────────────────────────────────────────

  /** 跑一次工具：会话目录、错误换成工具错误，末尾附上改动文件的错误。 */
  async #run(
    sessionId: SessionId,
    body: (context: { cwd: string; lines: Lines }) => Promise<string>,
    options: { feedback?: boolean } = {},
  ): Promise<AppToolResult> {
    const record = this.#options.storage.sessions.get(sessionId);
    const workspace = record && this.#options.storage.workspaces.get(record.workspaceId);
    if (!record || !workspace || workspace.removedAt !== undefined) {
      throw new AppToolError('This Wevir session no longer exists.');
    }
    const cwd = await realpath(record.cwd).catch(() => record.cwd);
    try {
      let text = await body({ cwd, lines: new Lines(cwd) });
      if (options.feedback !== false) text += await this.#feedback(sessionId, cwd);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      if (error instanceof LspUnavailableError || error instanceof LspRequestError) {
        throw new AppToolError(unavailableText(error));
      }
      throw error;
    }
  }

  async #client(file: string, cwd: string): Promise<LspClient> {
    return this.#options.lsp.client(file, cwd);
  }

  /** 位置参数：文件、1 起的行，加上列或这一行上的符号名。 */
  async #position(
    args: Record<string, unknown>,
    cwd: string,
    lines: Lines,
  ): Promise<{ client: LspClient; point: Point; label: string }> {
    const file = await sessionFile(cwd, requiredString(args, 'path'));
    const line = optionalInt(args, 'line', 1, Number.MAX_SAFE_INTEGER);
    if (line === undefined) throw new AppToolError('line is required (1-based).');
    const text = await lines.get(file);
    if (text === undefined) throw new AppToolError(`Cannot read ${args.path}.`);
    const lineText = text[line - 1];
    if (lineText === undefined) {
      throw new AppToolError(`${args.path} has ${text.length} lines; line ${line} does not exist.`);
    }
    const column = optionalInt(args, 'column', 1, Number.MAX_SAFE_INTEGER);
    const symbol = optionalString(args, 'symbol');
    let character: number;
    if (column !== undefined) {
      character = Math.min(column - 1, lineText.length);
    } else if (symbol !== undefined) {
      const index = findSymbol(lineText, symbol);
      if (index < 0) {
        throw new AppToolError(
          `"${symbol}" is not on line ${line} of ${args.path}: ${truncate(lineText.trim(), CONTEXT_CHARS)}`,
        );
      }
      character = index;
    } else {
      throw new AppToolError('Give column (1-based) or symbol (a name on that line).');
    }
    const client = await this.#client(file, cwd);
    await client.refreshOpen();
    await client.sync(file);
    const word = wordAt(lineText, character);
    const label = `${word === '' ? '' : `${word} at `}${displayPath(cwd, file)}:${line}:${character + 1}`;
    return { client, point: { file, line: line - 1, character }, label };
  }

  /** 一个文件的诊断：启动服务器、同步磁盘内容、等结果。 */
  async #fileDiagnostics(file: string, cwd: string, timeoutMs: number): Promise<FileDiagnostics> {
    try {
      const client = await this.#client(file, cwd);
      const sync = await client.sync(file);
      if (sync === undefined) return { file, error: 'file no longer exists' };
      const result = await client.diagnostics(file, timeoutMs);
      return { file, server: client.label, ...result };
    } catch (error) {
      if (error instanceof LspUnavailableError || error instanceof LspRequestError) {
        return { file, error: `${unavailableLabel(error)}: ${error.message}` };
      }
      throw error;
    }
  }

  /**
   * 附在其他 LSP 工具结果末尾：这个会话改过、还没报过的文件里的错误（只看已在运行的服务器，不为此启动服务器）。
   */
  async #feedback(sessionId: SessionId, cwd: string): Promise<string> {
    const lsp = this.#options.lsp;
    const files = await existingFiles(cwd, lsp.takeChanged(sessionId));
    if (files.length === 0) return '';
    const reports = await Promise.all(
      files
        .slice(-DIAGNOSTICS_MAX_FILES)
        .map(async (file): Promise<FileDiagnostics | undefined> => {
          const client = await lsp.runningClient(file, cwd).catch(() => undefined);
          if (client === undefined) return undefined;
          try {
            if ((await client.sync(file)) === undefined) return undefined;
            return {
              file,
              server: client.label,
              ...(await client.diagnostics(file, FEEDBACK_TIMEOUT_MS)),
            };
          } catch {
            return undefined;
          }
        }),
    );
    const checked = reports.filter((report) => report !== undefined);
    if (checked.length === 0) return '';
    const withErrors = checked.filter((report) =>
      (report.diagnostics ?? []).some((item) => (item.severity ?? 1) === 1),
    );
    if (withErrors.length === 0) {
      return `\n\nFiles you changed since the last LSP result have no errors: ${checked
        .map((report) => displayPath(cwd, report.file))
        .join(', ')}.`;
    }
    return `\n\nErrors in files you changed since the last LSP result:\n${formatDiagnostics(cwd, withErrors, 'error')}`;
  }
}

interface FileDiagnostics {
  file: string;
  server?: string;
  diagnostics?: Diagnostic[];
  timedOut?: boolean;
  error?: string;
}

function formatDiagnostics(
  cwd: string,
  reports: readonly FileDiagnostics[],
  severity: 'error' | 'warning' | 'all',
): string {
  const max = severity === 'error' ? 1 : severity === 'warning' ? 2 : 4;
  const blocks: string[] = [];
  let errors = 0;
  let warnings = 0;
  for (const report of reports) {
    const name = displayPath(cwd, report.file);
    if (report.error !== undefined) {
      blocks.push(`${name}: not checked: ${report.error}`);
      continue;
    }
    const all = report.diagnostics ?? [];
    const shown = all
      .filter((item) => (item.severity ?? 1) <= max)
      .sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || compareRange(a.range, b.range));
    const fileErrors = all.filter((item) => (item.severity ?? 1) === 1).length;
    const fileWarnings = all.filter((item) => item.severity === 2).length;
    errors += fileErrors;
    warnings += fileWarnings;
    const stale = report.timedOut ? ' (server did not finish in time; may be incomplete)' : '';
    if (shown.length === 0) {
      blocks.push(`${name}: no ${severity === 'error' ? 'errors' : 'errors or warnings'}${stale}`);
      continue;
    }
    const counts = [
      fileErrors > 0 ? `${fileErrors} error${fileErrors === 1 ? '' : 's'}` : '',
      fileWarnings > 0 && max >= 2 ? `${fileWarnings} warning${fileWarnings === 1 ? '' : 's'}` : '',
    ]
      .filter((part) => part !== '')
      .join(', ');
    const rows = shown.slice(0, DIAGNOSTICS_PER_FILE).map((item) => {
      const at = item.range.start;
      const code = item.code === undefined ? '' : ` ${item.source ?? ''}(${String(item.code)})`;
      return `  ${at.line + 1}:${at.character + 1} ${SEVERITIES[item.severity ?? 1] ?? 'error'}${code}: ${truncate(oneLine(relativeIn(cwd, typeof item.message === 'string' ? item.message : item.message.value)), 500)}`;
    });
    const more =
      shown.length > DIAGNOSTICS_PER_FILE
        ? `\n  … ${shown.length - DIAGNOSTICS_PER_FILE} more`
        : '';
    blocks.push(
      `${name}: ${counts || `${shown.length} problem${shown.length === 1 ? '' : 's'}`}${stale}\n${rows.join('\n')}${more}`,
    );
  }
  const servers = [...new Set(reports.flatMap((report) => report.server ?? []))];
  // 没检查到的文件（服务器起不来、文件没了）不算进“0 errors”；没等到结果的另说明可能不全。
  const checked = reports.filter((report) => report.error === undefined).length;
  const unchecked = reports.length - checked;
  const incomplete = reports.filter((report) => report.timedOut === true).length;
  const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
  const notes = [
    ...(unchecked > 0 ? [`${files(unchecked)} not checked`] : []),
    ...(incomplete > 0 ? [`${files(incomplete)} may be incomplete`] : []),
  ];
  // 没检查到不是“没有错误”：说清这是环境问题，不要据此改代码。
  const environment =
    unchecked > 0
      ? `\nFiles not checked say nothing about errors in them. ${ENVIRONMENT_NOTE}`
      : '';
  const summary =
    checked === 0
      ? `No diagnostics: ${files(unchecked)} not checked.${environment}`
      : `${errors} error${errors === 1 ? '' : 's'}${max >= 2 ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''} in ${files(checked)}${servers.length > 0 ? ` (${servers.join(', ')})` : ''}${notes.length > 0 ? `; ${notes.join('; ')}` : ''}.`;
  return `${blocks.join('\n')}\n${summary}${checked === 0 ? '' : environment}`;
}

/** 语言服务器用不了或出错时给模型看的说明：这是环境问题，不是代码的问题。 */
const ENVIRONMENT_NOTE =
  'This is a problem with the language server environment, not with the code: do not change code because of it. ' +
  "Check the code with the project's build or test commands instead, and tell the user if code intelligence is needed " +
  '(the user can see, install and restart language servers in Wevir).';

function unavailableLabel(error: LspUnavailableError | LspRequestError): string {
  if (error instanceof LspRequestError) return 'language server error';
  return error.state === 'unsupported'
    ? 'no language server for this file type'
    : `language server unavailable (${error.state})`;
}

function unavailableText(error: LspUnavailableError | LspRequestError): string {
  const label = unavailableLabel(error);
  if (error instanceof LspUnavailableError && error.state === 'unsupported') {
    return `${label[0]?.toUpperCase()}${label.slice(1)}. ${error.message}`;
  }
  return `${label[0]?.toUpperCase()}${label.slice(1)}: ${error.message}\n${ENVIRONMENT_NOTE}`;
}

function compareRange(a: Range, b: Range): number {
  return a.start.line - b.start.line || a.start.character - b.start.character;
}

function positionParams(point: Point) {
  return {
    textDocument: { uri: fileUri(point.file) },
    position: { line: point.line, character: point.character },
  };
}

function filePathOf(uri: string): string | undefined {
  if (!uri.startsWith('file:')) return undefined;
  try {
    return path.normalize(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

/** 定义 / 引用的结果（Location、Location[]、LocationLink[]）换成排好序、去了重的位置。 */
function locations(result: Location | Location[] | LocationLink[] | null | undefined): Point[] {
  if (result === null || result === undefined) return [];
  const list = (Array.isArray(result) ? result : [result]) as Array<Location | LocationLink>;
  const points = list.flatMap((item): Point[] => {
    const uri = 'targetUri' in item ? item.targetUri : item.uri;
    const range = 'targetUri' in item ? item.targetSelectionRange : item.range;
    const file = filePathOf(uri);
    return file === undefined
      ? []
      : [{ file, line: range.start.line, character: range.start.character }];
  });
  const seen = new Set<string>();
  return points
    .filter((point) => {
      const key = `${point.file}:${point.line}:${point.character}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character);
}

async function formatPoints(points: readonly Point[], cwd: string, lines: Lines): Promise<string> {
  const rows = await Promise.all(
    points.map(async (point) => {
      const context = (await lines.get(point.file))?.[point.line]?.trim();
      const at = `${displayPath(cwd, point.file)}:${point.line + 1}:${point.character + 1}`;
      return context === undefined || context === ''
        ? at
        : `${at}  ${truncate(context, CONTEXT_CHARS)}`;
    }),
  );
  return rows.join('\n');
}

async function where(
  cwd: string,
  file: string | undefined,
  range: Range,
  lines: Lines,
  withContext: boolean,
): Promise<string> {
  if (file === undefined) return `${range.start.line + 1}:${range.start.character + 1}`;
  const at = `${displayPath(cwd, file)}:${range.start.line + 1}:${range.start.character + 1}`;
  if (!withContext) return at;
  const context = (await lines.get(file))?.[range.start.line]?.trim();
  return context ? `${at}  ${truncate(context, CONTEXT_CHARS)}` : at;
}

/** 会话目录里的相对路径（用 `/`）；目录外的写绝对路径。 */
export function displayPath(cwd: string, file: string): string {
  return isInside(cwd, file) ? path.relative(cwd, file).split(path.sep).join('/') : file;
}

/** 会话目录里的文件（真实路径，符号链接指到目录外的也拒绝）。 */
export async function sessionFile(cwd: string, input: string): Promise<string> {
  const absolute = path.resolve(cwd, input);
  const real = await realpath(absolute).catch(() => undefined);
  if (real === undefined) throw new AppToolError(`${input} does not exist.`);
  if (!isInside(cwd, real)) {
    throw new AppToolError(`${input} is not inside this session's folder (${cwd}).`);
  }
  const info = await stat(real).catch(() => undefined);
  if (!info?.isFile()) throw new AppToolError(`${input} is not a file.`);
  return real;
}

/** 还在的、在会话目录里的文件。 */
async function existingFiles(cwd: string, files: readonly string[]): Promise<string[]> {
  const result = await Promise.all(
    files.map(async (file) => {
      const real = await realpath(file).catch(() => undefined);
      return real !== undefined && isInside(cwd, real) ? real : undefined;
    }),
  );
  return [...new Set(result.filter((file) => file !== undefined))];
}

/** 这一行上符号名第一次出现的位置（前后不是标识符字符的优先）。 */
export function findSymbol(line: string, symbol: string): number {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const whole = new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, 'u').exec(line);
  return whole?.index ?? line.indexOf(symbol);
}

function wordAt(line: string, character: number): string {
  const match = /[\p{L}\p{N}_$#]+/gu;
  for (let found = match.exec(line); found !== null; found = match.exec(line)) {
    if (found.index <= character && character < found.index + found[0].length) return found[0];
    if (found.index > character) break;
  }
  return '';
}

function hoverText(contents: Hover['contents']): string {
  const piece = (value: MarkedString | { kind: string; value: string }): string =>
    typeof value === 'string'
      ? value
      : 'kind' in value
        ? value.value
        : `\`\`\`${value.language}\n${value.value}\n\`\`\``;
  return Array.isArray(contents) ? contents.map(piece).join('\n\n') : piece(contents);
}

/** 消息里写的会话目录内的绝对路径换成相对路径（clangd 的 note 带绝对路径）。 */
function relativeIn(cwd: string, text: string): string {
  return text.split(`${cwd}${path.sep}`).join('');
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
