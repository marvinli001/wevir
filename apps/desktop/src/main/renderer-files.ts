import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { CSP_NONCE_PLACEHOLDER, productionCsp } from '../shared/csp.js';
import { APP_HOST } from '../shared/renderer-origin.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * `wevir://app/<路径>` 的处理器：从构建产物目录 `root`（out/renderer）读文件，每个响应都带
 * `productionCsp()`。只接受 GET / HEAD 与主机 `app`；路径解码后必须仍在 `root` 之内。页面本身（index.html）每次
 * 都生成新的样式 nonce：换掉 Vite 写进去的占位符，并写进这次响应的 CSP（src/shared/csp.ts）。
 */
export async function serveRendererFile(request: Request, root: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return status(405);
  const url = new URL(request.url);
  if (url.host !== APP_HOST) return status(404);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return status(400);
  }
  const base = resolve(root);
  const target = resolve(base, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!target.startsWith(base + sep)) return status(403);
  let body: Buffer;
  try {
    body = await readFile(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return status(404);
    throw error;
  }
  let nonce: string | undefined;
  if (target === resolve(base, 'index.html')) {
    nonce = randomBytes(16).toString('base64');
    body = Buffer.from(body.toString('utf8').replaceAll(CSP_NONCE_PLACEHOLDER, nonce));
  }
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), {
    headers: {
      'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
      'Content-Security-Policy': productionCsp(nonce),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function status(code: number): Response {
  return new Response(null, { status: code });
}
