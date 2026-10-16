// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/src/components/markdown/mermaid.ts
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：源码的检查、清洗与排队渲染照搬；挂到页面上的部分改写：渲染进程的 CSP 不放行注入的 <style> 与 style 属性，SVG 经
// DOMParser 解析后把 style 属性挪开、挂上再经 CSSOM 补回，<style> 换成 document.createElement 建的（带样式 nonce，
// lib/style-nonce.ts）；Mermaid 排版期间同样改走 CSSOM 与 nonce（withCspSafeStyles）；主题取 Wevir 的 useTheme，文案走 i18n，
// 样式在 styles/markdown.css；去掉“下载 SVG”。
//
// 文件窗格里 Markdown 的 Mermaid 图（0.32.0）：```mermaid 的代码块先显示源码，进入视口附近后再渲染成图，可切回源码；源码
// 太大、太复杂、带不安全的指令或渲染失败时只显示源码。Mermaid 约 1 MB，第一次用到时才加载。

import DOMPurify from 'dompurify';
import type { MermaidConfig } from 'mermaid';
import { type RefObject, useEffect } from 'react';
import { t } from '@/i18n';
import { useTheme } from '@/theme/theme';
import { whenNearViewport } from './highlight';

type ResolvedThemeMode = 'light' | 'dark';

export const MERMAID_LIMITS = {
  maxSourceBytes: 50_000,
  maxNodes: 250,
  maxEdges: 400,
  maxStatements: 400,
  maxLines: 800,
  renderTimeoutMs: 5_000,
};

export type MermaidGuardResult =
  | { ok: true }
  | { ok: false; reason: 'size' | 'complexity' | 'unsafe'; message: string };

export type MermaidRuntime = {
  initialize: (config: MermaidConfig) => void;
  render: (id: string, source: string) => Promise<{ svg: string }>;
};

export type MermaidRuntimeLoader = () => Promise<MermaidRuntime>;

export type MermaidRenderResult =
  | { status: 'rendered'; svg: string; sheets: string[] }
  | {
      status: 'source';
      reason: 'size' | 'complexity' | 'unsafe' | 'invalid' | 'timeout' | 'unavailable';
    };

