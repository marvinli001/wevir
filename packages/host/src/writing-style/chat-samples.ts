// 从 Wevir 的聊天记录里取用户自己写的消息（0.95.0，domain-model §3.43），作写作风格的 `chat` 样本。
//
// 只取用户在客户端里亲手发的：已提交的用户消息与插话里的文字段。不要别的会话、自动化、第二意见与回合后验证代发的（`from`，或
// `sentBy.clientId` 是 Host 自己的 `wevir-*`），不要标了 `pasted` 的大段粘贴（是别处的文字），去掉代码块；子会话、支线与分支会话
// 不看（分支会话的消息与原会话重复），Agent、自动化与第二意见开的会话也不看。被撤回或撤销的回合照样算：那仍是用户写的字。

import type { UserContentPart } from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import type { SampleInput } from './store.js';

/** 默认往回看多久（同 setup-writing-style 的“最近六个月”）。 */
export const CHAT_LOOKBACK_DAYS = 180;
/** 最多看多少个会话（最近更新的在前）。 */
export const CHAT_MAX_SESSIONS = 300;
/** 最多取多少条消息。 */
export const CHAT_MAX_MESSAGES = 600;

export interface ChatCollectOptions {
  since: Date;
  maxSessions?: number;
  maxMessages?: number;
}

/** 消息里用户自己写的文字；没有时 `undefined`。 */
export function ownText(content: readonly UserContentPart[]): string | undefined {
  const text = content
    .flatMap((part) => (part.type === 'text' && part.pasted !== true ? [part.text] : []))
    .join('\n')
    // 代码块与行内代码不是文风。
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/`[^`\n]*`/g, '')
    .trim();
  // 只有一条斜杠命令的消息不算。
  if (text === '' || /^\/\S+$/.test(text)) return undefined;
  return text;
}

/**
 * 按会话从新到旧取，返回的样本以会话 ID 作来源、消息的日期作日期：同一个会话同一天的消息在分析时合并成一份。会话太多时只看最近的
 * `maxSessions` 个，每个会话的消息从新到旧取，总数到 `maxMessages` 为止；各个会话轮流取，免得一个长会话占满名额。
 */
export function collectChatSamples(storage: Storage, options: ChatCollectOptions): SampleInput[] {
  const since = options.since.toISOString();
  const sessions = storage.sessions
    .list({ archived: 'include', includeRemovedWorkspaces: true })
    .filter(
      (record) =>
        record.updatedAt >= since &&
        record.forkedFrom === undefined &&
        record.side !== true &&
        record.parentSessionId === undefined &&
        (record.origin === undefined || record.origin.kind === 'suggested_task'),
    )
    .slice(0, options.maxSessions ?? CHAT_MAX_SESSIONS);
  const perSession: SampleInput[][] = [];
  for (const record of sessions) {
    const messages: SampleInput[] = [];
    for (const event of storage.events.iterate(record.id)) {
      if (event.type !== 'user.message' && event.type !== 'user.steered') continue;
      if (event.ts < since) continue;
      const payload = event.payload as {
        content?: UserContentPart[];
        from?: unknown;
        sentBy?: { clientId?: string };
      };
      if (payload.from !== undefined) continue;
      if (payload.sentBy?.clientId?.startsWith('wevir-') === true) continue;
      const text = ownText(payload.content ?? []);
      if (text === undefined) continue;
      messages.push({ text, source: record.id.toLowerCase(), date: event.ts.slice(0, 10) });
    }
    if (messages.length > 0) perSession.push(messages.reverse());
  }
  const max = options.maxMessages ?? CHAT_MAX_MESSAGES;
  const result: SampleInput[] = [];
  for (let round = 0; result.length < max; round += 1) {
    let any = false;
    for (const messages of perSession) {
      const message = messages[round];
      if (message === undefined) continue;
      any = true;
      result.push(message);
      if (result.length >= max) break;
    }
    if (!any) break;
  }
  return result;
}
