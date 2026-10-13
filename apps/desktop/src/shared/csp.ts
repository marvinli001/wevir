// 渲染进程的内容安全策略（Electron 安全清单第 7 条）。以响应头下发：构建产物由主进程的 `wevir:` 协议
// 处理器带上 `productionCsp()`；开发服务器由 electron.vite.config.ts 的 `server.headers` 带上
// `developmentCsp()`。本文件也被 electron.vite.config.ts 引用，不 import 任何包。

import { DEV_SERVER_PORT } from './renderer-origin.js';

/** Host 只监听 127.0.0.1、端口每次启动由系统分配（host-api.md §1），只能放行整个端口范围。 */
export const HOST_CONNECT_SRC = 'ws://127.0.0.1:*';

const COMMON = [
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];

/** 构建产物：没有内联脚本与样式，只连 Host。 */
export function productionCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src ${HOST_CONNECT_SRC}`,
    ...COMMON,
  ].join('; ');
}

/**
 * 开发服务器：React Fast Refresh 的引导脚本是内联的，Vite 以 `<style>` 注入 CSS（含 Tailwind），二者都
 * 由 Vite 的 `html.cspNonce` 带上 nonce，所以仍不需要 `'unsafe-inline'`；另放行 Vite 的 HMR WebSocket。
 * nonce 每次启动开发服务器时随机生成。
 */
export function developmentCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    `connect-src 'self' ws://localhost:${DEV_SERVER_PORT} ${HOST_CONNECT_SRC}`,
    ...COMMON,
  ].join('; ');
}
