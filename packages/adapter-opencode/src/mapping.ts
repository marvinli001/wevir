// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-opencode/src/server/adapter.ts（`handlePartUpdated`、`handlePartDelta`、
// `handleAssistantCompleted`、`emitTextPart`、`emitToolPart`、`emitTodo`、`accumulateOpenCodeStepUsage`、`toolStatus`、
// `toolOutput`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：T3 的节点、回合条目与计划换成 Wevir 的 AgentEvent（增量与替换它们的已提交消息、工具三段、清单、上下文用量）；清单取
// todowrite 工具调用的输入（要带 toolCallId），不用 opencode 另发的 todo.updated；bash 运行中的输出（metadata.output）作工具的
// 增量输出。
//
// 一个 opencode 会话（顶层或 task 子会话）里一个回合的事件 → AgentEvent（opencode-event-mapping.md §5）。回合的开始与结束、审批
// 与提问在 opencode-adapter.ts；这里只管消息的内容：
// - 每个 assistant 消息是一次模型调用（opencode 每一步新开一条），对应一个 `attemptId`；其中的 text / reasoning part 各是一个
//   增量块（`message.part.delta` → `assistant.delta`），part 带上结束时间或消息完成时提交（`assistant.message` /
//   `assistant.thought` 替换这个块），消息完成时报 `assistant.stream_ended`；
// - tool part 按 `callID` 报 `tool.started` / `tool.updated` / `tool.finished`；question 工具不报（提问由 `question.asked` 报）；
// - step-finish 与 assistant 消息带 token 用量，消息完成时报 `usage.updated` 与这次调用的 `usage.recorded`（0.62.0）。

import type { AgentEvent, TodoItem, UsageRecordedEvent } from '@wevir/runtime-adapter';
import { engineToolCall } from './app-tools.js';
import type { Message, Part } from './sdk.js';
import { openCodeToolDisplay } from './tool-display.js';

/** engine.raw 的 `protocol`。 */
export const ENGINE_RAW_PROTOCOL = 'opencode-sdk';

type TextLikePart = Extract<Part, { type: 'text' | 'reasoning' }>;
type ToolPart = Extract<Part, { type: 'tool' }>;
type AssistantMessage = Extract<Message, { role: 'assistant' }>;

interface Block {
  readonly attemptId: string;
  readonly blockIndex: number;
  readonly kind: 'text' | 'reasoning';
  /** 已经作为增量发出的文本。 */
  emitted: string;
  /** 最新的全文（part 的快照或增量拼出来的）。 */
  text: string;
  committed: boolean;
}

interface Attempt {
  nextBlock: number;
  /** 发过增量：结束时要报 `assistant.stream_ended`。 */
  streamed: boolean;
  ended: boolean;
}

/** 一次模型调用的输出时刻（0.62.0，opencode 的时间戳）：第一个与最后一个 token，有没有调工具。 */
interface CallTiming {
  firstAt?: number;
  lastAt?: number;
  tools: boolean;
}

interface ToolState {
  /** 分发工具的调用有了参数之后换成目标工具。 */
  toolName: string;
  started: boolean;
  finished: boolean;
  inputJson: string;
  output: string | undefined;
  todosJson: string | undefined;
}

