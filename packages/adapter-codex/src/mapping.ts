import type {
  AgentEvent,
  AssistantStreamEndedEvent,
  DeltaBlockRef,
  EngineRawEvent,
  TodoItem,
  ToolDisplay,
  TurnFailedEvent,
  TurnSettledEvent,
} from '@wevir/runtime-adapter';
import type {
  AgentMessageItem,
  ApprovalRequestMethod,
  CommandExecutionItem,
  CommandExecutionRequestApprovalParams,
  DeltaNotification,
  ErrorNotification,
  FileChangeItem,
  FileChangeRequestApprovalParams,
  ItemNotification,
  McpProgressNotification,
  PatchUpdatedNotification,
  ReasoningItem,
  TokenUsageNotification,
  ToolItem,
  TurnNotification,
  TurnPlanStepStatus,
  TurnPlanUpdatedNotification,
} from './protocol.js';
import {
  fileChangeDisplay,
  isToolItem,
  toolDisplay,
  toolName,
  toolOutput,
} from './tool-display.js';
import { classifyTurnError } from './turn-error.js';

// codex-app-server 的通知 → AgentEvent（docs/architecture/codex-event-mapping.md §6，codex-notes §10）。一个会话
// （一个 thread）一个映射器，按通知到达的顺序调用 `map`；回合开始时 `reset`。输入是 app-server 写出的原始参数，
// 不做 schema 校验，只检查要读的字段；对不上的整条保留为 engine.raw，不丢弃。
//
// 增量与已提交消息：Codex 的增量与已提交项共用 itemId，对齐是直接的（不需要 adapter-dsh 的 DeltaMerger）。每个
// agentMessage / reasoning item 是一个 attempt（`attemptId` = itemId；推理摘要另用 `<itemId>/summary`），块号是
// 内容序号（agentMessage 只有块 0）。

/** engine.raw 的 `protocol`。 */
export const ENGINE_RAW_PROTOCOL = 'codex-app-server';

/** 映射成 Wevir 事件的通知（其余一律 engine.raw，除了 `IGNORED_NOTIFICATIONS`）。 */
export const MAPPED_NOTIFICATIONS = Object.freeze([
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'thread/tokenUsage/updated',
  'turn/plan/updated',
  'turn/completed',
  'error',
] as const);

/**
 * `turn/plan/updated` 没有对应的工具调用（`update_plan` 不产生 item），`todo.updated.toolCallId` 用这个前缀加回合 ID
 * 合成（codex-event-mapping.md §6.1）。客户端只按回合取最新的计划，不按 toolCallId 找工具。
 */
export const PLAN_TOOL_CALL_PREFIX = 'plan:';

/** Codex 的计划步骤状态 → Wevir 的待办状态（与 dsh 的 `todo_write` 同一套：pending / in_progress / completed）。 */
const PLAN_STATUS: Record<TurnPlanStepStatus, string> = {
  pending: 'pending',
  inProgress: 'in_progress',
  completed: 'completed',
};

/**
 * 认识、但没有对应 Wevir 事件、也不值得保留的通知：回合开始（Host 自己写 `turn.started`）、推理摘要分段的
 * 标记（块号已在增量里）、thread 的运行状态（Host 自己维护会话状态）、新 thread 的通知（会话由 `thread/start`
 * 的结果登记）。
 */
export const IGNORED_NOTIFICATIONS = Object.freeze([
  'turn/started',
  'item/reasoning/summaryPartAdded',
  'thread/status/changed',
  'thread/started',
  // 自动批准（0.11.0，§4.7）的审查过程与结论：允许的照常执行，拒绝的以工具失败结束、理由在输出里，不另出事件。
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'guardianWarning',
] as const);

/** 这些 item 不产生事件：用户消息由 Host 自己记（`user.message`）。 */
const SILENT_ITEMS = new Set(['userMessage']);

const SUMMARY_SUFFIX = '/summary';