const MERMAID_ARROW_PATTERN = /(?:--!?>|---|-.->|==>|~~~|<--!?>|<==>)/g;
const MERMAID_NODE_DECLARATION_PATTERN = /\b([A-Za-z_][\w-]{0,63})\s*(?=\[|\(\(|\(\[|\{|>)/g;
const MERMAID_PARTICIPANT_PATTERN =
  /^\s*(?:participant|actor|class|entity|state)\s+([A-Za-z_][\w-]{0,63})\b/gm;
const MERMAID_URL_ATTRIBUTES = new Set([
  'clip-path',
  'cursor',
  'fill',
  'filter',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'stroke',
]);
const MERMAID_REDIRECT_ATTRIBUTES = new Set(['href', 'src', 'xlink:href']);
const MERMAID_FORBIDDEN_ELEMENTS = 'a,foreignObject,image,iframe,object,embed,script,use';

let mermaidRuntimePromise: Promise<MermaidRuntime> | null = null;
let mermaidRenderQueue: Promise<void> = Promise.resolve();
let mermaidRenderId = 0;

export function normalizeCssEscapes(value: string) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\(?:\r\n|[\n\r\f])/g, '')
    .replace(
      /\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?|\\([^\n\r\f])/g,
      (_match: string, hex: string | undefined, escaped: string | undefined) => {
        if (!hex) return escaped ?? '';
        const codePoint = Number.parseInt(hex, 16);
        if (
          codePoint === 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return '\uFFFD';
        }
        return String.fromCodePoint(codePoint);
      },
    );
}

function hasUnsafeMermaidSource(source: string) {
  const normalized = normalizeCssEscapes(source);
  if (/%%\s*\{\s*(?:init|config)\s*:/i.test(normalized)) return true;
  if (/(?:^|[;\n\r])\s*click(?:\s|$)/i.test(normalized)) return true;

  const frontmatter = /^\s*---[^\S\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)---/.exec(normalized);
  if (frontmatter?.[1] && /(?:^|\n)\s*config\s*:/i.test(frontmatter[1])) return true;

  return /(?:javascript|data|blob|file|https?|wss?|ftp)\s*:|\/\/|@import\b|\burl\s*\(|\b(?:href|src|xlink:href)\s*=/i.test(
    normalized,
  );
}

function countMermaidStatements(source: string) {
  let count = 0;
  for (const statement of source.split(/[;\n]/)) {
    const trimmed = statement.trim();
    if (trimmed && !trimmed.startsWith('%%')) count += 1;
  }
  return count;
}

function estimateMermaidNodes(source: string) {
  const nodes = new Set<string>();

  for (const match of source.matchAll(MERMAID_NODE_DECLARATION_PATTERN)) {
    if (match[1]) nodes.add(match[1]);
  }

  for (const match of source.matchAll(MERMAID_PARTICIPANT_PATTERN)) {
    if (match[1]) nodes.add(match[1]);
  }

  for (const line of source.split('\n')) {
    if (!MERMAID_ARROW_PATTERN.test(line)) {
      MERMAID_ARROW_PATTERN.lastIndex = 0;
      continue;
    }
    MERMAID_ARROW_PATTERN.lastIndex = 0;
    const withoutLabels = line.replace(/\[[^\]\n]*\]|\([^)\n]*\)|\{[^}\n]*\}/g, '');
    const segments = withoutLabels.split(MERMAID_ARROW_PATTERN);
    MERMAID_ARROW_PATTERN.lastIndex = 0;

    for (const segment of segments) {
      const identifiers = segment.match(/[A-Za-z_][\w-]{0,63}/g);
      const identifier = identifiers?.at(-1);
      if (identifier) nodes.add(identifier);
    }
  }

  return nodes.size;
}

export function guardMermaidSource(source: string): MermaidGuardResult {
  if (source.length > MERMAID_LIMITS.maxSourceBytes) {
    return { ok: false, reason: 'size', message: 'Diagram source is too large to render safely.' };
  }
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > MERMAID_LIMITS.maxSourceBytes) {
    return { ok: false, reason: 'size', message: 'Diagram source is too large to render safely.' };
  }

  if (hasUnsafeMermaidSource(source)) {
    return {
      ok: false,
      reason: 'unsafe',
      message: 'Diagram source contains unsafe directives or resources.',
    };
  }

  const lines = source.split('\n').length;
  const statements = countMermaidStatements(source);
  const edges = source.match(MERMAID_ARROW_PATTERN)?.length ?? 0;
  MERMAID_ARROW_PATTERN.lastIndex = 0;
  const nodes = estimateMermaidNodes(source);
  if (
    lines > MERMAID_LIMITS.maxLines ||
    statements > MERMAID_LIMITS.maxStatements ||
    edges > MERMAID_LIMITS.maxEdges ||
    nodes > MERMAID_LIMITS.maxNodes
  ) {
    return { ok: false, reason: 'complexity', message: 'Diagram is too complex to render safely.' };
  }

  return { ok: true };
}

export function mermaidConfigForTheme(theme: ResolvedThemeMode): MermaidConfig {
  return {
    arrowMarkerAbsolute: false,
    deterministicIds: false,
    flowchart: { htmlLabels: false },
    htmlLabels: false,
    logLevel: 'fatal',
    maxEdges: MERMAID_LIMITS.maxEdges,
    maxTextSize: MERMAID_LIMITS.maxSourceBytes,
    secure: [
      'dompurifyConfig',
      'flowchart',
      'htmlLabels',
      'maxEdges',
      'maxTextSize',
      'secure',
      'securityLevel',
      'startOnLoad',
      'theme',
      'themeCSS',
      'themeVariables',
    ],
    securityLevel: 'strict',
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: theme === 'dark' ? 'dark' : 'default',
  };
}

export function isSafeMermaidSvgReference(value: string) {
  const normalized = normalizeCssEscapes(value).trim();
  if (!normalized) return true;
  if (/@import|(?:expression|behavior)\s*\(|-moz-binding/i.test(normalized)) return false;
  if (/(?:javascript|data|blob|file|https?|ftp):|(?:^|[\s("'=])\/\//i.test(normalized))
    return false;

  for (const match of normalized.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!/^#[A-Za-z_][\w:.-]*$/.test(match[2]?.trim() ?? '')) return false;
  }

  return true;
}

export function sanitizeMermaidSvg(svg: string) {
  if (
    typeof DOMPurify.sanitize !== 'function' ||
    typeof DOMParser === 'undefined' ||
    typeof XMLSerializer === 'undefined'
  ) {
    throw new MermaidSanitizerUnavailableError();
  }

  const clean = DOMPurify.sanitize(svg, {
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_ATTR: ['href', 'src', 'xlink:href'],
    FORBID_TAGS: ['a', 'embed', 'foreignObject', 'iframe', 'image', 'object', 'script', 'use'],
    USE_PROFILES: { svg: true, svgFilters: true },
  });
  const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.localName !== 'svg' || parsed.querySelector('parsererror')) {
    throw new Error('Mermaid returned invalid SVG.');
  }

  for (const forbidden of Array.from(root.querySelectorAll(MERMAID_FORBIDDEN_ELEMENTS))) {
    forbidden.remove();
  }

  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith('on') ||
        MERMAID_REDIRECT_ATTRIBUTES.has(name) ||
        ((name === 'style' || name === 'data-csp-style' || MERMAID_URL_ATTRIBUTES.has(name)) &&
          !isSafeMermaidSvgReference(attribute.value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }

    if (element.localName === 'style' && !isSafeMermaidSvgReference(element.textContent ?? '')) {
      element.remove();
    }
  }

  if (!root.hasAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return new XMLSerializer().serializeToString(root);
}

class MermaidTimeoutError extends Error {}
class MermaidSanitizerUnavailableError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new MermaidTimeoutError()), timeoutMs);
    void promise.then(resolve, reject).finally(() => globalThis.clearTimeout(timer));
  });
}

async function loadMermaidRuntime() {
  mermaidRuntimePromise ??= import('mermaid').then((module) => module.default);
  try {
    return await mermaidRuntimePromise;
  } catch (cause) {
    mermaidRuntimePromise = null;
    throw cause;
  }
}

function enqueueMermaidRender<T>(render: () => Promise<T>) {
  const result = mermaidRenderQueue.then(render, render);
  mermaidRenderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function renderMermaidSource(
  source: string,
  theme: ResolvedThemeMode,
  options: { loadRuntime?: MermaidRuntimeLoader; timeoutMs?: number } = {},
): Promise<MermaidRenderResult> {
  const guard = guardMermaidSource(source);
  if (!guard.ok) return { status: 'source', reason: guard.reason };

  const loadRuntime = options.loadRuntime ?? loadMermaidRuntime;
  const timeoutMs = options.timeoutMs ?? MERMAID_LIMITS.renderTimeoutMs;

  return enqueueMermaidRender(async () => {
    let loaded = false;
    try {
      const rendered = await withTimeout(
        (async () => {
          const runtime = await loadRuntime();
          loaded = true;
          runtime.initialize(mermaidConfigForTheme(theme));
          mermaidRenderId += 1;
          return withCspSafeStyles(() =>
            runtime.render(`wevir-mermaid-${mermaidRenderId}`, source),
          );
        })(),
        timeoutMs,
      );

      const { markup, sheets } = extractSvgStyles(rendered.svg);
      return {
        status: 'rendered',
        svg: sanitizeMermaidSvg(markup),
        sheets: sheets.filter((sheet) => isSafeMermaidSvgReference(sheet)),
      };
    } catch (cause) {
      if (cause instanceof MermaidTimeoutError) return { status: 'source', reason: 'timeout' };
      if (cause instanceof MermaidSanitizerUnavailableError || !loaded)
        return { status: 'source', reason: 'unavailable' };
      return { status: 'source', reason: 'invalid' };
    }
  });
}

/**
 * Mermaid 排版时在页面里临时建图（d3 的 `setAttribute('style', …)` 与它自己的 `<style>`），CSP 会拦下，量出来的文字宽度跟最终
 * 的图对不上。渲染期间把 style 属性改走 CSSOM、给新建的 `<style>` 盖上样式 nonce（lib/style-nonce.ts 只管 createElement）。
 * 这不放宽 CSP：CSSOM 写样式与带 nonce 的 `<style>` 本来就是放行的，拦的是注入的标记，这里只改 JS 的写法；渲染排队一个一个来，
 * 结束（或超时）后还原。
 */
async function withCspSafeStyles<T>(render: () => Promise<T>): Promise<T> {
  const nonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce;
  const elementProto = Element.prototype;
  const documentProto = Document.prototype;
  const setAttribute = elementProto.setAttribute;
  const createElementNS = documentProto.createElementNS;
  const parseFromString = DOMParser.prototype.parseFromString;
  // Mermaid 渲染最后自己用 DOMPurify 清洗一遍（DOMParser 解析出的文档继承 CSP，每个 style 属性报一次违规）：解析前同样改名。
  DOMParser.prototype.parseFromString = function (this: DOMParser, string: string, type) {
    // DOMPurify 在有 Trusted Types 的浏览器里传 TrustedHTML（CSP 没有强制 Trusted Types，换回字符串照样能解析）。
    return parseFromString.call(this, moveStyleAttributes(String(string)), type);
  };
  elementProto.setAttribute = function (this: Element, name: string, value: string) {
    if (
      name.toLowerCase() === 'style' &&
      (this instanceof HTMLElement || this instanceof SVGElement)
    ) {
      this.style.cssText = String(value);
      return;
    }
    setAttribute.call(this, name, value);
  };
  documentProto.createElementNS = function (
    this: Document,
    ...args: Parameters<Document['createElementNS']>
  ) {
    const element = (createElementNS as (...a: typeof args) => Element).apply(this, args);
    if (nonce && element.localName === 'style' && 'nonce' in element) {
      (element as HTMLElement).nonce = nonce;
    }
    return element;
  } as Document['createElementNS'];
  try {
    return await render();
  } finally {
    elementProto.setAttribute = setAttribute;
    documentProto.createElementNS = createElementNS;
    DOMParser.prototype.parseFromString = parseFromString;
  }
}

function sourceStatus(reason: Exclude<MermaidRenderResult, { status: 'rendered' }>['reason']) {
  if (reason === 'size') return t('markdown.mermaidTooLarge');
  if (reason === 'complexity') return t('markdown.mermaidTooComplex');
  if (reason === 'unsafe') return t('markdown.mermaidUnsafe');
  if (reason === 'timeout') return t('markdown.mermaidTimeout');
  if (reason === 'unavailable') return t('markdown.mermaidUnavailable');
  return t('markdown.mermaidInvalid');
}

/**
 * 解析之前先在字符串上把 style 属性改名为 data-csp-style、取出 <style> 的内容：DOMParser 与 DOMPurify 解析出的文档继承页面的 CSP，
 * 里面的 style 属性与 <style> 每个都报一次违规（不渲染，只是噪音）。Mermaid 的输出由 XMLSerializer 生成，属性一律双引号。
 */
export function extractSvgStyles(svg: string): { markup: string; sheets: string[] } {
  const sheets: string[] = [];
  const markup = svg.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_match, text: string) => {
    sheets.push(text);
    return '';
  });
  return { markup: moveStyleAttributes(markup), sheets };
}

/** 标签里的 `style="…"` 改名为 `data-csp-style="…"`（文字内容里的不动）。 */
function moveStyleAttributes(markup: string): string {
  return markup.replace(/(<[^>]*?\s)style="/g, '$1data-csp-style="');
}

/**
 * 把清洗过的 SVG 挂进 `pane`，不触发 CSP：style 属性已经是 data-csp-style（extractSvgStyles），挂上后经 CSSOM 补回；样式表用
 * document.createElement 建的 <style>（style-nonce.ts 给它盖上 nonce）。
 */
export function mountSvg(pane: HTMLElement, svg: string, sheets: readonly string[]): void {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = document.importNode(parsed.documentElement, true);
  for (const text of sheets) {
    const style = document.createElement('style');
    style.textContent = text;
    root.prepend(style);
  }
  restoreCspStyles(root);
  pane.replaceChildren(root);
}

/** 经 CSSOM 补回挪到 data-csp-style 的 style 属性（KaTeX 的公式、Mermaid 的图）。 */
export function restoreCspStyles(root: Element): void {
  const elements = root.hasAttribute('data-csp-style')
    ? [root, ...Array.from(root.querySelectorAll<Element>('[data-csp-style]'))]
    : Array.from(root.querySelectorAll<Element>('[data-csp-style]'));
  for (const element of elements) {
    if (element instanceof HTMLElement || element instanceof SVGElement) {
      element.style.cssText = element.getAttribute('data-csp-style') ?? '';
    }
    element.removeAttribute('data-csp-style');
  }
}

const renderedDiagrams = new WeakSet<HTMLElement>();

function setMermaidView(element: HTMLElement, view: 'rendered' | 'source') {
  const rendered = element.querySelector<HTMLElement>('[data-mermaid-rendered]');
  const source = element.querySelector<HTMLElement>('[data-mermaid-source]');
  if (!rendered || !source) return;
  const showRendered = view === 'rendered' && renderedDiagrams.has(element);
  rendered.hidden = !showRendered;
  source.hidden = showRendered;
  element.dataset.mermaidState = showRendered ? 'rendered' : 'source';
  for (const button of element.querySelectorAll<HTMLButtonElement>('[data-mermaid-view]')) {
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.mermaidView === (showRendered ? 'rendered' : 'source')),
    );
  }
}

