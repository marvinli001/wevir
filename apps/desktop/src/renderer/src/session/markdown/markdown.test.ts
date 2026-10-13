// 渲染器的纯逻辑测试，跑在 Node 上。Node 里没有 DOM，DOMPurify 用不了，这里换成原样返回，只核对 marked 的
// 输出与流式时的块复用；清洗在 Electron 渲染进程里生效。

import { describe, expect, it, vi } from 'vitest';
import {
  codeLanguage,
  createStreamingMarkdownRenderer,
  externalHref,
  renderMarkdownHtml,
} from './markdown';

vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

describe('renderMarkdownHtml', () => {
  it('代码块带语言标签与复制按钮，源码转义', () => {
    const html = renderMarkdownHtml('```ts\nconst a = 1 < 2;\n```');
    expect(html).toContain('data-code-block');
    expect(html).toContain('<span>ts</span>');
    expect(html).toContain('data-code-copy');
    expect(html).toContain('<code class="language-ts">const a = 1 &lt; 2;</code>');
  });

  it('原文里的 HTML 按文本显示；只有外部链接可点，图片显示为链接', () => {
    const html = renderMarkdownHtml(
      '<script>x</script>\n\n[官网](https://example.com) [本地](./a.md) ![图](https://e.com/a.png)',
    );
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<a href="https://example.com/" data-external-link="">官网</a>');
    expect(html).not.toContain('a.md"');
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

  it('codeLanguage 取信息串的第一个词并过滤怪字符', () => {
    expect(codeLanguage('TypeScript title="a"')).toBe('typescript');
    expect(codeLanguage('c++')).toBe('c++');
    expect(codeLanguage('"><x')).toBeUndefined();
    expect(codeLanguage(undefined)).toBeUndefined();
  });
});
