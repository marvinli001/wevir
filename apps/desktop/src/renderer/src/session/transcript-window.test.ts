import type { ChatMessage } from '@wevir/client-sdk';
import type { TurnId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { transcriptWindowEnd } from './transcript-window';

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
  it('不切开回合，超长回合只保留它自己', () => {
    const messages = Array.from({ length: 400 }, (_, i) => message(i, i < 200 ? 0 : i));
    expect(transcriptWindowEnd(messages, 0)).toBe(200);
    expect(transcriptWindowEnd(messages, 200)).toBe(320);
  });
});
