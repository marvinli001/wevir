// 代码块语法高亮（T5.3）：只在消息定稿（流式结束）且代码块进入视口附近后做，做法参考 OpenWork
// markdown.tsx 的 enhanceNearViewport（候选 #5，只参考）。用 highlight.js 而不是 Shiki：highlight.js 输出
// 带类名的 <span>，颜色由 styles/markdown.css 按设计 Token 给出；Shiki 输出内联 style、默认引擎要 WASM，
// 都被渲染进程的 CSP 拦下（src/shared/csp.ts）。highlight.js 按需动态加载，首屏不带它。

type Highlighter = typeof import('highlight.js/lib/common').default;

let loading: Promise<Highlighter> | undefined;

function loadHighlighter(): Promise<Highlighter> {
  loading ??= import('highlight.js/lib/common').then((module) => module.default);
  return loading;
}

const HIGHLIGHTED = 'data-highlighted';
/** 超过这个长度的代码块不高亮（highlight.js 在主线程上同步执行）。 */
const MAX_HIGHLIGHT_LENGTH = 100_000;

/** 给 `root` 里还没高亮、标了已知语言的代码块上色。highlight.js 的输出已转义，可以直接写回。 */
export async function highlightCodeBlocks(root: HTMLElement): Promise<void> {
  const blocks = [
    ...root.querySelectorAll<HTMLElement>(`pre code[class^="language-"]:not([${HIGHLIGHTED}])`),
  ];
  if (blocks.length === 0) return;
  const hljs = await loadHighlighter();
  for (const code of blocks) {
    if (!code.isConnected || code.hasAttribute(HIGHLIGHTED)) continue;
    code.setAttribute(HIGHLIGHTED, '');
    const language = code.className.replace(/^language-/, '');
    const text = code.textContent ?? '';
    if (!hljs.getLanguage(language) || text.length > MAX_HIGHLIGHT_LENGTH) continue;
    code.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    code.classList.add('hljs');
  }
}

/** 元素进入视口（上下各放宽 320px）后调用一次 `enhance`。返回取消函数。 */
export function whenNearViewport(element: HTMLElement, enhance: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    enhance();
    return () => {};
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      enhance();
    },
    { rootMargin: '320px 0px' },
  );
  observer.observe(element);
  return () => observer.disconnect();
}
