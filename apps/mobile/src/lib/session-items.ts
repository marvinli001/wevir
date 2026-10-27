// 会话页要画的行：用户的话、助手的回答、工具一行、错误，末尾是待批准的审批（画法同助理的审批卡）、等回答的问题与排队中的
// 消息。思考、子会话之类桌面专有的部件不画。纯逻辑。

import type { ChatMessage, Transcript } from '@wevir/client-sdk';
import type {
  PendingDelivery,
  PendingMessage,
  QuestionRequest,
  ToolDisplayKind,
} from '@wevir/protocol';
import { approvalView, type BotPost } from './bots';

export type ToolState = 'running' | 'done' | 'failed';

export type SessionItem =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string }
  | { kind: 'tool'; key: string; label: string; state: ToolState }
  | { kind: 'error'; key: string; text: string }
  /** 待批准的审批：`post` 是助理审批卡的形状，`approvalId` 用来回应。 */
  | { kind: 'approval'; key: string; approvalId: string; post: BotPost }
  /** 等用户回答的问题。 */
  | { kind: 'question'; key: string; request: QuestionRequest }
  /** 回合进行中发出、还没送达的消息（插话等着插进去、排队等这个回合结束）。 */
  | { kind: 'pending'; key: string; pendingId: string; text: string; delivery: PendingDelivery };

function toolState(status: string): ToolState {
  if (status === 'running' || status === 'awaiting_approval') return 'running';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  return 'done';
}

/** 用户消息的文字，图片写成 `[图片]`。 */
/** 界面语言的文字：图片占位，工具种类的动词（不认识的种类给 `undefined`，用工具名）。 */
export interface SessionItemLabels {
  image: string;
  tool: (kind: ToolDisplayKind) => string | undefined;
}

function userText(parts: readonly { type: string; text?: string }[], imageLabel: string): string {
  return parts
    .map((part) =>
      part.type === 'text' ? (part.text ?? '') : part.type === 'image' ? `[${imageLabel}]` : '',
    )
    .filter((part) => part !== '')
    .join('\n\n')
    .trim();
}

function pendingItem(message: PendingMessage, imageLabel: string): SessionItem {
  return {
    kind: 'pending',
    key: `pending:${message.id}`,
    pendingId: message.id,
    text: userText(message.content, imageLabel),
    delivery: message.delivery,
  };
}

function messageItems(message: ChatMessage, labels: SessionItemLabels): SessionItem[] {
  const out: SessionItem[] = [];
  if (message.role === 'user') {
    const text = userText(message.parts, labels.image);
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
        const name = labels.tool(display.kind) ?? part.toolName.split('__').at(-1) ?? part.toolName;
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

/** 消息流，末尾是待批准的审批、等回答的问题与还没送达的消息。 */
export function sessionItems(transcript: Transcript, labels: SessionItemLabels): SessionItem[] {
  const out = transcript.messages.flatMap((message) => messageItems(message, labels));
  for (const request of transcript.pendingApprovals) {
    out.push({
      kind: 'approval',
      key: `approval:${request.id}`,
      approvalId: request.id,
      post: approvalView(request, 'pending'),
    });
  }
  for (const question of transcript.pendingQuestions) {
    out.push({ kind: 'question', key: `question:${question.id}`, request: question });
  }
  for (const message of transcript.pendingMessages) {
    if (message.status === 'waiting' || message.status === 'held')
      out.push(pendingItem(message, labels.image));
  }
  return out;
}
