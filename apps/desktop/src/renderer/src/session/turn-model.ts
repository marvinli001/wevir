// 回合在消息流里的折叠（U2，照 Codex 桌面端 design-refs/10–12 与方向稿 A 静器）：正常完成的回合把用户消息到最后一段
// 助手正文之间的全部过程收进一行“已处理 2 分 31 秒”，只留最后的回答、错误与插话；回答下面是“N 个文件已更改 +a −d”。
// 出错、被停止、被中断的回合不自动折叠，那一行写“出错 · 用时”等。工作组（一串思考与工具调用）的分组在 tool-model.ts。

import type { ChatMessage, ChatPart } from '@wevir/client-sdk';
import type { SessionState, TurnId, TurnOutcome } from '@wevir/protocol';
import { t } from '@/i18n';
import { formatDuration } from './format';
import { visibleParts } from './subagent-model';
import { editStats, type IssueKind, type LineStats, toolLifecycle } from './tool-model';

/** 消息流的一块：一个回合的全部消息（用户消息、助手消息、插话），或一条不属于回合的系统消息。 */
export type TranscriptBlock =
  | { kind: 'turn'; key: string; turnId: TurnId; messages: ChatMessage[] }
  | { kind: 'message'; key: string; message: ChatMessage };

/** 连续的同一回合的消息合成一块；系统消息单独一块。块的 key 是第一条消息的 ID。 */
export function groupTurns(messages: readonly ChatMessage[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let current: Extract<TranscriptBlock, { kind: 'turn' }> | undefined;
  for (const message of messages) {
    if (message.role === 'system') {
      current = undefined;
      blocks.push({ kind: 'message', key: message.id, message });
    } else if (current?.turnId === message.turnId) {
      current.messages.push(message);
    } else {
      current = { kind: 'turn', key: message.id, turnId: message.turnId, messages: [message] };
      blocks.push(current);
    }
  }
  return blocks;
}

/**
 * 某个事件在消息流里的位置（任务回顾跳到出处，0.76.0）：seq 范围包含它的那条消息；没有时取它之前最近的一条（事件没有
 * 自己的消息，例如审批、检查）。都没有时 -1。
 */
export function messageIndexForSeq(messages: readonly ChatMessage[], seq: number): number {
  let before = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const [first, last] = (messages[index] as ChatMessage).seqRange;
    if (first <= seq && seq <= last) return index;
    if (first <= seq) before = index;
  }
  return before;
}

/** 一块（回合或系统消息）覆盖的 seq 范围。 */
export function blockSeqRange(block: TranscriptBlock): readonly [number, number] {
  const messages = block.kind === 'turn' ? block.messages : [block.message];
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (const message of messages) {
    first = Math.min(first, message.seqRange[0]);
    last = Math.max(last, message.seqRange[1]);
  }
  return [first, last];
}

/**
 * 分段渲染的起点往前挪到所在回合的第一条消息：一个回合不会只渲染后半截（折叠要看到整个回合）。
 */
export function turnStart(messages: readonly ChatMessage[], index: number): number {
  let start = index;
  const turnId = (message: ChatMessage | undefined) =>
    message && message.role !== 'system' ? message.turnId : undefined;
  const id = turnId(messages[start]);
  while (id !== undefined && start > 0 && turnId(messages[start - 1]) === id) start -= 1;
  return start;
}

/** 会话正在进行的回合（运行中、等待审批、正在取消）。 */
export function isActiveTurn(
  turnId: TurnId,
  transcript: { activeTurnId: TurnId | undefined; state: SessionState | undefined },
): boolean {
  return (
    turnId === transcript.activeTurnId &&
    (transcript.state === 'running' ||
      transcript.state === 'awaiting_approval' ||
      transcript.state === 'cancelling')
  );
}

export interface TurnFold {
  /** 回合结束了才有：结果与用时（`turn.started` 到 `turn.finished`，Host 算的 `durationMs`）。 */
  finished?: { outcome: TurnOutcome; durationMs: number };
  /** 回合开始的时刻（进行中的计时）。 */
  startedAt?: string;
  /** 最后一段正文：`<消息 ID>/<部件 key>`。 */
  finalKey?: string;
  /** 除了最后一段正文、错误与插话，还有别的内容（思考、工具、子智能体、待办）。 */
  hasProcess: boolean;
  /** 显示回合那一行（“已处理 …”“出错 · …”）。 */
  showHeader: boolean;
  /** 默认收起：正常完成且有过程。出错、被停止、被中断的不自动收起。 */
  defaultFolded: boolean;
  /** 成功的修改涉及的文件数与增删行数（回答下面的“N 个文件已更改”）。 */
  changes: { files: number } & LineStats;
  /** 收起的过程里不能被吞掉的调用。 */
  issues: Record<IssueKind, number>;
}

/**
 * 插话（R11）、错误部件、建议的任务（U23：卡片与回报）、上下文压缩（0.24.0）、计划（0.36.0）、交给用户的文件（0.40.0）、第二意见（0.75.0）、
 * 审查发现（0.83.0）与护栏拦截（0.86.0）始终显示，收起的回合里也在。
 */
export function alwaysShown(part: ChatPart): boolean {
  return (
    part.type === 'error' ||
    part.type === 'plan' ||
    part.type === 'tasks' ||
    part.type === 'task_report' ||
    part.type === 'opinion' ||
    part.type === 'files' ||
    part.type === 'findings' ||
    part.type === 'guardrail' ||
    part.type === 'compaction' ||
    part.type === 'chapter'
  );
}

