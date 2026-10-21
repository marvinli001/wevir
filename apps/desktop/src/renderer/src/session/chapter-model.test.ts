import type { TranscriptChapter } from '@wevir/client-sdk';
import { describe, expect, it } from 'vitest';
import { currentChapter } from './chapter-model';

const chapter = (seq: number): TranscriptChapter => ({
  key: `h:${seq}`,
  seq,
  title: `第 ${seq} 章`,
  messageId: `m${seq}`,
});

describe('正在读的章节', () => {
  const chapters = [chapter(10), chapter(40), chapter(80)];

  it('最后一条过了读线的分隔线；都在读线以下时是第一章之前', () => {
    const anchors = [
      { key: 'h:10', top: -400 },
      { key: 'h:40', top: 30 },
      { key: 'h:80', top: 900 },
    ];
    expect(currentChapter(chapters, anchors, 1, 48)).toBe(1);
    expect(currentChapter(chapters, anchors, 1, 20)).toBe(0);
    expect(
      currentChapter(
        chapters,
        anchors.map((anchor) => ({ ...anchor, top: anchor.top + 1000 })),
        1,
        48,
      ),
    ).toBe(-1);
  });

  it('没画出来的章节在渲染的第一块之前就算读过了', () => {
    expect(currentChapter(chapters, [{ key: 'h:80', top: 600 }], 50, 48)).toBe(1);
    expect(currentChapter(chapters, [], undefined, 48)).toBe(-1);
  });
});
