import type { ChatMessage } from '@wevir/client-sdk';
import type { TurnId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  earlierWindow,
  laterWindow,
  laterWindowStart,
  RENDER_WINDOW,
  type TranscriptWindow,
  transcriptWindowEnd,
} from './transcript-window';
import { turnStart } from './turn-model';

function system(index: number): ChatMessage {
  return { role: 'system', id: `m${index}`, parts: [], seqRange: [index, index] };
}

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
  it('回合都折叠、两头哨兵同时在视口附近时，一段只增不减，不来回翻页', () => {
    // 一条接力材料，三个跑完的长回合（69、53、81 条），最后一个进行中的回合 8 条。
    const messages: ChatMessage[] = [system(0)];
    for (const [turn, length] of [69, 53, 81, 8].entries())
      for (let i = 0; i < length; i++) messages.push(message(messages.length, 100 + turn));
    const keep = () => false;
    // 贴底时渲染的一段（最后一个回合在里面），转为手动阅读后两头哨兵都在视口附近。
    let window: TranscriptWindow = {
      start: turnStart(messages, messages.length - RENDER_WINDOW),
      end: messages.length,
    };
    const seen = new Set<string>();
    while (window.start > 0 || window.end < messages.length) {
      const key = `${window.start}:${window.end}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      const next =
        window.start > 0
          ? earlierWindow(messages, window, keep)
          : laterWindow(messages, window, keep);
      expect(next.start).toBeLessThanOrEqual(window.start);
      expect(next.end).toBeGreaterThanOrEqual(window.end);
      window = next;
    }
    expect(window).toEqual({ start: 0, end: messages.length });
  });
  it('离视口足够远时照常裁掉另一头，往后翻页一直有进展', () => {
    const messages = Array.from({ length: 600 }, (_, i) => message(i, Math.floor(i / 7)));
    const trim = () => true;
    let window: TranscriptWindow = { start: 0, end: transcriptWindowEnd(messages, 0) };
    while (window.end < messages.length) {
      const next = laterWindow(messages, window, trim);
      expect(next.start).toBeGreaterThan(window.start);
      expect(next.end).toBeGreaterThan(window.end);
      expect(next.end - next.start).toBeLessThanOrEqual(RENDER_WINDOW * 2 + 2 * 7);
      window = next;
    }
    const earlier = earlierWindow(messages, window, trim);
    expect(earlier.start).toBeLessThan(window.start);
    expect(earlier.end).toBe(transcriptWindowEnd(messages, earlier.start));
  });
});
