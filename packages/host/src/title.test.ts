import { describe, expect, it } from 'vitest';
import {
  GENERATED_TITLE_MAX_LENGTH,
  loadTitleInstructions,
  parseGeneratedTitle,
  TITLE_INPUT_MAX_BYTES,
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
