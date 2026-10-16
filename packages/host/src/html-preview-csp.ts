// SPDX-License-Identifier: Apache-2.0
// 移植自 getpaseo/paseo packages/app/src/file-pane/html-preview-csp.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra
// 由 Wevir 修改：Paseo 把策略写成 <meta http-equiv> 插在文档最前面，Wevir 由 Host 作为响应头下发（file-urls.ts），所以不需要
// 它的前言与 BOM 处理；另加 T3 Code 的 `sandbox`（不透明 origin），脚本、样式、图片、字体与音视频多放行 `'self'`（同一个令牌下的
// 文件：网页的相对引用）。
//
// A preview renders a self-contained document and nothing else. Inline styles and
// scripts run so a plan page keeps its layout and its diagrams; fetch, XHR,
// WebSocket, beacon, remote script, remote font, remote image, and form posts are
// all refused. Agent-written HTML is not trusted markup.
//
// What this does NOT stop: the document navigating itself. Wevir's desktop main
// process refuses sub-frame requests outside the Host's file URLs instead.

/** 文件预览里 HTML 的 CSP（0.32.0，host-api.md §1 的 `GET /files/…`）。 */
export const HTML_PREVIEW_CSP = [
  'sandbox allow-scripts allow-forms allow-popups allow-downloads',
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ');
