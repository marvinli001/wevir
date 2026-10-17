import { describe, expect, it } from 'vitest';
import { repairStreamingMarkdown as repair } from './stream-safe';

describe('repairStreamingMarkdown', () => {
  it('写完的文本不变', () => {
    for (const text of [
      '**粗体**与*斜体*、`code` 和 ~~删除~~。',
      '| a | b |\n|---|---|\n| 1 | 2 |\n',
      '- 一\n- 二\n',
      '```ts\nconst a = 1;\n```\n',
      '5 * 3 = 15',
      'snake_case_name',
    ]) {
      expect(repair(text)).toBe(text);
    }
  });

  it('补上末行没闭合的强调与行内代码，后开的先闭合', () => {
    expect(repair('第二轮回归**基本')).toBe('第二轮回归**基本**');
    expect(repair('一段*斜')).toBe('一段*斜*');
    expect(repair('运行 `pnpm te')).toBe('运行 `pnpm te`');
    expect(repair('~~旧')).toBe('~~旧~~');
    expect(repair('**粗 *斜')).toBe('**粗 *斜***');
    expect(repair('`a **b` **c')).toBe('`a **b` **c**');
  });

  it('刚写出的开头标记先去掉', () => {
    expect(repair('结论是 **')).toBe('结论是 ');
    expect(repair('结论是 `')).toBe('结论是 ');
    expect(repair('**粗体*')).toBe('**粗体**');
    expect(repair('**粗体**')).toBe('**粗体**');
  });

  it('写到一半的链接先只显示文字', () => {
    expect(repair('见 [文档](https://exa')).toBe('见 文档');
    expect(repair('见 [文')).toBe('见 文');
    expect(repair('见 [文档](https://example.com)')).toBe('见 [文档](https://example.com)');
  });

  it('只有块标记的末行与写到一半的围栏开头先不显示', () => {
    expect(repair('段落\n\n1.')).toBe('段落\n\n');
    expect(repair('段落\n- ')).toBe('段落\n');
    expect(repair('段落\n\n##')).toBe('段落\n\n');
    expect(repair('段落\n\n```t')).toBe('段落\n\n');
    expect(repair('段落\n\n``')).toBe('段落\n\n');
  });

  it('代码块里的内容不动', () => {
    expect(repair('```ts\nconst a = **b')).toBe('```ts\nconst a = **b');
    expect(repair('```\n| a |')).toBe('```\n| a |');
  });

  it('表格的分隔行到了才显示整张表', () => {
    expect(repair('结果：\n\n| 编号 | 结果 |')).toBe('结果：\n\n');
    expect(repair('结果：\n\n| 编号 | 结果 |\n')).toBe('结果：\n\n');
    expect(repair('结果：\n\n| 编号 | 结果 |\n|---|--')).toBe('结果：\n\n');
    expect(repair('结果：\n\n| 编号 | 结果 |\n|---|---|')).toBe('结果：\n\n');
    expect(repair('结果：\n\n| 编号 | 结果 |\n|---|---|\n')).toBe(
      '结果：\n\n| 编号 | 结果 |\n|---|---|\n',
    );
    expect(repair('| 编号 | 结果 |\n|---|---|\n| R1 | 通**过')).toBe(
      '| 编号 | 结果 |\n|---|---|\n| R1 | 通**过',
    );
  });
});
