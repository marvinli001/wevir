import { randomBytes } from 'node:crypto';
import type { MessageFrom, UserContentPart } from '@wevir/protocol';

// 转来的消息的信封（prompts/base.md「不可信内容」）：别的会话里的 agent 发来的消息、Host 回报的回合结果、后台进程的通知，
// 交给引擎时包进 `<relayed_message trust="relay">`，开闭标签带同一个随机 id，让模型分清它不是用户在输入框里写的，
// 文件或命令输出里照抄的同样格式的文字也冒充不了。参照 Claude Code 桌面版的 `<pasted_content>` 与 `trust="relay"`。
// 只改交给引擎的输入：事件里存的仍是原文，客户端照 `from` 显示。自动修复与引用的第二意见是 Host 或用户发起的，不包。

/** 这条消息要不要包、包成什么：返回信封的属性，不包时 `undefined`。 */
function relayAttributes(from: MessageFrom): Record<string, string> | undefined {
  if (from.repair !== undefined || from.opinion !== undefined) return undefined;
  if (from.process !== undefined) {
    return {
      kind: 'process_notice',
      from: `background process ${from.process.id} (${from.process.name})`,
    };
  }
  return { kind: from.kind, from: `session ${from.sessionId}` };
}

function attribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** 交给引擎的内容：转来的消息在第一段文字前加开标签、最后一段文字后加闭标签；用户自己的消息原样返回。 */
export function relayContent(
  from: MessageFrom | undefined,
  content: readonly UserContentPart[],
  id: string = randomBytes(6).toString('hex'),
): UserContentPart[] {
  const attributes = from === undefined ? undefined : relayAttributes(from);
  const first = content.findIndex((part) => part.type === 'text');
  if (attributes === undefined || first === -1) return [...content];
  const last = content.findLastIndex((part) => part.type === 'text');
  const attrs = Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${attribute(value)}"`)
    .join('');
  return content.map((part, index) => {
    if (part.type !== 'text') return part;
    let text = part.text;
    if (index === first) text = `<relayed_message id="${id}" trust="relay"${attrs}>\n${text}`;
    if (index === last) text = `${text}\n</relayed_message id="${id}">`;
    return { type: 'text', text };
  });
}
