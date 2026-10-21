import { describe, expect, it } from 'vitest';
import {
  GENERATED_TITLE_MAX_LENGTH,
  loadTitleInstructions,
  opaqueLinks,
  parseGeneratedTitle,
  TITLE_INPUT_MAX_BYTES,
  TITLE_LINK_EXCERPT_MAX_LENGTH,
  titleInput,
} from './title.js';

describe('loadTitleInstructions', () => {
  it('读仓库的 thread-title.md，去掉文件头的注释', () => {
    const text = loadTitleInstructions();
    expect(text.startsWith('你为 Wevir 的会话起标题。')).toBe(true);
    expect(text).not.toContain('<!--');
    expect(text).toContain('{"title": "标题", "description": "检索摘要"}');
  });
});

describe('titleInput', () => {
  it('转义 & < >，超过上限时截断，不切开字符与转义序列', () => {
    expect(titleInput(' a<b>&c ')).toBe('<user_prompt>\na&lt;b&gt;&amp;c\n</user_prompt>');
    const long = titleInput('字'.repeat(1000));
    const body = long.slice('<user_prompt>\n'.length, -'\n</user_prompt>'.length);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(TITLE_INPUT_MAX_BYTES);
    expect(body).toBe('字'.repeat(Math.floor(TITLE_INPUT_MAX_BYTES / 3)));
    const amp = titleInput(`${'a'.repeat(TITLE_INPUT_MAX_BYTES - 2)}&`);
    expect(amp.endsWith('a\n</user_prompt>')).toBe(true);
  });
});

describe('opaqueLinks', () => {
  it('请求几乎只是链接时返回链接（去掉结尾标点、去重、最多两个）', () => {
    expect(opaqueLinks('https://github.com/acme/app/issues/42')).toEqual([
      'https://github.com/acme/app/issues/42',
    ]);
    expect(opaqueLinks('看下这个 https://github.com/acme/app/pull/57。')).toEqual([
      'https://github.com/acme/app/pull/57',
    ]);
    expect(
      opaqueLinks(
        'https://a.example/1 https://a.example/1 https://b.example/2 https://c.example/3',
      ),
    ).toEqual(['https://a.example/1', 'https://b.example/2']);
  });

  it('请求本身说清了主题、或没有 http(s) 链接时返回空', () => {
    expect(
      opaqueLinks(
        '登录接口返回 500，日志在 https://ci.example/run/1，帮我查一下 session-manager 里是不是 token 刷新的问题',
      ),
    ).toEqual([]);
    expect(opaqueLinks('ftp://example.com/file')).toEqual([]);
    expect(opaqueLinks('你好')).toEqual([]);
  });
});

describe('titleInput 的链接内容', () => {
  it('接上 <link_context>，属性与正文转义，正文折叠空白并截断', () => {
    const input = titleInput('https://x.example/a', [
      {
        url: 'https://x.example/a?q="1"',
        title: 'Retry <uploads>',
        excerpt: `a\n\n b ${'c'.repeat(400)}`,
      },
    ]);
    expect(input).toContain(
      '</user_prompt>\n<link_context>\n<link url="https://x.example/a?q=&quot;1&quot;" title="Retry &lt;uploads&gt;">\na b ',
    );
    const excerpt = input.split('\n')[5] ?? '';
    expect(Array.from(excerpt)).toHaveLength(TITLE_LINK_EXCERPT_MAX_LENGTH);
    expect(input.endsWith('</link>\n</link_context>')).toBe(true);
  });

  it('没有查到链接时与原来一样', () => {
    expect(titleInput('hi', [])).toBe('<user_prompt>\nhi\n</user_prompt>');
  });
});

describe('parseGeneratedTitle', () => {
  it('取 JSON 里的 title 与 description；去掉首尾引号、结尾标点与多余空白', () => {
    expect(
      parseGeneratedTitle('{"title": "“修复  登录 500。”", "description": "登录接口。"}'),
    ).toEqual({
      title: '修复 登录 500',
      description: '登录接口',
    });
    expect(parseGeneratedTitle('```json\n{"title":"Fix login"}\n```')).toEqual({
      title: 'Fix login',
    });
  });

  it('按长度截断；不是 JSON、没有 title 或整理后为空时返回 undefined', () => {
    expect(parseGeneratedTitle(JSON.stringify({ title: 'x'.repeat(100) }))?.title).toHaveLength(
      GENERATED_TITLE_MAX_LENGTH,
    );
    expect(parseGeneratedTitle('修复登录')).toBeUndefined();
    expect(parseGeneratedTitle('{"name": "x"}')).toBeUndefined();
    expect(parseGeneratedTitle('{"title": "。。"}')).toBeUndefined();
    expect(parseGeneratedTitle('{"title": ')).toBeUndefined();
  });
});
