import type { ChatMessage } from '@wevir/client-sdk';
import { turnStart } from './turn-model';

export const RENDER_WINDOW = 60;

/** `index` 处（跳过前面的系统消息）那个回合结束的位置：下一个回合的开头，或消息流末尾。 */
function turnEnd(messages: readonly ChatMessage[], index: number): number {
  let first = index;
  while (messages[first]?.role === 'system') first++;
  const turn = messages[first];
  if (!turn || turn.role === 'system') return first;
  let end = first + 1;
  while (end < messages.length) {
    const message = messages[end];
    if (message && message.role !== 'system' && message.turnId !== turn.turnId) break;
    end++;
  }
  return end;
}

/**
 * 手动阅读的一段在哪里结束：从 `start` 起两页，且第一个回合之后至少还有一页；回合不切开，落在回合中间就保留到这个回合结束。
 * 不能往回切到回合开头：后面紧跟一个超长回合时，那样一段只剩开头几条，底部哨兵马上往后翻、顶部哨兵又往前翻，来回不停。
 */
export function transcriptWindowEnd(messages: readonly ChatMessage[], start: number): number {
  const limit = Math.min(
    messages.length,
    Math.max(start + RENDER_WINDOW * 2, turnEnd(messages, start) + RENDER_WINDOW),
  );
  if (limit === messages.length) return limit;
  const boundary = turnStart(messages, limit);
  return boundary === limit ? limit : turnEnd(messages, boundary);
}

/** 往后翻一页的新起点：往后一页所在回合的开头；第一个回合比一页还长时，跳到它结束的位置（一段里一定还有它后面的一页）。 */
export function laterWindowStart(messages: readonly ChatMessage[], start: number, end: number) {
  const next = turnStart(messages, Math.min(end, start + RENDER_WINDOW));
  return next > start ? next : Math.min(end, turnEnd(messages, start));
}

/** 手动阅读时渲染的一段 `[start, end)`。 */
export interface TranscriptWindow {
  start: number;
  end: number;
}

/**
 * 往前翻一页：起点挪到前一页所在回合的开头；底部只在 `canTrim(新的结尾)` 时裁掉（那里离视口足够远），否则保留到原来的结尾。
 * 回合都折叠着、一段在屏幕上很矮时，顶部和底部的哨兵同时在视口附近：只按条数裁掉底部，底部哨兵马上往后翻、顶部哨兵又往前翻，
 * 来回不停，正在看的回合闪进闪出。
 */
export function earlierWindow(
  messages: readonly ChatMessage[],
  { start, end }: TranscriptWindow,
  canTrim: (index: number) => boolean,
): TranscriptWindow {
  const next = turnStart(messages, Math.max(0, start - RENDER_WINDOW));
  const trimmed = transcriptWindowEnd(messages, next);
  return { start: next, end: trimmed < end && canTrim(trimmed) ? trimmed : end };
}

/** 往后翻一页：结尾往后挪一页（不切开回合，一定有进展）；顶部只在 `canTrim(新的起点)` 时裁掉，理由同 `earlierWindow`。 */
export function laterWindow(
  messages: readonly ChatMessage[],
  { start, end }: TranscriptWindow,
  canTrim: (index: number) => boolean,
): TranscriptWindow {
  const next = laterWindowStart(messages, start, end);
  const trim = next > start && canTrim(next);
  const slid = trim ? transcriptWindowEnd(messages, next) : end;
  if (slid > end) return { start: next, end: slid };
  const page = Math.min(messages.length, end + RENDER_WINDOW);
  const boundary = turnStart(messages, page);
  return {
    start: trim ? next : start,
    end: boundary === page ? page : turnEnd(messages, boundary),
  };
}
