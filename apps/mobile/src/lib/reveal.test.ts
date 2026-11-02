import { describe, expect, it } from 'vitest';
import { REVEAL_FRAME_MS, revealStep, streamSafe } from './reveal';

describe('revealStep', () => {
  it('放得比收到的慢，落后越多放得越快，写完以后放得更快', () => {
    const text = 'x'.repeat(1_000);
    const small = revealStep(0, 'x'.repeat(20), REVEAL_FRAME_MS, false);
    const large = revealStep(0, text, REVEAL_FRAME_MS, false);
    const ended = revealStep(0, text, REVEAL_FRAME_MS, true);
    expect(small).toBeGreaterThanOrEqual(1);
    expect(small).toBeLessThan(20);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThan(text.length);
    expect(ended).toBeGreaterThan(large);
  });

  it('追上之后停在全文，不切开代理对', () => {
    expect(revealStep(5, 'abcde', 100, false)).toBe(5);
    const emoji = 'a😀b';
    expect(revealStep(1, emoji, 1, false)).toBe(3);
  });

  it('按帧放字，一秒多就放完一段普通长度的回答', () => {
    const text = '回答'.repeat(300);
    let shown = 0;
    let frames = 0;
    while (shown < text.length && frames < 1_000) {
      shown = revealStep(shown, text, REVEAL_FRAME_MS, false);
      frames += 1;
    }
    expect(frames * REVEAL_FRAME_MS).toBeLessThan(2_000);
  });
});

describe('streamSafe', () => {
  it('末行只有块标记或半截围栏时先不显示', () => {
    expect(streamSafe('第一段\n\n- ')).toBe('第一段\n\n');
    expect(streamSafe('第一段\n#')).toBe('第一段\n');
    expect(streamSafe('看代码：\n```ts')).toBe('看代码：\n');
    expect(streamSafe('看代码：\n``')).toBe('看代码：\n');
  });

  it('末行没闭合的粗体与行内代码补上闭合，刚写出开头时去掉', () => {
    expect(streamSafe('这是 **重点')).toBe('这是 **重点**');
    expect(streamSafe('运行 `pnpm te')).toBe('运行 `pnpm te`');
    expect(streamSafe('这是 **')).toBe('这是 ');
    expect(streamSafe('写完的 **粗体** 不动')).toBe('写完的 **粗体** 不动');
  });

  it('代码块里的内容不动', () => {
    const text = '```\nconst a = `x\n- ';
    expect(streamSafe(text)).toBe(text);
  });
});
