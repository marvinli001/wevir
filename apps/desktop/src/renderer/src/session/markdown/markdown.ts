// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/src/components/markdown/markdown-primitive.ts
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：改写（T5.3，OpenWork 候选 #4）。保留 createStreamingMarkdownRenderer（流式时只重新 lex 末尾 2 个块，
// 已定的块复用同一个 {__html} 对象，含引用式链接定义时整篇重来）、KaTeX、Mermaid 与 DOMPurify 清洗。
// 去掉 emoji、favicon、视频与图片预览、Shiki；渲染器改为几乎不带类名的语义 HTML（样式在
// styles/markdown.css），因为 CSP 不放行 HTML 里的 style 属性：表格对齐用 align 属性，图片只显示为链接
// （CSP 也不加载外部图片）。原文里的 HTML 一律按文本显示。代码块只输出转义后的源码，高亮在流式结束且
// 进入视口后另做（highlight.ts）。链接不直接导航，由 markdown-view.tsx 经主进程用系统浏览器打开；U32 起相对与绝对路径的
// 链接是文件链接，点开在文件窗格里。文件窗格另用 markdown-document.ts，显示会话目录里的图片。

import DOMPurify from 'dompurify';
import { Marked, type RendererObject, type Token } from 'marked';
import { parseFileHref } from '@/files/file-path';
import { t } from '@/i18n';
import { sessionHrefId } from '@/session/session-link-model';
import { markdownMath } from './markdown-math';
import { repairStreamingMarkdown } from './stream-safe';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 能交给系统浏览器打开的链接；其余（相对路径、file:、javascript: 等）只显示文字。 */
export function externalHref(href: string): string | undefined {
  try {
    const url = new URL(href.trim());
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** 代码块语言：围栏信息串的第一个词，只留常见字符。 */
export function codeLanguage(lang: string | undefined): string | undefined {
  const first = lang?.trim().split(/\s+/)[0]?.toLowerCase();
  return first && /^[a-z0-9_+#.-]{1,32}$/.test(first) ? first : undefined;
}

export function codeBlockHtml(text: string, lang: string | undefined): string {
  const language = codeLanguage(lang);
  const label = escapeHtml(language ?? t('markdown.code'));
  const copy = escapeHtml(t('markdown.copyCode'));
  const codeClass = language ? ` class="language-${language}"` : '';
  return (
    `<div class="md-code" data-code-block="">` +
    `<div class="md-code-header"><span>${label}</span>` +
    `<button type="button" class="md-code-copy" data-code-copy="" aria-label="${copy}">${copy}</button>` +
    `</div><pre><code${codeClass}>${escapeHtml(text.replace(/\n$/, ''))}</code></pre></div>`
  );
}

/** 图片只显示为链接（CSP 也不加载外部图片）。 */
export function imageLinkHtml(href: string, text: string): string {
  const external = externalHref(href);
  const label = escapeHtml(text || href);
  return external ? `<a href="${escapeHtml(external)}" data-external-link="">${label}</a>` : label;
}

export const BASE_OPTIONS = {
  async: false,
  gfm: true,
  breaks: false,
  pedantic: false,
  silent: true,
} as const;

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

export const renderer: RendererObject<string, string> = {
  code({ text, lang }) {
    if (codeLanguage(lang) === 'mermaid') return mermaidBlockHtml(text);
    return codeBlockHtml(text, lang);
  },
  html({ text }) {
    return escapeHtml(text);
  },
  link({ href, title, tokens }) {
    const inner = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    const external = externalHref(href);
    if (external) {
      return `<a href="${escapeHtml(external)}" data-external-link=""${titleAttr}>${inner}</a>`;
    }
    // 会话链接（`wevir://session/<id>` 或 `#<id>`）：胶囊，悬停与点击由 session-link.tsx 的 MarkdownSessionLinks 处理。
    const sessionId = sessionHrefId(href);
    if (sessionId) {
      return `<a href="#" class="session-pill" data-session-link="${sessionId}"${titleAttr}>${inner}</a>`;
    }
    // 文件链接（U32，Codex 写 `[a.ts](/绝对路径/a.ts:12)`）：点开时由 markdown-view.tsx 交给文件窗格。
    if (parseFileHref(href)) {
      return `<a href="#" data-file-link="${escapeHtml(href)}"${titleAttr}>${inner}</a>`;
    }
    return inner;
  },
  image({ href, text }) {
    return imageLinkHtml(href, text);
  },
};

const parser = new Marked<string, string>({ ...BASE_OPTIONS, renderer }, markdownMath());

const SANITIZE_ATTR = [
  'href',
  'title',
  'class',
  'align',
  'start',
  'type',
  'checked',
  'disabled',
  'aria-label',
  'data-code-block',
  'data-code-copy',
  'data-external-link',
  'data-file-link',
  'data-session-link',
];

/**
 * KaTeX 的 HTML 带 style 属性，CSP 不放行：清洗前挪到 data-csp-style，挂上之后经 CSSOM 补回（mermaid.ts 的
 * restoreCspStyles）。只改 KaTeX 的输出：原文里的 HTML 已按文本转义，不会带进 style。
 */
function moveKatexStyles(html: string): string {
  return html.replace(/ style="([^"]*)"/g, ' data-csp-style="$1"');
}

export function sanitizeMarkdown(html: string, allowImages = false): string {
  return DOMPurify.sanitize(moveKatexStyles(html), {
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
    FORBID_TAGS: ['style', 'iframe', 'form', 'video', 'audio', ...(allowImages ? [] : ['img'])],
  });
}

/** 整篇渲染（已定的消息、历史）。 */
export function renderMarkdownHtml(text: string): string {
  if (!text.trim()) return '';
  return sanitizeMarkdown(parser.parse(text, { async: false }));
}

/**
 * 一个顶层块的 `dangerouslySetInnerHTML`。块的源码不变时返回同一个对象，React 就不会动它的 DOM，只有正在
 * 增长的末尾块重新渲染。
 */
export type MarkdownBlockHtml = { readonly __html: string };

export interface StreamingMarkdownRenderer {
  /** 每个顶层块清洗后的 HTML，按文档顺序。 */
  render(text: string): MarkdownBlockHtml[];
  /** 消息定稿后丢掉保留的 token。 */
  reset(): void;
}

interface StreamingState {
  source: string;
  tokens: Token[];
  blocks: MarkdownBlockHtml[];
}

/**
 * 每次追加时重新 lex 的块数：正在增长的块，加上它前面那个——增长中的块会回头改变前一个块的形状（列表的
 * 懒续行、setext 标题的下划线、表格的分隔行）。
 */
const STREAMING_RELEX_TAIL = 2;

function hasReferenceDefinition(tokens: readonly Token[]): boolean {
  return tokens.some((token) => token.type === 'def');
}

/**
 * 流式消息的增量渲染器。整篇渲染每来一个片段就要把全文重新 lex、parse、清洗一遍，代价随文本增长；这里保留
 * 上一帧的顶层 token，追加时只重新 lex 末尾，已定的块复用之前的 HTML 对象。引用式链接定义跨块生效，所以
 * 源码里有定义时总是整篇重来。末尾没写完的语法先经 stream-safe.ts 修补，不露出 `**`、半张表这类原文。
 */
export function createStreamingMarkdownRenderer(): StreamingMarkdownRenderer {
  let state: StreamingState | null = null;

  const renderBlock = (token: Token): MarkdownBlockHtml => ({
    __html: sanitizeMarkdown(parser.parser([token])),
  });

  const renderAll = (source: string, previous: StreamingState | null): StreamingState => {
    const tokens = parser.lexer(repairStreamingMarkdown(source));
    const reusable =
      previous && !hasReferenceDefinition(tokens) && !hasReferenceDefinition(previous.tokens)
        ? previous
        : null;
    const blocks = tokens.map((token, index) => {
      const priorToken = reusable?.tokens[index];
      const priorBlock = reusable?.blocks[index];
      return priorToken && priorBlock && priorToken.raw === token.raw
        ? priorBlock
        : renderBlock(token);
    });
    return { source, tokens, blocks };
  };

  const renderAppended = (source: string, previous: StreamingState): StreamingState | null => {
    const keep = previous.tokens.length - STREAMING_RELEX_TAIL;
    if (keep <= 0 || hasReferenceDefinition(previous.tokens)) return null;
    let offset = 0;
    for (const token of previous.tokens.slice(0, keep)) offset += token.raw.length;
    // 末尾修补（stream-safe.ts）只动最后一两个块，已定的块的 raw 仍与原文一致，下一次的 offset 才对得上。
    const tail = parser.lexer(repairStreamingMarkdown(source.slice(offset)));
    if (hasReferenceDefinition(tail)) return null;
    // 末尾没变的块同样复用（例如新片段只开了一个新块）。
    const previousTail = previous.tokens.slice(keep);
    const tailBlocks = tail.map((token, index) =>
      previousTail[index]?.raw === token.raw
        ? (previous.blocks[keep + index] ?? renderBlock(token))
        : renderBlock(token),
    );
    return {
      source,
      tokens: [...previous.tokens.slice(0, keep), ...tail],
      blocks: [...previous.blocks.slice(0, keep), ...tailBlocks],
    };
  };

  return {
    render(text) {
      // marked 在 lex 前统一换行符；这里照做，token 的 raw 长度才能对上 source 的下标。
      const source = text.replace(/\r\n|\r/g, '\n');
      if (state?.source === source) return state.blocks;
      const appended =
        state && source.startsWith(state.source) ? renderAppended(source, state) : null;
      state = appended ?? renderAll(source, state);
      return state.blocks;
    },
    reset() {
      state = null;
    },
  };
}
