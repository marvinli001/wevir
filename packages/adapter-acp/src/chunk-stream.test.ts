// 逐字流式的引擎（`messageChunks: 'streamed'`，Grok Build、Gemini CLI）：会话队列把消息与思考的 chunk 当增量，合成一块
// 再提交（acp-event-mapping.md §1.5）。

import type { AgentEvent } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import type { AcpSessionNotification } from './acp-mapping.js';
import { SessionEventQueue } from './session-events.js';

const queue = (warnings: string[] = []) =>
  new SessionEventQueue('s1', (key) => warnings.push(key), {
    tools: { display: () => ({ kind: 'unknown' }) },
    messageChunks: 'streamed',
  });

const chunk = (
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk',
  text: string,
  messageId?: string,
): AcpSessionNotification => ({
  sessionId: 's1',
  update: {
    sessionUpdate,
    content: { type: 'text', text },
    ...(messageId === undefined ? {} : { messageId }),
  },
});

const toolCall: AcpSessionNotification = {
  sessionId: 's1',
  update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', status: 'pending' },
};

/** 订阅后同步喂入，最后结束回合并读出全部事件。 */
async function collect(
  q: SessionEventQueue,
  feed: (q: SessionEventQueue) => void,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const iterator = q.subscribe();
  q.beginTurn();
  feed(q);
  q.endTurn({
    type: 'turn.settled',
    engineSessionId: 's1',
    outcome: 'completed',
    stopReason: 'end_turn',
  });
  q.end();
  for await (const event of iterator) events.push(event);
  return events;
}

const brief = (events: AgentEvent[]) =>
  events.map((e) => {
    switch (e.type) {
      case 'assistant.delta':
        return `delta ${e.attemptId}#${e.blockIndex} ${e.kind} ${e.text}`;
      case 'assistant.message':
      case 'assistant.thought':
        return `${e.type} ${e.messageId} ${e.text} ← ${e.replaces.map((r) => `${r.attemptId}#${r.blockIndex}`).join(',')}`;
      case 'assistant.stream_ended':
        return `ended ${e.attemptId} ${e.outcome}`;
      default:
        return e.type;
    }
  });

describe('逐字流式的 chunk', () => {
  it('思考与文本各成一块：增量 → 换种类时提交上一块 → 回合结束提交最后一块', async () => {
    const events = await collect(queue(), (q) => {
      q.acpUpdate(chunk('agent_thought_chunk', '先'));
      q.acpUpdate(chunk('agent_thought_chunk', '想'));
      q.acpUpdate(chunk('agent_message_chunk', '你'));
      q.acpUpdate(chunk('agent_message_chunk', '好'));
    });
    const a = (events[0] as { attemptId?: string }).attemptId;
    const b = (events[4] as { attemptId?: string }).attemptId;
    expect(a).toMatch(/^acp-\d+$/);
    expect(brief(events)).toEqual([
      `delta ${a}#0 reasoning 先`,
      `delta ${a}#0 reasoning 想`,
      `assistant.thought ${a} 先想 ← ${a}#0`,
      `ended ${a} committed`,
      `delta ${b}#0 text 你`,
      `delta ${b}#0 text 好`,
      `assistant.message ${b} 你好 ← ${b}#0`,
      `ended ${b} committed`,
      'turn.settled',
    ]);
    expect(a).not.toBe(b);
  });

  it('工具调用截断正在流式的文本；引擎给的 messageId 用作消息 ID，换了 messageId 另起一块', async () => {
    const events = await collect(queue(), (q) => {
      q.acpUpdate(chunk('agent_message_chunk', '先看看', 'm1'));
      q.acpUpdate(toolCall);
      q.acpUpdate(chunk('agent_message_chunk', '一', 'm2'));
      q.acpUpdate(chunk('agent_message_chunk', '二', 'm3'));
    });
    const kinds = brief(events).map((line) => line.replace(/acp-\d+/g, 'A'));
    expect(kinds).toEqual([
      'delta A#0 text 先看看',
      'assistant.message m1 先看看 ← A#0',
      'ended A committed',
      'tool.started',
      'delta A#0 text 一',
      'assistant.message m2 一 ← A#0',
      'ended A committed',
      'delta A#0 text 二',
      'assistant.message m3 二 ← A#0',
      'ended A committed',
      'turn.settled',
    ]);
  });

  it('usage_update 不截断；空文本不发增量；只有空 chunk 的块不提交', async () => {
    const events = await collect(queue(), (q) => {
      q.acpUpdate(chunk('agent_message_chunk', ''));
      q.acpUpdate({ sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 1, size: 9 } });
      q.acpUpdate(chunk('agent_message_chunk', 'x'));
      q.acpUpdate({ sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 2, size: 9 } });
      q.acpUpdate(chunk('agent_message_chunk', 'y'));
    });
    expect(brief(events).map((line) => line.replace(/acp-\d+/g, 'A'))).toEqual([
      'usage.updated',
      'delta A#0 text x',
      'usage.updated',
      'delta A#0 text y',
      'assistant.message A xy ← A#0',
      'ended A committed',
      'turn.settled',
    ]);
  });

  it('不是文本的内容与回合外的 chunk 保留为 engine.raw', async () => {
    const warnings: string[] = [];
    const q = queue(warnings);
    const iterator = q.subscribe();
    q.acpUpdate(chunk('agent_message_chunk', '回放的历史'));
    q.beginTurn();
    q.acpUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: '' } },
    });
    q.endTurn({
      type: 'turn.settled',
      engineSessionId: 's1',
      outcome: 'completed',
      stopReason: 'end_turn',
    });
    q.end();
    const events: AgentEvent[] = [];
    for await (const event of iterator) events.push(event);
    expect(events.map((e) => e.type)).toEqual(['engine.raw', 'engine.raw', 'turn.settled']);
    expect(warnings.some((key) => key.startsWith('acp:outside_turn'))).toBe(true);
  });

  it('引擎退出时提交已经流出的部分，再发 engine.exited', async () => {
    const q = queue();
    const iterator = q.subscribe();
    q.beginTurn();
    q.acpUpdate(chunk('agent_message_chunk', '半句'));
    q.exited({ type: 'engine.exited', engineSessionId: 's1', exitCode: 1, signal: null });
    const events: AgentEvent[] = [];
    for await (const event of iterator) events.push(event);
    expect(events.map((e) => e.type)).toEqual([
      'assistant.delta',
      'assistant.message',
      'assistant.stream_ended',
      'engine.exited',
    ]);
  });
});
