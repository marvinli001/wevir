// 会话页要画的行：用户的话、助手的回答（还在写的带 `streaming`，逐字放出）、思考与工具各一行、错误；回合进行中消息流末尾是
// 运行状态（当前动作、已用时间、正在流出的思考或命令输出），之后是待批准的审批（画法同助理的审批卡）、等回答的问题与排队中的
// 消息。不是用户写的消息（别的会话发来的、回报、后台进程的通知等，`from`）照桌面端画成卡片或一行标记，不画成用户的气泡。
// 子会话之类桌面专有的部件不画。纯逻辑。

import {
  type ChatMessage,
  type ChatPartOf,
  type ContinuityNotice,
  reportBody,
  type Transcript,
} from '@wevir/client-sdk';
import type {
  MessageFrom,
  PendingDelivery,
  PendingMessage,
  QuestionRequest,
  SessionId,
  ToolDisplayKind,
} from '@wevir/protocol';
import { t } from '../i18n';
import { type ApprovalContext, approvalView, type BotPost } from './bots';
import { isBusy } from './session-actions';

export type ToolState = 'awaiting' | 'running' | 'done' | 'failed' | 'skipped' | 'unknown';

/** 不是用户写的消息的图标：后台进程、自动修复、第二意见、回报、别的会话发来的消息。 */
export type NoticeIcon = 'process' | 'repair' | 'opinion' | 'report' | 'message';

/** 进行中的回合正在做什么（同桌面端的当前动作）：停止中、等审批、等回答、在跑的工具，都不是时在思考。 */
export type LiveAction =
  | { kind: 'thinking' | 'awaiting' | 'input' | 'stopping' }
  | { kind: 'tool'; label: string };

export type SessionItem =
  | { kind: 'user'; key: string; text: string }
  /** `streaming`：还在流出的回答或计划。 */
  | { kind: 'assistant'; key: string; text: string; streaming?: true }
  /** 一段思考：一行“思考了 N 秒”，有文字时可展开。 */
  | { kind: 'thought'; key: string; text: string; durationMs?: number }
  | { kind: 'tool'; key: string; label: string; state: ToolState }
  /**
   * 回合进行中的运行状态，在消息流末尾：当前动作，回合开始的时刻（`startedAt`，算已用时间），`detail` 是正在流出的思考或
   * 在跑的命令最近的输出。
   */
  | { kind: 'live'; key: 'live'; action: LiveAction; startedAt?: string; detail?: string }
  | { kind: 'error'; key: string; text: string }
  | { kind: 'handoff'; key: string; notice: ContinuityNotice }
  | { kind: 'usage-limit'; key: string; part: ChatPartOf<'error'> }
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

function toolState(part: ToolPart): ToolState {
  if (part.status === 'completed') return 'done';
  if (part.status === 'cancelled' || part.approval?.status === 'denied') return 'skipped';
  if (part.status === 'awaiting_approval') return 'awaiting';
  return part.status;
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

type ToolPart = ChatPartOf<'tool'>;

/** 工具一行的文字：动词（不认识的种类用工具名）加摘要、命令、网址或搜索词。 */
function toolLabel(part: ToolPart, labels: SessionItemLabels): string {
  const display = part.display;
  const detail = display.summary ?? display.command ?? display.url ?? display.query;
  const name = labels.tool(display.kind) ?? part.toolName.split('__').at(-1) ?? part.toolName;
  return detail !== undefined && detail !== '' ? `${name} · ${detail}` : name;
}

function durationOf(part: ChatPartOf<'reasoning'>): number | undefined {
  if (part.startedAt === undefined || part.endedAt === undefined) return undefined;
  const ms = Date.parse(part.endedAt) - Date.parse(part.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * 运行状态下面露出的那段：正在流出的思考或命令输出的末尾，压成一段。手机上只露三行，从末尾往前取到 `DETAIL_WIDTH` 个半角字宽
 * （全角字按两个），前面截掉的写成省略号，最新的字总在最后一行。
 */
const DETAIL_WIDTH = 130;

function detailText(text: string): string | undefined {
  const flat = text
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat === '') return undefined;
  const chars = Array.from(flat);
  let width = 0;
  let start = chars.length;
  while (start > 0) {
    const code = chars[start - 1]?.codePointAt(0) ?? 0;
    const next = width + (code >= 0x2e80 ? 2 : 1);
    if (next > DETAIL_WIDTH) break;
    width = next;
    start -= 1;
  }
  return start === 0 ? flat : `…${chars.slice(start).join('').trimStart()}`;
}

function messageItems(
  message: ChatMessage,
  own: SessionId | undefined,
  labels: SessionItemLabels,
  /** 正在流出、由运行状态代表的思考（不另画一行）。 */
  liveThought: string | undefined,
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
      case 'plan':
        if (part.text.trim() !== '')
          out.push({
            kind: 'assistant',
            key: part.key,
            text: part.text,
            ...(part.state === 'streaming' && { streaming: true }),
          });
        break;
      case 'reasoning': {
        if (part.key === liveThought) break;
        const durationMs = durationOf(part);
        // 没有文字、又不到一秒的思考（引擎只给了加密的思考）不占一行。
        if (part.text.trim() === '' && (durationMs === undefined || durationMs < 1_000)) break;
        out.push({
          kind: 'thought',
          key: part.key,
          text: part.text,
          ...(durationMs !== undefined && { durationMs }),
        });
        break;
      }
      case 'tool':
        out.push({
          kind: 'tool',
          key: part.key,
          label: toolLabel(part, labels),
          state: toolState(part),
        });
        break;
      case 'error':
        out.push(
          part.usageLimit !== undefined
            ? { kind: 'usage-limit', key: part.key, part }
            : { kind: 'error', key: part.key, text: part.message },
        );
        break;
      case 'notice':
        if (part.notice.kind === 'handoff' || part.notice.kind === 'configured') {
          out.push({ kind: 'handoff', key: part.key, notice: part.notice });
        }
        break;
    }
  }
  return out;
}