interface StreamState {
  kind: 'text' | 'reasoning';
  /** 块号 → 到目前为止的增量文本。 */
  blocks: Map<number, string>;
  ended: boolean;
}

interface ItemState {
  type: string;
  /** attemptId → 增量。 */
  streams: Map<string, StreamState>;
  /** 工具：`item/started` 时的 item 与展示。 */
  tool?: ToolItem;
  display?: ToolDisplay;
  /** 工具：累积的输出（命令输出增量、MCP 进度）。 */
  output: string;
  completed: boolean;
}

export interface CodexEventMapperOptions {
  /** 会话模型的上下文大小（模型目录的 `context_window`）；不知道时用 Codex 报的 `modelContextWindow`。 */
  contextSize?: () => number | undefined;
}

export class CodexEventMapper {
  readonly engineSessionId: string;
  readonly #items = new Map<string, ItemState>();
  readonly #contextSize: () => number | undefined;

  constructor(engineSessionId: string, options: CodexEventMapperOptions = {}) {
    this.engineSessionId = engineSessionId;
    this.#contextSize = options.contextSize ?? (() => undefined);
  }

  /** 回合开始（或结束）：丢掉上一个回合的 item 状态。 */
  reset(): void {
    this.#items.clear();
  }

  /** 一条通知对应的 AgentEvent，按发出顺序。`turn/completed` 的最后一个事件是回合的终结事件。 */
  map(method: string, params: unknown): AgentEvent[] {
    if ((IGNORED_NOTIFICATIONS as readonly string[]).includes(method)) return [];
    if (!isRecord(params)) return [this.raw(method, params)];
    switch (method) {
      case 'item/started':
        return isItemNotification(params) ? this.#itemStarted(params) : [this.raw(method, params)];
      case 'item/completed':
        return isItemNotification(params)
          ? this.#itemCompleted(params)
          : [this.raw(method, params)];
      case 'item/agentMessage/delta':
        return isDelta(params)
          ? this.#delta(params.itemId, params.itemId, 0, 'text', params.delta)
          : [this.raw(method, params)];
      case 'item/reasoning/textDelta':
        return isDelta(params)
          ? this.#delta(
              params.itemId,
              params.itemId,
              params.contentIndex ?? 0,
              'reasoning',
              params.delta,
            )
          : [this.raw(method, params)];
      case 'item/reasoning/summaryTextDelta':
        return isDelta(params)
          ? this.#delta(
              params.itemId,
              `${params.itemId}${SUMMARY_SUFFIX}`,
              params.summaryIndex ?? 0,
              'reasoning',
              params.delta,
            )
          : [this.raw(method, params)];
      case 'item/commandExecution/outputDelta':
        return isDelta(params)
          ? this.#toolOutput(params.itemId, params.delta)
          : [this.raw(method, params)];
      case 'item/mcpToolCall/progress':
        return isMcpProgress(params)
          ? this.#toolOutput(params.itemId, `${params.message}\n`)
          : [this.raw(method, params)];
      case 'item/fileChange/patchUpdated':
        return isPatchUpdated(params) ? this.#patchUpdated(params) : [this.raw(method, params)];
      case 'thread/tokenUsage/updated':
        return isTokenUsage(params) ? this.#usage(params) : [this.raw(method, params)];
      case 'turn/plan/updated':
        return isPlanUpdated(params) ? [this.#plan(params)] : [this.raw(method, params)];
      case 'error':
        return this.#error(params as Partial<ErrorNotification>, method);
      case 'turn/completed':
        return isTurnNotification(params)
          ? this.#turnCompleted(params)
          : [this.raw(method, params)];
      default:
        return [this.raw(method, params)];
    }
  }

  raw(method: string, params: unknown, kind?: string): EngineRawEvent {
    return {
      type: 'engine.raw',
      engineSessionId: this.engineSessionId,
      protocol: ENGINE_RAW_PROTOCOL,
      method,
      ...(kind !== undefined && { kind }),
      ...(params !== undefined && { params }),
    };
  }

  /**
   * 审批请求之前要发的事件（codex-event-mapping.md §6.6）。Host 从同一 toolCallId 的工具取审批详情：app-server 在
   * 请求之前已经发了这个 item 的 `item/started`（命令原文、cwd、commandActions，补丁的 changes），这里只补上请求里的
   * 理由（`reason` → 输入的 `justification`，与模型调 `exec_command` 时的参数同名），发一条 `tool.updated`；没见过
   * 这个 item 时按请求合成一条 `tool.started`。
   */
  approvalPrelude(
    method: ApprovalRequestMethod,
    params: CommandExecutionRequestApprovalParams | FileChangeRequestApprovalParams,
  ): AgentEvent[] {
    const reason = typeof params.reason === 'string' && params.reason !== '' ? params.reason : '';
    const state = this.#items.get(params.itemId);
    if (state?.tool !== undefined) {
      if (reason === '' || state.completed) return [];
      return [
        {
          type: 'tool.updated',
          engineSessionId: this.engineSessionId,
          toolCallId: params.itemId,
          input: { ...state.tool, justification: reason },
        },
      ];
    }
    const item: ToolItem =
      method === 'item/commandExecution/requestApproval'
        ? ({
            type: 'commandExecution',
            id: params.itemId,
            command: (params as CommandExecutionRequestApprovalParams).command ?? '',
            cwd: (params as CommandExecutionRequestApprovalParams).cwd ?? '',
            status: 'inProgress',
            commandActions: (params as CommandExecutionRequestApprovalParams).commandActions ?? [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          } satisfies CommandExecutionItem)
        : ({
            type: 'fileChange',
            id: params.itemId,
            changes: [],
            status: 'inProgress',
          } satisfies FileChangeItem);
    const events = this.#toolStarted(item);
    const started = events[0];
    if (reason !== '' && started?.type === 'tool.started') {
      started.input = { ...item, justification: reason };
    }
    return events;
  }

  // ── item ────────────────────────────────────────────────────────────────────────────

  #state(id: string, type: string): ItemState {
    let state = this.#items.get(id);
    if (state === undefined) {
      state = { type, streams: new Map(), output: '', completed: false };
      this.#items.set(id, state);
    }
    return state;
  }

  #itemStarted(params: ItemNotification): AgentEvent[] {
    const item = params.item;
    if (item.type === 'agentMessage' || item.type === 'reasoning') {
      this.#state(item.id, item.type);
      return [];
    }
    if (SILENT_ITEMS.has(item.type)) return [];
    if (!isToolItem(item)) return [this.raw('item/started', params, item.type)];
    return this.#toolStarted(item);
  }

  #toolStarted(item: ToolItem): AgentEvent[] {
    const state = this.#state(item.id, item.type);
    if (state.tool !== undefined) return [];
    const display = toolDisplay(item);
    state.tool = item;
    state.display = display;
    return [
      {
        type: 'tool.started',
        engineSessionId: this.engineSessionId,
        toolCallId: item.id,
        toolName: toolName(item),
        display,
        input: item,
      },
    ];
  }

  #itemCompleted(params: ItemNotification): AgentEvent[] {
    const item = params.item;
    switch (item.type) {
      case 'agentMessage':
        return isAgentMessage(item)
          ? this.#commit(item.id, 'text', item.text)
          : [this.raw('item/completed', params, item.type)];
      case 'reasoning':
        return isReasoning(item)
          ? this.#commit(item.id, 'reasoning', reasoningText(item))
          : [this.raw('item/completed', params, item.type)];
    }
    if (SILENT_ITEMS.has(item.type)) return [];
    if (!isToolItem(item)) return [this.raw('item/completed', params, item.type)];
    const events = this.#toolStarted(item);
    const state = this.#state(item.id, item.type);
    if (state.completed) return events;
    state.completed = true;
    const display = toolDisplay(item);
    if (JSON.stringify(display) !== JSON.stringify(state.display)) {
      state.display = display;
      events.push({
        type: 'tool.updated',
        engineSessionId: this.engineSessionId,
        toolCallId: item.id,
        display,
      });
    }
    const output = toolOutput(item, state.output);
    events.push({
      type: 'tool.finished',
      engineSessionId: this.engineSessionId,
      toolCallId: item.id,
      // declined（被拒绝）、interrupted 都记为 failed：tool.finished 只有两种状态，拒绝的语义由审批事件承担
      // （ADR-0005 决策 6.2）。
      status: item.status === 'completed' ? 'completed' : 'failed',
      ...(output !== undefined && { output }),
    });
    return events;
  }

  #toolOutput(itemId: string, delta: string): AgentEvent[] {
    const state = this.#items.get(itemId);
    if (state?.tool === undefined || state.completed) return [];
    state.output += delta;
    return [
      {
        type: 'tool.updated',
        engineSessionId: this.engineSessionId,
        toolCallId: itemId,
        output: state.output,
      },
    ];
  }

  #patchUpdated(params: PatchUpdatedNotification): AgentEvent[] {
    const state = this.#items.get(params.itemId);
    if (state?.tool?.type !== 'fileChange' || state.completed) return [];
    const item: FileChangeItem = { ...state.tool, changes: params.changes };
    state.tool = item;
    state.display = fileChangeDisplay(params.changes);
    return [
      {
        type: 'tool.updated',
        engineSessionId: this.engineSessionId,
        toolCallId: params.itemId,
        display: state.display,
        input: item,
      },
    ];
  }

  // ── 增量与已提交消息 ─────────────────────────────────────────────────────────────────

  #delta(
    itemId: string,
    attemptId: string,
    blockIndex: number,
    kind: 'text' | 'reasoning',
    text: string,
  ): AgentEvent[] {
    const item = this.#state(itemId, kind === 'text' ? 'agentMessage' : 'reasoning');
    if (item.completed) return [];
    let stream = item.streams.get(attemptId);
    if (stream === undefined) {
      stream = { kind, blocks: new Map(), ended: false };
      item.streams.set(attemptId, stream);
    }
    if (stream.ended) return [];
    stream.blocks.set(blockIndex, (stream.blocks.get(blockIndex) ?? '') + text);
    return [
      {
        type: 'assistant.delta',
        engineSessionId: this.engineSessionId,
        attemptId,
        blockIndex,
        kind,
        text,
      },
    ];
  }

  /**
   * 已提交的消息或思考：替换这个 item 的全部增量块，并结束它的增量流。没有增量、文本也是空的（例如没有原始推理的
   * reasoning 项）不发事件。
   */
  #commit(itemId: string, kind: 'text' | 'reasoning', text: string): AgentEvent[] {
    const item = this.#state(itemId, kind === 'text' ? 'agentMessage' : 'reasoning');
    if (item.completed) return [];
    item.completed = true;
    const open = [...item.streams.entries()].filter(([, stream]) => !stream.ended);
    if (open.length === 0 && text === '') return [];
    const replaces: DeltaBlockRef[] = open.flatMap(([attemptId, stream]) =>
      [...stream.blocks.keys()].map((blockIndex) => ({ attemptId, blockIndex })),
    );
    const events: AgentEvent[] = [
      {
        type: kind === 'text' ? 'assistant.message' : 'assistant.thought',
        engineSessionId: this.engineSessionId,
        messageId: itemId,
        text,
        replaces,
      },
    ];
    for (const [attemptId, stream] of open) {
      stream.ended = true;
      events.push(this.#streamEnded(attemptId, 'committed'));
    }
    return events;
  }

  #streamEnded(attemptId: string, outcome: 'committed' | 'abandoned'): AssistantStreamEndedEvent {
    return {
      type: 'assistant.stream_ended',
      engineSessionId: this.engineSessionId,
      attemptId,
      outcome,
    };
  }

  /**
   * 回合结束时还没提交的增量（取消或出错发生在流式中途，Codex 不再发 `item/completed`，codex-notes §2.2）：
   * 含非空白字符的按已提交消息补发，保留已经显示的输出（与 dsh 取消时一次性补发已生成部分的做法一致）；只有空白的
   * 以 `abandoned` 结束。
   */
  #flushOpenStreams(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const [itemId, item] of this.#items) {
      if (item.completed || item.streams.size === 0) continue;
      const open = [...item.streams.entries()].filter(([, stream]) => !stream.ended);
      if (open.length === 0) continue;
      const kind = open[0]?.[1].kind ?? 'text';
      // 推理同时有原始推理与摘要时以原始推理为准（与 reasoningText 一致）。
      const main = streamText(open.filter(([attemptId]) => !attemptId.endsWith(SUMMARY_SUFFIX)));
      const text = main.trim() !== '' ? main : streamText(open);
      if (text.trim() === '') {
        item.completed = true;
        for (const [attemptId, stream] of open) {
          stream.ended = true;
          events.push(this.#streamEnded(attemptId, 'abandoned'));
        }
      } else {
        events.push(...this.#commit(itemId, kind, text));
      }
    }
    return events;
  }

  /** `error` 带 `willRetry: true`：Codex 会重发整个请求，已经流出的增量不会再被提交，按 abandoned 结束。 */
  #abandonOpenStreams(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const item of this.#items.values()) {
      if (item.completed) continue;
      for (const [attemptId, stream] of item.streams) {
        if (stream.ended) continue;
        stream.ended = true;
        events.push(this.#streamEnded(attemptId, 'abandoned'));
      }
      if (item.streams.size > 0) item.completed = true;
    }
    return events;
  }

  // ── 用量、计划、错误、回合结束 ─────────────────────────────────────────────────────────

  #plan(params: TurnPlanUpdatedNotification): AgentEvent {
    const items: TodoItem[] = params.plan.map((step) => ({
      content: step.step,
      status: PLAN_STATUS[step.status] ?? step.status,
    }));
    return {
      type: 'todo.updated',
      engineSessionId: this.engineSessionId,
      toolCallId: `${PLAN_TOOL_CALL_PREFIX}${params.turnId}`,
      items,
    };
  }

  /** 已用量取最近一次请求的 `last.totalTokens`（codex-notes §2.7 的口径），上下文大小优先取模型目录。 */
  #usage(params: TokenUsageNotification): AgentEvent[] {
    const contextSize = this.#contextSize() ?? params.tokenUsage.modelContextWindow ?? undefined;
    if (contextSize === undefined) return [this.raw('thread/tokenUsage/updated', params)];
    return [
      {
        type: 'usage.updated',
        engineSessionId: this.engineSessionId,
        contextUsed: params.tokenUsage.last.totalTokens,
        contextSize,
      },
    ];
  }

  /**
   * `error` 通知原样保留为 engine.raw。`willRetry: true` 的不是回合失败（Codex 自己也只在状态栏短暂显示），只是
   * 结束已经流出的增量；`willRetry: false` 的随后有 `turn/completed`（failed），回合失败以它为准。
   */
  #error(params: Partial<ErrorNotification>, method: string): AgentEvent[] {
    const events: AgentEvent[] = [this.raw(method, params)];
    if (params.willRetry === true) events.push(...this.#abandonOpenStreams());
    return events;
  }

  #turnCompleted(params: TurnNotification): AgentEvent[] {
    const { turn } = params;
    let terminal: TurnSettledEvent | TurnFailedEvent;
    switch (turn.status) {
      case 'completed':
      case 'interrupted':
        terminal = {
          type: 'turn.settled',
          engineSessionId: this.engineSessionId,
          outcome: turn.status === 'completed' ? 'completed' : 'cancelled',
          stopReason: turn.status,
        };
        break;
      case 'failed': {
        const error = turn.error;
        const details = error?.additionalDetails;
        const { category, httpStatus } = classifyTurnError(error);
        terminal = {
          type: 'turn.failed',
          engineSessionId: this.engineSessionId,
          category,
          message:
            (error?.message ?? 'Codex 报告回合失败') +
            (details !== null && details !== undefined && details !== '' ? `\n${details}` : ''),
          ...(httpStatus !== undefined && { code: httpStatus }),
        };
        break;
      }
      default:
        return [this.raw('turn/completed', params)];
    }
    const events = [
      ...this.#flushOpenStreams(),
      ...(turn.status === 'interrupted' ? this.#failOpenTools() : []),
      terminal,
    ];
    this.reset();
    return events;
  }

  /**
   * 回合被中断时还没结束的工具：Codex 不会再发它们的 `item/completed`（审批挂起时取消、审批选了“告诉它换个做法”
   * 的补丁），按失败结束；取消期间 Host 把它记为 cancelled（domain-model.md §6.4）。
   */
  #failOpenTools(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const [itemId, item] of this.#items) {
      if (item.tool === undefined || item.completed) continue;
      item.completed = true;
      events.push({
        type: 'tool.finished',
        engineSessionId: this.engineSessionId,
        toolCallId: itemId,
        status: 'failed',
      });
    }
    return events;
  }
}

