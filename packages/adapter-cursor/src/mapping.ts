// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-cursor/src/server/adapter.ts（handleInteractionUpdate、handleToolUpdate、
// finalizeTurn）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：T3 投影成自己的节点、消息与回合项；这里产出 Wevir 的增量、已提交消息、工具与待办事件，子 agent 只当工具，没完成的工具在取消或失败时按失败收尾。
//
// Cursor SDK 的流式更新（`send` 的 `onDelta`，`InteractionUpdate`）→ AgentEvent（docs/architecture/cursor-event-mapping.md §4）。
// 一个回合（一个 run）一个映射器，按更新到达的顺序调用 `map`，回合结束时 `finish`。
//
// 增量与已提交消息：SDK 只给增量、不给“这段文字定稿了”的消息，所以一段文字是一个 attempt（`<runId>:text:<n>`，块 0），这段结束时
// 发出 `assistant.message` 替换它的增量；思考同理（`<runId>:reasoning:<n>`）。

import type { InteractionUpdate, ToolCall } from '@cursor/sdk';
import type { AgentEvent, TodoItem, UsageRecordedEvent } from '@wevir/runtime-adapter';
import { todoItems, toolDisplay, toolFailed, toolName, toolOutput } from './tool-display.js';
import { CursorTransportFailure } from './transport-failure.js';

/** engine.raw 的 `protocol`。 */
export const ENGINE_RAW_PROTOCOL = 'cursor-sdk';

/** 认识但不映射的更新：用量与步骤的节拍、摘要、子 agent 的嵌套更新（子 agent 只看 `task` 的结果）、回显的用户消息。 */
export const IGNORED_UPDATES: ReadonlySet<string> = new Set([
  'token-delta',
  'summary',
  'summary-started',
  'summary-completed',
  'step-started',
  'tool-requests-listed',
  'tool-call-delta',
  'user-message-appended',
]);

interface TextSegment {
  readonly attemptId: string;
  text: string;
}

interface TextStream {
  readonly kind: 'text' | 'reasoning';
  current: TextSegment | undefined;
  count: number;
}

interface OpenTool {
  toolCall: ToolCall;
  /** 上一次报给 Host 的参数（JSON），局部更新没变就不再报。 */
  input: string;
  /** 流式收到的命令输出。 */
  output: string;
  /** 上一次报的待办（JSON）。 */
  todos?: string;
}

export class CursorTurnMapper {
  readonly engineSessionId: string;
  readonly runId: string;
  /** 回答是否只是一段传输诊断（transport-failure.ts）。 */
  readonly reply = new CursorTransportFailure();
  readonly #text: TextStream = { kind: 'text', current: undefined, count: 0 };
  readonly #reasoning: TextStream = { kind: 'reasoning', current: undefined, count: 0 };
  readonly #tools = new Map<string, OpenTool>();
  #finished = false;
  /** 报过这个 run 的 `usage.recorded`（0.62.0）。 */
  #recorded = false;

  constructor(engineSessionId: string, runId: string) {
    this.engineSessionId = engineSessionId;
    this.runId = runId;
  }

  /** 这个回合有没有流出过回答文字。 */
  get answered(): boolean {
    return this.#text.count > 0;
  }

