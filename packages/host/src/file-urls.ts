// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/http.ts（assetResponseHeaders、assetByteRange、assetFileResponse）与
// apps/server/src/assets/AssetAccess.ts（workspace-file 令牌、同目录资源的扩展名与路径规则）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写，不用 Effect；令牌不签名，只在内存里（同 app-mcp.ts）；HTML 的 CSP 在 html-preview-csp.ts（另加 Paseo 的不能联网）。
//
// 文件预览的流式地址（0.32.0，host-api.md §1、§3.1 的 `workspace.fileUrl`）：PDF、网页、音视频、Office 文件与大图片不走 base64 的
// JSON-RPC，渲染进程从 Host 的 RPC 端口直接读（`GET /files/<令牌>/<路径>`）。照 T3 Code 的 AssetAccess：令牌按目录发，令牌给的
// 文件之外，同一目录里只读得到网页会引用的几类文件（相对引用与 Markdown 里的图片照常加载），路径里不能有以 `.` 开头的段；
// HTML 放进 CSP 的沙箱（不透明 origin），且不能联网（html-preview-csp.ts）；HTML 的 <head> 开头插一段点链接的脚本（html-preview.ts，T3 的
// htmlRender），外部链接请桌面端用系统浏览器打开。

import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { injectHtmlPreviewBootstrap } from './html-preview.js';
import { HTML_PREVIEW_CSP } from './html-preview-csp.js';
import { statWorkspaceFile } from './workspace-files.js';

/** 路径前缀。 */
export const FILE_URL_PREFIX = '/files/';
/** 令牌的有效期（T3 也是一小时）。 */
export const FILE_URL_TTL_MS = 60 * 60 * 1000;
/** 同时有效的令牌数上限，多了先丢最早的。 */
export const FILE_URL_MAX_TOKENS = 64;
/** 网页要插入点链接的脚本（html-preview.ts），整个读进内存；更大的照原样流出去。 */
const HTML_INJECT_MAX_BYTES = 8 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.aiff': 'audio/aiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

/** 同一目录里令牌也读得到的文件（T3 的 PREVIEW_ASSET_EXTENSIONS，加上音视频）。 */
const SIBLING_EXTENSIONS = new Set(Object.keys(CONTENT_TYPES));

// HTML 的 CSP：T3 的沙箱加 Paseo 的不能联网（html-preview-csp.ts，Apache-2.0）。
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

interface Grant {
  /** 目录的 realpath。 */
  root: string;
  expiresAt: number;
}

export interface FileUrlsOptions {
  now?: () => number;
  onError?: (error: unknown) => void;
}

/**
 * 发与认文件预览的令牌。令牌只在内存里（Host 重启后全部作废），按目录发：同一个目录在有效期还剩一半以上时给同一个。
 */
export class FileUrls {
  readonly #grants = new Map<string, Grant>();
  readonly #byRoot = new Map<string, string>();
  readonly #now: () => number;
  readonly #onError: ((error: unknown) => void) | undefined;
  #port: number | undefined;

  constructor(options: FileUrlsOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError;
  }

  /** RPC 服务监听之后才知道端口。 */
  setPort(port: number): void {
    this.#port = port;
  }

