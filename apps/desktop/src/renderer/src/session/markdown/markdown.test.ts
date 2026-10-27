// 渲染器的纯逻辑测试，跑在 Node 上。Node 里没有 DOM，DOMPurify 用不了，这里换成原样返回，只核对 marked 的
// 输出与流式时的块复用；清洗在 Electron 渲染进程里生效。

import { describe, expect, it, vi } from 'vitest';
import {
  codeLanguage,
  createStreamingMarkdownRenderer,
  externalHref,
  renderMarkdownHtml,
} from './markdown';
import { renderDocumentHtml } from './markdown-document';
import { repairStreamingMarkdown } from './stream-safe';

vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

describe('renderMarkdownHtml', () => {
  it('代码块带语言标签与复制按钮，源码转义', () => {
    const html = renderMarkdownHtml('```ts\nconst a = 1 < 2;\n```');
    expect(html).toContain('data-code-block');
    expect(html).toContain('<span>ts</span>');
    expect(html).toContain('data-code-copy');
    expect(html).toContain('<code class="language-ts">const a = 1 &lt; 2;</code>');
  });

  it('原文里的 HTML 按文本显示；外部链接交给浏览器、本地路径是文件链接，图片显示为链接', () => {
    const html = renderMarkdownHtml(
      '<script>x</script>\n\n[官网](https://example.com) [本地](./a.md) ![图](https://e.com/a.png)',
    );
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<a href="https://example.com/" data-external-link="">官网</a>');
    expect(html).toContain('<a href="#" data-file-link="./a.md">本地</a>');
    expect(html).toContain('<a href="https://e.com/a.png" data-external-link="">图</a>');
    expect(html).not.toContain('<img');
  });

  it('表格对齐用 align 属性，不用 style（CSP 不放行内联样式）', () => {
    const html = renderMarkdownHtml('| a | b |\n|:-:|--:|\n| 1 | 2 |');
    expect(html).toContain('align="center"');
    expect(html).not.toContain('style=');
  });
});

describe('createStreamingMarkdownRenderer', () => {
  it('追加时已定的块复用同一个对象，只有末尾的块换新', () => {
    const renderer = createStreamingMarkdownRenderer();
    const first = renderer.render('# 标题\n\n第一段。\n\n第二段');
    const second = renderer.render('# 标题\n\n第一段。\n\n第二段继续写');
    expect(second[0]).toBe(first[0]);
    expect(second.at(-1)).not.toBe(first.at(-1));
    expect(second.at(-1)?.__html).toContain('第二段继续写');
    expect(renderer.render('# 标题\n\n第一段。\n\n第二段继续写')).toBe(second);
  });

  it('与整篇渲染结果一致（逐字追加一段 Markdown）', () => {
    const source =
      '## 汇总\n\n| 地区 | 金额 |\n|--|--:|\n| 华东 | 1 |\n\n1. 一\n2. 二\n\n```py\nprint(1)\n```\n';
    const renderer = createStreamingMarkdownRenderer();
    let blocks = renderer.render('');
    for (let i = 1; i <= source.length; i++) blocks = renderer.render(source.slice(0, i));
    expect(blocks.map((block) => block.__html).join('')).toBe(renderMarkdownHtml(source));
  });

  it('每个前缀都与修补后的整篇渲染一致（只重新 lex 末尾不会走样）', () => {
    const docs = [
      '## 结论\n\n第二轮回归**基本通过**，剩下三处：\n\n1. 第一 `a()`\n2. 第二\n   继续\n3. 第三\n\n| a | b |\n|---|---|\n| 1 | *2* |\n\n> 引用\n> 第二行\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\n- x [链接](https://x.y)\n- y\n  - z\n\n最后 ~~删~~。\n',
      '我先看看。\n\n**结论**：可以。\n\n- 一\n\n- 二\n\n段落\n标题\n===\n\n    缩进代码\n\n结束',
      'Intro\n\n1. **Bold** item with `code`\n2. Another\n\n## Heading\n\nText.\n\n---\n\nMore with [link](https://x.y).\n',
    ];
    for (const doc of docs) {
      const renderer = createStreamingMarkdownRenderer();
      for (let i = 1; i <= doc.length; i++) {
        const prefix = doc.slice(0, i);
        const html = renderer
          .render(prefix)
          .map((block) => block.__html)
          .join('');
        expect(html, JSON.stringify(prefix)).toBe(
          renderMarkdownHtml(repairStreamingMarkdown(prefix)),
        );
      }
    }
  });

  it('含引用式链接定义时整篇重来', () => {
    const renderer = createStreamingMarkdownRenderer();
    renderer.render('见[文档][d]。\n\n[d]: https://example.com\n\n后文');
    const blocks = renderer.render('见[文档][d]。\n\n[d]: https://example.com\n\n后文更多');
    expect(blocks.map((block) => block.__html).join('')).toContain(
      '<a href="https://example.com/" data-external-link="">文档</a>',
    );
  });
});

