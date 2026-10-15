// 支线会话（0.17.0，U23.1，codex-event-mapping.md §6.9）：真实 codex-app-server + 网关 + mock 模型。`fork` 分出的 thread
// 带着主线的历史与边界说明，主线不受影响；主线回合进行中只分到最近一个结束的回合；临时 thread 换进程后恢复不了。
// 二进制不在时跳过。

import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import { SIDE_BOUNDARY_NOTE } from './side.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  collectingLogger,
  finishTurn,
  newAdapter,
  TempDirs,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 支线会话');
const dirs = new TempDirs();
let mock: MockModel;
const adapters: CodexAdapter[] = [];

/** `[slow]` 慢慢回答（主线回合进行中分支用），其余一句话。 */
const script: MockScript = (view) =>
  view.lastUserText.includes('[slow]')
    ? { text: ['慢', '慢', '地', '答'], delayMs: 400 }
    : { text: [`收到：${view.lastUserText}`] };

const BOUNDARY_LINE = '--- Side conversation starts here ---';

async function open(home?: string) {
  const dirsMade = dirs.make('side');
  const logger = collectingLogger();
  const adapter = newAdapter({
    home: home ?? dirsMade.home,
    providers: [mockProvider(mock)],
    logger,
  });
  adapters.push(adapter);
  const config = { cwd: dirsMade.workspace, providerId: 'mock', modelId: MOCK_MODEL };
  const { engineSessionId } = await adapter.createSession(config);
  return {
    adapter,
    id: engineSessionId,
    config,
    home: home ?? dirsMade.home,
    events: collectEvents(adapter, engineSessionId),
  };
}

async function run(adapter: CodexAdapter, id: string, events: AgentEvent[], text: string) {
  const from = events.length;
  await adapter.send(id, { content: [{ type: 'text', text }] });
  return finishTurn(events, from);
}

/** 发给模型的最近一次请求里，属于这段文字所在 thread 的那一次。 */
function lastRequestWith(text: string) {
  return mock.requests.findLast((request) => JSON.stringify(request.body.input).includes(text));
}

describe.skipIf(binary === undefined)(
  'CodexAdapter 支线会话（真实 codex-app-server）',
  { timeout: 90_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel(script);
    });
    afterEach(async () => {
      await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.dispose()));
    });
    afterAll(async () => {
      await mock?.close();
      dirs.cleanup();
    });

    it('支线带着主线的历史与边界说明，回答在支线里；主线的请求里没有支线的内容', async () => {
      const { adapter, id, config, events } = await open();
      await run(adapter, id, events, '记住暗号 ALPHA-7');
      const side = await adapter.fork(id, config);
      expect(side.engineSessionId).not.toBe(id);
      const sideEvents = collectEvents(adapter, side.engineSessionId);
      const turn = await run(adapter, side.engineSessionId, sideEvents, 'btw 暗号是什么');
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      const sideRequest = lastRequestWith('btw 暗号是什么');
      const input = JSON.stringify(sideRequest?.body.input);
      expect(input).toContain('ALPHA-7');
      expect(input).toContain(BOUNDARY_LINE);
      expect(input.indexOf('ALPHA-7')).toBeLessThan(input.indexOf(BOUNDARY_LINE));
      expect(input.indexOf(BOUNDARY_LINE)).toBeLessThan(input.indexOf('btw 暗号是什么'));
      // 边界是一条 user 消息，紧跟在继承的历史后面。
      const boundary = sideRequest?.body.input.find((item) =>
        JSON.stringify(item).includes(BOUNDARY_LINE),
      );
      expect(boundary).toMatchObject({ role: 'user' });

      await run(adapter, id, events, '主线继续');
      const mainInput = JSON.stringify(lastRequestWith('主线继续')?.body.input);
      expect(mainInput).not.toContain(BOUNDARY_LINE);
      expect(mainInput).not.toContain('btw 暗号是什么');
      expect(SIDE_BOUNDARY_NOTE).toContain(BOUNDARY_LINE);
    });

    it('主线回合进行中分支：只分到最近一个结束的回合，进行中的不在支线里', async () => {
      const { adapter, id, config, events } = await open();
      await run(adapter, id, events, '第一回合 BRAVO');
      const from = events.length;
      await adapter.send(id, { content: [{ type: 'text', text: '[slow] 第二回合 CHARLIE' }] });
      // 等第二回合真的开始流式输出。
      for (
        let i = 0;
        i < 100 && !events.slice(from).some((e) => e.type === 'assistant.delta');
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const side = await adapter.fork(id, config);
      const sideEvents = collectEvents(adapter, side.engineSessionId);
      await run(adapter, side.engineSessionId, sideEvents, 'btw 刚才说了什么');
      const input = JSON.stringify(lastRequestWith('btw 刚才说了什么')?.body.input);
      expect(input).toContain('BRAVO');
      expect(input).not.toContain('CHARLIE');
      await finishTurn(events, from);
    });

    it('临时 thread 不落盘：换一个进程后恢复报 session_lost', async () => {
      const { adapter, id, config, events, home } = await open();
      await run(adapter, id, events, '你好');
      const side = await adapter.fork(id, config);
      await adapter.dispose();
      const next = newAdapter({
        home,
        providers: [mockProvider(mock)],
        logger: collectingLogger(),
      });
      adapters.push(next);
      await expect(next.resumeSession(side.engineSessionId, config)).rejects.toMatchObject({
        code: 'session_lost',
      });
      // 主线照常能恢复。
      await expect(next.resumeSession(id, config)).resolves.toMatchObject({ engineSessionId: id });
    });
  },
);
