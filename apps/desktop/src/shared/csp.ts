// 渲染进程的内容安全策略（Electron 安全清单第 7 条）。以响应头下发：构建产物由主进程的 `wevir:` 协议
// 处理器带上 `productionCsp(nonce)`；开发服务器由 electron.vite.config.ts 的 `server.headers` 带上
// `developmentCsp(nonce)`。本文件也被 electron.vite.config.ts 引用，不 import 任何包。
//
// 样式的 nonce（U3，ADR-0004 补记 9）：libraries.dev 的动效库在运行时插入 `<style>`（border-beam 每个实例渲染一个，
// metal-fx、img-fx 在模块加载时往 <head> 插全局样式），`style-src 'self'` 会拦下。比较过三种做法：
// - 只对样式放开 `'unsafe-inline'`：最简单，但模型输出、工具结果一旦绕过 DOMPurify 注入了 `<style>` 或 `style`
//   属性，就能盖住、伪造审批卡片这类界面（外连仍被 img-src / connect-src 挡住），等于拆掉一层防线。不采纳。
// - 把库的样式静态提取进自己的 CSS：metal-fx、img-fx 的全局样式是定值可以提取，border-beam 的样式按实例与属性
//   生成（实例 ID、强度、主题都写在规则里），只能 fork 或 pnpm patch，每次升级都要重做。不采纳。
// - 每次加载随机的 nonce（采用）：开发服务器本来就用 Vite 的 `html.cspNonce`；构建产物里 Vite 在 index.html 写一个
//   占位符 `CSP_NONCE_PLACEHOLDER`，协议处理器每次提供 index.html 时生成 128 位随机 nonce，替换占位符并写进这次的
//   响应头。渲染进程的 lib/style-nonce.ts 从 `<meta property="csp-nonce">` 读出 nonce，给经
//   `document.createElement('style')` 建出的元素都盖上。
// 取舍：注入的标记（innerHTML 等由解析器建出的 `<style>`）拿不到 nonce，照旧被拦，`style` 属性也照旧不放行（nonce 不管
// 属性；React 的 style 属性走 CSSOM，不受影响）；nonce 只进 `style-src`，`script-src` 仍然只有 `'self'`。代价是渲染进程里
// 任何脚本都能读到 nonce、经 createElement 建的 `<style>` 一律放行，也就是“能在渲染进程执行脚本”的人能加样式，而这种人本来
// 就拿到了渲染进程的全部权限（docs/security.md）。WebGL（metal-fx、img-fx 的 three）不受 CSP 管；这些库不建 Web Worker、
// 不用 blob: 或 eval，`default-src 'none'` 不需要为它们放开别的；img-fx 用 `new Image()` 加载图片，受 `img-src` 管。

import { DEV_SERVER_PORT } from './renderer-origin.js';

/** Host 只监听 127.0.0.1、端口每次启动由系统分配（host-api.md §1），只能放行整个端口范围。 */
export const HOST_CONNECT_SRC = 'ws://127.0.0.1:*';

/**
 * 构建产物 index.html 里的 nonce 占位符（Vite 的 `html.cspNonce`，electron.vite.config.ts）：协议处理器每次提供
 * index.html 时换成新的 nonce（main/renderer-files.ts）。
 */
export const CSP_NONCE_PLACEHOLDER = 'WEVIR_CSP_NONCE';

const COMMON = [
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];

/**
 * 构建产物：没有内联脚本，只连 Host。`nonce` 是这次加载的样式 nonce，只给 index.html 的响应；其他文件的响应头不决定
 * 页面的策略，省略时样式只放行 `'self'`。
 */
export function productionCsp(nonce?: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    nonce === undefined ? "style-src 'self'" : `style-src 'self' 'nonce-${nonce}'`,
    `connect-src ${HOST_CONNECT_SRC}`,
    ...COMMON,
  ].join('; ');
}

/**
 * 开发服务器：React Fast Refresh 的引导脚本是内联的，Vite 以 `<style>` 注入 CSS（含 Tailwind），二者都
 * 由 Vite 的 `html.cspNonce` 带上 nonce，所以仍不需要 `'unsafe-inline'`；另放行 Vite 的 HMR WebSocket。
 * nonce 每次启动开发服务器时随机生成；动效库插入的 `<style>` 同构建产物，由 lib/style-nonce.ts 盖上它。
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
