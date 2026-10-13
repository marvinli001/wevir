// 渲染进程从哪里加载。Host 的 Origin 白名单（@wevir/protocol 的 DESKTOP_RENDERER_ORIGINS，host-api.md §1）
// 必须与这里一致，renderer-origin.test.ts 核对。本文件也被 electron.vite.config.ts 引用，不 import 任何包。

/** 构建产物经特权自定义协议加载：`wevir://app/index.html`（Electron 安全清单：不用 file://）。 */
export const APP_SCHEME = 'wevir';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

/** 开发模式下 electron-vite 开发服务器的固定端口（strictPort：被占用时启动失败，不换端口）。 */
export const DEV_SERVER_PORT = 5199;
export const DEV_SERVER_ORIGIN = `http://localhost:${DEV_SERVER_PORT}`;

/**
 * 一个 URL 的 origin，按渲染进程的方式算。WHATWG URL 对非特殊协议（`wevir:`）的 `origin` 一律是
 * `'null'`，所以自定义协议按 `<协议>//<主机>` 拼；不能解析时返回 undefined。
 */
export function rendererOriginOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol === `${APP_SCHEME}:`) return `${parsed.protocol}//${parsed.host}`;
  return parsed.origin === 'null' ? undefined : parsed.origin;
}