async function enhanceMermaidElement(
  element: HTMLElement,
  theme: ResolvedThemeMode,
  signal: AbortSignal,
) {
  const code = element.querySelector('[data-mermaid-source] code');
  const renderedPane = element.querySelector<HTMLElement>('[data-mermaid-rendered]');
  const renderedButton = element.querySelector<HTMLButtonElement>("[data-mermaid-view='rendered']");
  const status = element.querySelector<HTMLElement>('[data-mermaid-status]');
  if (!(code instanceof HTMLElement) || !renderedPane) return;

  element.setAttribute('aria-busy', 'true');
  if (status) {
    status.hidden = false;
    status.textContent = t('markdown.mermaidRendering');
  }

  const result = await renderMermaidSource(code.textContent ?? '', theme);
  if (signal.aborted || !element.isConnected) return;
  const preserveSource = renderedDiagrams.has(element) && element.dataset.mermaidState === 'source';

  element.setAttribute('aria-busy', 'false');
  if (result.status === 'source') {
    renderedDiagrams.delete(element);
    renderedPane.replaceChildren();
    element.dataset.mermaidReason = result.reason;
    if (renderedButton) renderedButton.disabled = true;
    if (status) status.textContent = sourceStatus(result.reason);
    setMermaidView(element, 'source');
    return;
  }

  delete element.dataset.mermaidReason;
  mountSvg(renderedPane, result.svg, result.sheets);
  renderedDiagrams.add(element);
  if (renderedButton) renderedButton.disabled = false;
  if (status) status.hidden = true;
  setMermaidView(element, preserveSource ? 'source' : 'rendered');
}

