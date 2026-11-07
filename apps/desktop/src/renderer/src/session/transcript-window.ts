import type { ChatMessage } from '@wevir/client-sdk';
import { turnStart } from './turn-model';

export const RENDER_WINDOW = 60;

/** 手动阅读最多保留两页；一个回合不可拆开，超长回合保留到下个回合。 */
export function transcriptWindowEnd(messages: readonly ChatMessage[], start: number): number {
  const limit = Math.min(messages.length, start + RENDER_WINDOW * 2);
  if (limit === messages.length) return limit;
  const boundary = turnStart(messages, limit);
  if (boundary > start) return boundary;
  const turn = messages[boundary];
  if (!turn || turn.role === 'system') return limit;
  let end = limit;
  while (end < messages.length) {
    const message = messages[end];
    if (message && message.role !== 'system' && message.turnId !== turn.turnId) break;
    end++;
  }
  return end;
}
