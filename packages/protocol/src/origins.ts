// Host 的 Origin 白名单（ADR-0002 §1，host-api.md §1）。浏览器类客户端（桌面渲染进程）的 WebSocket 升级
// 必带 Origin 头，Host 只放行这里列出的；不带 Origin 的客户端（CLI、测试）不受影响。值由桌面端
// apps/desktop 决定（T5.1），桌面端的测试核对两边一致。

/** 渲染进程从自定义协议加载（electron-vite build 的产物，`wevir://app/index.html`）时的 origin。 */
export const DESKTOP_APP_ORIGIN = 'wevir://app';

/**
 * 开发模式下渲染进程来自 electron-vite 的开发服务器。端口固定（`strictPort`），被占用时开发服务器启动
 * 失败，不会换到白名单之外的端口。
 */
export const DESKTOP_DEV_SERVER_ORIGIN = 'http://localhost:5199';

/** 带 Origin 头的 WebSocket 升级只放行这些 origin（精确匹配），其余 403。 */
export const DESKTOP_RENDERER_ORIGINS: readonly string[] = [
  DESKTOP_APP_ORIGIN,
  DESKTOP_DEV_SERVER_ORIGIN,
];