describe('辅助函数', () => {
  it('externalHref 只接受 http、https、mailto', () => {
    expect(externalHref('https://a.com/x')).toBe('https://a.com/x');
    expect(externalHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(externalHref('javascript:alert(1)')).toBeUndefined();
    expect(externalHref('file:///etc/passwd')).toBeUndefined();
    expect(externalHref('./a.md')).toBeUndefined();
  });

  it('文件路径的链接带 data-file-link，别的协议只留文字', () => {
    expect(renderMarkdownHtml('[a.ts](/Users/me/p/a.ts:12)')).toContain(
      '<a href="#" data-file-link="/Users/me/p/a.ts:12">a.ts</a>',
    );
    expect(renderMarkdownHtml('[x](javascript:alert(1))')).not.toContain('<a');
  });

  it('会话链接（wevir://session/<id> 或 #<id>）渲染成胶囊，别的锚点只留文字', () => {
    expect(renderMarkdownHtml('[修复登录](wevir://session/ses_ab12)')).toContain(
      '<a href="#" class="session-pill" data-session-link="ses_ab12">修复登录</a>',
    );
    expect(renderMarkdownHtml('[修复登录](#ses_ab12)')).toContain('data-session-link="ses_ab12"');
    expect(renderMarkdownHtml('[x](#section)')).not.toContain('<a');
    expect(renderMarkdownHtml('[x](wevir://session/ses_a"b)')).not.toContain('data-session-link');
  });

  it('codeLanguage 取信息串的第一个词并过滤怪字符', () => {
    expect(codeLanguage('TypeScript title="a"')).toBe('typescript');
    expect(codeLanguage('c++')).toBe('c++');
    expect(codeLanguage('"><x')).toBeUndefined();
    expect(codeLanguage(undefined)).toBeUndefined();
  });
});

describe('renderDocumentHtml（文件窗格，0.32.0）', () => {
  it('公式交给 KaTeX，style 挪到 data-csp-style', () => {
    const html = renderDocumentHtml('质能方程 $E = mc^2$ 与\n\n$$\\frac{a}{b}$$');
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
    expect(html).not.toContain(' style="');
    expect(html).toContain('data-csp-style="');
  });

  it('Mermaid 代码块先显示源码，会话目录里的图片输出 data-file-image', () => {
    const html = renderDocumentHtml(
      '```mermaid\ngraph TD; A-->B\n```\n\n![架构](./img/a.png) ![外部](https://example.com/b.png)',
      { imagePath: (href) => (href.startsWith('./') ? `docs/${href.slice(2)}` : undefined) },
    );
    expect(html).toContain('data-mermaid=""');
    expect(html).toContain('<code class="language-mermaid">graph TD; A--&gt;B</code>');
    expect(html).toContain('<img data-file-image="docs/img/a.png" alt="架构" loading="lazy">');
    // 外部图片仍只是链接。
    expect(html).toContain('<a href="https://example.com/b.png" data-external-link="">外部</a>');
    // 消息里的 Markdown 不变：没有公式与图。
    expect(renderMarkdownHtml('$E$')).toBe('<p>$E$</p>\n');
  });

  it('原文里的 HTML 照旧按文本显示', () => {
    expect(renderDocumentHtml('<img src=x onerror=alert(1)>')).toContain('&lt;img');
  });
});

describe('extractSvgStyles（Mermaid 的 SVG 挂上前）', () => {
  it('style 属性改名、<style> 取出', async () => {
    const { extractSvgStyles } = await import('./mermaid');
    const { markup, sheets } = extractSvgStyles(
      '<svg id="m" style="max-width: 10px;"><style>#m .node{fill:red}</style><g><rect style="fill:#fff" data-style="x"/><text>style="not attr"</text></g></svg>',
    );
    expect(sheets).toEqual(['#m .node{fill:red}']);
    expect(markup).toBe(
      '<svg id="m" data-csp-style="max-width: 10px;"><g><rect data-csp-style="fill:#fff" data-style="x"/><text>style="not attr"</text></g></svg>',
    );
  });
});