/** 渲染 `rootRef` 里的 Mermaid 代码块；`content` 变了（新的 HTML）或主题变了时重做。 */
export function useMermaidEnhancer(
  rootRef: RefObject<HTMLElement | null>,
  /** Identity of the rendered content; diagrams are re-enhanced when it changes. */
  content: unknown,
  enabled = true,
) {
  const { resolved: theme } = useTheme();

  // biome-ignore lint/correctness/useExhaustiveDependencies: content 只用来在 HTML 换了之后重做。
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;

    const controller = new AbortController();
    const diagrams = Array.from(root.querySelectorAll<HTMLElement>('[data-mermaid]'));

    const handleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest('button');
      const diagram = button?.closest('[data-mermaid]');
      if (!(button instanceof HTMLButtonElement) || !(diagram instanceof HTMLElement)) return;
      const view = button.dataset.mermaidView;
      if (view === 'source' || view === 'rendered') {
        event.preventDefault();
        setMermaidView(diagram, view);
      }
    };

    root.addEventListener('click', handleClick);
    const stops = diagrams.map((diagram) =>
      whenNearViewport(
        diagram,
        () => void enhanceMermaidElement(diagram, theme, controller.signal),
      ),
    );

    return () => {
      controller.abort();
      for (const stop of stops) stop();
      root.removeEventListener('click', handleClick);
    };
  }, [content, enabled, rootRef, theme]);
}
