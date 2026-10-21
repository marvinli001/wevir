import { describe, expect, it } from 'vitest';
import { messageContent } from './composer-images';
import {
  expandPastes,
  isLargePaste,
  lineCount,
  PASTE_MIN_LENGTH,
  PASTE_MIN_LINES,
  registerPaste,
  textParts,
} from './composer-pastes';

describe('粘贴的大段文字', () => {
  it('够长或够多行才换成占位符', () => {
    expect(isLargePaste('x'.repeat(PASTE_MIN_LENGTH))).toBe(true);
    expect(isLargePaste('x'.repeat(PASTE_MIN_LENGTH - 1))).toBe(false);
    expect(isLargePaste(Array(PASTE_MIN_LINES).fill('a').join('\n'))).toBe(true);
    expect(lineCount('a\r\nb\nc')).toBe(3);
  });

  it('占位符拆成标 pasted 的一段，前后自己写的各成一段；没有占位符时原样一段', () => {
    const log = 'Error: ENOENT\n    at open (node:fs)';
    const token = registerPaste(log);
    expect(token).toMatch(/^\[.+#\d+.+\]$/);
    expect(textParts(`为什么失败：\n${token}\n修一下`)).toEqual([
      { type: 'text', text: '为什么失败：' },
      { type: 'text', text: log, pasted: true },
      { type: 'text', text: '修一下' },
    ]);
    expect(textParts(token)).toEqual([{ type: 'text', text: log, pasted: true }]);
    expect(textParts('  普通的话 ')).toEqual([{ type: 'text', text: '  普通的话 ' }]);
    expect(textParts('')).toEqual([]);
  });

  it('多个占位符按出现的顺序；改坏的占位符当普通文字', () => {
    const a = registerPaste('A');
    const b = registerPaste('B');
    expect(textParts(`${b} 和 ${a}`)).toEqual([
      { type: 'text', text: 'B', pasted: true },
      { type: 'text', text: '和' },
      { type: 'text', text: 'A', pasted: true },
    ]);
    const broken = a.slice(0, -1);
    expect(textParts(broken)).toEqual([{ type: 'text', text: broken }]);
  });

  it('expandPastes 换回原文；messageContent 用它拆段，图片在后', () => {
    const token = registerPaste('body');
    expect(expandPastes(`/goal ${token}`)).toBe('/goal body');
    const image = {
      type: 'image' as const,
      imageId: 'img_x' as never,
      mimeType: 'image/png' as const,
      size: 1,
    };
    expect(messageContent(`看 ${token}`, [image])).toEqual([
      { type: 'text', text: '看' },
      { type: 'text', text: 'body', pasted: true },
      image,
    ]);
  });
});
