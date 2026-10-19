// 应用级工具的 MCP 端点（0.30.0，domain-model §3.15）：Host 在 RPC 的同一个 HTTP 服务上开 `POST /mcp`，按 MCP 的 Streamable
// HTTP 传输回 JSON（不开 SSE 流，不记 MCP 会话），每个 Wevir 会话一个令牌，谁调的工具就是令牌对应的会话。照 T3 Code 的
// McpHttpServer / McpSessionRegistry（每个 provider 会话一个 bearer 令牌、只存摘要），写法是 Wevir 自己的：只用 Node 内置模块，
// 同 runtime-adapter 的 history-tool.ts。
//
// 一个进程服务所有会话的引擎（OpenCode）拿的是引擎令牌（`grantEngine`）：调用工具时在 `x-wevir-engine-session` 请求头里写自己的
// 引擎会话 ID，Host 映射回 Wevir 会话（只认交给这个引擎的 Provider 种类），之后与按会话的令牌一样。照 Paseo 的 OpenCode 桥
// （一个桥令牌，按 OpenCode 会话 ID 找 agent）。

import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionId } from '@wevir/protocol';
import { APP_TOOLS_ENGINE_SESSION_HEADER, type AppToolsEndpoint } from '@wevir/runtime-adapter';

/** 端点路径。 */
export const APP_MCP_PATH = '/mcp';
/** 请求体上限。 */
export const APP_MCP_BODY_LIMIT_BYTES = 1024 * 1024;
/** 支持的 MCP 协议版本，新的在前。 */
export const APP_MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** 工具结果（MCP `CallToolResult`）。 */
export interface AppToolResult {
  /** 文本，截图类的工具还有图片（base64）。 */
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** 一次工具调用的上下文。 */
export interface AppToolCall {
  /** 调用工具的会话（令牌对应的）。 */
  sessionId: SessionId;
  /** 客户端断开（引擎取消了这次调用）时触发。 */
  signal: AbortSignal;
}

export interface AppTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  call(args: Record<string, unknown>, call: AppToolCall): Promise<AppToolResult>;
}

/** 工具拒绝执行：结果带 `isError`，模型看得到原因。 */
export class AppToolError extends Error {}

export interface AppMcpServerOptions {
  tools: readonly AppTool[];
  /** `initialize` 结果里的服务版本。 */
  version: string;
  /**
   * 给模型的说明（`initialize` 的 `instructions`）。给函数时按调用方生成（记忆索引每个会话不同）；调用方不明（引擎令牌的
   * `initialize` 不带会话头）时 `sessionId` 是 `undefined`。
   */
  instructions?:
    | string
    | ((sessionId: SessionId | undefined) => string | undefined | Promise<string | undefined>);
  onError?: (error: unknown) => void;
  /**
   * 这个会话能用哪些工具（预设角色的限制，roles.ts；会话的工具预设，tool-presets.ts；Host 设置关掉的记忆工具）：`tools/list` 只列留下的，`tools/call` 拒绝没留下
   * 的。调用方不明（引擎令牌的 `tools/list` 不带会话头）时 `sessionId` 是 `undefined`，照样经过它（角色不限，Host 设置照样算）。
   * 不给时都能用。
   */
  filterTools?: (
    sessionId: SessionId | undefined,
    tools: readonly AppTool[],
  ) => readonly AppTool[] | Promise<readonly AppTool[]>;
  /**
   * 引擎令牌的调用方：引擎会话 ID → 由交给这个引擎的 Provider 种类（`kinds`）承载、还存在的 Wevir 会话；认不出时 `undefined`。
   * 不给时 `grantEngine` 不发令牌。
   */
  engineSession?: (kinds: readonly string[], engineSessionId: string) => SessionId | undefined;
  /**
   * 大输出落盘（tool-output.ts）：每个工具结果交回引擎之前经过它，太长的换成摘要与文件路径。不给时原样返回。
   */
  spill?: (sessionId: SessionId, toolName: string, result: AppToolResult) => Promise<AppToolResult>;
}

type JsonRpcId = string | number;
interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: JsonRpcId | null;
  method?: unknown;
  params?: unknown;
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * 应用级工具的 MCP 服务。令牌只在内存里：`grant` 给会话发一个（同一个会话在 Host 运行期间一直用同一个），只存摘要到会话的映射；
 * Host 重启后全部作废，恢复会话时适配器拿到新的。
 */