/** 若干增量流按块号拼起来的文本。 */
function streamText(streams: ReadonlyArray<[string, StreamState]>): string {
  return streams
    .flatMap(([, stream]) => [...stream.blocks.entries()].sort(([a], [b]) => a - b))
    .map(([, piece]) => piece)
    .join('');
}

/** reasoning 项的文本：有原始推理（DeepSeek 等）就用它，否则用摘要（OpenAI）。 */
function reasoningText(item: ReasoningItem): string {
  const content = item.content.join('');
  return content !== '' ? content : item.summary.join('\n\n');
}

// ── 形状检查 ───────────────────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isItemNotification(
  params: Record<string, unknown>,
): params is ItemNotification & Record<string, unknown> {
  const item = params.item;
  return isRecord(item) && typeof item.type === 'string' && typeof item.id === 'string';
}

function isDelta(
  params: Record<string, unknown>,
): params is DeltaNotification & Record<string, unknown> {
  return typeof params.itemId === 'string' && typeof params.delta === 'string';
}

function isMcpProgress(
  params: Record<string, unknown>,
): params is McpProgressNotification & Record<string, unknown> {
  return typeof params.itemId === 'string' && typeof params.message === 'string';
}

function isPatchUpdated(
  params: Record<string, unknown>,
): params is PatchUpdatedNotification & Record<string, unknown> {
  return typeof params.itemId === 'string' && Array.isArray(params.changes);
}

