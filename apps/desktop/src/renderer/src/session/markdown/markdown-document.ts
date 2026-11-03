// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/src/components/markdown/markdown-primitive.ts（mermaidBlockHtml、图片与 KaTeX 的接法）
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：改写，Mermaid 的占位用 Wevir 的类名与文案（样式在 styles/markdown.css），图片只认会话目录里的。
//
// 文件窗格里的 Markdown：同聊天的公式、Mermaid 与清洗逻辑，会话目录里的图片输出
// `<img data-file-image>`（地址由 markdown-view.tsx 向 Host 要）。

import { Marked } from 'marked';
import {
  BASE_OPTIONS,
  escapeHtml,
  externalHref,
  imageLinkHtml,
  renderer,
  sanitizeMarkdown,
} from './markdown';
import { markdownMath } from './markdown-math';

/** 这次渲染的文件里，图片的相对路径换成会话目录里的路径（renderDocumentHtml 同步设置）。 */
let documentImagePath: ((href: string) => string | undefined) | undefined;

const documentParser = new Marked<string, string>(
  {
    ...BASE_OPTIONS,
    renderer: {
      ...renderer,
      image({ href, text }) {
        const path = externalHref(href) ? undefined : documentImagePath?.(href);
        if (path === undefined) return imageLinkHtml(href, text);
        return `<img data-file-image="${escapeHtml(path)}" alt="${escapeHtml(text)}" loading="lazy">`;
      },
    },
  },
  markdownMath(),
);

/**
 * 文件窗格里的 Markdown：同 renderMarkdownHtml，`imagePath` 认得的图片输出成
 * `<img data-file-image>`。
 */
export function renderDocumentHtml(
  text: string,
  options: { imagePath?: (href: string) => string | undefined } = {},
): string {
  if (!text.trim()) return '';
  documentImagePath = options.imagePath;
  try {
    return sanitizeMarkdown(documentParser.parse(text, { async: false }), true);
  } finally {
    documentImagePath = undefined;
  }
}
