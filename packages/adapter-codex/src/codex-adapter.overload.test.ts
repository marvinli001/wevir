// 容量不足时自动续跑（`policyCapacityUnavailable`，rust-v0.166.0 起才有的 codexErrorInfo）：CodexAdapter 驱动
// test-fixtures/fake-app-server.mjs，回放临时写下的失败回合，不需要二进制，不依赖锁定的 Codex 版本是否会报这一类。

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import { collectEvents, newAdapter, ofType, runTurn, TempDirs } from './test-fixtures/harness.js';
import { MOCK_MODEL, MOCK_UPSTREAM_KEY } from './test-fixtures/mock-model.js';

const FAKE_APP_SERVER = fileURLToPath(
  new URL('./test-fixtures/fake-app-server.mjs', import.meta.url),
);
const RECORDED = fileURLToPath(new URL('./test-fixtures/app-server/', import.meta.url));
const MESSAGE = 'Policy-restricted capacity is unavailable. Please try again later.';
const dirs = new TempDirs();
let adapters: CodexAdapter[] = [];
afterEach(async () => {
  await Promise.allSettled(adapters.map((adapter) => adapter.dispose()));
  adapters = [];
});
afterAll(() => dirs.cleanup());

/** 样本目录：`capacity` 是以 `policyCapacityUnavailable` 失败的回合，续跑的空输入回放录下的 `stream`。 */
function fixtures(root: string): string {
  const dir = join(root, 'fixtures');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(RECORDED, 'stream.jsonl'), join(dir, 'stream.jsonl'));
  const thread = 'thread-1';
  const turn = { id: 'turn-1', items: [], status: 'inProgress', error: null };
  const error = {
    message: MESSAGE,
    codexErrorInfo: 'policyCapacityUnavailable',
    additionalDetails: null,
  };
  const lines = [
    { method: 'turn/started', params: { threadId: thread, turn } },
    { method: 'error', params: { error, willRetry: false, threadId: thread, turnId: turn.id } },
    {
      method: 'turn/completed',
      params: { threadId: thread, turn: { ...turn, status: 'failed', error } },
    },
  ];
  writeFileSync(join(dir, 'capacity.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n'));
  return dir;
}

describe('CodexAdapter 容量不足时续跑', () => {
  it('policyCapacityUnavailable 与 serverOverloaded 一样报 turn.retrying，空输入续跑后回合完成', async () => {
    const { home, workspace } = dirs.make('capacity');
    const adapter = newAdapter({
      home,
      binary: process.execPath,
      binaryArgs: [FAKE_APP_SERVER, '--fixtures', fixtures(home)],
      overloadRetry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 },
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
    const turn = await runTurn(adapter, engineSessionId, 'replay:capacity', events);
    expect(turn.filter(ofType('turn.retrying'))).toEqual([
      {
        type: 'turn.retrying',
        engineSessionId,
        attempt: 1,
        maxAttempts: 2,
        reason: MESSAGE,
      },
    ]);
    expect(turn.filter(ofType('turn.failed'))).toEqual([]);
    expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  });
});
