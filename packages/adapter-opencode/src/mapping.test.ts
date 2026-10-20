// 映射回放：把真实 opencode 录下的事件（test-fixtures/events，record-events.test.ts）逐条喂给 OpenCodeTurnMapper，核对产出的
// AgentEvent。回合的开始结束、审批与提问在适配器里，见 opencode-adapter.test.ts。

import type { AgentEvent } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import { contextTokens, OpenCodeTurnMapper, todoItems } from './mapping.js';
import type { Event } from './sdk.js';
import { loadRecording, type Recording } from './test-fixtures/fake-opencode.js';

/** 按适配器的分发把一个会话的事件喂给映射器（用户消息的 part 不算）。 */
function replay(
  recording: Recording,
  sessionID = recording.sessionID,
  mapper = new OpenCodeTurnMapper(sessionID, {
    contextSize: () => 128_000,
    usage: { totalTokens: 0 },
  }),
): { mapper: OpenCodeTurnMapper; events: AgentEvent[] } {
  const roles = new Map<string, string>();
  const events: AgentEvent[] = [];
  for (const line of recording.lines) {
    const event = line.event as Event | undefined;
    if (event === undefined) continue;
    switch (event.type) {
      case 'message.updated':
        if (event.properties.sessionID !== sessionID) break;
        roles.set(event.properties.info.id, event.properties.info.role);
        events.push(...mapper.message(event.properties.info));
        break;
      case 'message.part.updated':
        if (event.properties.part.sessionID !== sessionID) break;
        if (roles.get(event.properties.part.messageID) === 'user') break;
        events.push(...mapper.part(event.properties.part));
        break;
      case 'message.part.delta':
        if (event.properties.sessionID !== sessionID) break;
        events.push(...mapper.delta(event.properties));
        break;
      case 'permission.asked':
        if (event.properties.sessionID !== sessionID || event.properties.tool === undefined) break;
        events.push(
          ...mapper.ensureTool(
            event.properties.tool.callID,
            mapper.toolName(event.properties.tool.callID) ?? event.properties.permission,
            event.properties.metadata,
          ),
        );
        break;
      default:
        break;
    }
  }
  return { mapper, events };
}

const types = (events: readonly AgentEvent[]) => events.map((event) => event.type);

