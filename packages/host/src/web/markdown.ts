import { createRequire } from 'node:module';
import TurndownService from 'turndown';

// 网页 → 正文 Markdown（docs/architecture/web-tools.md §4）：turndown 7.2.4（MIT，ADR-0004 补记 12）加它在 Node 里用的 DOM
// domino。先去掉不是正文的部分（脚本、样式、导航、侧栏、页脚、表单、图片、菜单与工具栏、换语言的链接、MediaWiki 页面框架），
// 有 `<main>` / `<article>` 且里面有足够的文字时只转它，链接改成绝对地址。

/**
 * domino（BSD-2-Clause，turndown 在 Node 里用的 DOM）自带的类型声明的是模块 `domino`、用的是浏览器的 DOM 类型，在 Node 的包里
 * 解析不了；这里经 require 取它（CommonJS），只声明用到的部分。
 */
interface DominoElement {
  textContent: string | null;
  readonly tagName: string;
  readonly parentNode: DominoElement | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  remove(): void;
}

/** domino 的 `querySelector` 找不到时返回 undefined（不是浏览器的 null），`body` 也可能没有。 */
interface DominoDocument {
  readonly title: string;
  readonly body: DominoElement | null | undefined;
  readonly documentElement: DominoElement;
  querySelector(selector: string): DominoElement | null | undefined;
  querySelectorAll(selector: string): ArrayLike<DominoElement>;
}

const { createDocument } = createRequire(import.meta.url)('@mixmark-io/domino') as {
  createDocument(html: string, force?: boolean): DominoDocument;
};

/** 不是正文的元素：整个删掉。图片对模型没用，只占上下文。 */
const NOISE = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'video',
  'audio',
  'picture',
  'img',
  'nav',
  'aside',
  'footer',
  'form',
  'button',
  'select',
  'input',
  'textarea',
  'dialog',
  '[hidden]',
  '[aria-hidden="true"]',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="search"]',
  '[role="toolbar"]',
  // MediaWiki（维基百科等）放在 <main> 里的页面框架：换语言与工具的下拉、编辑链接、跳转链接、导航框、分类。
  '.vector-dropdown',
  '.vector-page-toolbar',
  '.vector-header-container',
  '.mw-portlet',
  '.mw-editsection',
  '.mw-jump-link',
  '.navbox',
  '.catlinks',
  '.printfooter',
].join(',');

/** `<main>` / `<article>` 里至少有这么多字才只转它，否则转整个 `<body>`（有的站把正文放在别处）。 */
const MAIN_MIN_CHARS = 200;

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '_',
  linkStyle: 'inlined',
});
// 没有文字的链接（图标、被删掉的图片）只剩一个空的 `[](…)`，去掉。
turndown.addRule('emptyLink', {
  filter: (node) => node.nodeName === 'A' && (node.textContent ?? '').trim() === '',
  replacement: () => '',
});

export interface HtmlPage {
  title?: string;
  markdown: string;
}

/** HTML → 标题与正文 Markdown。`baseUrl` 是网页最终的地址，相对链接按它补全。 */
export function htmlToMarkdown(html: string, baseUrl: string): HtmlPage {
  const document = createDocument(html, true);
  const title = document.title.replace(/\s+/g, ' ').trim();
  for (const element of Array.from(document.querySelectorAll(NOISE))) element.remove();
  // 换语言的链接（hreflang）连同它所在的列表项一起去掉：一长串别的语言的名字不是正文。
  for (const link of Array.from(document.querySelectorAll('a[hreflang]'))) {
    (link.parentNode?.tagName === 'LI' ? link.parentNode : link).remove();
  }
  absolutize(document.querySelectorAll('a[href]'), 'href', baseUrl);
  const root = mainContent(document.querySelector('main'), document.querySelector('article'));
  const source = root ?? document.body ?? document.documentElement;
  const markdown = tidy(turndown.turndown(source as unknown as TurndownService.Node));
  return { ...(title !== '' && { title }), markdown };
}

function mainContent(
  ...candidates: (DominoElement | null | undefined)[]
): DominoElement | undefined {
  return candidates.find(
    (element): element is DominoElement =>
      element != null && (element.textContent ?? '').replace(/\s+/g, '').length >= MAIN_MIN_CHARS,
  );
}

function absolutize(elements: ArrayLike<DominoElement>, attribute: string, base: string): void {
  for (const element of Array.from(elements)) {
    const value = element.getAttribute(attribute)?.trim() ?? '';
    let url: URL | undefined;
    try {
      url = new URL(value, base);
    } catch {
      url = undefined;
    }
    // javascript: 与 data: 链接对模型没用，留文字、去链接。
    if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      element.removeAttribute(attribute);
    } else {
      element.setAttribute(attribute, url.href);
    }
  }
}

/** 去掉行尾空白与连续空行。 */
function tidy(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
