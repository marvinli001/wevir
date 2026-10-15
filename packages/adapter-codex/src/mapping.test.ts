import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { checkDeltaReplacement, checkTurnEvents } from '@wevir/runtime-adapter/contract';
import { describe, expect, it } from 'vitest';
import { CodexEventMapper, ENGINE_RAW_PROTOCOL, PLAN_TOOL_CALL_PREFIX } from './mapping.js';
import type { ApprovalRequestMethod } from './protocol.js';

// 回放真实 codex-app-server（rust-v0.162.1）录下的通知序列（src/test-fixtures/app-server/，录制方法见
// record-app-server.test.ts），检查映射成的 AgentEvent（docs/architecture/codex-event-mapping.md §6）。

interface Notification {
  method: string;
  params: Record<string, unknown>;
}

function fixture(name: string): { threadId: string; notifications: Notification[] } {
  const lines = readFileSync(
    join(import.meta.dirname, 'test-fixtures', 'app-server', `${name}.jsonl`),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Notification & { _meta?: unknown });
  const notifications = lines.filter((line) => line._meta === undefined);
  const threadId = notifications[0]?.params.threadId;
  if (typeof threadId !== 'string') throw new Error(`${name}.jsonl 第一条通知没有 threadId`);
  return { threadId, notifications };
}

/** 回放一个样本里属于会话本身（父 thread）的通知。 */
function replay(
  name: string,
  { contextSize }: { contextSize?: number } = { contextSize: 128_000 },
) {
  const { threadId, notifications } = fixture(name);
  const mapper = new CodexEventMapper(threadId, { contextSize: () => contextSize });
  const events = notifications
    .filter((n) => n.params.threadId === threadId)
    .flatMap((n) => mapper.map(n.method, n.params));
  return { threadId, events };
}

interface ConversationLine {
  method?: string;
  params?: Record<string, unknown>;
  serverRequest?: { id: string; method: ApprovalRequestMethod; params: Record<string, unknown> };
}

/**
 * 回放审批对话：前缀（到审批请求为止）接上一个分支。审批请求按适配器的做法先取 `approvalPrelude`，再记一个占位的
 * `approval.requested`（请求本身由适配器上报，这里只为看清顺序）；`serverRequest/resolved` 由适配器处理，跳过。
 */
