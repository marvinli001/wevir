// 会话中换模型与推理档位（0.9.0，codex-event-mapping.md §4.6）：CodexAdapter 驱动 test-fixtures/fake-app-server.mjs，
// 核对之后的 turn/start 带上 model 与 effort。不需要二进制。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  collectEvents,
  collectingLogger,
  newAdapter,
  runTurn,
  TempDirs,
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

/** fake-app-server 记下的 turn/start（在 CODEX_HOME 下，按目录找）。 */
function turnStarts(home: string): { model?: string; effort?: string | null }[] {
  const find = (dir: string): string | undefined => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name === 'fake-turn-starts.jsonl') return path;
      if (entry.isDirectory()) {
        const found = find(path);
        if (found) return found;
      }
    }
    return undefined;
  };
  const file = find(home);
  if (!file) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('CodexAdapter.configureSession', () => {
  it('之后的 turn/start 带 model 与 effort；没换过时不带；Provider 没有的模型报 invalid_input', async () => {
    const { home } = dirs.make('configure');
    const adapter = newAdapter({
      home,
      binary: process.execPath,
      binaryArgs: [FAKE_APP_SERVER],
      logger: collectingLogger(),
      providers: [
        {
          id: 'mock',
          kind: 'openai-compatible',
          displayName: 'Wevir Mock',
          api: 'openai-responses',
          baseURL: 'http://127.0.0.1:9/v1',
          models: [
            { id: MOCK_MODEL, contextWindow: 128_000 },
            { id: 'mock-large', contextWindow: 256_000, reasoningEfforts: ['off', 'high'] },
          ],
          defaultModelId: MOCK_MODEL,
          apiKey: MOCK_UPSTREAM_KEY,
        },
      ],
    });
    adapters.push(adapter);
    const { engineSessionId } = await adapter.createSession({
      cwd: dirs.make('configure-ws').workspace,
      providerId: 'mock',
      modelId: MOCK_MODEL,
    });
    const events = collectEvents(adapter, engineSessionId);
    const turn = (text: string) => runTurn(adapter, engineSessionId, text, events);

    await turn('one');
    await adapter.configureSession(engineSessionId, {
      modelId: 'mock-large',
      reasoningEffort: 'off',
    });
    await turn('two');
    await adapter.configureSession(engineSessionId, { modelId: MOCK_MODEL });
    await turn('three');

    expect(turnStarts(home).map(({ model, effort }) => ({ model, effort }))).toEqual([
      { model: undefined, effort: undefined },
      { model: 'mock-large', effort: 'none' },
      { model: MOCK_MODEL, effort: null },
    ]);
    await expect(
      adapter.configureSession(engineSessionId, { modelId: 'missing' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
