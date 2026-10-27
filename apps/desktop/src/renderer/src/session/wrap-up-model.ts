// 回合末的下一步卡片（0.128.0）的纯逻辑：哪条回答带卡片、卡片画什么、侧栏与回顾卡片怎么看它。

import type { ChatMessage, Transcript, TranscriptWrapUp } from '@wevir/client-sdk';
import type { WrapUpAction } from '@wevir/protocol';

export interface WrapUpCardContent {
  recap: string;
  ask: string;
  actions: readonly WrapUpAction[];
}

/** 卡片的内容：有问题、有按钮时才画；只有回顾的不画（回顾给离开后摘要与提醒用）。 */
export function wrapUpCardOf(wrapUp: TranscriptWrapUp | undefined): WrapUpCardContent | undefined {
  if (wrapUp?.ask === undefined || wrapUp.actions === undefined || wrapUp.actions.length === 0) {
    return undefined;
  }
  return { recap: wrapUp.recap, ask: wrapUp.ask, actions: wrapUp.actions };
}

/** 一个回合的消息里带收尾的那条助手消息的收尾（一个回合至多一条）。 */
export function turnWrapUp(messages: readonly ChatMessage[]): TranscriptWrapUp | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.wrapUp !== undefined) return message.wrapUp;
  }
  return undefined;
}

/** 会话最后一条消息所在的回合画着下一步卡片：这时不再出离开后的回顾卡片，免得同一段话出现两次。 */
export function lastTurnShowsWrapUp(transcript: Pick<Transcript, 'messages'>): boolean {
  const last = transcript.messages.at(-1);
  if (last === undefined || last.role === 'system') return false;
  const turnMessages = transcript.messages.filter(
    (message) => message.role !== 'system' && message.turnId === last.turnId,
  );
  return wrapUpCardOf(turnWrapUp(turnMessages)) !== undefined;
}
