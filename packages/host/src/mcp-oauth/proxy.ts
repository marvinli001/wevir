// 远程 MCP 服务的本机代理（0.97.0）：Host 在 RPC 的同一个端口上开 `/mcp/remote/<连接器 ID>`，引擎带 Host 发的代理令牌来，Host
// 换成 OAuth 访问令牌转发到连接器的地址。透明转发 Streamable HTTP（POST、GET 的 SSE 流、DELETE），不解析 MCP 消息，响应体边收边
// 发；访问令牌快过期时先刷新，上游回 401 时刷新一次再发。入口检查同 app-mcp.ts：只认代理令牌，拒绝带 Origin 或 Host 不是本机的
// 请求（防 DNS 重绑定）。

import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { MCP_REMOTE_PATH, type McpOAuthService, type OAuthTarget } from './service.js';
import { parseBearerChallenge } from './www-authenticate.js';

/** 能重发的请求体上限；更大的照样转发，但上游回 401 时不重发。 */
export const MCP_PROXY_REPLAY_LIMIT_BYTES = 4 * 1024 * 1024;
/** 跟随同 origin 的 307 / 308 的次数。 */
const MAX_REDIRECTS = 3;

/** 从引擎转给上游的请求头（Streamable HTTP 用到的）。 */
const FORWARD_REQUEST = [
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
] as const;
/** 从上游转回引擎的响应头。`www-authenticate` 只在 403 时转（401 时转了引擎会自己去做 OAuth 发现）。 */
const FORWARD_RESPONSE = [
  'content-type',
  'content-length',
  'content-encoding',
  'cache-control',
  'mcp-session-id',
  'mcp-protocol-version',
  'retry-after',
] as const;

export interface McpRemoteProxyOptions {
  oauth: McpOAuthService;
  /** 连接器的当前配置（展开后的地址与请求头）。 */
  target(id: string): OAuthTarget | undefined;
  onError?: (error: unknown) => void;
}

export class McpRemoteProxy {
  readonly #options: McpRemoteProxyOptions;
  #port: number | undefined;
  #closed = false;
  readonly #inflight = new Set<AbortController>();

  constructor(options: McpRemoteProxyOptions) {
    this.#options = options;
  }

  setPort(port: number): void {
    this.#port = port;
  }