describe('OpenCodeTurnMapper 回放真实录音', () => {
  it('一问一答：两段增量，part 结束时替换它们，消息完成时结束流并报用量', () => {
    const recording = loadRecording('plain');
    const { events, mapper } = replay(recording);
    expect(types(events)).toEqual([
      'assistant.delta',
      'assistant.delta',
      'assistant.message',
      'assistant.stream_ended',
      'usage.recorded',
      'usage.updated',
    ]);
    const [first, second, message, ended, recorded, usage] = events;
    expect(first).toMatchObject({ kind: 'text', text: 'Hello from ', blockIndex: 0 });
    expect(second).toMatchObject({ text: 'the mock model.' });
    const attemptId = (first as { attemptId: string }).attemptId;
    expect(message).toMatchObject({
      type: 'assistant.message',
      text: 'Hello from the mock model.',
      replaces: [{ attemptId, blockIndex: 0 }],
    });
    expect(ended).toMatchObject({ attemptId, outcome: 'committed' });
    expect(usage).toMatchObject({ contextUsed: 132, contextSize: 128_000, totalTokens: 132 });
    // 每次调用的用量（0.62.0）：时长到 text part 结束，首个 token 是 text part 开始。
    expect(recorded).toEqual({
      type: 'usage.recorded',
      engineSessionId: recording.sessionID,
      requestId: 'msg_13e26fdd2001lU3DllkZDPbCo1',
      model: 'echo',
      upstream: 'mock',
      inputTokens: 120,
      outputTokens: 12,
      durationMs: 424,
      firstTokenMs: 423,
    });
    expect(mapper.lastFinish).toBe('stop');
    expect(mapper.finish()).toEqual([]);
  });

  it('推理：思考与回答是同一次调用里的两个块，思考先提交', () => {
    const { events } = replay(loadRecording('reasoning'));
    const committed = events.filter(
      (event) => event.type === 'assistant.thought' || event.type === 'assistant.message',
    );
    expect(committed).toMatchObject([
      {
        type: 'assistant.thought',
        text: 'Thinking about the answer.',
        replaces: [{ blockIndex: 0 }],
      },
      { type: 'assistant.message', text: 'Here is the answer.', replaces: [{ blockIndex: 1 }] },
    ]);
    const deltas = events.filter((event) => event.type === 'assistant.delta');
    expect(deltas.map((event) => (event as { kind: string }).kind)).toEqual([
      'reasoning',
      'reasoning',
      'text',
      'text',
    ]);
  });

  it('工具：pending 没有输入时不报，running 报开始，completed 报结束与输出；两次调用各自一个 attempt', () => {
    const { events } = replay(loadRecording('tool'));
    const tools = events.filter((event) => event.type.startsWith('tool.'));
    expect(tools).toMatchObject([
      {
        type: 'tool.started',
        toolName: 'glob',
        display: { kind: 'search', query: '*.txt', summary: '*.txt' },
        input: { pattern: '*.txt' },
      },
      { type: 'tool.finished', status: 'completed' },
    ]);
    expect((tools[1] as { output?: string }).output).toContain('hello.txt');
    const attempts = new Set(
      events
        .filter((event) => event.type === 'assistant.stream_ended')
        .map((event) => (event as { attemptId: string }).attemptId),
    );
    expect(attempts.size).toBe(1);
    expect(events.filter((event) => event.type === 'usage.updated')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'usage.updated', totalTokens: 264 });
    // 调工具的那次：时长只到工具开始跑（不含工具的一秒），没有文本就没有首个 token 的时间。
    expect(events.filter((event) => event.type === 'usage.recorded')).toEqual([
      expect.objectContaining({ requestId: 'msg_13e270030001jFyjCqagNJjvlQ', durationMs: 12 }),
      expect.objectContaining({
        requestId: 'msg_13e27046b001kcNvA3X3Tz4o8a',
        durationMs: 10,
        firstTokenMs: 9,
      }),
    ]);
    expect(events.find((event) => event.type === 'usage.recorded')).not.toHaveProperty(
      'firstTokenMs',
    );
  });

  it('审批：tool part 还是 pending 时请求审批，用请求的 metadata 先报开始；bash 运行中的输出作增量', () => {
    const { events } = replay(loadRecording('approval-stop'));
    const started = events.find((event) => event.type === 'tool.started');
    expect(started).toMatchObject({
      toolName: 'bash',
      display: { kind: 'shell', command: 'echo wevir' },
      input: { command: 'echo wevir' },
    });
    const tools = events.filter((event) => event.type.startsWith('tool.'));
    expect(types(tools)).toEqual(['tool.started', 'tool.updated', 'tool.finished']);
    expect(tools[2]).toMatchObject({
      status: 'failed',
      output: 'The user rejected permission to use this specific tool call.',
    });

    const accepted = replay(loadRecording('approval-accept')).events.filter((event) =>
      event.type.startsWith('tool.'),
    );
    expect(
      accepted.some((event) => event.type === 'tool.updated' && event.output === 'wevir\n'),
    ).toBe(true);
    expect(accepted.at(-1)).toMatchObject({ type: 'tool.finished', status: 'completed' });
  });

  it('清单：todowrite 的输入报成 todo.updated，紧跟它的 tool.started；状态原样', () => {
    const { events } = replay(loadRecording('todo'));
    const index = events.findIndex((event) => event.type === 'todo.updated');
    expect(events[index - 1]).toMatchObject({ type: 'tool.started', toolName: 'todowrite' });
    expect(events[index]).toMatchObject({
      items: [
        { content: 'Read the code', status: 'completed' },
        { content: 'Write the fix', status: 'in_progress' },
        { content: 'Run the tests', status: 'pending' },
      ],
    });
    expect(events.filter((event) => event.type === 'todo.updated')).toHaveLength(1);
    expect((events[index - 1] as { display: { kind: string } }).display.kind).toBe('plan');
  });

  it('提问：question 工具不报（提问由 question.asked 报）', () => {
    const { events } = replay(loadRecording('question'));
    expect(events.some((event) => event.type.startsWith('tool.'))).toBe(false);
    expect(events.some((event) => event.type === 'assistant.message')).toBe(true);
  });

  it('取消：opencode 不再发 part 的最终快照，finish 用已有的增量提交并结束流', () => {
    const { events, mapper } = replay(loadRecording('slow-cancel'));
    expect(types(events)).toEqual(['assistant.delta', 'assistant.delta', 'assistant.delta']);
    const finished = mapper.finish();
    expect(finished).toMatchObject([
      { type: 'assistant.message', text: 'word0 word1 word2 ', replaces: [{ blockIndex: 0 }] },
      { type: 'assistant.stream_ended', outcome: 'committed' },
    ]);
    expect(mapper.finish()).toEqual([]);
  });

  it('插话：opencode 在这一步结束后接着跑一步，那一步的 assistant 消息回答插话（parentID 是它）', () => {
    const recording = loadRecording('steer');
    const assistants = recording.lines
      .map((line) => line.event)
      .filter(
        (event): event is Extract<Event, { type: 'message.updated' }> =>
          event?.type === 'message.updated' && event.properties.info.role === 'assistant',
      )
      .map(
        (event) =>
          event.properties.info as Extract<typeof event.properties.info, { role: 'assistant' }>,
      );
    expect([...new Set(assistants.map((info) => info.parentID))]).toEqual([
      recording.messageID,
      recording.steerMessageID,
    ]);
    // 插话的用户消息在第一步结束之前就存下了。
    const steerAt = recording.lines.findIndex(
      (line) =>
        line.event?.type === 'message.updated' &&
        line.event.properties.info.id === recording.steerMessageID,
    );
    const firstDone = recording.lines.findIndex(
      (line) =>
        line.event?.type === 'message.updated' &&
        line.event.properties.info.role === 'assistant' &&
        line.event.properties.info.time.completed !== undefined,
    );
    expect(steerAt).toBeGreaterThan(0);
    expect(steerAt).toBeLessThan(firstDone);
    const { events } = replay(recording);
    const messages = events.filter(
      (event): event is Extract<AgentEvent, { type: 'assistant.message' }> =>
        event.type === 'assistant.message',
    );
    expect(messages.map((event) => event.replaces?.[0]?.attemptId)).toEqual([
      assistants[0]?.id,
      assistants.at(-1)?.id,
    ]);
    expect(messages.at(-1)).toMatchObject({ text: 'The weather is sunny.' });
  });

  it('子会话：子会话自己的事件流（用户消息之外）照样映射', () => {
    const recording = loadRecording('subagent-approval');
    const child = recording.lines
      .map((line) => line.event)
      .find((event) => event?.type === 'session.created');
    const childId = (child as Extract<Event, { type: 'session.created' }>).properties.info.id;
    const { events } = replay(recording, childId);
    expect(events.find((event) => event.type === 'tool.started')).toMatchObject({
      engineSessionId: childId,
      toolName: 'bash',
      input: { command: 'echo wevir-subagent' },
    });
    expect(events.find((event) => event.type === 'assistant.message')).toMatchObject({
      text: 'The subagent ran the command.',
    });
  });

  it('task 工具显示为子 agent，摘要是描述', () => {
    const recording = loadRecording('subagent');
    const { events } = replay(recording);
    expect(events.find((event) => event.type === 'tool.started')).toMatchObject({
      toolName: 'task',
      display: { kind: 'sub_agent', summary: 'Say hi' },
    });
  });
});

