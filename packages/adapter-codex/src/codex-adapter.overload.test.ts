// 容量不足时自动续跑（`policyCapacityUnavailable`，rust-v0.166.0 起才有的 codexErrorInfo）：CodexAdapter 驱动
// test-fixtures/fake-app-server.mjs，回放临时写下的失败回合，不需要二进制，不依赖锁定的 Codex 版本是否会报这一类。

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import { CodexRpcError } from './codex-process.js';
import { collectEvents, newAdapter, ofType, runTurn, TempDirs } from './test-fixtures/harness.js';
import { MOCK_MODEL, MOCK_UPSTREAM_KEY, mockProvider } from './test-fixtures/mock-model.js';

const FAKE_APP_SERVER = fileURLToPath(
  new URL('./test-fixtures/fake-app-server.mjs', import.meta.url),
);
const RECORDED = fileURLToPath(new URL('./test-fixtures/app-server/', import.meta.url));
const MESSAGE = 'Policy-restricted capacity is unavailable. Please try again later.';
const dirs = new TempDirs();
let adapters: CodexAdapter[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
    await expectContinued([]);
  });

  it('失败回合的通知先于 turn/start 的结果处理完：续跑照样开新回合，不把失败的回合 ID 记回去', async () => {
    await expectContinued(['--notify-before-result']);
  });

  it.each([
    {
      data: { type: 'modelProviderNotConfigured', modelProvider: 'wevir_deleted' },
      category: 'provider',
      message: '服务商已删除',
    },
    {
      data: {
        type: 'modelProviderMismatch',
        modelProvider: 'wevir_a',
        currentModelProvider: 'wevir_b',
      },
      category: 'unknown',
      message: '路由异常',
    },
  ])('续跑收到 $data.type 时报告新原因，不复用容量失败', async ({ data, category, message }) => {
    const { home, workspace } = dirs.make('capacity-provider');
    const adapter = newAdapter({
      home,
      binary: process.execPath,
      binaryArgs: [FAKE_APP_SERVER, '--fixtures', fixtures(home)],
      providers: [mockProvider({ baseURL: 'http://127.0.0.1:9/v1' })],
      overloadRetry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 },
    });
    adapters.push(adapter);
    const { engineSessionId } = await adapter.createSession({
      cwd: workspace,
      providerId: 'mock',
      modelId: MOCK_MODEL,
    });
    const original = adapter.process.request.bind(adapter.process);
    vi.spyOn(adapter.process, 'request').mockImplementation(
      async <T>(method: string, params: unknown): Promise<T> => {
        const input = (params as { input?: unknown[] }).input;
        if (method === 'turn/start' && input?.length === 0)
          throw new CodexRpcError(method, {
            code: -32600,
            message: 'native provider failure',
            data,
          });
        return original<T>(method, params);
      },
    );
    const turn = await runTurn(
      adapter,
      engineSessionId,
      'replay:capacity',
      collectEvents(adapter, engineSessionId),
    );
    expect(turn.at(-1)).toMatchObject({
      type: 'turn.failed',
      category,
      message: expect.stringContaining(message),
    });
    expect(turn.at(-1)).not.toMatchObject({ message: MESSAGE });
  });
});

/** 以 `policyCapacityUnavailable` 失败一次，续跑回放录下的 `stream`：报一次 turn.retrying，回合正常完成。 */
async function expectContinued(fakeArgs: string[]): Promise<void> {
  const { home, workspace } = dirs.make('capacity');
  const adapter = newAdapter({
    home,
    binary: process.execPath,
    binaryArgs: [FAKE_APP_SERVER, '--fixtures', fixtures(home), ...fakeArgs],
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
}
