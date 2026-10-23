// 会话页要画的行：用户的话、助手的回答、工具一行、错误，以及待批准的审批（画法同助理的审批卡）。思考、子会话之类桌面专有的部件
// 不画。纯逻辑。

import type { ChatMessage, Transcript } from '@wevir/client-sdk';
import { approvalView, type BotPost } from './bots';

export type ToolState = 'running' | 'done' | 'failed';

export type SessionItem =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string }
  | { kind: 'tool'; key: string; label: string; state: ToolState }
  | { kind: 'error'; key: string; text: string }
  /** 待批准的审批：`post` 是助理审批卡的形状，`approvalId` 用来回应。 */
  | { kind: 'approval'; key: string; approvalId: string; post: BotPost }
  /** 等用户回答的问题：手机上只提示到电脑上回答。 */
  | { kind: 'question'; key: string; text: string };

function toolState(status: string): ToolState {
  if (status === 'running' || status === 'awaiting_approval') return 'running';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  return 'done';
}

function messageItems(message: ChatMessage, imageLabel: string): SessionItem[] {
  const out: SessionItem[] = [];
  if (message.role === 'user') {
    const text = message.parts
      .map((part) =>
        part.type === 'text' ? part.text : part.type === 'image' ? `[${imageLabel}]` : '',
      )
      .filter((part) => part !== '')
      .join('\n\n')
      .trim();
    if (text !== '') out.push({ kind: 'user', key: message.id, text });
    return out;
  }
  for (const part of message.parts) {
    switch (part.type) {
      case 'text':
        if (part.text.trim() !== '')
          out.push({ kind: 'assistant', key: part.key, text: part.text });
        break;
      case 'plan':
        if (part.text.trim() !== '')
          out.push({ kind: 'assistant', key: part.key, text: part.text });
        break;
      case 'tool': {
        const display = part.display;
        const detail = display.summary ?? display.command ?? display.url ?? display.query;
        const name = part.toolName.split('__').at(-1) ?? part.toolName;
        out.push({
          kind: 'tool',
          key: part.key,
          label: detail !== undefined && detail !== '' ? `${name} · ${detail}` : name,
          state: toolState(part.status),
        });
        break;
      }
      case 'error':
        out.push({ kind: 'error', key: part.key, text: part.message });
        break;
    }
  }
  return out;
}

/** 消息流，末尾是待批准的审批与等回答的问题。 */
export function sessionItems(transcript: Transcript, imageLabel: string): SessionItem[] {
  const out = transcript.messages.flatMap((message) => messageItems(message, imageLabel));
  for (const request of transcript.pendingApprovals) {
    out.push({
      kind: 'approval',
      key: `approval:${request.id}`,
      approvalId: request.id,
      post: approvalView(request, 'pending'),
    });
  }
  for (const question of transcript.pendingQuestions) {
    out.push({
      kind: 'question',
      key: `question:${question.id}`,
      text: question.questions.map((q) => q.question).join('\n'),
    });
  }
  return out;
}
