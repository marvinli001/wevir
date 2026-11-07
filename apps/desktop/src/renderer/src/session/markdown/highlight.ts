// 代码块语法高亮（T5.3）：只在消息定稿（流式结束）且代码块进入视口附近后做，做法参考 OpenWork
// markdown.tsx 的 enhanceNearViewport（候选 #5，只参考）。highlight.js 输出带类名的 <span>，颜色由
// styles/markdown.css 按设计 Token 给出；按需动态加载，首屏不带它。Shiki WASM 已获 CSP 放行；聊天接入仍需
// 复用 worker 生命周期、适配 AST 与主题样式，内联 style 继续受 CSP 限制（src/shared/csp.ts）。

type Highlighter = typeof import('highlight.js/lib/common').default;

let loading: Promise<Highlighter> | undefined;

function loadHighlighter(): Promise<Highlighter> {
  loading ??= import('highlight.js/lib/common').then((module) => module.default);
  return loading;
}

const HIGHLIGHTED = 'data-highlighted';
/** 超过这个长度的代码块不高亮（highlight.js 在主线程上同步执行）。 */
const MAX_HIGHLIGHT_LENGTH = 20_000;

/** 给 `root` 里还没高亮、标了已知语言的代码块上色。highlight.js 的输出已转义，可以直接写回。 */
export async function highlightCodeBlocks(root: HTMLElement): Promise<void> {
  const blocks = [
    ...root.querySelectorAll<HTMLElement>(`pre code[class^="language-"]:not([${HIGHLIGHTED}])`),
  ];
  if (blocks.length === 0) return;
  const hljs = await loadHighlighter();
  for (const [index, code] of blocks.entries()) {
    if (!code.isConnected || code.hasAttribute(HIGHLIGHTED)) continue;
    code.setAttribute(HIGHLIGHTED, '');
    const language = code.className.replace(/^language-/, '');
    const text = code.textContent ?? '';
    if (!hljs.getLanguage(language) || text.length > MAX_HIGHLIGHT_LENGTH) continue;
    code.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    code.classList.add('hljs');
    if (index < blocks.length - 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
