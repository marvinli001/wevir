// DshAdapter 的真实 dsh 集成测试：stream-tap 插件装进 Wevir 专属 DSH_HOME，模型换成本地脚本化的 OpenAI
// 兼容服务（test-fixtures/mock-model.ts），不需要 Key。覆盖增量被已提交消息替换（含取消时补发的半段）与
// 工具调用的展示类型；错误归类见 turn-error.integration.test.ts。

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEvent,
  type AssistantDeltaEvent,
  type DeltaBlockRef,
  isTurnTerminal,
} from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter } from './dsh-adapter.js';
import {
  MOCK_KEY,
  MOCK_KEY_ENV,
  MOCK_MODEL,
  type MockReply,
  type MockRequest,
  startMockModel,
  writeMockOverlay,
} from './test-fixtures/mock-model.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `wevir-dsh-adapter-it-${label}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(script: (request: MockRequest) => MockReply) {
  const model = await startMockModel(script);
  cleanups.push(() => model.close());
  const warnings: string[] = [];
  const adapter = new DshAdapter({
    home: tempDir('home'),
    patches: [writeMockOverlay(tempDir('overlay'), model.baseURL)],
    env: { [MOCK_KEY_ENV]: MOCK_KEY },
    logger: { warn: (message) => void warnings.push(message) },
  });
  cleanups.push(() => adapter.dispose());
  const cwd = tempDir('ws');
  const { engineSessionId } = await adapter.createSession({
    cwd,
    providerId: 'wevir-test',
    modelId: MOCK_MODEL,
  });
  const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
  const turn = async (text: string, during?: (event: AgentEvent) => void) => {
    await adapter.send(engineSessionId, { content: [{ type: 'text', text }] });
    const out: AgentEvent[] = [];
    for (;;) {
      const { value, done } = await events.next();
      if (done) throw new Error('订阅在回合结束前结束');
      out.push(value);
      during?.(value);
      if (isTurnTerminal(value)) return out;
    }
  };
  return { adapter, engineSessionId, cwd, warnings, turn };
}

const deltas = (events: AgentEvent[]) =>
  events.filter((e): e is AssistantDeltaEvent => e.type === 'assistant.delta');

/** replaces 指向的块拼起来的增量文本。 */
function replacedText(events: AgentEvent[], replaces: DeltaBlockRef[]): string {
  return deltas(events)
    .filter((d) =>
      replaces.some((r) => r.attemptId === d.attemptId && r.blockIndex === d.blockIndex),
    )
    .map((d) => d.text)
    .join('');
}

describe('DshAdapter（真实 dsh + mock Provider）', () => {
  it('增量先到，已提交的思考与消息各自替换同一 attempt 的增量块', async () => {
    const reasoning = ['先想', '一想。'];
    const text = Array.from({ length: 10 }, (_, i) => `第${i + 1}句。`);
    const t = await setup(() => ({ reasoning, text, delayMs: 30 }));
    expect(t.adapter.process.streamTapState).toBe('active');
    const events = await t.turn('介绍一下西湖');

    const thought = events.find((e) => e.type === 'assistant.thought');
    const message = events.find((e) => e.type === 'assistant.message');
    expect(thought).toMatchObject({ text: reasoning.join('') });
    expect(message).toMatchObject({ text: text.join('') });
    if (thought?.type !== 'assistant.thought' || message?.type !== 'assistant.message') return;
    expect(thought.replaces).toHaveLength(1);
    expect(message.replaces).toHaveLength(1);
    expect(replacedText(events, thought.replaces)).toBe(reasoning.join(''));
    expect(replacedText(events, message.replaces)).toBe(text.join(''));
    // 增量都在已提交消息之前（之后到的被丢弃），回合终结事件最后。
    const lastDelta = events.findLastIndex((e) => e.type === 'assistant.delta');
    expect(lastDelta).toBeLessThan(events.indexOf(message));
    expect(events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    expect(t.warnings).toEqual([]);
  }, 30_000);

  it('生成中取消：dsh 一次补发已生成的半段，它替换已发出的增量，回合以 cancelled 结算', async () => {
    const text = Array.from({ length: 200 }, (_, i) => `第${i + 1}段。`);
    const t = await setup(() => ({ text, delayMs: 20 }));
    let cancelling: Promise<void> | undefined;
    const events = await t.turn('写一篇长文', (event) => {
      if (event.type === 'assistant.delta' && cancelling === undefined) {
        cancelling = new Promise((resolve) => setTimeout(resolve, 300)).then(() =>
          t.adapter.cancel(t.engineSessionId),
        );
      }
    });
    await cancelling;
    const message = events.find((e) => e.type === 'assistant.message');
    expect(message?.type).toBe('assistant.message');
    if (message?.type !== 'assistant.message') return;
    expect(message.text.length).toBeLessThan(text.join('').length);
    expect(text.join('').startsWith(message.text)).toBe(true);
    expect(message.replaces).toHaveLength(1);
    // 半段消息以已发出的增量为前缀（尾部的增量可能还在 fd 3 里，到了也被丢弃）。
    expect(message.text.startsWith(replacedText(events, message.replaces))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
  }, 30_000);

  it('工具调用：kind 恒为 other 的 tool_call 按工具名得到展示类型与路径', async () => {
    const t = await setup((request) =>
      request.messages.some((m) => m.role === 'tool')
        ? { text: ['读完了。'] }
        : { toolCall: { name: 'read', arguments: { file_path: 'notes.txt' } } },
    );
    writeFileSync(join(t.cwd, 'notes.txt'), 'hello\n');
    const events = await t.turn('读一下 notes.txt');
    expect(events.map((e) => e.type).filter((type) => type.startsWith('tool.'))).toEqual([
      'tool.started',
      'tool.finished',
    ]);
    expect(events.find((e) => e.type === 'tool.started')).toMatchObject({
      toolName: 'read',
      display: { kind: 'read', summary: 'notes.txt', paths: ['notes.txt'] },
      input: { file_path: 'notes.txt' },
    });
    expect(events.find((e) => e.type === 'tool.finished')).toMatchObject({
      status: 'completed',
      output: expect.stringContaining('hello'),
    });
  }, 30_000);
});
