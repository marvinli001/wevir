import type { AgentInput } from '@wevir/runtime-adapter';
import { isRecord } from './mapping.js';
import type { CollabAgentToolCallItem } from './protocol.js';

// 子 agent → 子会话的纯逻辑（R4，codex-event-mapping.md §6.5）：从 collabAgentToolCall 认出子 thread、兜底标题、子回合的输入。

/** 子 agent 的状态里表示“没有这个子 agent”的值（等待或关闭一个不存在的 ID 时），这样的 receiver 不当作子会话。 */
const NOT_FOUND = 'notFound';

/** 是不是 collabAgentToolCall item（只检查要读的字段）。 */
export function isCollabItem(item: unknown): item is CollabAgentToolCallItem {
  return (
    isRecord(item) &&
    item.type === 'collabAgentToolCall' &&
    typeof item.id === 'string' &&
    typeof item.tool === 'string' &&
    Array.isArray(item.receiverThreadIds)
  );
}

/** item 指向的子 thread：`receiverThreadIds` 里去掉 `agentsStates` 报 notFound 的。 */
export function collabReceivers(item: CollabAgentToolCallItem): string[] {
  const states = isRecord(item.agentsStates) ? item.agentsStates : {};
  return item.receiverThreadIds.filter((id): id is string => {
    if (typeof id !== 'string' || id === '') return false;
    const state = states[id];
    return !(isRecord(state) && state.status === NOT_FOUND);
  });
}

/** 去掉首尾空白后非空才算有。 */
export function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 文本的第一个非空行。 */
export function firstLine(text: string | undefined): string | undefined {
  return text
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
}

/**
 * 子会话的兜底标题（ADR-0005 决策 6.1）：Codex 给的 thread 名称 → 任务描述的第一行 → 昵称；都没有时为空串。截断由
 * Host 做（与首条消息的截断标题同一个长度）。
 */
export function subagentTitle(parts: {
  name?: string;
  prompt?: string;
  nickname?: string;
}): string {
  return nonEmpty(parts.name) ?? firstLine(parts.prompt) ?? nonEmpty(parts.nickname) ?? '';
}

/** 子回合的 userMessage item → `turn.started` 的输入（只取文本）；没有文本时 undefined。 */
export function userMessageInput(item: unknown): AgentInput['content'] | undefined {
  if (!isRecord(item) || item.type !== 'userMessage' || !Array.isArray(item.content)) {
    return undefined;
  }
  const parts = item.content.flatMap((part) =>
    isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.text !== ''
      ? [{ type: 'text' as const, text: part.text }]
      : [],
  );
  return parts.length === 0 ? undefined : parts;
}
