// 支线会话（U23.1，0.17.0，desktop-layout.md §17、domain-model §3.12）：输入框里的 `/btw 〈问题〉` 从当前会话分出一个
// 支线，在窗格区开一个支线窗格，问题发进支线；关掉窗格后仍可从主会话的详情重开。

import type { Transcript, WevirClient } from '@wevir/client-sdk';
import type { SessionId } from '@wevir/protocol';
import type { PaneController } from '@/layout/pane-controller';
import { sendText } from './start-session';

/** 标签上问题开头的字数。 */
const TITLE_LENGTH = 40;

/** `/btw 〈问题〉` 里的问题；不是这个前缀、或问题是空的时 `undefined`（照原样发出）。 */
export function btwQuestion(text: string): string | undefined {
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.trim());
  const question = match?.[1]?.trim();
  return question ? question : undefined;
}

/** 会话至少有一个结束的回合（Codex 没有第一条用户消息时分不出来）。 */
export function hasFinishedTurn(transcript: Transcript): boolean {
  return transcript.messages.some(
    (message) => message.role === 'assistant' && message.finished !== undefined,
  );
}

/** 支线标签的标题：问题的开头。 */
export function sideTitle(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH)}…` : line;
}

/**
 * 分出支线、开窗格，不发消息。`prepare` 在窗格打开之前拿到支线的 ID（消息里选中文字的“支线提问”借此把引用放进它的输入框）。
 * 失败时抛出，调用方显示。
 */
export async function openSide(
  client: WevirClient,
  sessionId: SessionId,
  title: string,
  panes: PaneController | undefined,
  prepare?: (sideId: SessionId) => void,
): Promise<SessionId> {
  const { session } = await client.request('session.fork', { sessionId, side: true });
  prepare?.(session.id);
  panes?.open({ kind: 'session', params: { sessionId: session.id, title: sideTitle(title) } });
  return session.id;
}

/** 分出支线、开窗格、把问题发进支线。失败时抛出，调用方显示。 */
export async function startSide(
  client: WevirClient,
  sessionId: SessionId,
  question: string,
  panes: PaneController | undefined,
): Promise<void> {
  const sideId = await openSide(client, sessionId, question, panes);
  await sendText(client, sideId, question);
}

/** 已完成的问答，作为引用带回主会话。 */
export function sideReturnText(transcript: Transcript): string | undefined {
  const answer = transcript.messages.findLast(
    (message) => message.role === 'assistant' && message.finished?.outcome === 'completed',
  );
  if (answer?.role !== 'assistant') return undefined;
  const messages = transcript.messages.filter(
    (message) => message.role === 'user' && message.turnId === answer.turnId,
  );
  const textOf = (message: Transcript['messages'][number]) =>
    message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n');
  const text = textOf(answer).trim();
  if (!text) return undefined;
  return [...messages.map(textOf), text].filter(Boolean).join('\n\n');
}