describe('辅助函数', () => {
  it('todoItems 跳过空内容，缺状态时当 pending', () => {
    expect(
      todoItems({
        todos: [{ content: ' a ', status: 'cancelled' }, { content: '' }, { content: 'b' }],
      }),
    ).toEqual([
      { content: 'a', status: 'cancelled' },
      { content: 'b', status: 'pending' },
    ]);
    expect(todoItems({})).toBeUndefined();
  });

  it('contextTokens 是输入、缓存与输出之和', () => {
    expect(
      contextTokens({ input: 10, output: 5, reasoning: 3, cache: { read: 100, write: 1 } }),
    ).toBe(116);
    expect(contextTokens({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })).toBe(
      undefined,
    );
  });

  it('part 只发快照不发增量（旧版本）时按快照的差补增量', () => {
    const mapper = new OpenCodeTurnMapper('ses_1');
    const base = { id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'text' as const };
    expect(mapper.part({ ...base, text: 'Hel' })).toMatchObject([
      { type: 'assistant.delta', text: 'Hel' },
    ]);
    expect(mapper.part({ ...base, text: 'Hello' })).toMatchObject([
      { type: 'assistant.delta', text: 'lo' },
    ]);
    expect(mapper.part({ ...base, text: 'Hello', time: { start: 1, end: 2 } })).toMatchObject([
      { type: 'assistant.message', text: 'Hello' },
    ]);
    expect(mapper.part({ ...base, id: 'prt_2', text: 'x', synthetic: true })).toEqual([]);
  });
});

describe('每次调用的用量（0.62.0）', () => {
  it('输出加回推理；缓存原样；没拿到用量（第一个 step 前中断）的不报', () => {
    const mapper = new OpenCodeTurnMapper('s');
    const base = {
      id: 'msg_1',
      sessionID: 's',
      role: 'assistant',
      time: { created: 1_000, completed: 3_000 },
      parentID: 'msg_0',
      modelID: 'claude-sonnet-4-5',
      providerID: 'anthropic',
      mode: 'build',
      agent: 'build',
      path: { cwd: '/', root: '/' },
      cost: 0,
    } as const;
    const events = mapper.message({
      ...base,
      tokens: { input: 50, output: 200, reasoning: 80, cache: { read: 9000, write: 300 } },
    });
    expect(events.find((event) => event.type === 'usage.recorded')).toEqual({
      type: 'usage.recorded',
      engineSessionId: 's',
      requestId: 'msg_1',
      model: 'claude-sonnet-4-5',
      upstream: 'anthropic',
      inputTokens: 50,
      outputTokens: 280,
      cacheReadTokens: 9000,
      cacheWriteTokens: 300,
      reasoningTokens: 80,
      durationMs: 2000,
    });
    const aborted = mapper.message({
      ...base,
      id: 'msg_2',
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(aborted.some((event) => event.type === 'usage.recorded')).toBe(false);
  });
});