function replayConversation(name: string, branch: string) {
  const read = (file: string) =>
    readFileSync(join(import.meta.dirname, 'test-fixtures', 'app-server', `${file}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ConversationLine & { _meta?: unknown })
      .filter((line) => line._meta === undefined);
  const lines = [...read(name), ...read(`${name}.${branch}`)];
  const mapper = new CodexEventMapper('<thread>', { contextSize: () => 128_000 });
  const events: AgentEvent[] = [];
  for (const line of lines) {
    if (line.serverRequest !== undefined) {
      const { method, params } = line.serverRequest;
      events.push(...mapper.approvalPrelude(method, params as never));
      events.push({
        type: 'approval.requested',
        engineSessionId: '<thread>',
        requestId: 'r1',
        toolCallId: String(params.itemId),
        options: [],
      });
    } else if (line.method !== undefined && line.method !== 'serverRequest/resolved') {
      events.push(...mapper.map(line.method, line.params));
    }
  }
  return events;
}

const types = (events: readonly AgentEvent[]) => events.map((event) => event.type);
const nonRaw = (events: readonly AgentEvent[]) => events.filter((e) => e.type !== 'engine.raw');

function of<K extends AgentEvent['type']>(events: readonly AgentEvent[], type: K) {
  return events.filter((event): event is Extract<AgentEvent, { type: K }> => event.type === type);
}

describe('回放 codex-app-server 的通知', () => {
  it('stream：推理与文本的增量被已提交的 thought / message 替换，随后是用量与回合完成', () => {
    const { threadId, events } = replay('stream');
    expect(checkTurnEvents(events, threadId)).toEqual([]);
    expect(checkDeltaReplacement(events)).toEqual([]);
    expect(types(events)).toEqual([
      'assistant.delta',
      'assistant.delta',
      'assistant.thought',
      'assistant.stream_ended',
      'assistant.delta',
      'assistant.delta',
      'assistant.delta',
      'assistant.message',
      'assistant.stream_ended',
      'usage.updated',
      'turn.settled',
    ]);
    const [thought] = of(events, 'assistant.thought');
    const [message] = of(events, 'assistant.message');
    expect(thought).toMatchObject({ text: 'The user greets me.' });
    expect(thought?.replaces).toEqual([{ attemptId: thought?.messageId, blockIndex: 0 }]);
    expect(message).toMatchObject({ text: 'Hello from the mock.' });
    expect(message?.replaces).toEqual([{ attemptId: message?.messageId, blockIndex: 0 }]);
    expect(of(events, 'assistant.delta').map((d) => [d.kind, d.text])).toEqual([
      ['reasoning', 'The user '],
      ['reasoning', 'greets me.'],
      ['text', 'Hello'],
      ['text', ' from'],
      ['text', ' the mock.'],
    ]);
    expect(of(events, 'assistant.stream_ended').map((e) => e.outcome)).toEqual([
      'committed',
      'committed',
    ]);
    // 已用量是最近一次请求的 last.totalTokens，上下文大小取模型目录（不是 Codex 报的 95% 有效窗口）；累计用量是
    // total.totalTokens（0.14.0）。
    expect(of(events, 'usage.updated')).toEqual([
      {
        type: 'usage.updated',
        engineSessionId: threadId,
        contextUsed: 1020,
        contextSize: 128_000,
        totalTokens: 1020,
      },
    ]);
    expect(events.at(-1)).toEqual({
      type: 'turn.settled',
      engineSessionId: threadId,
      outcome: 'completed',
      stopReason: 'completed',
    });
  });

  it('上下文大小不知道时用 Codex 报的 modelContextWindow', () => {
    const { events } = replay('stream', {});
    expect(of(events, 'usage.updated')[0]).toMatchObject({ contextSize: 121_600 });
  });

  it('tool-read：只读命令显示为 read，带路径与原始命令', () => {
    const { threadId, events } = replay('tool-read');
    expect(checkTurnEvents(events, threadId)).toEqual([]);
    const [started] = of(events, 'tool.started');
    expect(started).toMatchObject({
      toolName: 'commandExecution',
      display: {
        kind: 'read',
        paths: ['<workspace>/README.md'],
        command: 'cat README.md',
      },
      // input 是原样的 item，命令带 shell 外壳；display 里是去掉外壳的。
      input: { type: 'commandExecution', command: expect.stringContaining('cat README.md') },
    });
    expect(of(events, 'tool.finished')).toEqual([
      {
        type: 'tool.finished',
        engineSessionId: threadId,
        toolCallId: started?.toolCallId,
        status: 'completed',
        output: 'hello readme\n',
      },
    ]);
    expect(types(nonRaw(events)).slice(0, 2)).toEqual(['tool.started', 'tool.finished']);
  });

  it('tool-search：搜索与列目录都显示为 search，搜索词进 query', () => {
    const { events } = replay('tool-search');
    const started = of(events, 'tool.started');
    expect(started.map((e) => e.display)).toEqual([
      expect.objectContaining({
        kind: 'search',
        query: 'hello',
        paths: ['.'],
        command: 'grep -rn hello .',
      }),
      expect.objectContaining({ kind: 'search', summary: 'ls', command: 'ls' }),
    ]);
    // 两个命令并行执行，结束的先后不定。
    expect(
      of(events, 'tool.finished')
        .map((e) => `${e.status} ${e.output}`)
        .sort(),
    ).toEqual(['completed ./notes.txt:1:say hello\n', 'completed notes.txt\n']);
  });

  it('tool-shell：普通命令显示为 shell，输出增量累积成 tool.updated', () => {
    const { events } = replay('tool-shell');
    const [started] = of(events, 'tool.started');
    expect(started?.display).toEqual({
      kind: 'shell',
      summary: 'for i in 1 2 3; do echo line $i; sleep 0.2; done',
      command: 'for i in 1 2 3; do echo line $i; sleep 0.2; done',
    });
    const updates = of(events, 'tool.updated');
    expect(updates.length).toBeGreaterThan(0);
    // 每条是到目前为止的输出，逐条变长。
    for (const [i, update] of updates.entries()) {
      expect(update.toolCallId).toBe(started?.toolCallId);
      if (i > 0) expect(update.output?.startsWith(updates[i - 1]?.output ?? '')).toBe(true);
    }
    expect(of(events, 'tool.finished')[0]).toMatchObject({
      status: 'completed',
      output: 'line 1\nline 2\nline 3\n',
    });
  });

  it('apply-patch：新建文件显示为 write，输出是 diff；turn/diff/updated 保留为 engine.raw', () => {
    const { threadId, events } = replay('apply-patch');
    expect(checkTurnEvents(events, threadId)).toEqual([]);
    expect(of(events, 'tool.started')[0]).toMatchObject({
      toolName: 'fileChange',
      display: {
        kind: 'write',
        summary: '<workspace>/wevir-mock.txt',
        paths: ['<workspace>/wevir-mock.txt'],
      },
    });
    expect(of(events, 'tool.finished')[0]).toMatchObject({
      status: 'completed',
      output: 'hello from the Wevir mock model\n',
    });
    const raw = of(events, 'engine.raw');
    expect(raw.length).toBeGreaterThan(0);
    expect(new Set(raw.map((e) => e.method))).toEqual(new Set(['turn/diff/updated']));
    expect(raw[0]).toMatchObject({ protocol: ENGINE_RAW_PROTOCOL });
  });

  it('upstream-error：error（willRetry false）保留为 engine.raw，回合以 turn.failed 结束', () => {
    const { threadId, events } = replay('upstream-error');
    expect(checkTurnEvents(events, threadId)).toEqual([]);
    expect(types(events)).toEqual(['engine.raw', 'turn.failed']);
    expect(events[0]).toMatchObject({ method: 'error', params: { willRetry: false } });
    // codexErrorInfo 是 other，原文是上游的错误体（turn-error.ts）。
    expect(events[1]).toMatchObject({ type: 'turn.failed', category: 'provider' });
    expect((events[1] as { message: string }).message).toContain(
      'mock upstream rejected the request',
    );
  });

  it('plan：turn/plan/updated → todo.updated，toolCallId 是 plan:<回合 ID>，inProgress 换成 in_progress', () => {
    const { threadId, events } = replay('plan');
    expect(checkTurnEvents(events, threadId)).toEqual([]);
    const [todo] = of(events, 'todo.updated');
    const { notifications } = fixture('plan');
    const turnId = notifications.find((n) => n.method === 'turn/plan/updated')?.params.turnId;
    expect(todo).toEqual({
      type: 'todo.updated',
      engineSessionId: threadId,
      toolCallId: `${PLAN_TOOL_CALL_PREFIX}${turnId}`,
      items: [
        { content: 'Read the code', status: 'completed' },
        { content: 'Write the fix', status: 'in_progress' },
        { content: 'Run the tests', status: 'pending' },
      ],
    });
    // update_plan 不产生工具调用。
    expect(of(events, 'tool.started')).toEqual([]);
  });

  it('approval-exec：item/started 在请求之前，请求前补一条带理由的 tool.updated；同意后工具完成', () => {
    const events = replayConversation('approval-exec', 'accept');
    expect(
      checkTurnEvents(
        events.filter((e) => e.type !== 'approval.requested'),
        '<thread>',
      ),
    ).toEqual([]);
    const requested = events.findIndex((e) => e.type === 'approval.requested');
    const before = types(events.slice(0, requested)).filter((t) => t !== 'engine.raw');
    expect(before.slice(-2)).toEqual(['tool.started', 'tool.updated']);
    expect(events[requested - 1]).toMatchObject({
      type: 'tool.updated',
      input: {
        type: 'commandExecution',
        command: expect.stringContaining('touch <outside>/approval.txt'),
        cwd: '<workspace>',
        justification: '需要在工作区之外写文件',
      },
    });
    expect(of(events, 'tool.finished')).toMatchObject([{ status: 'completed' }]);
    expect(events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  });

  it('approval-exec：decline → 工具 failed、回合完成；cancel → 工具 failed、回合以 cancelled 结算', () => {
    const declined = replayConversation('approval-exec', 'decline');
    expect(of(declined, 'tool.finished')).toMatchObject([{ status: 'failed' }]);
    expect(declined.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    const cancelled = replayConversation('approval-exec', 'cancel');
    expect(of(cancelled, 'tool.finished')).toMatchObject([{ status: 'failed' }]);
    expect(cancelled.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
  });

  it('approval-exec：审批挂起时中断，命令没有 item/completed，回合结算前按失败收尾', () => {
    const events = replayConversation('approval-exec', 'interrupt');
    const finished = events.findIndex((e) => e.type === 'tool.finished');
    expect(events[finished]).toMatchObject({ status: 'failed' });
    expect(events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
    expect(finished).toBe(events.length - 2);
  });

  it('approval-patch：补丁的 changes 在 tool.started 里，请求没有理由就不补；“告诉它换个做法”时按失败收尾', () => {
    const accepted = replayConversation('approval-patch', 'accept');
    const requested = accepted.findIndex((e) => e.type === 'approval.requested');
    const started = of(accepted, 'tool.started')[0];
    expect(started).toMatchObject({
      toolName: 'fileChange',
      display: { kind: 'write', paths: ['<outside>/approval.txt'] },
      input: { changes: [expect.objectContaining({ diff: expect.stringContaining('outside') })] },
    });
    expect(accepted[requested - 1]?.type).not.toBe('tool.updated');
    expect(of(accepted, 'tool.finished')).toMatchObject([{ status: 'completed' }]);
    const cancelled = replayConversation('approval-patch', 'cancel');
    expect(of(cancelled, 'tool.finished')).toMatchObject([{ status: 'failed' }]);
    expect(cancelled.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
  });

  it('cancel：中断时没提交的增量按已提交消息补发，回合以 cancelled 结算', () => {
    const { threadId, events } = replay('cancel');
    expect(checkTurnEvents(events, threadId)).toEqual([]);
    expect(checkDeltaReplacement(events)).toEqual([]);
    expect(types(events)).toEqual([
      'assistant.delta',
      'assistant.message',
      'assistant.stream_ended',
      'turn.settled',
    ]);
    expect(events[1]).toMatchObject({ text: 'chunk 0 ' });
    expect(events[2]).toMatchObject({ outcome: 'committed' });
    expect(events[3]).toMatchObject({ outcome: 'cancelled', stopReason: 'interrupted' });
  });

  it('subagent：父 thread 上的 spawn_agent 是 sub_agent 工具调用', () => {
    const { threadId, events } = replay('subagent');
    expect(checkTurnEvents(events, threadId)).toEqual([]);
    expect(of(events, 'tool.started')[0]).toMatchObject({
      toolName: 'collabAgentToolCall.spawnAgent',
      display: { kind: 'sub_agent', summary: 'Helper task' },
    });
    expect(of(events, 'tool.finished')[0]).toMatchObject({ status: 'completed' });
  });

  it('每个样本里的通知都有去处：映射、按设计忽略，或 engine.raw', () => {
    for (const name of [
      'stream',
      'tool-read',
      'tool-search',
      'tool-shell',
      'apply-patch',
      'cancel',
      'plan',
    ]) {
      const { events } = replay(name);
      // 没有未预期的 engine.raw：只有 turn/diff/updated。
      expect(
        of(events, 'engine.raw')
          .map((e) => e.method)
          .filter((method) => method !== 'turn/diff/updated'),
      ).toEqual([]);
    }
  });
});

describe('映射的边界情况', () => {
  const id = 'thread-1';
  const turnId = 'turn-1';

  it('error 带 willRetry: true：不算回合失败，已流出的增量以 abandoned 结束', () => {
    const mapper = new CodexEventMapper(id);
    mapper.map('item/started', {
      threadId: id,
      turnId,
      item: { type: 'agentMessage', id: 'm1', text: '' },
    });
    mapper.map('item/agentMessage/delta', { threadId: id, turnId, itemId: 'm1', delta: 'part' });
    const events = mapper.map('error', {
      threadId: id,
      turnId,
      willRetry: true,
      error: { message: 'stream disconnected', codexErrorInfo: 'other', additionalDetails: null },
    });
    expect(types(events)).toEqual(['engine.raw', 'assistant.stream_ended']);
    expect(events[1]).toMatchObject({ attemptId: 'm1', outcome: 'abandoned' });
    // 之后同一 item 的增量与提交都不再发事件；回合正常结束时没有补发。
    expect(
      mapper.map('item/agentMessage/delta', { threadId: id, turnId, itemId: 'm1', delta: 'x' }),
    ).toEqual([]);
    expect(
      types(
        mapper.map('turn/completed', {
          threadId: id,
          turn: { id: turnId, status: 'completed', error: null },
        }),
      ),
    ).toEqual(['turn.settled']);
  });

  it('中断时只有空白的增量以 abandoned 结束，不补发消息', () => {
    const mapper = new CodexEventMapper(id);
    mapper.map('item/agentMessage/delta', { threadId: id, turnId, itemId: 'm1', delta: '  \n' });
    const events = mapper.map('turn/completed', {
      threadId: id,
      turn: { id: turnId, status: 'interrupted', error: null },
    });
    expect(events.map((e) => [e.type, (e as { outcome?: string }).outcome])).toEqual([
      ['assistant.stream_ended', 'abandoned'],
      ['turn.settled', 'cancelled'],
    ]);
  });

  it('推理摘要与原始推理分开计块，thought 优先用原始推理', () => {
    const mapper = new CodexEventMapper(id);
    mapper.map('item/reasoning/summaryTextDelta', {
      threadId: id,
      turnId,
      itemId: 'r1',
      delta: 'sum',
      summaryIndex: 0,
    });
    mapper.map('item/reasoning/textDelta', {
      threadId: id,
      turnId,
      itemId: 'r1',
      delta: 'raw',
      contentIndex: 0,
    });
    const events = mapper.map('item/completed', {
      threadId: id,
      turnId,
      item: { type: 'reasoning', id: 'r1', summary: ['sum'], content: ['raw'] },
    });
    expect(events[0]).toMatchObject({
      type: 'assistant.thought',
      text: 'raw',
      replaces: [
        { attemptId: 'r1/summary', blockIndex: 0 },
        { attemptId: 'r1', blockIndex: 0 },
      ],
    });
    expect(
      of(events, 'assistant.stream_ended')
        .map((e) => e.attemptId)
        .sort(),
    ).toEqual(['r1', 'r1/summary']);
  });

  it('没有原始推理也没有增量的空 reasoning 不发事件', () => {
    const mapper = new CodexEventMapper(id);
    expect(
      mapper.map('item/completed', {
        threadId: id,
        turnId,
        item: { type: 'reasoning', id: 'r', summary: [], content: [] },
      }),
    ).toEqual([]);
  });

  it('被拒绝（declined）的命令记为 failed', () => {
    const mapper = new CodexEventMapper(id);
    const item = {
      type: 'commandExecution',
      id: 'c1',
      command: 'touch /outside',
      cwd: '/w',
      status: 'declined',
      commandActions: [{ type: 'unknown', command: 'touch /outside' }],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    // 没有 item/started 也补发 tool.started。
    const events = mapper.map('item/completed', { threadId: id, turnId, item });
    expect(types(events)).toEqual(['tool.started', 'tool.finished']);
    expect(events[1]).toMatchObject({ status: 'failed' });
    expect(events[1]).not.toHaveProperty('output');
  });

  it('字段不合预期的通知整条保留为 engine.raw', () => {
    const mapper = new CodexEventMapper(id);
    const bad = { threadId: id, turnId, item: { type: 'fileChange', id: 'f', changes: 'oops' } };
    expect(mapper.map('item/started', bad)).toEqual([
      {
        type: 'engine.raw',
        engineSessionId: id,
        protocol: ENGINE_RAW_PROTOCOL,
        method: 'item/started',
        kind: 'fileChange',
        params: bad,
      },
    ]);
    expect(mapper.map('item/agentMessage/delta', { threadId: id })).toMatchObject([
      { type: 'engine.raw' },
    ]);
    expect(
      mapper.map('turn/completed', { threadId: id, turn: { id: turnId, status: 'inProgress' } }),
    ).toMatchObject([{ type: 'engine.raw', method: 'turn/completed' }]);
    expect(mapper.map('thread/name/updated', { threadId: id, name: 'x' })).toMatchObject([
      { type: 'engine.raw', method: 'thread/name/updated' },
    ]);
  });

  it('按设计忽略回合开始、thread 状态与用户消息', () => {
    const mapper = new CodexEventMapper(id);
    expect(mapper.map('turn/started', { threadId: id, turn: { id: turnId } })).toEqual([]);
    expect(mapper.map('thread/status/changed', { threadId: id, status: { type: 'idle' } })).toEqual(
      [],
    );
    expect(
      mapper.map('item/started', {
        threadId: id,
        turnId,
        item: { type: 'userMessage', id: 'u', content: [] },
      }),
    ).toEqual([]);
  });

  it('turn.failed 的说明带上 additionalDetails', () => {
    const mapper = new CodexEventMapper(id);
    const [event] = mapper.map('turn/completed', {
      threadId: id,
      turn: {
        id: turnId,
        status: 'failed',
        error: { message: 'boom', codexErrorInfo: 'other', additionalDetails: 'more' },
      },
    });
    expect(event).toEqual({
      type: 'turn.failed',
      engineSessionId: id,
      category: 'unknown',
      message: 'boom\nmore',
    });
  });
});