  /** `root`（realpath）下 `path` 的地址；端口未知时抛错。 */
  issue(root: string, path: string): { url: string; expiresAt: number } {
    if (this.#port === undefined) throw new Error('file urls are not listening yet');
    const now = this.#now();
    let token = this.#byRoot.get(root);
    let grant = token === undefined ? undefined : this.#grants.get(token);
    if (token === undefined || grant === undefined || grant.expiresAt - now < FILE_URL_TTL_MS / 2) {
      token = randomBytes(24).toString('base64url');
      grant = { root, expiresAt: now + FILE_URL_TTL_MS };
      this.#grants.set(token, grant);
      this.#byRoot.set(root, token);
      this.#prune(now);
    }
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return {
      url: `http://127.0.0.1:${this.#port}${FILE_URL_PREFIX}${token}/${encoded}`,
      expiresAt: grant.expiresAt,
    };
  }

  #prune(now: number): void {
    for (const [token, grant] of this.#grants) {
      if (grant.expiresAt > now && this.#grants.size <= FILE_URL_MAX_TOKENS) continue;
      this.#grants.delete(token);
      if (this.#byRoot.get(grant.root) === token) this.#byRoot.delete(grant.root);
    }
  }

  /** 处理一个 HTTP 请求；不是 `/files/` 时返回 `false`，交给调用方。 */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = req.url ?? '';
    if (!url.startsWith(FILE_URL_PREFIX)) return false;
    void this.#serve(req, res, url).catch((error: unknown) => {
      this.#onError?.(error);
      if (!res.headersSent) plain(res, 500);
      else res.destroy();
    });
    return true;
  }

  async #serve(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    // 防 DNS 重绑定：只认本机地址。渲染进程的 <img>、<iframe> 不一定带 Origin，不看它。
    if (!localHost(req.headers.host, this.#port)) return plain(res, 403);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return plain(res, 405);
    }
    const rest = url.slice(FILE_URL_PREFIX.length).split(/[?#]/, 1)[0] ?? '';
    const slash = rest.indexOf('/');
    if (slash <= 0) return plain(res, 404);
    const grant = this.#grants.get(rest.slice(0, slash));
    if (!grant || grant.expiresAt <= this.#now()) return plain(res, 404);
    let path: string;
    try {
      path = rest
        .slice(slash + 1)
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');
    } catch {
      return plain(res, 404);
    }
    if (!isServablePath(path)) return plain(res, 404);
    const file = await statWorkspaceFile(grant.root, path);
    if (!file) return plain(res, 404);
    const headers = fileResponseHeaders(path);
    if (isHtml(path) && file.size <= HTML_INJECT_MAX_BYTES) {
      const body = Buffer.from(
        injectHtmlPreviewBootstrap((await readFile(file.real)).toString('utf8')),
        'utf8',
      );
      headers['Content-Length'] = String(body.length);
      delete headers['Accept-Ranges'];
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    let status = 200;
    let start = 0;
    let end = file.size - 1;
    const rangeHeader = req.headers.range;
    // If-Range 要能确认是同一份字节，Host 不给校验器，带它时回整个文件（T3 同样）。
    if (
      req.method === 'GET' &&
      rangeHeader !== undefined &&
      req.headers['if-range'] === undefined
    ) {
      const range = byteRange(rangeHeader, file.size);
      if (range === 'unsatisfiable') {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${file.size}` });
        res.end();
        return;
      }
      if (range) {
        status = 206;
        ({ start, end } = range);
        headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
      }
    }
    const length = file.size === 0 ? 0 : end - start + 1;
    headers['Content-Length'] = String(length);
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || length === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(file.real, { start, end });
    stream.on('error', (error) => {
      this.#onError?.(error);
      res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}

/**
 * 令牌下能读的路径：令牌是按目录发的，任何相对路径都要过这一关（T3 对同目录资源的规则）——相对、不含 `..`、没有以 `.` 开头的段
 * （`.env`、`.git/`），扩展名是网页会引用的那几类或 Office 文件。
 */
export function isServablePath(path: string): boolean {
  if (path === '' || path.includes('\0') || path.includes('\\')) return false;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment.startsWith('.'))) return false;
  const extension = extname(path).toLowerCase();
  return SIBLING_EXTENSIONS.has(extension) || OFFICE_EXTENSIONS.has(extension);
}

/** 渲染进程按字节解析或交给系统预览的 Office 文件。 */
const OFFICE_EXTENSIONS = new Set([
  '.docx',
  '.xlsx',
  '.pptx',
  '.doc',
  '.xls',
  '.ppt',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
  '.key',
  '.numbers',
  '.pages',
]);

/** 响应头：类型按扩展名，HTML 与 SVG 带 CSP（T3 的 assetResponseHeaders，Wevir 都不缓存）。 */
export function fileResponseHeaders(path: string): Record<string, string> {
  const extension = extname(path).toLowerCase();
  const headers: Record<string, string> = {
    'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    // 令牌就是凭据：渲染进程（wevir://app、开发服务器）要 fetch Office 文件的字节。
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
  };
  if (isHtml(path)) headers['Content-Security-Policy'] = HTML_PREVIEW_CSP;
  else if (extension === '.svg') headers['Content-Security-Policy'] = SVG_CSP;
  return headers;
}

function isHtml(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === '.html' || extension === '.htm';
}

/** 单段的字节范围（T3 的 assetByteRange）；不支持的写法回 undefined，用整个文件。 */
export function byteRange(
  header: string,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (first !== undefined && last !== undefined && last < first) return undefined;
  if (size === 0 || (first !== undefined && first >= size) || (first === undefined && last === 0)) {
    return 'unsatisfiable';
  }
  const start = first ?? ((last as number) >= size ? 0 : size - (last as number));
  const end = first === undefined || last === undefined || last >= size ? size - 1 : last;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'unsatisfiable';
  return { start, end };
}

function localHost(host: string | undefined, port: number | undefined): boolean {
  if (host === undefined || port === undefined) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function plain(res: ServerResponse, status: number): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(String(status));
}
