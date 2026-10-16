// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/shared/src/htmlRender.ts（readHtmlRenderLinkRequest、htmlRenderResult）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：不带 T3 的修饰键（Wevir 的链接一律交给系统浏览器）。
//
// 文件窗格里的网页（0.32.0）点外部链接时发来的 `ui/open-link` 请求（Host 插进页面的脚本，packages/host/src/html-preview.ts）。纯逻辑。

const OPEN_LINK_METHOD = 'ui/open-link';

/** A frame's `ui/open-link` request, if `data` is one with an http(s) URL. */
export function readOpenLinkRequest(
  data: unknown,
): { readonly id: string | number; readonly url: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { jsonrpc, id, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== '2.0' || method !== OPEN_LINK_METHOD) return undefined;
  if (typeof id !== 'string' && typeof id !== 'number') return undefined;
  if (typeof params !== 'object' || params === null) return undefined;
  const { url } = params as Record<string, unknown>;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? { id, url } : undefined;
}

/** The empty result a client sends back for a frame's request. */
export function openLinkResult(id: string | number) {
  return { jsonrpc: '2.0', id, result: {} } as const;
}