  close(): void {
    this.#closed = true;
    for (const controller of this.#inflight) controller.abort();
  }

  /** 处理一个 HTTP 请求；不是 `/mcp/remote/…` 时返回 false，交给调用方。 */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (!path.startsWith(MCP_REMOTE_PATH)) return false;
    void this.#serve(req, res, decodeURIComponent(path.slice(MCP_REMOTE_PATH.length))).catch(
      (error: unknown) => {
        this.#options.onError?.(error);
        if (!res.headersSent) plain(res, 502);
        else res.destroy();
      },
    );
    return true;
  }

  async #serve(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (this.#closed) return plain(res, 503);
    if (req.headers.origin !== undefined || !localHost(req.headers.host, this.#port))
      return plain(res, 403);
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (token === undefined || this.#options.oauth.proxyTarget(token) !== id) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return plain(res, 401);
    }
    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      res.setHeader('Allow', 'GET, POST, DELETE');
      return plain(res, 405);
    }
    const target = this.#options.target(id);
    if (target?.auth !== 'oauth') return plain(res, 404);
    const controller = new AbortController();
    this.#inflight.add(controller);
    const abort = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on('close', abort);
    try {
      const body =
        req.method === 'POST' ? await readReplayable(req) : { buffered: Buffer.alloc(0) };
      let access = await this.#options.oauth.accessToken(id);
      if (access === undefined) return unauthorized(res);
      let response = await this.#send(target, req, body, access, controller.signal);
      if (response.statusCode === 401 && body.rest === undefined) {
        response.resume();
        access = await this.#options.oauth.afterUnauthorized(id, access);
        if (access === undefined) return unauthorized(res);
        response = await this.#send(target, req, body, access, controller.signal);
      }
      if (response.statusCode === 401) {
        response.resume();
        return unauthorized(res);
      }
      if (response.statusCode === 403) {
        const challenge = parseBearerChallenge(response.headers['www-authenticate']);
        if (challenge?.error === 'insufficient_scope')
          void this.#options.oauth.insufficientScope(id, challenge.scope);
      }
      const headers: OutgoingHttpHeaders = {};
      for (const name of FORWARD_RESPONSE) {
        const value = response.headers[name];
        if (value !== undefined) headers[name as string] = value;
      }
      if (response.statusCode === 403 && response.headers['www-authenticate'] !== undefined)
        headers['www-authenticate'] = response.headers['www-authenticate'];
      res.writeHead(response.statusCode ?? 502, headers);
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      // SSE 不缓冲：pipe 收到一块写一块。
      await new Promise<void>((resolve) => {
        response.pipe(res);
        response.on('error', () => res.destroy());
        res.on('close', resolve);
      });
    } catch (error) {
      // 引擎断开了：上游请求随之取消，不算错误。
      if (!controller.signal.aborted) throw error;
    } finally {
      this.#inflight.delete(controller);
      res.off('close', abort);
    }
  }

  /** 发一次上游请求，跟随同 origin 的 307 / 308；别的跳转回 502。 */
  async #send(
    target: OAuthTarget,
    req: IncomingMessage,
    body: Replayable,
    access: string,
    signal: AbortSignal,
  ): Promise<IncomingMessage> {
    const origin = new URL(target.url).origin;
    let url = new URL(target.url);
    for (let redirects = 0; ; redirects += 1) {
      const response = await upstream(url, req, target, body, access, signal);
      const status = response.statusCode ?? 0;
      if (status < 300 || status >= 400) return response;
      response.resume();
      const location = response.headers.location;
      let next: URL | undefined;
      try {
        next = location === undefined ? undefined : new URL(location, url);
      } catch {
        next = undefined;
      }
      if (
        next === undefined ||
        next.origin !== origin ||
        (status !== 307 && status !== 308) ||
        redirects >= MAX_REDIRECTS ||
        body.rest !== undefined
      )
        throw new Error(`The MCP server redirected the request (HTTP ${status})`);
      url = next;
    }
  }
}

interface Replayable {
  buffered: Buffer;
  /** 超过上限时还没读的部分：只能发一次。 */
  rest?: Readable;
}

async function readReplayable(req: IncomingMessage): Promise<Replayable> {
  const chunks: Buffer[] = [];
  let size = 0;
  const iterator = req[Symbol.asyncIterator]();
  for (;;) {
    const next = await iterator.next();
    if (next.done) return { buffered: Buffer.concat(chunks) };
    const chunk = next.value as Buffer;
    chunks.push(chunk);
    size += chunk.length;
    if (size > MCP_PROXY_REPLAY_LIMIT_BYTES) {
      const rest = Readable.from(
        (async function* () {
          for (;;) {
            const item = await iterator.next();
            if (item.done) return;
            yield item.value as Buffer;
          }
        })(),
      );
      return { buffered: Buffer.concat(chunks), rest };
    }
  }
}

function upstream(
  url: URL,
  req: IncomingMessage,
  target: OAuthTarget,
  body: Replayable,
  access: string,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const headers: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(target.headers))
    if (key.toLowerCase() !== 'authorization') headers[key] = value;
  for (const name of FORWARD_REQUEST) {
    const value = req.headers[name];
    if (value !== undefined) headers[name as string] = value;
  }
  headers.authorization = `Bearer ${access}`;
  headers['accept-encoding'] = 'identity';
  if (req.method === 'POST' && body.rest === undefined)
    headers['content-length'] = String(body.buffered.length);
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request: ClientRequest = send(url, { method: req.method, headers, signal }, resolve);
    request.on('error', reject);
    if (req.method !== 'POST') {
      request.end();
      return;
    }
    request.write(body.buffered);
    if (body.rest === undefined) request.end();
    else body.rest.pipe(request);
  });
}

function unauthorized(res: ServerResponse): void {
  res.setHeader('WWW-Authenticate', 'Bearer');
  plain(res, 401);
}

function localHost(host: string | undefined, port: number | undefined): boolean {
  if (host === undefined || port === undefined) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function plain(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' }).end(String(status));
}
