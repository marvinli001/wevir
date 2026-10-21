// 任务回顾的投影（0.76.0，ADR-0012 决策 3、4、7）：把会话事件归约成一份可以存进 SQLite 的状态。纯函数，只看事件，不读文件、不调
// 模型；同一串事件不管一次喂完还是分几次喂，结果都一样（增量 = 全量）。撤销与撤回会回头影响早先的回合，所以状态按回合分桶，撤销只
// 给桶打标记，重做再去掉。现读的东西（代码状态、回合快照、Git、批注）不在这里，见 live.ts；怎么组出回顾见 build.ts。

import {
  RETRO_COMMAND_MAX_CHARS,
  RETRO_SCHEMA_VERSION,
  RETRO_TEXT_MAX_CHARS,
  RETRO_USER_TEXT_MAX_CHARS,
  type UserContentPart,
  type VerificationRun,
  type WevirEvent,
} from '@wevir/protocol';

/** 投影里留的验证记录条数（按最近一次更新的先后），多了丢最早的。 */
export const RETRO_RUNS_KEPT = 200;
/** 每个回合留的命令数与记忆操作数。 */
export const RETRO_TURN_COMMANDS_KEPT = 50;
/** 状态里留的回合外的决定（撤销、接力）条数。 */
export const RETRO_SESSION_DECISIONS_KEPT = 200;

export type RetroTurnKind = 'user' | 'repair' | 'report' | 'command' | 'goal' | 'engine';

export interface RetroStateText {
  seq: number;
  text: string;
}

export interface RetroStateDecision {
  seq: number;
  kind: string;
  text: string;
  turnId?: string;
}

export interface RetroStateCommand {
  seq: number;
  toolCallId: string;
  text: string;
  status?: string;
}

export interface RetroStateMemory {
  seq: number;
  scope: 'global' | 'project';
  name: string;
  operation: 'save' | 'delete';
}

/** 一个章节（0.82.0）；`turnId` 是标记它的回合，回合被撤销或撤回时章节随之不列。 */
export interface RetroStateChapter {
  seq: number;
  ts: string;
  title: string;
  summary?: string;
  turnId?: string;
}

/** 一个回合的桶。 */
export interface RetroStateTurn {
  turnId: string;
  /** 回合最早的事件（通常是 `user.message`）。 */
  seq: number;
  ts: string;
  /** `turn.started` 的 `seq`。 */
  startSeq?: number;
  endSeq?: number;
  outcome?: string;
  /** 撤销了且没重做。 */
  hidden?: true;
  kind: RetroTurnKind;
  /** 回合的用户消息（截短）；`steers` 是回合里的插话。 */
  message?: RetroStateText;
  steers: RetroStateText[];
  /** 回合里的用户决定：回答提问、拒绝审批、回合被停止。 */
  decisions: RetroStateDecision[];
  todos?: { seq: number; items: { content: string; status: string }[] };
  files: string[];
  commands: RetroStateCommand[];
  omittedCommands: number;
  memory: RetroStateMemory[];
}

/** 一条验证记录最近的样子（只留回顾用得上的字段）。 */
export interface RetroStateRun {
  seq: number;
  run: Pick<
    VerificationRun,
    | 'id'
    | 'checkId'
    | 'name'
    | 'command'
    | 'kind'
    | 'status'
    | 'reason'
    | 'codeState'
    | 'tests'
    | 'exitCode'
    | 'turnId'
    | 'finishedAt'
  >;
}

