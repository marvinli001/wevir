// 会话进行中的进度（应用级工具，domain-model §3.15 的“进度”一条）：从事件库里进行中的回合推出“正在做什么”，给 `wevir_session_wait`、
// `wevir_session_progress` 与 `wevir_session_list`。只读事件与快照，不改任何状态；回合结束后没有进度（终态由状态、`lastTurn`
// 与回答给出）。

import type { SessionSnapshot, TodoItem, TurnId, WevirEvent } from '@wevir/protocol';

/** 最近完成的几个工具调用。 */
export const PROGRESS_RECENT_MAX = 5;
/** 列出改过的文件最多几个。 */
export const PROGRESS_FILES_MAX = 10;
/** 一行文字（正在做的事、工具摘要、清单项）最多多少字符。 */
const LINE_MAX = 160;
/** 最近一段回答最多多少字符。 */
export const PROGRESS_TEXT_MAX = 400;

export interface SessionProgress {
  turnId: TurnId;
  startedAt: string;
  elapsedMs: number;
  /** 现在在做什么，一行；等用户批准或回答时 `waitingForUser` 为真。 */
  doing: string;
  waitingForUser?: true;
  /** 这个回合里已经结束的工具调用数。 */
  toolsFinished: number;
  /** 最近结束的几个工具调用，旧的在前。 */
  recent: string[];
  /** 这个回合里改过的文件（编辑与写入成功的），最多 10 个。 */
  changedFiles: string[];
  /** 这个回合最近一份清单的进度。 */
  todos?: { done: number; total: number; current?: string };
  /** 这个会话派出的子会话。 */
  subagents?: { running: number; total: number };
  /** 会话累计用掉的 token（引擎报的话）。 */
  totalTokens?: number;
  /** 这个回合已提交的最后一段回答（前 400 字）。 */
  lastText?: string;
}

interface ToolRecord {
  name: string;
  summary: string | undefined;
  kind: string;
  paths: string[];
  status?: string;
}

function clip(text: string, max = LINE_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

/** 进行中的回合的事件：从它的 `turn.started` 往后；找不到时按 `turnId` 筛。 */
function turnEvents(events: readonly WevirEvent[], turnId: TurnId): WevirEvent[] {
  let start = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'turn.started' && event.payload.turnId === turnId) {
      start = index;
      break;
    }
  }
  const slice = start >= 0 ? events.slice(start) : events;
  return slice.filter((event) => {
    const payload = event.payload as { turnId?: unknown };
    return payload.turnId === turnId;
  });
}

function toolLine(tool: ToolRecord): string {
  const head = tool.summary === undefined ? tool.name : `${tool.name}: ${tool.summary}`;
  const line = clip(head, 120);
  return tool.status === undefined || tool.status === 'completed'
    ? line
    : `${line} (${tool.status})`;
}

/**
 * 进行中的回合的进度；会话没有进行中的回合（空闲、出错、已关闭）时 `undefined`。`events` 是这个会话的事件（按 `seq`），
 * `now` 是当前的毫秒时间。
 */
export function sessionProgress(
  snapshot: SessionSnapshot,
  events: readonly WevirEvent[],
  now: number,
): SessionProgress | undefined {
  const active = snapshot.session.activeTurn;
  if (active === undefined) return undefined;
  const turnId = active.turnId;

  const tools = new Map<string, ToolRecord>();
  const finished: ToolRecord[] = [];
  let todos: TodoItem[] | undefined;
  let lastText: string | undefined;
  let streaming: 'text' | 'reasoning' | undefined;
  for (const event of turnEvents(events, turnId)) {
    switch (event.type) {
      case 'tool.started': {
        const { toolCallId, toolName, display } = event.payload;
        tools.set(toolCallId, {
          name: toolName,
          summary: display.summary === undefined ? undefined : clip(display.summary),
          kind: display.kind,
          paths: display.paths ?? [],
        });
        streaming = undefined;
        break;
      }
      case 'tool.updated': {
        const tool = tools.get(event.payload.toolCallId);
        const display = event.payload.display;
        if (tool !== undefined && display !== undefined) {
          if (display.summary !== undefined) tool.summary = clip(display.summary);
          if (display.paths !== undefined) tool.paths = display.paths;
        }
        break;
      }
      case 'tool.finished': {
        const tool = tools.get(event.payload.toolCallId);
        if (tool !== undefined && tool.status === undefined) {
          tool.status = event.payload.status;
          finished.push(tool);
        }
        break;
      }
      case 'todo.updated':
        todos = event.payload.items;
        break;
      case 'assistant.message':
        lastText = event.payload.text;
        streaming = undefined;
        break;
      case 'assistant.delta':
        streaming = event.payload.kind;
        break;
      case 'assistant.thought':
        streaming = undefined;
        break;
      default:
        break;
    }
  }

  const approval = snapshot.pendingApprovals[0];
  const question = snapshot.pendingQuestions?.[0];
  const running = [...tools.values()].reverse().find((tool) => tool.status === undefined);
  let doing: string;
  let waitingForUser = false;
  if (approval !== undefined) {
    const what =
      approval.detail === null
        ? 'a tool call'
        : (approval.detail.display.summary ?? approval.detail.toolName);
    doing = `waiting for the user to approve ${clip(what, 120)}`;
    waitingForUser = true;
  } else if (question !== undefined) {
    doing = `waiting for the user to answer: ${clip(question.questions[0]?.question ?? '', 120)}`;
    waitingForUser = true;
  } else if (snapshot.session.state === 'cancelling') {
    doing = 'stopping';
  } else if (running !== undefined) {
    doing = `running ${toolLine(running)}`;
  } else if (streaming === 'text') {
    doing = 'writing its answer';
  } else if (streaming === 'reasoning') {
    doing = 'thinking';
  } else {
    doing = 'working';
  }

  const changed: string[] = [];
  for (const tool of finished) {
    if (tool.status !== 'completed' || (tool.kind !== 'edit' && tool.kind !== 'write')) continue;
    for (const path of tool.paths) {
      if (!changed.includes(path) && changed.length < PROGRESS_FILES_MAX) changed.push(path);
    }
  }
  const current = todos?.find((item) => item.status === 'in_progress');
  const subagents = snapshot.subagents;
  const totalTokens = snapshot.usage?.totalTokens;
  const text = lastText?.trim();
  return {
    turnId,
    startedAt: active.startedAt,
    elapsedMs: Math.max(0, now - Date.parse(active.startedAt)),
    doing,
    ...(waitingForUser && { waitingForUser: true as const }),
    toolsFinished: finished.length,
    recent: finished.slice(-PROGRESS_RECENT_MAX).map(toolLine),
    changedFiles: changed,
    ...(todos !== undefined &&
      todos.length > 0 && {
        todos: {
          done: todos.filter((item) => item.status === 'completed').length,
          total: todos.length,
          ...(current !== undefined && { current: clip(current.content) }),
        },
      }),
    ...(subagents !== undefined &&
      subagents.length > 0 && {
        subagents: {
          running: subagents.filter((child) => child.status === 'running').length,
          total: subagents.length,
        },
      }),
    ...(totalTokens !== undefined && { totalTokens }),
    ...(text !== undefined && text !== '' && { lastText: clip(text, PROGRESS_TEXT_MAX) }),
  };
}
