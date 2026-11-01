// 会话页要画的行：用户的话、助手的回答、工具一行、错误，末尾是待批准的审批（画法同助理的审批卡）、等回答的问题与排队中的
// 消息。不是用户写的消息（别的会话发来的、回报、后台进程的通知等，`from`）照桌面端画成卡片或一行标记，不画成用户的气泡。
// 思考、子会话之类桌面专有的部件不画。纯逻辑。

import { type ChatMessage, reportBody, type Transcript } from '@wevir/client-sdk';
import type {
  MessageFrom,
  PendingDelivery,
  PendingMessage,
  QuestionRequest,
  SessionId,
  ToolDisplayKind,
} from '@wevir/protocol';
import { t } from '../i18n';
import { approvalView, type BotPost } from './bots';

export type ToolState = 'running' | 'done' | 'failed';

/** 不是用户写的消息的图标：后台进程、自动修复、第二意见、回报、别的会话发来的消息。 */
export type NoticeIcon = 'process' | 'repair' | 'opinion' | 'report' | 'message';

export type SessionItem =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string }
  | { kind: 'tool'; key: string; label: string; state: ToolState }
  | { kind: 'error'; key: string; text: string }
  /** 待批准的审批：`post` 是助理审批卡的形状，`approvalId` 用来回应。 */
  | { kind: 'approval'; key: string; approvalId: string; post: BotPost }
  /** 等用户回答的问题。 */
  | { kind: 'question'; key: string; request: QuestionRequest }
  /** 别的会话发来的消息或回报：标题一行，下面是发来的会话（几个回报合成一条时没有）与正文。 */
  | {
      kind: 'relayed';
      key: string;
      icon: 'report' | 'message';
      label: string;
      source?: string;
      text: string;
    }
  /** Host 交给模型的通知（后台进程、自动修复、引用的第二意见）：一行标记，`text` 是交给模型的全文。 */
  | { kind: 'notice'; key: string; icon: NoticeIcon; label: string; text: string }
  /**
   * 回合进行中发出、还没送达的消息（插话等着插进去、排队等这个回合结束）。不是用户写的（`notice`）只显示一行说明。
   */
  | {
      kind: 'pending';
      key: string;
      pendingId: string;
      text: string;
      delivery: PendingDelivery;
      notice?: { icon: NoticeIcon; label: string };
    };

function toolState(status: string): ToolState {
  if (status === 'running' || status === 'awaiting_approval') return 'running';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  return 'done';
}

/**
 * 界面语言的文字：图片占位，工具种类的动词（不认识的种类给 `undefined`，用工具名），发来消息的会话的标题（不知道时
 * `undefined`）。
 */
export interface SessionItemLabels {
  image: string;
  tool: (kind: ToolDisplayKind) => string | undefined;
  sessionTitle?: (sessionId: SessionId) => string | undefined;
}

/** 用户消息的文字，图片写成 `[图片]`。 */

function userText(parts: readonly { type: string; text?: string }[], imageLabel: string): string {
  return parts
    .map((part) =>
      part.type === 'text' ? (part.text ?? '') : part.type === 'image' ? `[${imageLabel}]` : '',
    )
    .filter((part) => part !== '')
    .join('\n\n')
    .trim();
}

function title(sessionId: SessionId, labels: SessionItemLabels): string {
  return labels.sessionTitle?.(sessionId) || t('session.untitled');
}

/** 后台进程的通知的一行说明：退出（带退出码或信号）或输出匹配。 */
function processLabel(process: NonNullable<MessageFrom['process']>): string {
  if (process.event !== 'exit') return t('transcript.processMatched', { name: process.name });
  if (process.signal !== undefined) {
    return t('transcript.processStopped', { name: process.name, signal: process.signal });
  }
  return t('transcript.processExited', {
    name: process.name,
    code: String(process.exitCode ?? '?'),
  });
}

/**
 * 不是用户写的消息怎么标：图标与一行说明，同桌面端（message-view.tsx）。几个子会话的回报合成一条时 `from` 指向这个会话
 * 自己（`merged`）。
 */
function noticeOf(
  from: MessageFrom,
  own: SessionId | undefined,
  labels: SessionItemLabels,
): { icon: NoticeIcon; label: string; merged: boolean } {
  if (from.process !== undefined) {
    return { icon: 'process', label: processLabel(from.process), merged: false };
  }
  if (from.repair !== undefined) {
    const label = t('transcript.repair', {
      attempt: from.repair.attempt,
      max: from.repair.maxAttempts,
    });
    return { icon: 'repair', label, merged: false };
  }
  if (from.opinion !== undefined) {
    return { icon: 'opinion', label: t('transcript.opinion'), merged: false };
  }
  if (from.kind === 'report') {
    const merged = from.sessionId === own && from.channel === undefined;
    const label = merged
      ? t('transcript.reportsMerged')
      : t('transcript.reportFrom', { title: title(from.sessionId, labels) });
    return { icon: 'report', label, merged };
  }
  return { icon: 'message', label: t('transcript.relayed.message'), merged: false };
}

function pendingItem(
  message: PendingMessage,
  own: SessionId | undefined,
  labels: SessionItemLabels,
): SessionItem {
  const notice = message.from !== undefined ? noticeOf(message.from, own, labels) : undefined;
  return {
    kind: 'pending',
    key: `pending:${message.id}`,
    pendingId: message.id,
    text: userText(message.content, labels.image),
    delivery: message.delivery,
    ...(notice !== undefined && { notice: { icon: notice.icon, label: notice.label } }),
  };
}

function messageItems(
  message: ChatMessage,
  own: SessionId | undefined,
  labels: SessionItemLabels,
): SessionItem[] {
  const out: SessionItem[] = [];
  if (message.role === 'user') {
    const text = userText(message.parts, labels.image);
    const from = message.from;
    if (from === undefined) {
      if (text !== '') out.push({ kind: 'user', key: message.id, text });
      return out;
    }
    // 额度恢复后或点了恢复按钮后 Host 替用户发的继续消息不显示。
    if (from.usageLimit !== undefined || from.retry !== undefined) return out;
    const { icon, label, merged } = noticeOf(from, own, labels);
    if (icon === 'report' || icon === 'message') {
      out.push({
        kind: 'relayed',
        key: message.id,
        icon,
        label,
        ...(!merged && { source: title(from.sessionId, labels) }),
        // 回报的正文是 Host 发给模型的英文外壳，只显示那个会话的回答。
        text: icon === 'report' ? reportBody(text) : text,
      });
      return out;
    }
    // 引用第二意见时用户附的话照常是用户的气泡。
    if (from.opinion?.note !== undefined) {
      out.push({ kind: 'user', key: `${message.id}:note`, text: from.opinion.note });
    }
    out.push({ kind: 'notice', key: message.id, icon, label, text });
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
  const own = transcript.sessionId;
  const out = transcript.messages.flatMap((message) => messageItems(message, own, labels));
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
      out.push(pendingItem(message, own, labels));
  }
  return out;
}
