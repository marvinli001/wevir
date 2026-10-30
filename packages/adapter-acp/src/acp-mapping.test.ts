// 通用映射里由引擎描述注入的部分：工具展示与待办、路由解码、能力表，以及没有增量旁路的会话队列。

import type { AgentEvent, ToolDisplay } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import {
  type AcpSessionNotification,
  mapAcpUpdate,
  routeModelOption,
  sessionConfigInfo,
} from './acp-mapping.js';
import { acpAdapterCapabilities } from './capabilities.js';
import type { AcpRouteCodec, AcpToolPresentation } from './engine.js';
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
  const capabilities = {
    toolCalls: true,
    approvals: true,
    resume: false,
    concurrentSessions: true,
  };

  it('引擎的能力表原样，incrementalStream 只在逐字流式的引擎上为 true，没有子会话与插话', () => {
    expect(acpAdapterCapabilities({ capabilities })).toEqual({
      incrementalStream: false,
      subagents: false,
      steer: false,
      ...capabilities,
    });
    expect(
      acpAdapterCapabilities({ capabilities, messageChunks: 'committed' }).incrementalStream,
    ).toBe(false);
    expect(
      acpAdapterCapabilities({ capabilities, messageChunks: 'streamed' }).incrementalStream,
    ).toBe(true);
  });
});

describe('SessionEventQueue：已提交消息的引擎', () => {
  it('已提交消息的 replaces 为空', async () => {
    const queue = new SessionEventQueue('s1', () => {}, { tools: KIND_TOOLS });
    const events = queue.subscribe();
    queue.beginTurn();
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

describe('模型选项（按类别）', () => {
  const route: AcpRouteCodec = { ...PLAIN_ROUTE, modelOption: 'model', modelCategory: 'model' };
  const select = (id: string, currentValue: string) => ({
    id,
    name: id,
    type: 'select',
    category: 'model',
    currentValue,
    options: [{ value: currentValue, name: currentValue }],
  });

  it('只认这一类里第一个 select，同类的开关与空 ID 不算；没有时用 modelOption', () => {
    const toggle = { id: 'fast', type: 'boolean', category: 'model', currentValue: true };
    const blank = { ...select('  ', 'x'), id: '  ' };
    const options = [toggle, blank, select('model_id', 'fixture-a'), select('later', 'fixture-b')];
    expect(routeModelOption(options, route)).toBe('model_id');
    expect(sessionConfigInfo(options, route)).toEqual({ modelId: 'fixture-a' });
    expect(routeModelOption([toggle], route)).toBe('model');
    expect(routeModelOption(undefined, route)).toBe('model');
  });
});

describe('上下文压缩（compaction_update）', () => {
  const update = (value: Record<string, unknown>): AcpSessionNotification => ({
    sessionId: 's1',
    update: { sessionUpdate: 'compaction_update', ...value },
  });

  it('in_progress → context.compacting，completed → context.compacted（auto，ID 带会话）；失败与摘要不发事件', () => {
    expect(mapAcpUpdate(update({ compactionId: 'c1', status: 'in_progress' }), KIND_TOOLS)).toEqual(
      [
        {
          type: 'context.compacting',
          engineSessionId: 's1',
          compactionId: 's1:c1',
          trigger: 'auto',
        },
      ],
    );
    expect(mapAcpUpdate(update({ compactionId: 'c1', status: 'completed' }), KIND_TOOLS)).toEqual([
      { type: 'context.compacted', engineSessionId: 's1', compactionId: 's1:c1', trigger: 'auto' },
    ]);
    const reasons: string[] = [];
    const onRaw = (reason: string) => reasons.push(reason);
    expect(
      mapAcpUpdate(update({ compactionId: 'c1', status: 'failed' }), KIND_TOOLS, onRaw)[0]?.type,
    ).toBe('engine.raw');
    const chunk: AcpSessionNotification = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: 'c1',
        content: { type: 'text', text: 'summary' },
      },
    };
    expect(mapAcpUpdate(chunk, KIND_TOOLS, onRaw)[0]?.type).toBe('engine.raw');
    expect(mapAcpUpdate(update({ status: 'completed' }), KIND_TOOLS, onRaw)[0]?.type).toBe(
      'engine.raw',
    );
    expect(reasons).toEqual(['by_design', 'by_design', 'unexpected_fields']);
  });

  it('会话队列：同一次压缩只报一次开始、一次完成；只报了完成的先补开始；回合外不报', async () => {
    const queue = new SessionEventQueue('s1', () => {}, { tools: KIND_TOOLS });
    const events = queue.subscribe();
    queue.acpUpdate(update({ compactionId: 'early', status: 'completed' }));
    queue.beginTurn();
    queue.acpUpdate(update({ compactionId: 'c1', status: 'in_progress' }));
    queue.acpUpdate(update({ compactionId: 'c1', status: 'in_progress' }));
    queue.acpUpdate(update({ compactionId: 'c1', status: 'completed' }));
    queue.acpUpdate(update({ compactionId: 'c1', status: 'completed', summary: [] }));
    queue.acpUpdate(update({ compactionId: 'c2', status: 'completed' }));
    queue.endTurn({
      type: 'turn.settled',
      engineSessionId: 's1',
      outcome: 'completed',
      stopReason: 'end_turn',
    });
    queue.end();
    const out: AgentEvent[] = [];
    for await (const event of events) out.push(event);
    expect(
      out.map((e) =>
        e.type.startsWith('context.')
          ? `${e.type} ${(e as { compactionId: string }).compactionId}`
          : e.type,
      ),
    ).toEqual([
      'engine.raw',
      'context.compacting s1:c1',
      'context.compacted s1:c1',
      'context.compacting s1:c2',
      'context.compacted s1:c2',
      'turn.settled',
    ]);
  });
});