export interface RetroState {
  v: typeof RETRO_SCHEMA_VERSION;
  throughSeq: number;
  /** 最近一个“有内容”的事件（不算增量、原始帧、用量、输入建议）；模型摘要看它判断自己是否过期。 */
  lastSubstantiveSeq: number;
  created?: {
    seq: number;
    ts: string;
    forkedFrom?: { sessionId: string; turnId?: string };
    side?: true;
    parentId?: string;
  };
  /** 分支时抄来的历史到哪一条为止（含）。 */
  inheritedThrough?: number;
  goal?: { seq: number; ts: string; objective: string; status: string };
  turns: RetroStateTurn[];
  activeTurnId?: string;
  board?: {
    seq: number;
    tasks: { id: string; subject: string; status: string; owner?: string }[];
  };
  runs: RetroStateRun[];
  acceptance?: { seq: number; status: string };
  /** 还没结束的审批与提问（`turnId` 用来判断是否在撤销的回合里）。 */
  pendingApprovals: { id: string; seq: number; turnId: string; text: string }[];
  pendingQuestions: { id: string; seq: number; turnId: string; text: string }[];
  /** 撤销、重做、撤回、接力。 */
  decisions: RetroStateDecision[];
  children: { sessionId: string; seq: number; relation: 'subagent' | 'opened'; text: string }[];
  chapters: RetroStateChapter[];
}

export function emptyRetroState(): RetroState {
  return {
    v: RETRO_SCHEMA_VERSION,
    throughSeq: 0,
    lastSubstantiveSeq: 0,
    turns: [],
    runs: [],
    pendingApprovals: [],
    pendingQuestions: [],
    decisions: [],
    children: [],
    chapters: [],
  };
}

/** 不改变回顾内容的事件：不算“有内容”。 */
const QUIET_EVENTS: ReadonlySet<string> = new Set([
  'assistant.delta',
  'assistant.stream_ended',
  'plan.delta',
  'engine.raw',
  'usage.updated',
  'suggestion.updated',
  'insight.updated',
  'session.state_changed',
  'pending.added',
  'pending.updated',
  'ui.show',
  'subagent.updated',
]);