/**
 * 回合进行中的运行状态（同桌面端的当前动作与“正在思考”那一行）；没在跑时 `undefined`。`toolKey` 是当前动作代表的那个工具
 * （它不另画一行，做完了才列进消息流），`thoughtKey` 是正在流出的那段思考。
 */
function liveStatus(
  transcript: Transcript,
  labels: SessionItemLabels,
):
  | { item: Extract<SessionItem, { kind: 'live' }>; toolKey?: string; thoughtKey?: string }
  | undefined {
  if (!isBusy(transcript)) return undefined;
  const turnId = transcript.activeTurnId;
  const messages = transcript.messages.filter(
    (message) => message.role !== 'system' && message.turnId === turnId,
  );
  const assistant = messages.findLast((message) => message.role === 'assistant');
  const prompt = messages.find((message) => message.role === 'user');
  const startedAt =
    assistant?.role === 'assistant' && assistant.startedAt !== undefined
      ? assistant.startedAt
      : prompt?.role === 'user'
        ? prompt.ts
        : undefined;
  const parts = assistant?.parts ?? [];
  const tool = parts.findLast(
    (part): part is ToolPart =>
      part.type === 'tool' && (part.status === 'running' || part.status === 'awaiting_approval'),
  );
  const tail = parts.at(-1);
  const thought = tail?.type === 'reasoning' && tail.state === 'streaming' ? tail : undefined;
  let action: LiveAction;
  if (transcript.state === 'cancelling') action = { kind: 'stopping' };
  else if (transcript.pendingApprovals.length > 0) action = { kind: 'awaiting' };
  else if (transcript.pendingQuestions.length > 0) action = { kind: 'input' };
  else if (tool !== undefined && tool.status === 'running')
    action = { kind: 'tool', label: toolLabel(tool, labels) };
  else action = { kind: 'thinking' };
  const detail =
    thought !== undefined
      ? detailText(thought.text)
      : action.kind === 'tool' && tool?.output !== undefined
        ? detailText(lastLine(tool.output.text))
        : undefined;
  return {
    item: {
      kind: 'live',
      key: 'live',
      action,
      ...(startedAt !== undefined && { startedAt }),
      ...(detail !== undefined && { detail }),
    },
    ...(action.kind === 'tool' && tool !== undefined && { toolKey: tool.key }),
    ...(thought !== undefined && { thoughtKey: thought.key }),
  };
}

/** 命令输出的最后一行有字的行。 */
function lastLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (line !== '') return line;
  }
  return '';
}

/**
 * 消息流，回合进行中末尾是运行状态，然后是待批准的审批、等回答的问题与还没送达的消息。只有本地缓存（离线）时 `live` 给
 * false：缓存里的回合在电脑上可能早已结束，不画运行状态。
 */
export function sessionItems(
  transcript: Transcript,
  labels: SessionItemLabels,
  {
    live: showLive = true,
    approvalContext,
  }: { live?: boolean; approvalContext?: ApprovalContext } = {},
): SessionItem[] {
  const own = transcript.sessionId;
  const live = showLive ? liveStatus(transcript, labels) : undefined;
  const out = transcript.messages
    .flatMap((message) => messageItems(message, own, labels, live?.thoughtKey))
    .filter((item) => item.key !== live?.toolKey);
  if (live !== undefined) out.push(live.item);
  for (const request of transcript.pendingApprovals) {
    out.push({
      kind: 'approval',
      key: `approval:${request.id}`,
      approvalId: request.id,
      post: approvalView(request, 'pending', approvalContext),
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
