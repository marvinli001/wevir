// 子会话（R4，codex-event-mapping.md §6.5）的录制回放：CodexAdapter 驱动 test-fixtures/fake-app-server.mjs，回放真实二进制
// 录的子 agent 样本（不等子 agent 的 subagent.jsonl、spawn → wait 的 subagent-wait.jsonl），以及把子 thread 的 turn/started 挪到 spawn_agent 完成之前的样本
// （subagent-early-child.jsonl，适配器要按 rootTurnId 当场认出它）。不需要二进制。

import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  collectEvents,
  collectingLogger,
  newAdapter,
  ofType,
  TempDirs,
  waitForEvent,
} from './test-fixtures/harness.js';
import { MOCK_MODEL, MOCK_UPSTREAM_KEY } from './test-fixtures/mock-model.js';

const FAKE_APP_SERVER = fileURLToPath(
  new URL('./test-fixtures/fake-app-server.mjs', import.meta.url),
);
const dirs = new TempDirs();
let adapters: CodexAdapter[] = [];
afterEach(async () => {
  await Promise.allSettled(adapters.map((adapter) => adapter.dispose()));
  adapters = [];
});
afterAll(() => dirs.cleanup());

async function replay(sample: string, fakeArgs: string[] = []) {
  const logger = collectingLogger();
  const adapter = newAdapter({
    home: dirs.make('subagent').home,
    binary: process.execPath,
    binaryArgs: [FAKE_APP_SERVER, ...fakeArgs],
    logger,
    providers: [
      {
        id: 'mock',
        kind: 'openai-compatible',
        displayName: 'Wevir Mock',
        api: 'openai-responses',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
        defaultModelId: MOCK_MODEL,
        apiKey: MOCK_UPSTREAM_KEY,
      },
    ],
  });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: dirs.make('subagent-ws').workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
  });
  const parent = collectEvents(adapter, engineSessionId);
  await adapter.send(engineSessionId, { content: [{ type: 'text', text: `replay:${sample}` }] });
  const started = await waitForEvent(parent, ofType('subagent.started'), 'subagent.started');
  const child = collectEvents(adapter, started.childEngineSessionId);
  await waitForEvent(child, ofType('turn.settled'), '子会话的回合结束');
  await waitForEvent(parent, ofType('turn.settled'), '父会话的回合结束');
  return { adapter, engineSessionId, parent, started, child, logger };
}

function checkChild(events: AgentEvent[], childId: string): void {
  expect(events.every((event) => event.engineSessionId === childId)).toBe(true);
  expect(events[0]).toEqual({
    type: 'turn.started',
    engineSessionId: childId,
    input: [{ type: 'text', text: 'Helper task\nSay that you are done.' }],
  });
  expect(events.filter(ofType('assistant.delta')).map((e) => e.text)).toEqual(['Helper', ' done.']);
  expect(events.find(ofType('assistant.message'))?.text).toBe('Helper done.');
  expect(events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
}

describe.each(['subagent', 'subagent-wait', 'subagent-early-child'])(
  '子会话的录制回放：%s',
  (sample) => {
    it('父会话的流里报出子会话，子 thread 的通知按子会话上报', async () => {
      const { engineSessionId, parent, started, child, logger } = await replay(sample);
      const spawn = parent.find(ofType('tool.started'));
      expect(spawn).toMatchObject({
        toolName: 'collabAgentToolCall.spawnAgent',
        display: { kind: 'sub_agent', summary: 'Helper task' },
      });
      expect(started).toEqual({
        type: 'subagent.started',
        engineSessionId,
        childEngineSessionId: started.childEngineSessionId,
        parentToolCallId: spawn?.toolCallId,
        title: 'Helper task',
        prompt: 'Helper task\nSay that you are done.',
        // 按 rootTurnId 先认出时，spawn 还在进行中，模型还是空的，用父会话的。
        modelId: MOCK_MODEL,
        reasoningEffort: 'medium',
      });
      expect(started.childEngineSessionId).not.toBe(engineSessionId);
      // R2 的 engine.raw（child_thread）没有了；父会话的流里只有父会话的事件。
      expect(
        parent.some((event) => event.type === 'engine.raw' && event.kind === 'child_thread'),
      ).toBe(false);
      expect(parent.every((event) => event.engineSessionId === engineSessionId)).toBe(true);
      checkChild(child, started.childEngineSessionId);
      // 假的 app-server 不支持 thread/read：昵称从缺，只告警一次，不影响子会话。
      expect(parent.some((event) => event.type === 'subagent.updated')).toBe(false);
      expect(
        logger.warnings.filter((w) => w.startsWith('读子 agent 的 thread 信息失败')),
      ).toHaveLength(1);
      expect(logger.warnings.some((w) => w.includes('没有认出来的 thread'))).toBe(false);
    });
  },
);

it('thread/read 先碰上子 thread 的 rollout 还是空的（-32603）：重试到读出来，昵称照样补上', async () => {
  const { parent, started, logger } = await replay('subagent', ['--thread-read-empty', '2']);
  const updated = await waitForEvent(parent, ofType('subagent.updated'), 'subagent.updated');
  expect(updated).toMatchObject({
    childEngineSessionId: started.childEngineSessionId,
    nickname: 'Ampere',
  });
  expect(logger.warnings.some((w) => w.startsWith('读子 agent 的 thread 信息失败'))).toBe(false);
});

describe('子会话的约束', () => {
  it('子会话不接受 send；可以订阅、列未决审批', async () => {
    const { adapter, started } = await replay('subagent');
    const childId = started.childEngineSessionId;
    await expect(
      adapter.send(childId, { content: [{ type: 'text', text: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await adapter.listPendingApprovals(childId)).toEqual([]);
    // 回合已结束：cancel 是无操作。
    await adapter.cancel(childId);
  });
});
