// 增量（stream-tap 旁路）与 ACP 已提交消息的合并。已提交消息取自 T0.3 的录制（F、E2、todo-subagent），
// 增量按 stream-tap 的帧形状构造（test-fixtures/stream-tap/frames.sample.json），经 SessionEventQueue 走一遍。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, AssistantMessageEvent } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import { type AcpSessionNotification, isAcpSessionNotification } from './acp-mapping.js';
import { SessionEventQueue, warnOnceVia } from './session-events.js';
import { parseStreamTapLine, type StreamTapEvent, streamTapEvents } from './stream-tap.js';
import { readTranscript, type TranscriptLine } from './test-fixtures/acp-fixtures.js';

const SID = 'a96a4101-fee3-411e-b638-d9e25710d351';

function harness() {
  const warnings: string[] = [];
  const queue = new SessionEventQueue(
    SID,
    warnOnceVia({ warn: (message) => void warnings.push(message) }),
  );
  const events = queue.subscribe();
  return {
    queue,
    warnings,
    async drain(): Promise<AgentEvent[]> {
      queue.end();
      const out: AgentEvent[] = [];
      for await (const event of events) out.push(event);
      return out;
    },
  };
}

const delta = (
  attemptId: string,
  blockIndex: number,
  kind: 'text' | 'reasoning',
  text: string,
): StreamTapEvent => ({
  type: 'assistant.delta',
  engineSessionId: SID,
  attemptId,
  blockIndex,
  kind,
  text,
});

const ended = (attemptId: string, outcome: 'committed' | 'abandoned'): StreamTapEvent => ({
  type: 'assistant.stream_ended',
  engineSessionId: SID,
  attemptId,
  outcome,
});

