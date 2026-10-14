import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll, beforeAll, describe } from 'vitest';
import { codexAdapterCapabilities } from './capabilities.js';
import type { CodexAdapter } from './codex-adapter.js';
import { codexBinaryOrSkip, newAdapter, TempDirs } from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

// 契约测试第 2 层（ADR-0005 决策 7）：真实 codex-app-server + 网关（Responses 透传）+ 本地 mock 模型。审批与恢复在 R3
// 打开（capabilities.ts）。二进制不在时跳过并打印下载命令。

const binary = codexBinaryOrSkip('adapter-codex 契约第 2 层');
const dirs = new TempDirs();
let mock: MockModel;
let workspace = '';

describe.skipIf(binary === undefined)('真实 codex-app-server + 网关 + mock 模型', () => {
  beforeAll(async () => {
    mock = await startMockModel();
    workspace = dirs.make('contract-ws').workspace;
  });
  afterAll(async () => {
    await mock?.close();
    dirs.cleanup();
  });

  runAdapterContract(
    (): CodexAdapter =>
      newAdapter({ home: dirs.make('contract').home, providers: [mockProvider(mock)] }),
    codexAdapterCapabilities,
    {
      name: 'CodexAdapter 契约（第 2 层）',
      sessionConfig: () => ({ cwd: workspace, providerId: 'mock', modelId: MOCK_MODEL }),
      waitTimeoutMs: 20_000,
      testTimeoutMs: 60_000,
      simulateEngineExit: async (adapter) => {
        const pid = adapter.process.pid;
        if (pid === undefined) throw new Error('codex-app-server 没有在运行');
        process.kill(pid, 'SIGKILL');
      },
      resourcesReleased: (adapter) =>
        adapter.process.pid === undefined &&
        adapter.process.state === 'disposed' &&
        adapter.gateway === undefined,
    },
  );
});