/** 按码点截短，空白折叠成一个空格。 */
export function clipText(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

function contentText(content: readonly UserContentPart[]): string {
  return content
    .map((part) => (part.type === 'text' ? part.text : '[image]'))
    .join('\n')
    .trim();
}

/** 工具的参数：Codex 的 MCP 调用把参数包在 `args` 里（`{ server, tool, args }`）。 */
function toolArgs(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const args = record.args ?? record.arguments;
  if (typeof args === 'object' && args !== null) return args as Record<string, unknown>;
  return record;
}

function memoryOperation(toolName: string): 'save' | 'delete' | undefined {
  if (toolName.endsWith('wevir_memory_save')) return 'save';
  if (toolName.endsWith('wevir_memory_delete')) return 'delete';
  return undefined;
}

/**
 * 归约：在 `state` 上应用 `events`（`seq` 升序、都大于 `state.throughSeq`），返回新状态。不改传入的状态。重复或更早的事件忽略，
 * 所以增量更新时多读了几条也不会算两次。
 */
export function foldRetro(state: RetroState, events: readonly WevirEvent[]): RetroState {
  const next: RetroState = structuredClone(state);
  for (const event of events) {
    if (event.seq <= next.throughSeq) continue;
    applyEvent(next, event);
    next.throughSeq = event.seq;
    if (!QUIET_EVENTS.has(event.type)) next.lastSubstantiveSeq = event.seq;
  }
  return next;
}

function turnOf(state: RetroState, turnId: string): RetroStateTurn | undefined {
  for (let index = state.turns.length - 1; index >= 0; index -= 1) {
    const turn = state.turns[index] as RetroStateTurn;
    if (turn.turnId === turnId) return turn;
  }
  return undefined;
}

function ensureTurn(state: RetroState, event: WevirEvent, turnId: string): RetroStateTurn {
  const existing = turnOf(state, turnId);
  if (existing !== undefined) return existing;
  const turn: RetroStateTurn = {
    turnId,
    seq: event.seq,
    ts: event.ts,
    kind: state.created?.parentId !== undefined ? 'engine' : 'user',
    steers: [],
    decisions: [],
    files: [],
    commands: [],
    omittedCommands: 0,
    memory: [],
  };
  state.turns.push(turn);
  return turn;
}

function addSessionDecision(state: RetroState, decision: RetroStateDecision): void {
  state.decisions.push(decision);
  if (state.decisions.length > RETRO_SESSION_DECISIONS_KEPT) state.decisions.shift();
}

function applyEvent(state: RetroState, event: WevirEvent): void {
  switch (event.type) {
    case 'session.created': {
      const { forkedFrom, side, parent } = event.payload;
      state.created = {
        seq: event.seq,
        ts: event.ts,
        ...(forkedFrom !== undefined && { forkedFrom: { ...forkedFrom } }),
        ...(side === true && { side: true as const }),
        ...(parent !== undefined && { parentId: parent.sessionId }),
      };
      break;
    }
    case 'session.goal_changed': {
      const { goal } = event.payload;
      if (goal === null) delete state.goal;
      else {
        state.goal = {
          seq: event.seq,
          ts: event.ts,
          objective: clipText(goal.objective, RETRO_USER_TEXT_MAX_CHARS),
          status: goal.status,
        };
      }
      break;
    }
    case 'session.handoff': {
      const { from, to } = event.payload;
      addSessionDecision(state, {
        seq: event.seq,
        kind: 'handoff',
        text: `${from.providerId}/${from.modelId} → ${to.providerId}/${to.modelId}`,
      });
      break;
    }
    case 'user.message': {
      const turn = ensureTurn(state, event, event.payload.turnId);
      const { from } = event.payload;
      if (from?.repair !== undefined) turn.kind = 'repair';
      else if (from !== undefined) turn.kind = 'report';
      else turn.kind = 'user';
      if (turn.message === undefined) {
        turn.message = {
          seq: event.seq,
          text: clipText(contentText(event.payload.content), RETRO_USER_TEXT_MAX_CHARS),
        };
      }
      break;
    }
    case 'user.steered': {
      const turn = ensureTurn(state, event, event.payload.turnId);
      if (event.payload.from === undefined) {
        turn.steers.push({
          seq: event.seq,
          text: clipText(contentText(event.payload.content), RETRO_USER_TEXT_MAX_CHARS),
        });
      }
      break;
    }
    case 'turn.started': {
      const turn = ensureTurn(state, event, event.payload.turnId);
      turn.startSeq = event.seq;
      if (event.payload.command !== undefined) turn.kind = 'command';
      else if (event.payload.trigger === 'goal' && turn.message === undefined) turn.kind = 'goal';
      else if (event.payload.input !== undefined && turn.message === undefined) {
        turn.kind = 'engine';
        turn.message = {
          seq: event.seq,
          text: clipText(contentText(event.payload.input), RETRO_USER_TEXT_MAX_CHARS),
        };
      }
      state.activeTurnId = event.payload.turnId;
      break;
    }
    case 'turn.finished': {
      const turn = ensureTurn(state, event, event.payload.turnId);
      turn.endSeq = event.seq;
      turn.outcome = event.payload.outcome;
      // 回合被停止：用户按了停止，或用户的新消息让修复回合让位（ADR-0008 决策 12）。
      if (event.payload.outcome === 'cancelled') {
        turn.decisions.push({ seq: event.seq, kind: 'cancelled', text: '' });
      }
      if (state.activeTurnId === event.payload.turnId) delete state.activeTurnId;
      if (
        state.created?.forkedFrom?.turnId === event.payload.turnId &&
        state.inheritedThrough === undefined &&
        event.ts <= state.created.ts
      ) {
        // 分支：抄来的历史以被分回合的结束为止（抄来的事件保留原来的时刻，早于新会话的创建）。
        state.inheritedThrough = event.seq;
      }
      break;
    }
    case 'turn.rewound': {
      const index = state.turns.findIndex((turn) => turn.turnId === event.payload.turnId);
      if (index >= 0) state.turns.splice(index, 1);
      addSessionDecision(state, { seq: event.seq, kind: 'rewound', text: '' });
      break;
    }
    case 'turn.undone': {
      const turn = turnOf(state, event.payload.turnId);
      if (turn !== undefined) turn.hidden = true;
      addSessionDecision(state, {
        seq: event.seq,
        kind: 'undone',
        text: '',
        turnId: event.payload.turnId,
      });
      break;
    }
    case 'turn.redone': {
      const turn = turnOf(state, event.payload.turnId);
      if (turn !== undefined) delete turn.hidden;
      addSessionDecision(state, {
        seq: event.seq,
        kind: 'redone',
        text: '',
        turnId: event.payload.turnId,
      });
      break;
    }
    case 'tool.started': {
      const { turnId, toolCallId, toolName, display, input } = event.payload;
      const turn = ensureTurn(state, event, turnId);
      if (display.kind === 'shell') {
        const command = display.command ?? display.summary ?? toolName;
        if (turn.commands.length >= RETRO_TURN_COMMANDS_KEPT) {
          turn.commands.shift();
          turn.omittedCommands += 1;
        }
        turn.commands.push({
          seq: event.seq,
          toolCallId,
          text: clipText(command, RETRO_COMMAND_MAX_CHARS),
        });
      } else if (display.kind === 'edit' || display.kind === 'write') {
        for (const path of display.paths ?? []) {
          if (path !== '' && !turn.files.includes(path)) turn.files.push(path);
        }
      }
      const operation = memoryOperation(toolName);
      const args = operation === undefined ? undefined : toolArgs(input);
      if (operation !== undefined && typeof args?.name === 'string' && args.name !== '') {
        if (turn.memory.length < RETRO_TURN_COMMANDS_KEPT) {
          turn.memory.push({
            seq: event.seq,
            scope: args.scope === 'global' ? 'global' : 'project',
            name: args.name,
            operation,
          });
        }
      }
      break;
    }
    case 'tool.finished': {
      const turn = turnOf(state, event.payload.turnId);
      const command = turn?.commands.find((item) => item.toolCallId === event.payload.toolCallId);
      if (command !== undefined) command.status = event.payload.status;
      break;
    }
    case 'todo.updated': {
      const turn = ensureTurn(state, event, event.payload.turnId);
      turn.todos = {
        seq: event.seq,
        items: event.payload.items.map((item) => ({
          content: clipText(item.content, RETRO_TEXT_MAX_CHARS),
          status: item.status,
        })),
      };
      break;
    }
    case 'tasks.board_updated':
      state.board = {
        seq: event.seq,
        tasks: event.payload.tasks.map((task) => ({
          id: task.id,
          subject: clipText(task.subject, RETRO_TEXT_MAX_CHARS),
          status: task.status,
          ...(task.owner !== undefined && { owner: task.owner }),
        })),
      };
      break;
    case 'approval.requested': {
      const { approval } = event.payload;
      const detail = approval.detail;
      const text =
        detail === null
          ? ''
          : (detail.display.command ?? detail.display.summary ?? detail.toolName);
      state.pendingApprovals.push({
        id: approval.id,
        seq: event.seq,
        turnId: approval.turnId,
        text: clipText(text, RETRO_COMMAND_MAX_CHARS),
      });
      break;
    }
    case 'approval.resolved': {
      const index = state.pendingApprovals.findIndex(
        (approval) => approval.id === event.payload.approvalId,
      );
      const approval = index >= 0 ? state.pendingApprovals[index] : undefined;
      if (index >= 0) state.pendingApprovals.splice(index, 1);
      if (
        approval !== undefined &&
        event.payload.status === 'denied' &&
        event.payload.resolution.reason === 'user'
      ) {
        turnOf(state, approval.turnId)?.decisions.push({
          seq: event.seq,
          kind: 'declined',
          text: approval.text,
        });
      }
      break;
    }
    case 'question.requested': {
      const { question } = event.payload;
      state.pendingQuestions.push({
        id: question.id,
        seq: event.seq,
        turnId: question.turnId,
        text: clipText(
          question.questions.map((item) => item.question).join(' / '),
          RETRO_TEXT_MAX_CHARS,
        ),
      });
      break;
    }
    case 'question.resolved': {
      const index = state.pendingQuestions.findIndex(
        (question) => question.id === event.payload.questionId,
      );
      const question = index >= 0 ? state.pendingQuestions[index] : undefined;
      if (index >= 0) state.pendingQuestions.splice(index, 1);
      const answers = event.payload.resolution.answers;
      if (question !== undefined && event.payload.status === 'answered' && answers !== undefined) {
        const picked = Object.values(answers)
          .flatMap((answer) => answer.answers)
          .join(', ');
        turnOf(state, question.turnId)?.decisions.push({
          seq: event.seq,
          kind: 'answer',
          text: clipText(`${question.text} → ${picked}`, RETRO_TEXT_MAX_CHARS),
        });
      }
      break;
    }
    case 'subagent.started': {
      const { subagent } = event.payload;
      state.children.push({
        sessionId: subagent.sessionId,
        seq: event.seq,
        relation: 'subagent',
        text: clipText(subagent.nickname ?? subagent.title, RETRO_TEXT_MAX_CHARS),
      });
      break;
    }
    case 'task.started': {
      if (!state.children.some((child) => child.sessionId === event.payload.sessionId)) {
        state.children.push({
          sessionId: event.payload.sessionId,
          seq: event.seq,
          relation: 'opened',
          text: '',
        });
      }
      break;
    }
    case 'verification.updated': {
      const { run } = event.payload;
      const index = state.runs.findIndex((entry) => entry.run.id === run.id);
      if (index >= 0) state.runs.splice(index, 1);
      state.runs.push({
        seq: event.seq,
        run: {
          id: run.id,
          checkId: run.checkId,
          name: run.name,
          command: clipText(run.command, RETRO_COMMAND_MAX_CHARS),
          kind: run.kind,
          status: run.status,
          ...(run.reason !== undefined && { reason: run.reason }),
          ...(run.codeState !== undefined && { codeState: run.codeState }),
          ...(run.tests !== undefined && { tests: run.tests }),
          ...(run.exitCode !== undefined && { exitCode: run.exitCode }),
          ...(run.turnId !== undefined && { turnId: run.turnId }),
          ...(run.finishedAt !== undefined && { finishedAt: run.finishedAt }),
        },
      });
      if (state.runs.length > RETRO_RUNS_KEPT) state.runs.shift();
      break;
    }
    case 'acceptance.changed':
      state.acceptance = { seq: event.seq, status: event.payload.acceptance.status };
      break;
    case 'chapter.marked': {
      const { title, summary, turnId } = event.payload;
      state.chapters.push({
        seq: event.seq,
        ts: event.ts,
        title: clipText(title, RETRO_TEXT_MAX_CHARS),
        ...(summary !== undefined && { summary: clipText(summary, RETRO_TEXT_MAX_CHARS) }),
        ...(turnId !== undefined && { turnId }),
      });
      break;
    }
    default:
      break;
  }
}

/**
 * 读回存下的状态：形状不对（缺字段、类型不对、版本不同）时是 undefined，调用方从头重放。只查结构上的要点，不逐字段校验——状态是
 * Host 自己写的，坏只会是整体坏（写了一半、手改、旧版本）。
 */
export function parseRetroState(text: string): RetroState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const state = value as Partial<RetroState>;
  const arrays = [
    state.turns,
    state.runs,
    state.pendingApprovals,
    state.pendingQuestions,
    state.decisions,
    state.children,
    state.chapters,
  ];
  if (
    state.v !== RETRO_SCHEMA_VERSION ||
    typeof state.throughSeq !== 'number' ||
    !Number.isInteger(state.throughSeq) ||
    state.throughSeq < 0 ||
    typeof state.lastSubstantiveSeq !== 'number' ||
    arrays.some((array) => !Array.isArray(array))
  ) {
    return undefined;
  }
  for (const turn of state.turns as unknown[]) {
    if (typeof turn !== 'object' || turn === null) return undefined;
    const t = turn as Partial<RetroStateTurn>;
    if (
      typeof t.turnId !== 'string' ||
      typeof t.seq !== 'number' ||
      !Array.isArray(t.files) ||
      !Array.isArray(t.commands) ||
      !Array.isArray(t.steers) ||
      !Array.isArray(t.decisions) ||
      !Array.isArray(t.memory)
    ) {
      return undefined;
    }
  }
  return state as RetroState;
}