export class AppMcpServer {
  readonly #tools: ReadonlyMap<string, AppTool>;
  readonly #options: AppMcpServerOptions;
  readonly #tokens = new Map<SessionId, string>();
  readonly #sessions = new Map<string, SessionId>();
  /** 引擎令牌：Provider 种类（排序后用逗号连起来）→ 令牌；令牌摘要 → 种类。 */
  readonly #engineTokens = new Map<string, string>();
  readonly #engines = new Map<string, readonly string[]>();
  /** 进行中的请求：Host 退出时中止，长等待（`wevir_session_wait`）不拖住退出。 */
  readonly #inflight = new Set<AbortController>();
  #port: number | undefined;
  #closed = false;

  constructor(options: AppMcpServerOptions) {
    this.#options = options;
    this.#tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  }

  /** RPC 服务开始监听后调用：端点在同一个端口上。 */
  setPort(port: number): void {
    this.#port = port;
  }

  get url(): string | undefined {
    return this.#port === undefined ? undefined : `http://127.0.0.1:${this.#port}${APP_MCP_PATH}`;
  }

  /** 这个会话的端点与令牌；还没监听时 `undefined`（会话照常建，只是没有应用级工具）。 */
  grant(sessionId: SessionId): AppToolsEndpoint | undefined {
    const url = this.url;
    if (url === undefined) return undefined;
    let token = this.#tokens.get(sessionId);
    if (token === undefined) {
      token = randomBytes(32).toString('base64url');
      this.#tokens.set(sessionId, token);
      this.#sessions.set(digest(token), sessionId);
    }
    return { url, token };
  }

  /** 令牌对应的会话。 */
  sessionOf(token: string): SessionId | undefined {
    return this.#sessions.get(digest(token));
  }

  /**
   * 引擎令牌：只认 Provider 种类在 `kinds` 里的会话，同一组种类在 Host 运行期间一直用同一个。还没监听、没有种类或没有
   * `engineSession` 时 `undefined`。
   */
  grantEngine(kinds: readonly string[]): AppToolsEndpoint | undefined {
    const url = this.url;
    if (url === undefined || kinds.length === 0 || this.#options.engineSession === undefined) {
      return undefined;
    }
    const scope = [...new Set(kinds)].sort();
    const key = scope.join(',');
    let token = this.#engineTokens.get(key);
    if (token === undefined) {
      token = randomBytes(32).toString('base64url');
      this.#engineTokens.set(key, token);
      this.#engines.set(digest(token), scope);
    }
    return { url, token };
  }

  /** Host 退出：之后的请求回 503，进行中的工具调用收到中止。 */
  close(): void {
    this.#closed = true;
    for (const controller of this.#inflight) controller.abort();
  }

  get toolNames(): string[] {
    return [...this.#tools.keys()];
  }

  /**
   * 处理一个 HTTP 请求；不是 `/mcp` 时返回 `false`，交给调用方。只接受不带 `Origin` 的请求（引擎进程，不是浏览器，防 DNS
   * 重绑定）、`Host` 是本机地址、令牌有效的 `POST`。
   */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = (req.url ?? '').split('?')[0];
    if (path !== APP_MCP_PATH) return false;
    void this.#serve(req, res).catch((error: unknown) => {
      this.#options.onError?.(error);
      if (!res.headersSent) plain(res, 500);
      else res.destroy();
    });
    return true;
  }

  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.#closed) return plain(res, 503);
    if (req.headers.origin !== undefined || !localHost(req.headers.host, this.#port)) {
      return plain(res, 403);
    }
    const auth = req.headers.authorization ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    let sessionId = token === undefined ? undefined : this.sessionOf(token);
    const engineKinds =
      sessionId === undefined && token !== undefined ? this.#engines.get(digest(token)) : undefined;
    if (sessionId === undefined && engineKinds === undefined) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return plain(res, 401);
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return plain(res, 405);
    }
    if (engineKinds !== undefined) {
      // 引擎令牌：带了引擎会话 ID 就要认得出；不带时只能列工具（插件启动时），不能调用。
      const header = req.headers[APP_TOOLS_ENGINE_SESSION_HEADER];
      const engineSessionId = typeof header === 'string' ? header.trim() : '';
      if (engineSessionId !== '') {
        sessionId = this.#options.engineSession?.(engineKinds, engineSessionId);
        if (sessionId === undefined) return plain(res, 404);
      }
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      if (error instanceof BodyTooLarge) return plain(res, 413);
      return json(res, 400, rpcError(null, -32700, 'parse error'));
    }
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const messages = Array.isArray(body) ? body : [body];
    const replies: unknown[] = [];
    this.#inflight.add(controller);
    try {
      for (const message of messages) {
        const reply = await this.#message(message as JsonRpcMessage, sessionId, controller.signal);
        if (reply !== undefined) replies.push(reply);
      }
    } finally {
      this.#inflight.delete(controller);
    }
    if (res.destroyed) return;
    if (replies.length === 0) {
      res.writeHead(202).end();
      return;
    }
    json(res, 200, Array.isArray(body) ? replies : replies[0]);
  }

  /** `filterTools` 之后留下的工具；过滤本身出错时不放行（拒绝比越权安全）。 */
  async #visible(
    sessionId: SessionId | undefined,
    tools: readonly AppTool[],
  ): Promise<readonly AppTool[]> {
    const filter = this.#options.filterTools;
    if (filter === undefined) return tools;
    try {
      return await filter(sessionId, tools);
    } catch (error) {
      this.#options.onError?.(error);
      return [];
    }
  }

  /** 一条 JSON-RPC 消息；通知与客户端的回复返回 `undefined`。 */
  async #message(
    message: JsonRpcMessage,
    sessionId: SessionId | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (message === null || typeof message !== 'object' || typeof message.method !== 'string') {
      return message !== null && typeof message === 'object' && 'id' in message
        ? undefined
        : rpcError(null, -32600, 'invalid request');
    }
    const id = message.id;
    if (id === undefined || id === null) return undefined;
    const params = (message.params ?? {}) as Record<string, unknown>;
    switch (message.method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const protocolVersion = (APP_MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(
          requested,
        )
          ? requested
          : APP_MCP_PROTOCOL_VERSIONS[0];
        const configured = this.#options.instructions;
        let instructions: string | undefined;
        try {
          instructions =
            typeof configured === 'function' ? await configured(sessionId) : configured;
        } catch (error) {
          // 说明生成不出来不该让引擎连不上工具：这次不带说明（Host 给的函数自己兜底，到这里是意外）。
          this.#options.onError?.(error);
        }
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'wevir', title: 'Wevir', version: this.#options.version },
          ...(instructions !== undefined && { instructions }),
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, {
          tools: (await this.#visible(sessionId, [...this.#tools.values()])).map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { title: tool.title, ...tool.annotations },
          })),
        });
      case 'tools/call': {
        const tool = typeof params.name === 'string' ? this.#tools.get(params.name) : undefined;
        if (!tool) return rpcError(id, -32602, `unknown tool: ${String(params.name)}`);
        if (sessionId === undefined) {
          return rpcError(id, -32602, `${APP_TOOLS_ENGINE_SESSION_HEADER} is required`);
        }
        if ((await this.#visible(sessionId, [tool])).length === 0) {
          return rpcResult(
            id,
            errorResult(new AppToolError(`${tool.name} is not available to this session.`)),
          );
        }
        const args =
          params.arguments !== null && typeof params.arguments === 'object'
            ? (params.arguments as Record<string, unknown>)
            : {};
        let result: AppToolResult;
        try {
          result = await tool.call(args, { sessionId, signal });
        } catch (error) {
          if (!(error instanceof AppToolError)) this.#options.onError?.(error);
          result = errorResult(error);
        }
        const spill = this.#options.spill;
        return rpcResult(
          id,
          spill === undefined ? result : await spill(sessionId, tool.name, result),
        );
      }
      default:
        return rpcError(id, -32601, `method not found: ${message.method}`);
    }
  }
}

/** 工具的正常结果：JSON 文本，同时作为 `structuredContent`。 */
export function jsonResult(value: Record<string, unknown>): AppToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(error: unknown): AppToolResult {
  const message =
    error instanceof AppToolError
      ? error.message
      : `Wevir could not run this tool: ${error instanceof Error ? error.message : String(error)}`;
  return { content: [{ type: 'text', text: message }], isError: true };
}

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: JsonRpcId | null, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

function localHost(host: string | undefined, port: number | undefined): boolean {
  if (host === undefined || port === undefined) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > APP_MCP_BODY_LIMIT_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function plain(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' }).end(String(status));
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}
