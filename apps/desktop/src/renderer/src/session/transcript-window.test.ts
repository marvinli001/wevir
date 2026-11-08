import type { ChatMessage } from '@wevir/client-sdk';
import type { TurnId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { laterWindowStart, RENDER_WINDOW, transcriptWindowEnd } from './transcript-window';
import { turnStart } from './turn-model';

function message(index: number, turn = index): ChatMessage {
  return {
    role: 'assistant',
    id: `m${index}`,
    turnId: `trn_${turn}` as TurnId,
    parts: [],
    seqRange: [index, index],
  };
}

describe('bounded transcript window', () => {
  it('反复向前翻页也只保留两页，能回到后面的消息', () => {
    const messages = Array.from({ length: 1000 }, (_, i) => message(i));
    for (let start = 880; start >= 0; start -= 60)
      expect(transcriptWindowEnd(messages, start) - start).toBeLessThanOrEqual(120);
    expect(transcriptWindowEnd(messages, 940)).toBe(1000);
  });
  it('不切开回合，超长回合之后还留一页', () => {
    const messages = Array.from({ length: 400 }, (_, i) => message(i, i < 200 ? 0 : i));
    expect(transcriptWindowEnd(messages, 0)).toBe(260);
    expect(transcriptWindowEnd(messages, 200)).toBe(320);
  });
  it('后面紧跟超长回合时，往前翻到开头不会只剩第一条（来回翻页闪烁）', () => {
    // 第一条是接力材料，后面一个回合跑了 299 条。
    const messages = Array.from({ length: 300 }, (_, i) => message(i, i === 0 ? 0 : 1));
    expect(turnStart(messages, messages.length - RENDER_WINDOW)).toBe(1);
    expect(transcriptWindowEnd(messages, 0)).toBe(300);
  });
  it('任意回合长度下，往前、往后翻页都保留正在看的内容并且有进展', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 50; round++) {
      const messages: ChatMessage[] = [];
      for (let turn = 0; messages.length < 800; turn++) {
        const length =
          random() < 0.2 ? 1 + Math.floor(random() * 300) : 1 + Math.floor(random() * 8);
        for (let i = 0; i < length; i++) messages.push(message(messages.length, turn));
      }
      let start = turnStart(messages, messages.length - RENDER_WINDOW);
      while (start > 0) {
        const earlier = turnStart(messages, Math.max(0, start - RENDER_WINDOW));
        expect(earlier).toBeLessThan(start);
        expect(transcriptWindowEnd(messages, earlier)).toBeGreaterThan(start);
        start = earlier;
      }
      let end = transcriptWindowEnd(messages, start);
      while (end < messages.length) {
        const later = turnStart(messages, laterWindowStart(messages, start, end));
        expect(later).toBeGreaterThan(start);
        expect(later).toBeLessThan(end);
        const laterEnd = transcriptWindowEnd(messages, later);
        expect(laterEnd).toBeGreaterThanOrEqual(end);
        start = later;
        end = laterEnd;
      }
    }
  });
});
