import { describe, expect, it } from 'vitest';
import { messageContent } from './composer-images';
import {
  expandPastes,
  isLargePaste,
  lineCount,
  PASTE_MIN_LENGTH,
  PASTE_MIN_LINES,
  pastePreview,
  textParts,
  withDraftPastes,
} from './composer-pastes';

describe('粘贴的大段文字', () => {
  it('够长或够多行才换成占位符', () => {
    expect(isLargePaste('x'.repeat(PASTE_MIN_LENGTH))).toBe(true);
    expect(isLargePaste('x'.repeat(PASTE_MIN_LENGTH - 1))).toBe(false);
    expect(isLargePaste(Array(PASTE_MIN_LINES).fill('a').join('\n'))).toBe(true);
    expect(lineCount('a\r\nb\nc')).toBe(3);
  });

  it('粘贴块按顺序交给 Host，正文中的字面量保留', () => {
    const blocks = [
      { key: crypto.randomUUID(), text: 'Error: ENOENT\n  at open (node:fs)' },
      { key: crypto.randomUUID(), text: 'second paste' },
    ];
    const body = withDraftPastes(blocks, '检查原因');
    expect(textParts(body)).toEqual([
      ...blocks.map((part) => ({ type: 'text', text: part.text, pasted: true })),
      { type: 'text', text: '检查原因' },
    ]);
    expect(expandPastes(body)).toBe(`${blocks.map((part) => part.text).join('\n')}\n检查原因`);
    expect(textParts('  普通的话 ')).toEqual([{ type: 'text', text: '  普通的话 ' }]);
    expect(textParts('')).toEqual([]);
  });
  it('宿主只收到解析后的正文与图片，未登记的标记视为普通文字', () => {
    const blocks = [{ key: crypto.randomUUID(), text: 'details' }];
    const image = {
      type: 'image' as const,
      imageId: 'img_x' as const,
      mimeType: 'image/png' as const,
      size: 1,
    };
    expect(messageContent(withDraftPastes(blocks, ''), [image])).toEqual([
      { type: 'text', text: 'details', pasted: true },
      image,
    ]);
    const literal = '\u2063[wevir-paste:missing]\u2063';
    expect(textParts(literal)).toEqual([{ type: 'text', text: literal }]);
    expect(expandPastes(literal)).toBe(literal);
  });

  it('标题取原文开头，空白折成一个空格', () => {
    expect(pastePreview('  新建会话\n\t搜索 ⌘K  助理 ')).toBe('新建会话 搜索 ⌘K 助理');
    expect(pastePreview('x'.repeat(500), 10)).toBe('x'.repeat(10));
  });
});
