// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/src/components/markdown/markdown-math.ts
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：出错时的兜底不带 OpenWork 的 Tailwind 类名，标记改叫 data-math-error（样式在 styles/markdown.css）。
//
// 文件窗格里 Markdown 的数学公式（0.32.0）：`$…$`、`$$…$$`、`\(…\)`、`\[…\]` 交给 KaTeX。KaTeX 的 HTML 带 style 属性，渲染进程
// 的 CSP 不放行，markdown.ts 清洗时把它挪到 data-csp-style，挂上之后经 CSSOM 补回（同 Pierre 的补丁）。

import 'katex/dist/katex.min.css';
import katex from 'katex';
import type { MarkedExtension, TokenizerAndRendererExtension, Tokens } from 'marked';
import markedKatex from 'marked-katex-extension';

// Models emit LaTeX with two delimiter families. `marked-katex-extension` covers the
// standard `$...$` / `$$...$$` pair (same approach as upstream opencode web); the
// `\(...\)` / `\[...\]` pair below is added here because models emit it just as often
// and markdown would otherwise swallow the backslash escapes.
const INLINE_PAREN_RULE = /^\\\(([\s\S]+?)\\\)/;
const INLINE_BRACKET_RULE = /^\\\[([\s\S]+?)\\\]/;
const BLOCK_BRACKET_RULE = /^ {0,3}\\\[([\s\S]+?)\\\](?:\n+|$)/;

const KATEX_OPTIONS = {
  // Malformed LaTeX must degrade to visible source instead of taking down the
  // surrounding message, so never throw and never reject non-strict input.
  throwOnError: false,
  strict: false,
  // `htmlAndMathml` keeps the MathML branch for screen readers and for copy-as-TeX.
  output: 'htmlAndMathml',
} satisfies katex.KatexOptions;

function escapeMathSource(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Last-resort output when KaTeX throws something `throwOnError: false` does not
 * swallow (it only catches `ParseError`). Shows the original LaTeX so the reader
 * still gets the content, and leaves the rest of the message intact.
 */
function mathFallbackHtml(source: string) {
  return `<code data-math-error="">${escapeMathSource(source)}</code>`;
}

export function renderMathHtml(text: string, displayMode: boolean) {
  try {
    return katex.renderToString(text, { ...KATEX_OPTIONS, displayMode });
  } catch {
    return mathFallbackHtml(text);
  }
}

function guardRenderer(extension: TokenizerAndRendererExtension): TokenizerAndRendererExtension {
  if (!('renderer' in extension)) {
    return extension;
  }

  const renderer = extension.renderer;

  return {
    ...extension,
    renderer(token) {
      try {
        return renderer.call(this, token);
      } catch {
        return mathFallbackHtml(typeof token.raw === 'string' ? token.raw : '');
      }
    },
  };
}

type MathToken = Tokens.Generic & { text: string; displayMode: boolean };

function isMathToken(token: Tokens.Generic): token is MathToken {
  return typeof token.text === 'string' && typeof token.displayMode === 'boolean';
}

function renderMathToken(token: Tokens.Generic) {
  return isMathToken(token) ? renderMathHtml(token.text, token.displayMode) : false;
}

function bracketMath(
  name: string,
  level: 'inline' | 'block',
  rule: RegExp,
  displayMode: boolean,
  startDelimiter: string,
): TokenizerAndRendererExtension {
  return {
    name,
    level,
    start(src) {
      const index = src.indexOf(startDelimiter);
      return index === -1 ? undefined : index;
    },
    tokenizer(src) {
      const match = rule.exec(src);

      if (!match) {
        return undefined;
      }

      return { type: name, raw: match[0], text: (match[1] as string).trim(), displayMode };
    },
    renderer: renderMathToken,
  };
}

/**
 * Marked extension rendering `$...$`, `$$...$$`, `\(...\)` and `\[...\]` with KaTeX.
 */
export function markdownMath(): MarkedExtension {
  const dollarExtensions = markedKatex(KATEX_OPTIONS).extensions ?? [];

  return {
    extensions: [
      ...dollarExtensions.map(guardRenderer),
      // Block first: a standalone `\[ ... \]` should render as centred display math
      // rather than as display math nested inside a paragraph.
      bracketMath('blockBracketKatex', 'block', BLOCK_BRACKET_RULE, true, '\\['),
      bracketMath('inlineBracketKatex', 'inline', INLINE_BRACKET_RULE, true, '\\['),
      bracketMath('inlineParenKatex', 'inline', INLINE_PAREN_RULE, false, '\\('),
    ],
  };
}
