import type { InteractionUpdate } from '@cursor/sdk';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import { CursorTurnMapper } from './mapping.js';
import { PLAIN_UPDATES, TOOL_UPDATES, TRANSPORT_FAILURE_UPDATES } from './test-fixtures/updates.js';

const SESSION = 'agent-1';

function replay(
  updates: readonly InteractionUpdate[],
  mapper = new CursorTurnMapper(SESSION, 'run-1'),
) {
  const events: AgentEvent[] = [];
  for (const update of updates) events.push(...mapper.map(update));
  return { mapper, events };
}

/** 去掉每个事件都有的 engineSessionId，断言好读一些。 */
function strip(events: AgentEvent[]) {
  return events.map(({ engineSessionId, ...rest }) => {
    expect(engineSessionId).toBe(SESSION);
    return rest;
  });
}

describe('CursorTurnMapper（回放 test-fixtures/updates.ts）', () => {
  it('思考与回答各是一段：增量之后提交成消息，替换自己的增量；节拍类更新不映射', () => {
    const { events, mapper } = replay(PLAIN_UPDATES);
    expect(strip(events)).toEqual([
      {
        type: 'assistant.delta',
        attemptId: 'run-1:reasoning:1',
        blockIndex: 0,
        kind: 'reasoning',
        text: 'The user ',
      },
      {
        type: 'assistant.delta',
        attemptId: 'run-1:reasoning:1',
        blockIndex: 0,
        kind: 'reasoning',
        text: 'says hello.',
      },
      {
        type: 'assistant.thought',
        messageId: 'run-1:reasoning:1',
        text: 'The user says hello.',
        replaces: [{ attemptId: 'run-1:reasoning:1', blockIndex: 0 }],
      },
      { type: 'assistant.stream_ended', attemptId: 'run-1:reasoning:1', outcome: 'committed' },
      {
        type: 'assistant.delta',
        attemptId: 'run-1:text:1',
        blockIndex: 0,
        kind: 'text',
        text: 'Hello',
      },
      {
        type: 'assistant.delta',
        attemptId: 'run-1:text:1',
        blockIndex: 0,
        kind: 'text',
        text: ' from Cursor.',
      },
      {
        type: 'assistant.message',
        messageId: 'run-1:text:1',
        text: 'Hello from Cursor.',
        replaces: [{ attemptId: 'run-1:text:1', blockIndex: 0 }],
      },
      { type: 'assistant.stream_ended', attemptId: 'run-1:text:1', outcome: 'committed' },
      // turn-ended 带的用量（0.62.0）：每个回合一条，按 run ID。
      { type: 'usage.recorded', requestId: 'run-1', inputTokens: 10, outputTokens: 5 },
    ]);
    expect(mapper.answered).toBe(true);
    expect(mapper.reply.failure).toBeUndefined();
    expect(mapper.finish('completed')).toEqual([]);
  });

  it('工具：开始、局部更新、完成；命令的流式输出；编辑带 diff；MCP 的 isError 算失败；待办；子 agent 的局部更新不看', () => {
    const { events } = replay(TOOL_UPDATES);
    const tools = strip(events).filter(
      (event) => event.type.startsWith('tool.') || event.type === 'todo.updated',
    );
    expect(tools).toEqual([
      {
        type: 'tool.started',
        toolCallId: 'call-shell',
        toolName: 'shell',
        display: { kind: 'shell', summary: 'ls -la', command: 'ls -la' },
        input: { command: 'ls -la' },
      },
      { type: 'tool.updated', toolCallId: 'call-shell', output: 'total 8\n' },
      {
        type: 'tool.finished',
        toolCallId: 'call-shell',
        status: 'completed',
        output: 'total 8\nREADME.md\n',
      },
      {
        type: 'tool.started',
        toolCallId: 'call-read',
        toolName: 'read',
        display: { kind: 'read', summary: 'README.md', paths: ['README.md'] },
        input: { path: 'README.md' },
      },
      { type: 'tool.finished', toolCallId: 'call-read', status: 'completed', output: '# Demo\n' },
      {
        type: 'tool.started',
        toolCallId: 'call-edit',
        toolName: 'edit',
        display: { kind: 'edit', summary: 'README.md', paths: ['README.md'] },
        input: { path: 'README.md' },
      },
      {
        type: 'tool.finished',
        toolCallId: 'call-edit',
        status: 'completed',
        output: '@@ -1 +1,2 @@\n # Demo\n+Hello\n',
      },
      // 只来了 completed 的工具也先报开始。
      {
        type: 'tool.started',
        toolCallId: 'call-grep',
        toolName: 'grep',
        display: { kind: 'search', summary: 'Hello', query: 'Hello', paths: ['src'] },
        input: { pattern: 'Hello', path: 'src' },
      },
      {
        type: 'tool.finished',
        toolCallId: 'call-grep',
        status: 'completed',
        output: JSON.stringify({ workspaceResults: {} }, null, 2),
      },
      {
        type: 'tool.started',
        toolCallId: 'call-mcp',
        toolName: 'mcp__docs__search',
        display: { kind: 'unknown', summary: 'docs/search', mcpServer: 'docs' },
        input: { args: { query: 'x' }, providerIdentifier: 'docs', toolName: 'search' },
      },
      { type: 'tool.finished', toolCallId: 'call-mcp', status: 'failed', output: 'server down' },
      {
        type: 'tool.started',
        toolCallId: 'call-todos',
        toolName: 'updateTodos',
        display: { kind: 'plan' },
        input: expect.objectContaining({ todos: expect.any(Array) }),
      },
      {
        type: 'todo.updated',
        toolCallId: 'call-todos',
        items: [
          { content: 'Read the README', status: 'completed' },
          { content: 'Add a greeting', status: 'in_progress' },
        ],
      },
      {
        type: 'todo.updated',
        toolCallId: 'call-todos',
        items: [
          { content: 'Read the README', status: 'completed' },
          { content: 'Add a greeting', status: 'completed' },
        ],
      },
      {
        type: 'tool.finished',
        toolCallId: 'call-todos',
        status: 'completed',
        output: expect.any(String),
      },
      {
        type: 'tool.started',
        toolCallId: 'call-task',
        toolName: 'task',
        display: { kind: 'sub_agent', summary: 'Check tests' },
        input: { description: 'Check tests', prompt: 'Run the tests' },
      },
      {
        type: 'tool.finished',
        toolCallId: 'call-task',
        status: 'completed',
        output: 'All tests pass.',
      },
    ]);
    // 工具调用一来，前一段回答就提交了；最后一段在回合结束时提交。
    const messages = strip(events).filter((event) => event.type === 'assistant.message');
    expect(messages.map((event) => 'text' in event && event.text)).toEqual([
      'Editing now.',
      'Done.',
    ]);
  });

  it('不认识的更新原样保留为 engine.raw', () => {
    const update = { type: 'brand-new-update', payload: 1 } as unknown as InteractionUpdate;
    const { events } = replay([update]);
    expect(strip(events)).toEqual([
      {
        type: 'engine.raw',
        protocol: 'cursor-sdk',
        method: 'onDelta',
        kind: 'brand-new-update',
        params: update,
      },
    ]);
  });

  it('回合在中途结束：还在流的文字提交、只有空白的放弃；取消或失败时没完成的工具按失败收尾，之后的更新都忽略', () => {
    const mapper = new CursorTurnMapper(SESSION, 'run-2');
    replay(
      [
        { type: 'text-delta', text: 'partial answer' },
        {
          type: 'tool-call-started',
          callId: 'call-1',
          modelCallId: 'model-call-1',
          toolCall: { type: 'shell', args: { command: 'sleep 100' } },
        },
        { type: 'shell-output-delta', event: { text: 'zz' } },
        { type: 'thinking-delta', text: '   ' },
      ],
      mapper,
    );
    expect(strip(mapper.finish('cancelled'))).toEqual([
      { type: 'assistant.stream_ended', attemptId: 'run-2:reasoning:1', outcome: 'abandoned' },
      { type: 'tool.finished', toolCallId: 'call-1', status: 'failed', output: 'zz' },
    ]);
    expect(mapper.map({ type: 'text-delta', text: 'late' })).toEqual([]);
    expect(mapper.finish('cancelled')).toEqual([]);
  });

  it('正常结束时没完成的工具留给 Host（记为 unknown），不在这里收尾', () => {
    const mapper = new CursorTurnMapper(SESSION, 'run-3');
    replay(
      [
        {
          type: 'tool-call-started',
          callId: 'call-1',
          modelCallId: 'model-call-1',
          toolCall: { type: 'read', args: { path: 'a.txt' } },
        },
      ],
      mapper,
    );
    expect(mapper.finish('completed')).toEqual([]);
  });

  it('没有回答增量时，run 的最终结果当作回答；有增量时不重复', () => {
    const silent = new CursorTurnMapper(SESSION, 'run-4');
    expect(strip(silent.finalResult('Final answer'))).toEqual([
      { type: 'assistant.message', messageId: 'run-4:result', text: 'Final answer', replaces: [] },
    ]);
    const { mapper } = replay(PLAIN_UPDATES);
    expect(mapper.finalResult('Hello from Cursor.')).toEqual([]);
  });

  it('回答只是一段传输诊断时 reply.failure 认出它', () => {
    const { mapper } = replay(TRANSPORT_FAILURE_UPDATES);
    expect(mapper.reply.failure).toBe('Error: ConnectError: [unavailable] upstream connect error');
  });
});

describe('回合的用量（0.62.0）', () => {
  it('缓存与推理原样带上；只报一次；没有用量的 turn-ended 不报', () => {
    const usage = {
      inputTokens: 40,
      outputTokens: 300,
      cacheReadTokens: 12_000,
      cacheWriteTokens: 800,
      reasoningTokens: 120,
    };
    const { events } = replay([
      { type: 'turn-ended', usage },
      { type: 'turn-ended', usage },
    ]);
    expect(strip(events)).toEqual([
      {
        type: 'usage.recorded',
        requestId: 'run-1',
        inputTokens: 40,
        outputTokens: 300,
        cacheReadTokens: 12_000,
        cacheWriteTokens: 800,
        reasoningTokens: 120,
      },
    ]);
    expect(replay([{ type: 'turn-ended' }]).events).toEqual([]);
  });
});
