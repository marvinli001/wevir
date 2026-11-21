import type { AgentEvent, AssistantDeltaEvent } from '@wevir/runtime-adapter';

/**
 * ACP v2 与逐字流式的 v1 引擎（`messageChunks: 'streamed'`，Grok Build、Gemini CLI）：每条 `agent_message_chunk` /
 * `agent_thought_chunk` 是一段增量，不是 dsh 那样一块已提交的完整内容（acp-event-mapping.md §1.5）。这里把它们变成
 * `assistant.delta`，并在一块内容结束时补一条替换这些增量的 `assistant.message` / `assistant.thought` 与
 * `assistant.stream_ended`，和 Codex 的增量与已提交消息同一个形状（codex-event-mapping.md）。
 *
 * 一块内容是同一种（文本或思考）、同一个 `messageId`（引擎给了的话）的连续增量；换了种类、换了 `messageId`，或者
 * 中间来了别的更新（工具调用等，调用方 `flush`），这一块就结束。每块是一个 attempt（`acp-<n>`，块序号 0），提交时
 * `messageId` 用引擎给的，没有时用 attemptId。attemptId 在进程内唯一（Host 按它分配 StreamId；同一个会话 resume 之后
 * 是新的 ChunkStream，不能从 1 重新数）。
 */
let attemptSeq = 0;

export class ChunkStream {
  readonly #engineSessionId: string;
  readonly #messageBlocks: Map<string, string[]> | undefined;
  #open: OpenBlock | undefined;

  constructor(engineSessionId: string, snapshots = false) {
    this.#engineSessionId = engineSessionId;
    this.#messageBlocks = snapshots ? new Map() : undefined;
  }

  beginTurn(): void {
    this.#messageBlocks?.clear();
  }

  /** 正在流式的块（还没提交）。 */
  get open(): boolean {
    return this.#open !== undefined;
  }

  /** 一段增量。空文本不发增量，但仍算这一块的开始。 */
  chunk(
    kind: AssistantDeltaEvent['kind'],
    messageId: string | undefined,
    text: string,
  ): AgentEvent[] {
    const events: AgentEvent[] = [];
    const open = this.#open;
    if (
      open !== undefined &&
      (open.kind !== kind ||
        (messageId !== undefined && open.messageId !== undefined && open.messageId !== messageId))
    ) {
      events.push(...this.flush());
    }
    let block = this.#open;
    if (block === undefined) {
      attemptSeq += 1;
      block = { kind, attemptId: `acp-${attemptSeq}`, text: '', deltas: 0 };
      this.#open = block;
    }
    block.messageId ??= messageId;
    if (text === '') return events;
    block.text += text;
    block.deltas += 1;
    events.push({
      type: 'assistant.delta',
      engineSessionId: this.#engineSessionId,
      attemptId: block.attemptId,
      blockIndex: 0,
      kind,
      text,
    });
    return events;
  }

  /** ACP v2 的完整消息会覆盖同 ID 的先前内容，包括工具或审批前已提交的流式块。 */
  snapshot(kind: AssistantDeltaEvent['kind'], messageId: string, text: string): AgentEvent[] {
    const events = this.flush();
    const key = JSON.stringify([kind, messageId]);
    const [first, ...rest] = this.#messageBlocks?.get(key) ?? [];
    if (first === undefined) {
      if (text.trim() !== '') events.push(...this.chunk(kind, messageId, text), ...this.flush());
      return events;
    }
    const commit = (attemptId: string, text: string): AgentEvent => ({
      type: kind === 'text' ? 'assistant.message' : 'assistant.thought',
      engineSessionId: this.#engineSessionId,
      messageId,
      text,
      replaces: [{ attemptId, blockIndex: 0 }],
    });
    events.push(...rest.map((id) => commit(id, '')), commit(first, text));
    if (text.trim() === '') this.#messageBlocks?.delete(key);
    else this.#messageBlocks?.set(key, [first]);
    return events;
  }

  /** 结束正在流式的块：已提交的消息或思考替换它的增量，再结束它的增量流。没有内容的块不发事件。 */
  flush(): AgentEvent[] {
    const block = this.#open;
    if (block === undefined) return [];
    this.#open = undefined;
    if (block.deltas === 0) return [];
    if (
      this.#messageBlocks !== undefined &&
      block.messageId !== undefined &&
      block.text.trim() !== ''
    ) {
      const key = JSON.stringify([block.kind, block.messageId]);
      const refs = this.#messageBlocks.get(key) ?? [];
      refs.push(block.attemptId);
      this.#messageBlocks.set(key, refs);
    }
    return [
      {
        type: block.kind === 'text' ? 'assistant.message' : 'assistant.thought',
        engineSessionId: this.#engineSessionId,
        messageId: block.messageId ?? block.attemptId,
        text: block.text,
        replaces: [{ attemptId: block.attemptId, blockIndex: 0 }],
      },
      {
        type: 'assistant.stream_ended',
        engineSessionId: this.#engineSessionId,
        attemptId: block.attemptId,
        outcome: 'committed',
      },
    ];
  }
}

interface OpenBlock {
  kind: AssistantDeltaEvent['kind'];
  attemptId: string;
  messageId?: string;
  text: string;
  deltas: number;
}