function isEmptyInput(input: unknown): boolean {
  return (
    input === undefined ||
    input === null ||
    (typeof input === 'object' && Object.keys(input as object).length === 0)
  );
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** todowrite 的 `todos` → 清单（opencode 的状态：pending、in_progress、completed、cancelled，原样保留）。 */
export function todoItems(input: unknown): TodoItem[] | undefined {
  const todos = (input as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return undefined;
  return todos.flatMap((todo): TodoItem[] => {
    if (typeof todo !== 'object' || todo === null) return [];
    const content = (todo as { content?: unknown }).content;
    const status = (todo as { status?: unknown }).status;
    if (typeof content !== 'string' || content.trim() === '') return [];
    return [{ content: content.trim(), status: typeof status === 'string' ? status : 'pending' }];
  });
}

/** 一次模型调用之后的上下文用量：这次的输入（含缓存）加输出，就是下一次请求要带上的。 */
export function contextTokens(tokens: AssistantMessage['tokens'] | undefined): number | undefined {
  if (tokens === undefined) return undefined;
  const used = tokens.input + tokens.cache.read + tokens.cache.write + tokens.output;
  return used > 0 ? used : undefined;
}

export interface TurnMapperOptions {
  /** 模型的上下文窗口；不知道时不报 `usage.updated`。 */
  contextSize?: () => number | undefined;
  /** 会话累计的 token，回合之间接着算。 */
  usage?: { totalTokens: number };
}

/** 一个会话里一个回合的映射。 */
export class OpenCodeTurnMapper {
  readonly #engineSessionId: string;
  readonly #options: TurnMapperOptions;
  readonly #blocks = new Map<string, Block>();
  readonly #attempts = new Map<string, Attempt>();
  readonly #tools = new Map<string, ToolState>();
  /** 计过用量的 assistant 消息。 */
  readonly #counted = new Set<string>();
  /** assistant 消息 ID → 它的输出时刻。 */
  readonly #timings = new Map<string, CallTiming>();
  /** 最近一条完成的 assistant 消息的 `finish`（回合结束的 stopReason）。 */
  lastFinish: string | undefined;

  constructor(engineSessionId: string, options: TurnMapperOptions = {}) {
    this.#engineSessionId = engineSessionId;
    this.#options = options;
  }

  /** `message.part.updated`（assistant 消息的 part；用户消息的由调用方滤掉）。 */
  part(part: Part): AgentEvent[] {
    this.#noteTiming(part);
    switch (part.type) {
      case 'text':
        if (part.synthetic === true || part.ignored === true) return [];
        return this.#textPart(part);
      case 'reasoning':
        return this.#textPart(part);
      case 'tool':
        return this.#toolPart(part);
      default:
        return [];
    }
  }

  /** `message.part.delta`：只认 `text` 字段，而且块要先由 part.updated 登记过（opencode 先发空文本的 part）。 */
  delta(input: { partID: string; field: string; delta: string }): AgentEvent[] {
    if (input.field !== 'text' || input.delta === '') return [];
    const block = this.#blocks.get(input.partID);
    if (block === undefined || block.committed) return [];
    block.text = `${block.text}${input.delta}`;
    return this.#emitDelta(block);
  }

  /** `message.updated` 的 assistant 消息：完成时提交它的块、结束它的流、报用量。 */
  message(info: Message): AgentEvent[] {
    if (info.role !== 'assistant' || info.time.completed === undefined) return [];
    const events: AgentEvent[] = [];
    for (const [partId, block] of this.#blocks) {
      if (block.attemptId === info.id) events.push(...this.#commit(partId, block));
    }
    events.push(...this.#endAttempt(info.id));
    if (info.finish !== undefined) this.lastFinish = info.finish;
    if (!this.#counted.has(info.id)) {
      this.#counted.add(info.id);
      const total =
        info.tokens.total ??
        info.tokens.input +
          info.tokens.cache.read +
          info.tokens.cache.write +
          info.tokens.output +
          info.tokens.reasoning;
      const usage = this.#options.usage;
      if (usage !== undefined) usage.totalTokens += total;
      const recorded = this.#record(info);
      if (recorded !== undefined) events.push(recorded);
      const contextUsed = contextTokens(info.tokens);
      const contextSize = this.#options.contextSize?.();
      if (contextUsed !== undefined && contextSize !== undefined) {
        events.push({
          type: 'usage.updated',
          engineSessionId: this.#engineSessionId,
          contextUsed,
          contextSize,
          ...(usage !== undefined && { totalTokens: usage.totalTokens }),
        });
      }
    }
    return events;
  }

  /**
   * text / reasoning part 的 `time.start` 是第一段输出到的时刻（opencode 在 `text-start` 时建 part），`time.end` 是这块结束；
   * tool part 的 `state.time.start` 是模型写完这次调用、工具开始跑的时刻。
   */
  #noteTiming(part: Part): void {
    const times: number[] = [];
    let first: number | undefined;
    if (part.type === 'text' || part.type === 'reasoning') {
      if (part.time === undefined) return;
      first = part.time.start;
      times.push(part.time.start, ...(part.time.end === undefined ? [] : [part.time.end]));
    } else if (part.type === 'tool') {
      if ('time' in part.state) times.push(part.state.time.start);
    } else {
      return;
    }
    const timing = this.#timings.get(part.messageID) ?? { tools: false };
    this.#timings.set(part.messageID, timing);
    if (part.type === 'tool') timing.tools = true;
    if (first !== undefined && (timing.firstAt === undefined || first < timing.firstAt))
      timing.firstAt = first;
    for (const time of times) {
      if (timing.lastAt === undefined || time > timing.lastAt) timing.lastAt = time;
    }
  }

  /**
   * 这次调用的 `usage.recorded`（0.62.0）。opencode 的 `tokens.input` 已经减掉缓存的读写（`Session.getUsage`），`output` 减掉
   * 了 `reasoning`，事件的输出要含推理，所以加回去。时长从消息建立（opencode 发请求之前）算到最后一段输出；消息的
   * `time.completed` 在工具跑完之后，只有没调工具时才拿它兜底。
   */
  #record(info: AssistantMessage): UsageRecordedEvent | undefined {
    const tokens = info.tokens;
    const count = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    const input = count(tokens.input);
    const reasoning = count(tokens.reasoning);
    const output = count(tokens.output) + reasoning;
    const cacheRead = count(tokens.cache?.read);
    const cacheWrite = count(tokens.cache?.write);
    // 中断在第一个 step 结束之前：opencode 没拿到用量。
    if (input + output + cacheRead + cacheWrite === 0) return undefined;
    const timing = this.#timings.get(info.id);
    this.#timings.delete(info.id);
    const created = info.time.created;
    const last = timing?.lastAt ?? (timing?.tools === true ? undefined : info.time.completed);
    const durationMs =
      last !== undefined && last >= created ? Math.round(last - created) : undefined;
    const firstTokenMs =
      timing?.firstAt !== undefined && timing.firstAt >= created
        ? Math.round(timing.firstAt - created)
        : undefined;
    return {
      type: 'usage.recorded',
      engineSessionId: this.#engineSessionId,
      requestId: info.id,
      ...(info.modelID !== '' && { model: info.modelID }),
      ...(info.providerID !== '' && { upstream: info.providerID }),
      inputTokens: input,
      outputTokens: output,
      ...(cacheRead > 0 && { cacheReadTokens: cacheRead }),
      ...(cacheWrite > 0 && { cacheWriteTokens: cacheWrite }),
      ...(reasoning > 0 && { reasoningTokens: reasoning }),
      ...(durationMs !== undefined && { durationMs }),
      ...(firstTokenMs !== undefined && { firstTokenMs }),
    };
  }

  /** 工具调用的名字（审批要用）；没见过时 undefined。 */
  toolName(callID: string): string | undefined {
    return this.#tools.get(callID)?.toolName;
  }

  /**
   * 审批之前确保这个工具调用已经报过 `tool.started`：opencode 可能在 tool part 还是 pending（没有输入）时就请求审批，这时用审批
   * 请求的 metadata（bash 是 `{ command }`）当输入。
   */
  ensureTool(callID: string, toolName: string, input: unknown): AgentEvent[] {
    const existing = this.#tools.get(callID);
    if (existing?.started === true) return [];
    // 分发工具的审批（参数里有目标）：报成目标工具。
    const call = engineToolCall(toolName, input);
    const state: ToolState = existing ?? {
      toolName: call.toolName,
      started: false,
      finished: false,
      inputJson: '',
      output: undefined,
      todosJson: undefined,
    };
    state.toolName = call.toolName;
    this.#tools.set(callID, state);
    state.started = true;
    state.inputJson = stableJson(input);
    return [
      {
        type: 'tool.started',
        engineSessionId: this.#engineSessionId,
        toolCallId: callID,
        toolName: state.toolName,
        display: openCodeToolDisplay(state.toolName, call.input),
        ...(!isEmptyInput(call.input) && { input: call.input }),
      },
    ];
  }

  /** 由审批合成的工具调用（没有对应的 tool part）结束。 */
  finishSynthetic(callID: string, status: 'completed' | 'failed', output?: string): AgentEvent[] {
    const state = this.#tools.get(callID);
    if (state === undefined || !state.started || state.finished) return [];
    state.finished = true;
    return [
      {
        type: 'tool.finished',
        engineSessionId: this.#engineSessionId,
        toolCallId: callID,
        status,
        ...(output !== undefined && { output }),
      },
    ];
  }

  /**
   * 回合结束：没提交的块按已有的文本提交（取消时 opencode 不再发 part 的最终快照），没结束的流报 committed。没收尾的工具调用
   * 留给 Host（domain-model §6.4：取消期间记 cancelled，否则 unknown）。
   */
  finish(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const [partId, block] of this.#blocks) events.push(...this.#commit(partId, block));
    for (const attemptId of this.#attempts.keys()) events.push(...this.#endAttempt(attemptId));
    return events;
  }

  #textPart(part: TextLikePart): AgentEvent[] {
    let block = this.#blocks.get(part.id);
    if (block === undefined) {
      const attempt = this.#attempt(part.messageID);
      block = {
        attemptId: part.messageID,
        blockIndex: attempt.nextBlock++,
        kind: part.type === 'text' ? 'text' : 'reasoning',
        emitted: '',
        text: '',
        committed: false,
      };
      this.#blocks.set(part.id, block);
    }
    if (block.committed) return [];
    // part 的快照是全文：比增量拼出来的长才用它（旧版本只发快照、不发增量）。
    if (part.text.length >= block.text.length) block.text = part.text;
    const events = this.#emitDelta(block);
    if (part.time?.end !== undefined) events.push(...this.#commit(part.id, block));
    return events;
  }

  #emitDelta(block: Block): AgentEvent[] {
    if (!block.text.startsWith(block.emitted) || block.text.length === block.emitted.length) {
      return [];
    }
    const text = block.text.slice(block.emitted.length);
    block.emitted = block.text;
    const attempt = this.#attempt(block.attemptId);
    attempt.streamed = true;
    return [
      {
        type: 'assistant.delta',
        engineSessionId: this.#engineSessionId,
        attemptId: block.attemptId,
        blockIndex: block.blockIndex,
        kind: block.kind,
        text,
      },
    ];
  }

  #commit(partId: string, block: Block): AgentEvent[] {
    if (block.committed) return [];
    block.committed = true;
    if (block.text.trim() === '') return [];
    const replaces =
      block.emitted === '' ? [] : [{ attemptId: block.attemptId, blockIndex: block.blockIndex }];
    return [
      {
        type: block.kind === 'text' ? 'assistant.message' : 'assistant.thought',
        engineSessionId: this.#engineSessionId,
        messageId: partId,
        text: block.text,
        replaces,
      },
    ];
  }

  #attempt(attemptId: string): Attempt {
    let attempt = this.#attempts.get(attemptId);
    if (attempt === undefined) {
      attempt = { nextBlock: 0, streamed: false, ended: false };
      this.#attempts.set(attemptId, attempt);
    }
    return attempt;
  }

  #endAttempt(attemptId: string): AgentEvent[] {
    const attempt = this.#attempts.get(attemptId);
    if (attempt === undefined || attempt.ended || !attempt.streamed) return [];
    attempt.ended = true;
    return [
      {
        type: 'assistant.stream_ended',
        engineSessionId: this.#engineSessionId,
        attemptId,
        outcome: 'committed',
      },
    ];
  }

  #toolPart(part: ToolPart): AgentEvent[] {
    // question 工具的那次调用由 `question.asked` 报成提问，再报一遍工具会在界面上重复（T3 同）。
    if (part.tool.toLowerCase() === 'question') return [];
    let state = this.#tools.get(part.callID);
    if (state === undefined) {
      state = {
        // 应用级工具报成 `mcp__wevir__…`（app-tools.ts）；分发工具等有了参数再换成目标工具。
        toolName: engineToolCall(part.tool, undefined).toolName,
        started: false,
        finished: false,
        inputJson: '',
        output: undefined,
        todosJson: undefined,
      };
      this.#tools.set(part.callID, state);
    }
    if (state.finished) return [];
    const events: AgentEvent[] = [];
    const raw = part.state.input;
    const inputJson = stableJson(raw);
    const status = part.state.status;
    // 经分发工具的调用报成目标工具与它的参数（app-tools.ts 的 `engineToolCall`）。
    const call = engineToolCall(part.tool, raw);
    const dispatched = call.input !== raw;
    const input = call.input;
    const display = () => openCodeToolDisplay(dispatched ? call.toolName : part.tool, input);
    if (!state.started) {
      // pending 而且还没有输入时先不报：opencode 接着会发带输入的 running（要审批时由 ensureTool 提前报）。
      if (status === 'pending' && isEmptyInput(raw)) return [];
      state.started = true;
      state.inputJson = inputJson;
      state.toolName = call.toolName;
      events.push({
        type: 'tool.started',
        engineSessionId: this.#engineSessionId,
        toolCallId: part.callID,
        toolName: state.toolName,
        display: display(),
        ...(!isEmptyInput(input) && { input }),
      });
    } else if (inputJson !== state.inputJson && !isEmptyInput(raw)) {
      state.inputJson = inputJson;
      events.push({
        type: 'tool.updated',
        engineSessionId: this.#engineSessionId,
        toolCallId: part.callID,
        display: display(),
        input,
      });
    }
    const todos = part.tool.toLowerCase() === 'todowrite' ? todoItems(input) : undefined;
    if (todos !== undefined) {
      const todosJson = stableJson(todos);
      if (todosJson !== state.todosJson) {
        state.todosJson = todosJson;
        events.push({
          type: 'todo.updated',
          engineSessionId: this.#engineSessionId,
          toolCallId: part.callID,
          items: todos,
        });
      }
    }
    if (status === 'running') {
      const output = part.state.metadata?.output;
      if (typeof output === 'string' && output !== '' && output !== state.output) {
        state.output = output;
        events.push({
          type: 'tool.updated',
          engineSessionId: this.#engineSessionId,
          toolCallId: part.callID,
          output,
        });
      }
    } else if (status === 'completed' || status === 'error') {
      state.finished = true;
      const output = status === 'completed' ? part.state.output : part.state.error;
      events.push({
        type: 'tool.finished',
        engineSessionId: this.#engineSessionId,
        toolCallId: part.callID,
        status: status === 'completed' ? 'completed' : 'failed',
        ...(output !== '' && { output }),
      });
    }
    return events;
  }
}