/** 把文本按码点切成 n 片，模拟 Provider 的流式分片。 */
function pieces(text: string, n: number): string[] {
  const chars = [...text];
  const size = Math.ceil(chars.length / n);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

const textDeltas = (attemptId: string, blockIndex: number, text: string, n = 5) =>
  pieces(text, n).map((piece) => delta(attemptId, blockIndex, 'text', piece));

const chunk = (
  kind: 'agent_message_chunk' | 'agent_thought_chunk',
  messageId: string,
  text: string,
) =>
  ({
    sessionId: SID,
    update: { sessionUpdate: kind, messageId, content: { type: 'text', text } },
  }) as AcpSessionNotification;

const settled = (stopReason = 'end_turn') => ({
  type: 'turn.settled' as const,
  engineSessionId: SID,
  outcome: stopReason === 'cancelled' ? ('cancelled' as const) : ('completed' as const),
  stopReason,
});

function acpUpdates(file: string): AcpSessionNotification[] {
  return readTranscript(file)
    .filter((line) => line.dir === 'a2c' && line.msg.method === 'session/update')
    .map((line) => line.msg.params)
    .filter(isAcpSessionNotification);
}

/** agent_message_chunk / agent_thought_chunk 的文本。 */
function textOf(notification: AcpSessionNotification | undefined): string {
  const content = notification?.update.content as { text?: unknown } | undefined;
  if (typeof content?.text !== 'string') throw new Error('样本里没有这条 chunk');
  return content.text;
}

const committed = (events: AgentEvent[]) =>
  events.filter(
    (e): e is AssistantMessageEvent | Extract<AgentEvent, { type: 'assistant.thought' }> =>
      e.type === 'assistant.message' || e.type === 'assistant.thought',
  );

describe('增量被已提交消息替换', () => {
  it('F：同一 attempt 的推理块与文本块分别被 agent_thought_chunk / agent_message_chunk 替换', async () => {
    // 推理增量来自真实的旁路帧（frames.sample.json，与场景 F 同一条提示词），会话 ID 换成 F 的。
    const sample = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('./test-fixtures/stream-tap/frames.sample.json', import.meta.url)),
        'utf8',
      ),
    ) as Array<{ sessionId: string; frame: Record<string, unknown> }>;
    const attemptId = `${SID}:1`;
    // 样本是 36 帧里抽的 8 帧，文本块只抽到一片，所以只取推理增量；文本增量按 F 的已提交消息切片。
    const tapEvents = sample
      .flatMap(({ frame }) =>
        streamTapEvents(
          parseStreamTapLine(
            JSON.stringify({ type: 'frame', sessionId: SID, frame: { ...frame, attemptId } }),
          ),
        ),
      )
      .filter((e) => e.type === 'assistant.delta' && e.kind === 'reasoning');
    expect(tapEvents.map((e) => e.type === 'assistant.delta' && e.text)).toEqual([
      '简单介',
      '绍即可',
      '。',
    ]);
    const [thought, message, usage] = acpUpdates('mock/transcripts/F-stream-granularity.jsonl');
    const messageText = textOf(message);

    const h = harness();
    h.queue.beginTurn();
    for (const event of tapEvents) h.queue.streamTap(event);
    for (const event of textDeltas(attemptId, 1, messageText, 30)) h.queue.streamTap(event);
    for (const update of [thought, message, usage])
      h.queue.acpUpdate(update as AcpSessionNotification);
    h.queue.streamTap(ended(attemptId, 'committed'));
    h.queue.endTurn(settled());
    const events = await h.drain();

    expect(committed(events)).toEqual([
      expect.objectContaining({
        type: 'assistant.thought',
        text: '简单介绍即可。',
        replaces: [{ attemptId, blockIndex: 0 }],
      }),
      expect.objectContaining({
        type: 'assistant.message',
        text: messageText,
        replaces: [{ attemptId, blockIndex: 1 }],
      }),
    ]);
    expect(events.filter((e) => e.type === 'assistant.delta')).toHaveLength(
      3 + pieces(messageText, 30).length,
    );
    expect(events.at(-1)?.type).toBe('turn.settled');
    expect(h.warnings).toEqual([]);
  });

  it('E2：取消时一次补发的半段消息替换已发出的增量，前面只含空白的块一并替换，迟到的尾部丢弃', async () => {
    const [half] = acpUpdates('mock/transcripts/E2-cancel-during-generation.jsonl');
    const halfText = textOf(half);
    const attemptId = `${SID}:1`;
    const all = textDeltas(attemptId, 1, halfText, 10);
    const h = harness();
    h.queue.beginTurn();
    h.queue.streamTap(delta(attemptId, 0, 'text', '\n\n'));
    // 最后两片在 fd 3 里落在 ACP 的半段消息之后才读到。
    for (const event of all.slice(0, -2)) h.queue.streamTap(event);
    h.queue.acpUpdate(half as AcpSessionNotification);
    for (const event of all.slice(-2)) h.queue.streamTap(event);
    h.queue.streamTap(ended(attemptId, 'committed'));
    h.queue.endTurn(settled('cancelled'));
    const events = await h.drain();

    expect(committed(events)).toEqual([
      expect.objectContaining({
        text: halfText,
        replaces: [
          { attemptId, blockIndex: 0 },
          { attemptId, blockIndex: 1 },
        ],
      }),
    ]);
    // 1 个空白块 + 8 片正文；迟到的 2 片没有发出。
    expect(events.filter((e) => e.type === 'assistant.delta')).toHaveLength(9);
    expect(events.map((e) => e.type).slice(-3)).toEqual([
      'assistant.message',
      'assistant.stream_ended',
      'turn.settled',
    ]);
  });

  it('todo-subagent：一个回合多个 attempt，按会话内顺序各自配对；只有工具调用的 attempt 没有增量', async () => {
    const lines = readTranscript('mock/transcripts/todo-subagent.jsonl');
    const h = harness();
    let attempt = 0;
    for (const line of lines) {
      if (line.dir === 'c2a' && line.msg.method === 'session/prompt') h.queue.beginTurn();
      if (line.dir !== 'a2c' || !isAcpSessionNotification(line.msg.params)) continue;
      const { update } = line.msg.params;
      if (update.sessionUpdate === 'agent_message_chunk') {
        // 每条已提交消息之前，它的 attempt 先把增量写到 fd 3。
        attempt += 1;
        const text = (update.content as { text: string }).text;
        for (const event of textDeltas(`${SID}:${attempt + 10}`, 0, text, 3)) {
          h.queue.streamTap(event);
        }
      }
      h.queue.acpUpdate({ ...line.msg.params, sessionId: SID });
    }
    h.queue.endTurn(settled());
    const messages = committed(await h.drain());
    expect(messages.map((m) => [m.text, m.replaces])).toEqual([
      ['已派出子 agent，等它回报行数。', [{ attemptId: `${SID}:11`, blockIndex: 0 }]],
      ['三步都完成了。', [{ attemptId: `${SID}:12`, blockIndex: 0 }]],
    ]);
  });

  it('同一条消息有多个文本块：dsh 每块发一条 chunk，各自替换对应的块', async () => {
    const a = `${SID}:1`;
    const h = harness();
    h.queue.beginTurn();
    for (const event of textDeltas(a, 0, '先看一下目录。')) h.queue.streamTap(event);
    // 块 1 是工具调用（没有文本增量），块 2 是第二段文本。
    for (const event of textDeltas(a, 2, '然后读取文件。')) h.queue.streamTap(event);
    h.queue.acpUpdate(chunk('agent_message_chunk', 'm1', '先看一下目录。'));
    h.queue.acpUpdate(chunk('agent_message_chunk', 'm1', '然后读取文件。'));
    h.queue.endTurn(settled());
    expect(committed(await h.drain()).map((m) => m.replaces)).toEqual([
      [{ attemptId: a, blockIndex: 0 }],
      [{ attemptId: a, blockIndex: 2 }],
    ]);
  });

  it('重试：abandoned 的 attempt 不参与配对，它的 stream_ended 照发', async () => {
    const [first, second] = [`${SID}:1`, `${SID}:2`];
    const h = harness();
    h.queue.beginTurn();
    for (const event of textDeltas(first, 0, '西湖位于')) h.queue.streamTap(event);
    h.queue.streamTap(ended(first, 'abandoned'));
    for (const event of textDeltas(second, 0, '西湖位于杭州。')) h.queue.streamTap(event);
    h.queue.acpUpdate(chunk('agent_message_chunk', 'm2', '西湖位于杭州。'));
    h.queue.endTurn(settled());
    const events = await h.drain();
    expect(committed(events)[0]?.replaces).toEqual([{ attemptId: second, blockIndex: 0 }]);
    expect(events.filter((e) => e.type === 'assistant.stream_ended')).toEqual([
      ended(first, 'abandoned'),
    ]);
  });

  it('推理没有增量：思考块配不上，同一消息的文本块仍然配上', async () => {
    const a = `${SID}:1`;
    const h = harness();
    h.queue.beginTurn();
    for (const event of textDeltas(a, 1, '答案是 3。')) h.queue.streamTap(event);
    h.queue.acpUpdate(chunk('agent_thought_chunk', 'm1', '数一下行数。'));
    h.queue.acpUpdate(chunk('agent_message_chunk', 'm1', '答案是 3。'));
    // 之后新 attempt 的增量不会被当成 m1 的思考而丢掉。
    h.queue.streamTap(delta(`${SID}:2`, 0, 'reasoning', '数一下'));
    h.queue.endTurn(settled());
    const events = await h.drain();
    expect(committed(events).map((m) => m.replaces)).toEqual([
      [],
      [{ attemptId: a, blockIndex: 1 }],
    ]);
    expect(events.filter((e) => e.type === 'assistant.delta').at(-1)).toMatchObject({
      attemptId: `${SID}:2`,
    });
  });
});

