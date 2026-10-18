// 通用映射里由引擎描述注入的部分：工具展示与待办、路由解码、能力表，以及没有增量旁路的会话队列。

import type { AgentEvent, ToolDisplay } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import { type AcpSessionNotification, mapAcpUpdate, sessionConfigInfo } from './acp-mapping.js';
import { acpAdapterCapabilities } from './capabilities.js';
import type { AcpEngine, AcpRouteCodec, AcpToolPresentation } from './engine.js';
import { SessionEventQueue } from './session-events.js';

/** 按 ACP `kind` 与 `locations` 给展示类型的引擎（Gemini CLI 这类），`write_todos` 是它的待办工具。 */
const KIND_TOOLS: AcpToolPresentation = {
  display: (_toolName, _rawInput, update): ToolDisplay => {
    const paths = Array.isArray(update.locations)
      ? update.locations.map((location: { path: string }) => location.path)
      : [];
    return update.kind === 'edit' ? { kind: 'edit', paths } : { kind: 'unknown' };
  },
  todos: (toolName, rawInput) =>
    toolName === 'write_todos'
      ? (rawInput as { todos: { content: string; status: string }[] }).todos
      : undefined,
};

/** 模型选项叫 `model_id`、值就是模型 ID、没有推理强度选项的引擎。 */
const PLAIN_ROUTE: AcpRouteCodec = {
  modelOption: 'model_id',
  encode: (_providerId, modelId) => modelId,
  decodeModel: (value) => value,
};

const update = (fields: Record<string, unknown>): AcpSessionNotification => ({
  sessionId: 's1',
  update: { sessionUpdate: 'tool_call', toolCallId: 't1', status: 'in_progress', ...fields },
});

describe('mapAcpUpdate：工具展示与待办来自引擎描述', () => {
  it('展示类型由引擎按整条更新给出', () => {
    const [started] = mapAcpUpdate(
      update({ title: 'Edit file', kind: 'edit', locations: [{ path: '/w/a.ts' }] }),
      KIND_TOOLS,
    );
    expect(started).toMatchObject({
      type: 'tool.started',
      toolName: 'Edit file',
      display: { kind: 'edit', paths: ['/w/a.ts'] },
    });
  });

  it('引擎认出待办工具时紧跟一条 todo.updated；没有 todos 的引擎不发', () => {
    const todos = [{ content: '读代码', status: 'pending' }];
    const notification = update({ title: 'write_todos', rawInput: { todos } });
    expect(mapAcpUpdate(notification, KIND_TOOLS).map((e) => e.type)).toEqual([
      'tool.started',
      'todo.updated',
    ]);
    expect(mapAcpUpdate(notification, KIND_TOOLS)[1]).toMatchObject({ items: todos });
    const noTodos: AcpToolPresentation = { display: () => ({ kind: 'unknown' }) };
    expect(mapAcpUpdate(notification, noTodos).map((e) => e.type)).toEqual(['tool.started']);
  });
});

describe('sessionConfigInfo：按引擎的路由编码读回模型', () => {
  it('选项名与编码由引擎决定；没有推理强度选项时不报推理强度', () => {
    const configOptions = [
      { id: 'model_id', currentValue: 'gemini-flash' },
      { id: 'reasoning_effort', currentValue: 'high' },
    ];
    expect(sessionConfigInfo(configOptions, PLAIN_ROUTE)).toEqual({ modelId: 'gemini-flash' });
  });

  it('解不出模型时省略', () => {
    const route: AcpRouteCodec = { ...PLAIN_ROUTE, decodeModel: () => undefined };
    expect(sessionConfigInfo([{ id: 'model_id', currentValue: 'x' }], route)).toEqual({});
  });
});

describe('acpAdapterCapabilities', () => {
  it('引擎的能力表原样，incrementalStream 只在旁路 active 时为 true，没有子会话与插话', () => {
    const engine: Pick<AcpEngine, 'capabilities'> = {
      capabilities: { toolCalls: true, approvals: true, resume: false, concurrentSessions: true },
    };
    expect(acpAdapterCapabilities(engine, 'off')).toEqual({
      incrementalStream: false,
      subagents: false,
      steer: false,
      toolCalls: true,
      approvals: true,
      resume: false,
      concurrentSessions: true,
    });
    expect(acpAdapterCapabilities(engine, 'active').incrementalStream).toBe(true);
  });
});

describe('SessionEventQueue：没有增量旁路的引擎', () => {
  it('已提交消息的 replaces 为空，旁路事件忽略', async () => {
    const queue = new SessionEventQueue('s1', () => {}, { tools: KIND_TOOLS });
    const events = queue.subscribe();
    queue.beginTurn();
    queue.incremental({
      type: 'assistant.delta',
      engineSessionId: 's1',
      attemptId: 'a',
      blockIndex: 0,
      kind: 'text',
      text: '你',
    });
    queue.acpUpdate({
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: '你好' },
      },
    });
    queue.endTurn({
      type: 'turn.settled',
      engineSessionId: 's1',
      outcome: 'completed',
      stopReason: 'end_turn',
    });
    queue.end();
    const out: AgentEvent[] = [];
    for await (const event of events) out.push(event);
    expect(out.map((e) => e.type)).toEqual(['assistant.message', 'turn.settled']);
    expect(out[0]).toMatchObject({ text: '你好', replaces: [] });
  });
});