/** `finalKey` 的格式。 */
export function partId(messageId: string, partKey: string): string {
  return `${messageId}/${partKey}`;
}

/**
 * 一个回合的折叠信息。`messages` 是 `groupTurns` 的一块；`hasSubagents` 同 `visibleParts`（派出过子会话时 collab
 * 调用不显示，也就不算过程）；`turnActive` 同 `toolLifecycle`。
 */
export function foldTurn(
  messages: readonly ChatMessage[],
  hasSubagents: boolean,
  turnActive: boolean,
): TurnFold {
  let finished: TurnFold['finished'];
  let startedAt: string | undefined;
  let finalKey: string | undefined;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    startedAt ??= message.startedAt;
    if (message.finished) finished = message.finished;
    for (const part of message.parts) {
      if (part.type === 'text') finalKey = partId(message.id, part.key);
    }
  }
  let hasProcess = false;
  const paths = new Set<string>();
  let unnamed = 0;
  const changes = { files: 0, added: 0, removed: 0 };
  const issues: TurnFold['issues'] = { failed: 0, denied: 0, unknown: 0 };
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of visibleParts(message.parts, hasSubagents)) {
      if (partId(message.id, part.key) === finalKey || alwaysShown(part)) continue;
      hasProcess = true;
      if (part.type !== 'tool') continue;
      const lifecycle = toolLifecycle(part, turnActive);
      if (lifecycle === 'failed' || lifecycle === 'denied' || lifecycle === 'unknown') {
        issues[lifecycle] += 1;
      }
      if (lifecycle !== 'completed') continue;
      const stats = editStats(part);
      if (!stats) continue;
      if (part.display.paths?.length) for (const path of part.display.paths) paths.add(path);
      else unnamed += 1;
      changes.added += stats.added;
      changes.removed += stats.removed;
    }
  }
  changes.files = paths.size + unnamed;
  const showHeader = finished !== undefined && (finished.outcome !== 'completed' || hasProcess);
  return {
    ...(finished && { finished }),
    ...(startedAt !== undefined && { startedAt }),
    ...(finalKey !== undefined && { finalKey }),
    hasProcess,
    showHeader,
    defaultFolded: finished?.outcome === 'completed' && hasProcess,
    changes,
    issues,
  };
}

/** 收起时留在助手消息里的部件：最后一段正文与 `alwaysShown` 的那些。 */
function keptInFold(messageId: string, part: ChatPart, fold: TurnFold): boolean {
  return partId(messageId, part.key) === fold.finalKey || alwaysShown(part);
}

/** 收起时一条消息里留下的部件：最后一段正文与错误。用户消息与插话整条留下。 */
export function foldedParts(message: ChatMessage, fold: TurnFold): readonly ChatPart[] {
  if (message.role !== 'assistant') return message.parts;
  return message.parts.filter((part) => keptInFold(message.id, part, fold));
}

/**
 * 交给用户的文件（0.40.0）排到回答后面（照 Codex）：回合结束后，同一条消息里在最后一段正文之前的文件卡片挪到这段正文
 * 之后，彼此顺序不变。进行中的回合不挪（正文还在变，卡片会跳）；回答不在这条消息里时原样返回。
 */
export function filesAfterAnswer<T extends ChatPart>(
  messageId: string,
  parts: readonly T[],
  fold: TurnFold,
): readonly T[] {
  if (!fold.finished) return parts;
  const answer = parts.findIndex((part) => partId(messageId, part.key) === fold.finalKey);
  if (answer < 0) return parts;
  const before = parts.slice(0, answer);
  const files = before.filter((part) => part.type === 'files');
  if (files.length === 0) return parts;
  return [
    ...before.filter((part) => part.type !== 'files'),
    parts[answer] as T,
    ...files,
    ...parts.slice(answer + 1),
  ];
}

/** 助手消息的一段：收起时留下的部件（`kept`），或夹在它们之间的一串过程。`key` 取第一个部件的 key。 */
export interface FoldSegment {
  key: string;
  kept: boolean;
  parts: ChatPart[];
}

/**
 * 有回合那一行的助手消息按收起时留不留分段（`parts` 是这条消息要显示的部件，已按 `visibleParts` 筛过）：过程段在展开、
 * 收起时有高度过渡，留下的段不动。留下的部件不是思考、工具或子智能体，本来就断开工作组，分段不改变 `groupWork` 的分组。
 */
export function foldSegments(
  messageId: string,
  parts: readonly ChatPart[],
  fold: TurnFold,
): FoldSegment[] {
  const segments: FoldSegment[] = [];
  for (const part of parts) {
    const kept = keptInFold(messageId, part, fold);
    const last = segments.at(-1);
    if (last && last.kept === kept) last.parts.push(part);
    else segments.push({ key: part.key, kept, parts: [part] });
  }
  return segments;
}

/** 回合那一行的文字：“已处理 2 分 31 秒”“出错 · 12 秒”“已停止 · 3 秒”“已中断 · 1 分 2 秒”。 */
export function turnHeaderText(finished: { outcome: TurnOutcome; durationMs: number }): string {
  return t(`turn.header.${finished.outcome}`, { duration: formatDuration(finished.durationMs) });
}

/** 会话最后一个回合（0.38.0，编辑最后一条用户消息）：最后一条用户或助手消息所在的回合；没有回合时 `undefined`。 */
export function lastTurnId(transcript: { messages: readonly ChatMessage[] }): TurnId | undefined {
  for (let i = transcript.messages.length - 1; i >= 0; i--) {
    const message = transcript.messages[i];
    if (message !== undefined && message.role !== 'system') return message.turnId;
  }
  return undefined;
}
