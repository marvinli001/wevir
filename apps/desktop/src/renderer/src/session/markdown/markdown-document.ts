// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/src/components/markdown/markdown-primitive.ts（mermaidBlockHtml、图片与 KaTeX 的接法）
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：改写，Mermaid 的占位用 Wevir 的类名与文案（样式在 styles/markdown.css），图片只认会话目录里的。
//
// 文件窗格里的 Markdown（0.32.0，desktop-layout.md §19）：同 markdown.ts 的渲染器（移植自 OpenWork 的 markdown-primitive），另外
// 加回 OpenWork 的 KaTeX（markdown-math.ts）与 Mermaid 的代码块（mermaid.ts 在挂上后渲染），会话目录里的图片输出
// `<img data-file-image>`（地址由 markdown-view.tsx 向 Host 要）。单独一个模块：KaTeX 只随文件窗格（`React.lazy`）加载，不进
// 启动时的主块。

import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { t } from '@/i18n';
import {
  BASE_OPTIONS,
  codeBlockHtml,
  codeLanguage,
  escapeHtml,
  externalHref,
  imageLinkHtml,
  renderer,
  SANITIZE_ATTR,
} from './markdown';
import { markdownMath } from './markdown-math';

/** Mermaid 的代码块：先显示源码，mermaid.ts 渲染成图后可切换（照 OpenWork 的 mermaidBlockHtml，样式在 styles/markdown.css）。 */
function mermaidBlockHtml(text: string): string {
  const rendered = escapeHtml(t('markdown.mermaidRendered'));
  const source = escapeHtml(t('markdown.mermaidSource'));
  return (
    `<div class="md-mermaid" data-mermaid="" data-mermaid-state="source" aria-busy="false">` +
    `<div class="md-mermaid-header"><span>${escapeHtml(t('markdown.mermaid'))}</span>` +
    `<div role="group" class="md-mermaid-views">` +
    `<button type="button" data-mermaid-view="rendered" aria-pressed="false" disabled="">${rendered}</button>` +
    `<button type="button" data-mermaid-view="source" aria-pressed="true">${source}</button>` +
    `</div></div>` +
    `<div class="md-mermaid-rendered" data-mermaid-rendered="" hidden=""></div>` +
    `<pre data-mermaid-source=""><code class="language-mermaid">${escapeHtml(text)}</code></pre>` +
    `<p class="md-mermaid-status" data-mermaid-status="" aria-live="polite" hidden=""></p>` +
    `</div>`
  );
}

/** 这次渲染的文件里，图片的相对路径换成会话目录里的路径（renderDocumentHtml 同步设置）。 */
let documentImagePath: ((href: string) => string | undefined) | undefined;

const documentParser = new Marked<string, string>(
  {
    ...BASE_OPTIONS,
    renderer: {
      ...renderer,
      code(token) {
        if (codeLanguage(token.lang) === 'mermaid') return mermaidBlockHtml(token.text);
        return codeBlockHtml(token.text, token.lang);
      },
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
 * KaTeX 的 HTML 带 style 属性，CSP 不放行：清洗前挪到 data-csp-style，挂上之后经 CSSOM 补回（mermaid.ts 的
 * restoreCspStyles）。只改 KaTeX 的输出：原文里的 HTML 已按文本转义，不会带进 style。
 */
export function moveKatexStyles(html: string): string {
  return html.replace(/ style="([^"]*)"/g, ' data-csp-style="$1"');
}

function sanitizeDocument(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_ATTR: [
      ...SANITIZE_ATTR,
      'alt',
      'loading',
      'hidden',
      'role',
      'aria-hidden',
      'aria-pressed',
      'aria-busy',
      'aria-live',
      'data-file-image',
      'data-csp-style',
      'data-math-error',
      'data-mermaid',
      'data-mermaid-state',
      'data-mermaid-view',
      'data-mermaid-rendered',
      'data-mermaid-source',
      'data-mermaid-status',
      // KaTeX 的 MathML 与 SVG（根号、可伸缩的箭头）。
      'encoding',
      'xmlns',
      'display',
      'mathvariant',
      'width',
      'height',
      'viewbox',
      'viewBox',
      'preserveaspectratio',
      'preserveAspectRatio',
      'd',
    ],
    // img 只有 data-file-image（src 由 markdown-view.tsx 换成 Host 的文件地址）。
    FORBID_ATTR: ['src', 'srcset'],
    FORBID_TAGS: ['style', 'iframe', 'form', 'video', 'audio'],
  });
}

/**
 * 文件窗格里的 Markdown：同 renderMarkdownHtml，另外渲染公式（KaTeX）与 Mermaid 的代码块，`imagePath` 认得的图片输出成
 * `<img data-file-image>`。
 */
export function renderDocumentHtml(
  text: string,
  options: { imagePath?: (href: string) => string | undefined } = {},
): string {
  if (!text.trim()) return '';
  documentImagePath = options.imagePath;
  try {
    return sanitizeDocument(moveKatexStyles(documentParser.parse(text, { async: false })));
  } finally {
    documentImagePath = undefined;
  }
}