describe('两条管道的到达顺序', () => {
  it('已提交消息先于全部增量到达：消息不替换任何块，这个 attempt 迟到的增量全部丢弃', async () => {
    const a = `${SID}:1`;
    const b = `${SID}:2`;
    const h = harness();
    h.queue.beginTurn();
    h.queue.acpUpdate(chunk('agent_thought_chunk', 'm1', '想一想。'));
    h.queue.acpUpdate(chunk('agent_message_chunk', 'm1', '你好。'));
    h.queue.streamTap(delta(a, 0, 'reasoning', '想一'));
    h.queue.streamTap(delta(a, 1, 'text', '你好'));
    h.queue.streamTap(ended(a, 'committed'));
    // 下一个 attempt 正常配对。
    for (const event of textDeltas(b, 0, '再见。', 2)) h.queue.streamTap(event);
    h.queue.acpUpdate(chunk('agent_message_chunk', 'm2', '再见。'));
    h.queue.endTurn(settled());
    const events = await h.drain();
    expect(events.filter((e) => e.type === 'assistant.delta').map((e) => e.attemptId)).toEqual([
      b,
      b,
    ]);
    expect(events.some((e) => e.type === 'assistant.stream_ended')).toBe(false);
    expect(committed(events).map((m) => m.replaces)).toEqual([
      [],
      [],
      [{ attemptId: b, blockIndex: 0 }],
    ]);
  });

  it('内容对不上时不替换（replaces 为空），由 Host 在回合结束时丢弃残留增量', async () => {
    const a = `${SID}:1`;
    const h = harness();
    h.queue.beginTurn();
    h.queue.streamTap(delta(a, 0, 'text', '甲乙'));
    h.queue.acpUpdate(chunk('agent_message_chunk', 'm1', '丙丁'));
    h.queue.endTurn(settled());
    expect(committed(await h.drain())[0]?.replaces).toEqual([]);
  });

  it('回合之外的增量与 stream_ended 丢弃；上一回合的 attempt 在下一回合迟到的帧也丢弃', async () => {
    const a = `${SID}:1`;
    const h = harness();
    h.queue.streamTap(delta(a, 0, 'text', '回合前'));
    h.queue.beginTurn();
    h.queue.streamTap(delta(a, 0, 'text', '你好'));
    h.queue.acpUpdate(chunk('agent_message_chunk', 'm1', '你好'));
    h.queue.endTurn(settled());
    // committed 的 end 帧晚于 session/prompt 的结果（T3.2a 实测）。
    h.queue.streamTap(ended(a, 'committed'));
    h.queue.beginTurn();
    h.queue.streamTap(delta(a, 0, 'text', '迟到'));
    h.queue.endTurn(settled());
    const events = await h.drain();
    expect(events.map((e) => e.type)).toEqual([
      'assistant.delta',
      'assistant.message',
      'turn.settled',
      'turn.settled',
    ]);
  });

  it('回合之外到达的 ACP 更新保留为 engine.raw，并告警一次', async () => {
    const h = harness();
    const late = chunk('agent_message_chunk', 'm1', '晚到的消息');
    h.queue.acpUpdate(late);
    h.queue.acpUpdate(late);
    const events = await h.drain();
    expect(events).toEqual([
      expect.objectContaining({ type: 'engine.raw', kind: 'agent_message_chunk', params: late }),
      expect.objectContaining({ type: 'engine.raw', kind: 'agent_message_chunk', params: late }),
    ]);
    expect(h.warnings).toEqual([expect.stringContaining('没有进行中的回合')]);
  });
});

it('录制里的帧都是 dsh 写出的原样（类型守卫认得每一条 session/update）', () => {
  const lines: TranscriptLine[] = readTranscript('mock/transcripts/flow-process-1.jsonl');
  const updates = lines.filter((l) => l.msg.method === 'session/update');
  expect(updates.length).toBeGreaterThan(0);
  expect(updates.every((l) => isAcpSessionNotification(l.msg.params))).toBe(true);
});
