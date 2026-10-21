// 登录回调服务器（RFC 8252 §7.3）：在 127.0.0.1 上临时开一个端口，只接受一次合法回调；回调页是 Host 直接返回的极简 HTML，
// 不引外部资源，语言按浏览器的 Accept-Language（中文或英文）。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CallbackServer {
  server: Server;
  port: number;
  close(): void;
}

/** 开在 127.0.0.1 上；`port` 为 0 时由系统分配。端口被占用时抛错。 */
export function listenCallback(
  port: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.off('error', reject);
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

const COPY = {
  zh: { ok: '登录完成，可以关闭此页。', failed: '登录失败', title: 'Wevir' },
  en: { ok: 'Signed in. You can close this page.', failed: 'Sign-in failed', title: 'Wevir' },
} as const;

/** 回调页：成功或失败（带原因代码）。 */
export function callbackPage(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  result: { ok: true } | { ok: false; reason: string },
): void {
  const lang = /^\s*zh\b/i.test(req.headers['accept-language'] ?? '') ? 'zh' : 'en';
  const copy = COPY[lang];
  const text = result.ok ? copy.ok : `${copy.failed}: ${result.reason}`;
  const body = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${copy.title}</title></head><body style="font:16px system-ui,sans-serif;margin:3em;text-align:center"><p>${escapeHtml(text)}</p></body></html>`;
  res
    .writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'referrer-policy': 'no-referrer',
    })
    .end(body);
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string,
  );
}