  map(update: InteractionUpdate): AgentEvent[] {
    if (this.#finished) return [];
    const type = (update as { type: string }).type;
    switch (update.type) {
      case 'text-delta':
        this.reply.push(update.text);
        return [...this.#complete(this.#reasoning), ...this.#append(this.#text, update.text)];
      case 'thinking-delta':
        return [...this.#complete(this.#text), ...this.#append(this.#reasoning, update.text)];
      case 'thinking-completed':
        return this.#complete(this.#reasoning);
      case 'tool-call-started':
      case 'partial-tool-call':
      case 'tool-call-completed':
        return [
          ...this.#complete(this.#text),
          ...this.#complete(this.#reasoning),
          ...this.#tool(update),
        ];
      case 'step-completed':
        return [...this.#complete(this.#text), ...this.#complete(this.#reasoning)];
      case 'turn-ended':
        return [
          ...this.#complete(this.#text),
          ...this.#complete(this.#reasoning),
          ...this.#usage(update.usage),
        ];
      case 'shell-output-delta':
        return this.#shellOutput(update.event);
      default:
        if (IGNORED_UPDATES.has(type)) return [];
        return [
          {
            type: 'engine.raw',
            engineSessionId: this.engineSessionId,
            protocol: ENGINE_RAW_PROTOCOL,
            method: 'onDelta',
            kind: type,
            params: update,
          },
        ];
    }
  }

  /**
   * `turn-ended` 带的这个 run 的用量（0.62.0，`usage.recorded`，每个回合一条，`requestId` 是 run ID）。SDK 的口径与事件相同：
   * `inputTokens` 不含缓存的读写（它的 `totalTokens` 是四项之和），`reasoningTokens` 含在输出里。SDK 不报实际的模型，也只按
   * 回合报：一个回合里有几次模型调用、中间跑了多久的工具都不知道，所以不报时长。
   */
  #usage(usage: Extract<InteractionUpdate, { type: 'turn-ended' }>['usage']): UsageRecordedEvent[] {
    if (usage === undefined || this.#recorded) return [];
    const count = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    const input = count(usage.inputTokens);
    const output = count(usage.outputTokens);
    const cacheRead = count(usage.cacheReadTokens);
    const cacheWrite = count(usage.cacheWriteTokens);
    const reasoning = Math.min(count(usage.reasoningTokens), output);
    if (input + output + cacheRead + cacheWrite === 0) return [];
    this.#recorded = true;
    return [
      {
        type: 'usage.recorded',
        engineSessionId: this.engineSessionId,
        requestId: this.runId,
        inputTokens: input,
        outputTokens: output,
        ...(cacheRead > 0 && { cacheReadTokens: cacheRead }),
        ...(cacheWrite > 0 && { cacheWriteTokens: cacheWrite }),
        ...(reasoning > 0 && { reasoningTokens: reasoning }),
      },
    ];
  }

  /**
   * run 的最终回答（`RunResult.result`）：回合里一个字的回答增量都没有时把它当作回答发出（T3 同样处理）。
   */
  finalResult(text: string | undefined): AgentEvent[] {
    if (this.#finished || this.answered || text === undefined || text.trim() === '') return [];
    this.reply.push(text);
    return [
      {
        type: 'assistant.message',
        engineSessionId: this.engineSessionId,
        messageId: `${this.runId}:result`,
        text,
        replaces: [],
      },
    ];
  }

  /**
   * 回合结束：还在流的文字与思考按已提交消息补发（取消或出错时保留已经显示的输出）；`completed` 以外的结局里没完成的工具按
   * 失败收尾（Host 在取消期间把它记为 cancelled），正常结束时留给 Host 记为 unknown（events.ts 的 ToolFinishedEvent）。之后的
   * 更新一律忽略。
   */
  finish(outcome: 'completed' | 'cancelled' | 'failed'): AgentEvent[] {
    if (this.#finished) return [];
    const events = [...this.#complete(this.#reasoning), ...this.#complete(this.#text)];
    if (outcome !== 'completed') {
      for (const [toolCallId, tool] of this.#tools) {
        events.push({
          type: 'tool.finished',
          engineSessionId: this.engineSessionId,
          toolCallId,
          status: 'failed',
          ...(tool.output !== '' && { output: tool.output }),
        });
      }
    }
    this.#tools.clear();
    this.#finished = true;
    return events;
  }

  // ── 文字与思考 ───────────────────────────────────────────────────────────────

  #append(stream: TextStream, text: string): AgentEvent[] {
    if (text === '') return [];
    if (stream.current === undefined) {
      stream.count += 1;
      stream.current = { attemptId: `${this.runId}:${stream.kind}:${stream.count}`, text: '' };
    }
    stream.current.text += text;
    return [
      {
        type: 'assistant.delta',
        engineSessionId: this.engineSessionId,
        attemptId: stream.current.attemptId,
        blockIndex: 0,
        kind: stream.kind,
        text,
      },
    ];
  }

  /** 一段结束：有非空白字符的提交成消息替换它的增量，只有空白的以 `abandoned` 结束。 */
  #complete(stream: TextStream): AgentEvent[] {
    const segment = stream.current;
    if (segment === undefined) return [];
    stream.current = undefined;
    if (segment.text.trim() === '') {
      return [
        {
          type: 'assistant.stream_ended',
          engineSessionId: this.engineSessionId,
          attemptId: segment.attemptId,
          outcome: 'abandoned',
        },
      ];
    }
    return [
      {
        type: stream.kind === 'text' ? 'assistant.message' : 'assistant.thought',
        engineSessionId: this.engineSessionId,
        messageId: segment.attemptId,
        text: segment.text,
        replaces: [{ attemptId: segment.attemptId, blockIndex: 0 }],
      },
      {
        type: 'assistant.stream_ended',
        engineSessionId: this.engineSessionId,
        attemptId: segment.attemptId,
        outcome: 'committed',
      },
    ];
  }

  // ── 工具 ─────────────────────────────────────────────────────────────────────

  #tool(
    update: Extract<
      InteractionUpdate,
      { type: 'tool-call-started' | 'partial-tool-call' | 'tool-call-completed' }
    >,
  ): AgentEvent[] {
    const { callId: toolCallId, toolCall } = update;
    // 子 agent 的参数是流式拼出来的，局部更新不看（T3）。
    if (toolCall.type === 'task' && update.type === 'partial-tool-call') return [];
    const events: AgentEvent[] = [];
    const input = (toolCall as { args?: unknown }).args;
    const inputJson = JSON.stringify(input ?? null);
    let tool = this.#tools.get(toolCallId);
    if (tool === undefined) {
      tool = { toolCall, input: inputJson, output: '' };
      this.#tools.set(toolCallId, tool);
      events.push({
        type: 'tool.started',
        engineSessionId: this.engineSessionId,
        toolCallId,
        toolName: toolName(toolCall),
        display: toolDisplay(toolCall),
        ...(input !== undefined && { input }),
      });
    } else {
      tool.toolCall = toolCall;
      if (inputJson !== tool.input) {
        tool.input = inputJson;
        events.push({
          type: 'tool.updated',
          engineSessionId: this.engineSessionId,
          toolCallId,
          display: toolDisplay(toolCall),
          ...(input !== undefined && { input }),
        });
      }
    }
    if (toolCall.type === 'updateTodos')
      events.push(...this.#todos(toolCallId, tool, todoItems(toolCall)));
    if (update.type === 'tool-call-completed') {
      this.#tools.delete(toolCallId);
      const output = toolOutput(toolCall, tool.output);
      events.push({
        type: 'tool.finished',
        engineSessionId: this.engineSessionId,
        toolCallId,
        status: toolFailed(toolCall) ? 'failed' : 'completed',
        ...(output !== undefined && { output }),
      });
    }
    return events;
  }

  #todos(toolCallId: string, tool: OpenTool, items: TodoItem[]): AgentEvent[] {
    const json = JSON.stringify(items);
    if (json === tool.todos) return [];
    tool.todos = json;
    return [{ type: 'todo.updated', engineSessionId: this.engineSessionId, toolCallId, items }];
  }

  /** 命令的流式输出加到最近一个还在跑的命令上（T3：SDK 不给这条输出属于哪次调用）。 */
  #shellOutput(event: Record<string, unknown>): AgentEvent[] {
    const shell = [...this.#tools.entries()]
      .reverse()
      .find(([, tool]) => tool.toolCall.type === 'shell');
    if (shell === undefined) return [];
    const text = [event.text, event.output, event.data, event.stdout, event.stderr, event.chunk]
      .filter((value): value is string => typeof value === 'string')
      .join('');
    if (text === '') return [];
    const [toolCallId, tool] = shell;
    tool.output += text;
    return [
      {
        type: 'tool.updated',
        engineSessionId: this.engineSessionId,
        toolCallId,
        output: tool.output,
      },
    ];
  }
}
