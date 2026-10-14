// 关闭与恢复、取消的兜底（codex-event-mapping.md §4.1、§4.2）：真实 codex-app-server + 网关 + mock 模型。关闭后在同一
// 进程上恢复；进程重启（另一个适配器实例，等于 Host 重启）后恢复，下一回合的模型请求带着完整的历史；找不到与损坏的
// rollout 报 session_lost；取消得不到确认时重启进程、会话以 engine.exited（cancel_unconfirmed）脱开、之后能恢复。

import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAdapterError } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  newAdapter,
  ofType,
  runTurn,
  TempDirs,
  waitForEvent,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 恢复');
const dirs = new TempDirs();
let mock: MockModel;
const adapters: CodexAdapter[] = [];

function adapter(
  home: string,
  options: Partial<Parameters<typeof newAdapter>[0]> = {},
): CodexAdapter {
  const created = newAdapter({ home, providers: [mockProvider(mock)], ...options });
  adapters.push(created);
  return created;
}

/** 最近一次模型请求里，用户与助手说过的话（跳过 Codex 注入的 `<…>` 上下文）。 */
function conversation(): string[] {
  const input = mock.requests.at(-1)?.body.input ?? [];
  return input
    .filter(
      (item) => item.type === 'message' && (item.role === 'user' || item.role === 'assistant'),
    )
    .map((item) => JSON.stringify(item.content))
    .filter((text) => !text.includes('<environment_context>'));
}

describe.skipIf(binary === undefined)(
  'CodexAdapter 恢复与取消（真实 codex-app-server）',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel((view) => ({ text: [`收到：${view.lastUserText}`] }));
    });
    afterEach(async () => {
      await Promise.allSettled(adapters.splice(0).map((created) => created.dispose()));
    });
    afterAll(async () => {
      await mock?.close();
      dirs.cleanup();
    });

    it('关闭之后在同一个进程上恢复；进程换了之后再恢复，下一回合带着完整的历史', async () => {
      const { home, workspace } = dirs.make('resume');
      const config = { cwd: workspace, providerId: 'mock', modelId: MOCK_MODEL };
      const first = adapter(home);
      const { engineSessionId: id } = await first.createSession(config);
      await runTurn(first, id, '记住香蕉这个词', collectEvents(first, id));
      await first.close(id);

      const resumed = await first.resumeSession(id, config);
      expect(resumed).toMatchObject({ engineSessionId: id, modelId: MOCK_MODEL });
      await runTurn(first, id, '第二句', collectEvents(first, id));
      await first.dispose();

      // 新的适配器与进程（Host 重启后就是这样）：适配器不认识这个会话，照样问 Codex。
      const second = adapter(home);
      await second.resumeSession(id, config);
      const turn = await runTurn(second, id, '我让你记住的是什么？', collectEvents(second, id));
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      const history = conversation();
      expect(history.some((text) => text.includes('记住香蕉这个词'))).toBe(true);
      expect(history.some((text) => text.includes('收到：第二句'))).toBe(true);
      expect(history.at(-1)).toContain('我让你记住的是什么？');
    });

    it('找不到 rollout → session_lost（not_found，说明原因）；rollout 损坏 → session_lost（corrupted）', async () => {
      const { home, workspace } = dirs.make('lost');
      const config = { cwd: workspace, providerId: 'mock', modelId: MOCK_MODEL };
      const first = adapter(home);
      const missing = await first
        .resumeSession('019a0000-0000-7000-8000-000000000000', config)
        .catch((e: unknown) => e);
      expect(isAdapterError(missing, 'session_lost')).toBe(true);
      expect(missing).toMatchObject({ lostReason: 'not_found' });
      expect((missing as Error).message).toContain('no rollout found');
      expect((missing as Error).message).toContain('Codex 找不到这个会话的记录');

      // 一次都没对话过的会话没有 rollout：进程换了之后也是 not_found。
      const { engineSessionId: empty } = await first.createSession(config);
      const { engineSessionId: id } = await first.createSession(config);
      await runTurn(first, id, '你好', collectEvents(first, id));
      await first.dispose();
      const rollout = findFiles(join(home, 'engines', 'codex', 'sessions')).find((file) =>
        file.includes(id),
      );
      writeFileSync(rollout as string, '');

      const second = adapter(home);
      const corrupted = await second.resumeSession(id, config).catch((e: unknown) => e);
      expect(isAdapterError(corrupted, 'session_lost')).toBe(true);
      expect(corrupted).toMatchObject({ lostReason: 'corrupted' });
      const never = await second.resumeSession(empty, config).catch((e: unknown) => e);
      expect(never).toMatchObject({ code: 'session_lost', lostReason: 'not_found' });
    });

    it('取消得不到确认：报 cancel_unconfirmed，重启进程，会话以 engine.exited（cancel_unconfirmed）脱开，之后能恢复', async () => {
      const { home, workspace } = dirs.make('cancel');
      const config = { cwd: workspace, providerId: 'mock', modelId: MOCK_MODEL };
      // 时限为 0：turn/interrupt 再快也来不及，走兜底的路径。
      const slow = adapter(home, { cancelTimeoutMs: 0 });
      const { engineSessionId: id } = await slow.createSession(config);
      const { engineSessionId: other } = await slow.createSession(config);
      const events = collectEvents(slow, id);
      const otherEvents = collectEvents(slow, other);
      const pid = slow.process.pid;
      await slow.send(id, { content: [{ type: 'text', text: '说点什么' }] });
      const error = await slow.cancel(id).catch((e: unknown) => e);
      expect(isAdapterError(error, 'cancel_unconfirmed')).toBe(true);
      const exited = await waitForEvent(events, ofType('engine.exited'), 'engine.exited');
      expect(exited).toMatchObject({ reason: 'cancel_unconfirmed', exitCode: null, signal: null });
      // 挂在同一进程上的其他会话一并脱开。
      await waitForEvent(otherEvents, ofType('engine.exited'), '另一个会话的 engine.exited');
      await expect(slow.send(id, { content: [{ type: 'text', text: 'x' }] })).rejects.toMatchObject(
        {
          code: 'session_closed',
        },
      );

      await slow.resumeSession(id, config);
      expect(slow.process.pid).not.toBe(pid);
      const turn = await runTurn(slow, id, '再来一次', collectEvents(slow, id));
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    });
  },
);

function findFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? findFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
