import { Marked } from 'marked';
import { expect, it } from 'vitest';
import { loadMath, mathReady, withMath } from './markdown-math-loader';

it('普通文本不加载公式，首次加载后已有和新建 parser 都保留 MathML', async () => {
  const parser = withMath(new Marked<string, string>());
  expect(mathReady()).toBe(false);
  expect(parser.parse('plain')).toContain('plain');
  expect(mathReady()).toBe(false);
  const loading = loadMath();
  expect(loadMath()).toBe(loading);
  await loading;
  expect(mathReady()).toBe(true);
  for (const current of [parser, withMath(new Marked<string, string>())]) {
    const html = current.parse('$x^2$');
    expect(html).toContain('katex');
    expect(html).toContain('<math');
  }
});