function isTokenUsage(
  params: Record<string, unknown>,
): params is TokenUsageNotification & Record<string, unknown> {
  const usage = params.tokenUsage;
  return isRecord(usage) && isRecord(usage.last) && typeof usage.last.totalTokens === 'number';
}

function isPlanUpdated(
  params: Record<string, unknown>,
): params is TurnPlanUpdatedNotification & Record<string, unknown> {
  return (
    typeof params.turnId === 'string' &&
    Array.isArray(params.plan) &&
    params.plan.every(
      (step) => isRecord(step) && typeof step.step === 'string' && typeof step.status === 'string',
    )
  );
}

function isTurnNotification(
  params: Record<string, unknown>,
): params is TurnNotification & Record<string, unknown> {
  return isRecord(params.turn) && typeof params.turn.status === 'string';
}

function isAgentMessage(
  item: Record<string, unknown>,
): item is AgentMessageItem & Record<string, unknown> {
  return typeof item.text === 'string';
}

function isReasoning(
  item: Record<string, unknown>,
): item is ReasoningItem & Record<string, unknown> {
  return (
    Array.isArray(item.content) &&
    Array.isArray(item.summary) &&
    item.content.every((piece) => typeof piece === 'string') &&
    item.summary.every((piece) => typeof piece === 'string')
  );
}
