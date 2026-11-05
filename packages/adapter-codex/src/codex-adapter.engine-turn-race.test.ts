// send 在同步插件、检查登录的时候 Codex 自己开了回合（目标续跑）：并进那个回合，不报 session_busy。CodexAdapter 驱动
// test-fixtures/fake-app-server.mjs 的 `--engine-turn`，不需要二进制。

import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import { CodexPlugins } from './plugins.js';
import {
  collectEvents,
  newAdapter,
  ofType,
  runTurn,
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
  vi.restoreAllMocks();
  await Promise.allSettled(adapters.map((adapter) => adapter.dispose()));
  adapters = [];
});
afterAll(() => dirs.cleanup());

describe('CodexAdapter 发送途中引擎自己开了回合', () => {
  it('插件同步时 Codex 开了回合：send 并进它，不报 session_busy', async () => {
    const { home, workspace } = dirs.make('engine-turn-race');
    const adapter = newAdapter({
      home,
      binary: process.execPath,
      binaryArgs: [FAKE_APP_SERVER, '--engine-turn', 'approval-exec'],
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
      cwd: workspace,
      providerId: 'mock',
      modelId: MOCK_MODEL,
    });
    const events = collectEvents(adapter, engineSessionId);
    await runTurn(adapter, engineSessionId, 'Say hello', events);

    // 第二次发送卡在插件同步上，直到 Codex 自己开的回合停在审批上（回合还在进行）。
    const from = events.length;
    const sync = CodexPlugins.prototype.sync;
    vi.spyOn(CodexPlugins.prototype, 'sync').mockImplementation(async function (
      this: CodexPlugins,
      cwd?: string,
    ) {
      await waitForEvent(events, ofType('approval.requested'), '引擎回合里的审批', from);
      return sync.call(this, cwd);
    });
    await expect(
      adapter.send(engineSessionId, { content: [{ type: 'text', text: 'Next' }] }),
    ).resolves.toBeUndefined();
    expect(events.slice(from).filter(ofType('turn.started'))).toHaveLength(1);
    const approval = events.slice(from).find(ofType('approval.requested'));
    await adapter.respondToApproval(engineSessionId, approval?.requestId ?? '', {
      optionId: 'accept',
    });
    const settled = await waitForEvent(events, ofType('turn.settled'), '回合结束', from);
    expect(settled).toMatchObject({ outcome: 'completed' });
    expect(events.slice(from).filter(ofType('turn.failed'))).toEqual([]);
  });
});
