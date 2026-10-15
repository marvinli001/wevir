// 会话中换模型与推理档位（0.9.0，codex-event-mapping.md §4.6）、权限模式（0.11.0，§4.7）与协作模式（0.36.0，§4.10）：
// CodexAdapter 驱动 test-fixtures/fake-app-server.mjs，核对之后的 turn/start 带上 model、effort、审批、审查方、沙箱与
// collaborationMode。不需要二进制。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  collectEvents,
  collectingLogger,
  finishTurn,
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

/** fake-app-server 在 CODEX_HOME 下写的文件（按目录找）。 */
function findFile(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    }
  }
  return undefined;
}

/** fake-app-server 记下的 turn/start。 */
function turnStarts(home: string): {
  model?: string;
  effort?: string | null;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandboxPolicy?: { type: string };
  collaborationMode?: {
    mode: string;
    settings: {
      model: string;
      reasoning_effort: string | null;
      developer_instructions: string | null;
    };
  };
}[] {
  const file = findFile(home, 'fake-turn-starts.jsonl');
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

  it('每个 turn/start 按权限模式带审批策略、审查方与沙箱；建会话、resume 与 configureSession 都能定', async () => {
    const { home } = dirs.make('permissions');
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
          models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
          defaultModelId: MOCK_MODEL,
          apiKey: MOCK_UPSTREAM_KEY,
        },
      ],
    });
    adapters.push(adapter);
    const config = {
      cwd: dirs.make('permissions-ws').workspace,
      providerId: 'mock',
      modelId: MOCK_MODEL,
    };
    const { engineSessionId } = await adapter.createSession({
      ...config,
      permissionMode: 'full_access',
    });
    const events = collectEvents(adapter, engineSessionId);
    const turn = (text: string) => runTurn(adapter, engineSessionId, text, events);

    await turn('one');
    await adapter.configureSession(engineSessionId, {
      modelId: MOCK_MODEL,
      permissionMode: 'auto_review',
    });
    await turn('two');
    await adapter.configureSession(engineSessionId, { modelId: MOCK_MODEL });
    await turn('three');

    const settings = turnStarts(home).map(
      ({ approvalPolicy, approvalsReviewer, sandboxPolicy }) => ({
        approvalPolicy,
        approvalsReviewer,
        sandbox: sandboxPolicy?.type,
      }),
    );
    expect(settings).toEqual([
      { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'dangerFullAccess' },
      { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspaceWrite' },
      { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspaceWrite' },
    ]);
  });

  it('协作模式（0.36.0）：initialize 开实验面；每个 turn/start 都带 collaborationMode，计划回合用 plan-mode.md，settings 跟着会话的模型与档位', async () => {
    const { home } = dirs.make('collaboration');
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
            { id: MOCK_MODEL, contextWindow: 128_000, reasoningEfforts: ['low', 'high'] },
            { id: 'mock-large', contextWindow: 256_000, reasoningEfforts: ['off', 'high'] },
          ],
          defaultModelId: MOCK_MODEL,
          apiKey: MOCK_UPSTREAM_KEY,
        },
      ],
    });
    adapters.push(adapter);
    expect(adapter.planMode).toBe(true);
    const { engineSessionId } = await adapter.createSession({
      cwd: dirs.make('collaboration-ws').workspace,
      providerId: 'mock',
      modelId: MOCK_MODEL,
      reasoningEffort: 'low',
    });
    const events = collectEvents(adapter, engineSessionId);
    const send = async (text: string, collaborationMode?: 'plan' | 'default') => {
      const from = events.length;
      await adapter.send(engineSessionId, {
        content: [{ type: 'text', text }],
        ...(collaborationMode !== undefined && { collaborationMode }),
      });
      return finishTurn(events, from);
    };

    await send('one', 'plan');
    await send('two');
    await adapter.configureSession(engineSessionId, {
      modelId: 'mock-large',
      reasoningEffort: 'off',
    });
    await send('three', 'plan');
    await adapter.configureSession(engineSessionId, { modelId: MOCK_MODEL });
    await send('four', 'default');

    const initialize = JSON.parse(
      readFileSync(findFile(home, 'fake-initialize.json') as string, 'utf8'),
    ) as { capabilities: { experimentalApi: boolean } };
    expect(initialize.capabilities.experimentalApi).toBe(true);

    const modes = turnStarts(home).map(({ collaborationMode }) => collaborationMode);
    expect(modes.map((mode) => mode?.mode)).toEqual(['plan', 'default', 'plan', 'default']);
    expect(modes.map((mode) => mode?.settings.model)).toEqual([
      MOCK_MODEL,
      MOCK_MODEL,
      'mock-large',
      MOCK_MODEL,
    ]);
    expect(modes.map((mode) => mode?.settings.reasoning_effort)).toEqual([
      'low',
      'low',
      'none',
      null,
    ]);
    // 计划回合：经网关的模型用 Wevir 的 plan-mode.md（去掉注释、渲染后的）；默认回合用 Codex 内置的说明（null）。
    const plan = modes[0]?.settings.developer_instructions ?? '';
    expect(plan.startsWith('# 协作模式：计划')).toBe(true);
    expect(plan).toContain('<proposed_plan>');
    expect(plan).not.toContain('<!--');
    expect(modes[2]?.settings.developer_instructions).toBe(plan);
    expect(modes.filter((_, index) => index % 2 === 1).map((mode) => mode?.settings)).toEqual([
      expect.objectContaining({ developer_instructions: null }),
      expect.objectContaining({ developer_instructions: null }),
    ]);
  });
});
