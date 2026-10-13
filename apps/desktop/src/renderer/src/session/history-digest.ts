// 基于历史新建会话（T5.5）的客户端做法：把只读会话的对话整理成新会话首条消息的草稿，放进同一工作区的新会话
// 输入框，用户看过、改过再发。Host 侧的 SessionFromHistory（domain-model §4.4）还没有排期，到时改为调用 Host
// 的方法，新会话的 session.created 记下来源。

import type { ChatMessage, Transcript } from '@wevir/client-sdk';
import { t } from '@/i18n';
import { toolSummary } from './tool-model';

/** 草稿里对话记录的字数上限：超出时保留最近的对话，开头注明省略了多少条。 */
export const HISTORY_DIGEST_LIMIT = 24_000;

/**
 * 对话记录：用户消息与助手的正文（不含思考），助手用过的工具各一行摘要；会话级提示、错误不收。返回开头的说明、
 * 记录与结尾的“接下来”，光标落在末尾。
 */
export function historyDigest(
  transcript: Pick<Transcript, 'messages' | 'title'>,
  limit = HISTORY_DIGEST_LIMIT,
): string {
  const blocks = transcript.messages.flatMap((message) => {
    const block = messageBlock(message);
    return block === undefined ? [] : [block];
  });
  const kept: string[] = [];
  let length = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i] as string;
    if (length + block.length > limit) {
      // 最近的一条本身就超长：只留它的结尾。
      if (kept.length === 0) kept.unshift(`…${block.slice(block.length - limit)}`);
      break;
    }
    kept.unshift(block);
    length += block.length;
  }
  const omitted = blocks.length - kept.length;
  const title = transcript.title || t('session.untitled');
  return [
    t('history.intro', { title }),
    ...(omitted > 0 ? [t('history.omitted', { count: omitted })] : []),
    ...kept,
    t('history.next'),
  ].join('\n\n');
}

function messageBlock(message: ChatMessage): string | undefined {
  if (message.role === 'system') return undefined;
  const texts: string[] = [];
  const tools: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'text' && part.text.trim() !== '') texts.push(part.text.trim());
    if (part.type === 'tool') {
      const summary = toolSummary(part);
      tools.push(summary ? `${part.toolName} ${summary}` : part.toolName);
    }
  }
  if (texts.length === 0 && tools.length === 0) return undefined;
  const label = t(message.role === 'user' ? 'history.user' : 'history.assistant');
  const lines = [label, ...texts];
  if (tools.length > 0) lines.push(t('history.tools', { tools: tools.join('；') }));
  return lines.join('\n');
}
