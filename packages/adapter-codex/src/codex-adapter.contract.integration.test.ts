// 契约测试第 2 层（ADR-0005 决策 7）：真实 codex-app-server + 网关（Responses 透传）+ 本地 mock 模型，能力开关全开
// （capabilities.ts）。审批用例让 mock 调一次越出沙箱的 `touch`（工作区外、且不在系统临时目录，outside-dir.ts）。
// 二进制不在时跳过并打印下载命令。Codex 升级时必须重跑（docs/upstream/UPSTREAM.md「Codex 升级检查清单」）。

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll, beforeAll, describe } from 'vitest';
import { codexAdapterCapabilities } from './capabilities.js';
import type { CodexAdapter } from './codex-adapter.js';
import {
  CODEX_CONTRACT_HOOKS,
  contractScript,
  mockContractPrompts,
  trackProcesses,
} from './test-fixtures/contract.js';
import { codexBinaryOrSkip, newAdapter, TempDirs } from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';
import { makeOutsideDir } from './test-fixtures/outside-dir.js';

const binary = codexBinaryOrSkip('adapter-codex 契约第 2 层');
const dirs = new TempDirs();
// 审批用例写的文件：工作区外、且不在系统临时目录（workspace-write 对两者都不要审批）。
const outside = makeOutsideDir('contract');
const target = join(outside.dir, 'contract.txt');
let mock: MockModel;
let workspace = '';
afterAll(() => {
  outside.remove();
  dirs.cleanup();
});

describe.skipIf(binary === undefined)('真实 codex-app-server + 网关 + mock 模型', () => {
  beforeAll(async () => {
    mock = await startMockModel(contractScript(target));
    workspace = dirs.make('contract-ws').workspace;
  });
  afterAll(async () => {
    await mock?.close();
  });

  runAdapterContract(
    (): CodexAdapter => {
      // 上一条用例批准过的命令留下的文件。
      rmSync(target, { force: true });
      return trackProcesses(
        newAdapter({ home: dirs.make('contract').home, providers: [mockProvider(mock)] }),
      );
    },
    codexAdapterCapabilities,
    {
      name: 'CodexAdapter 契约（第 2 层）',
      sessionConfig: () => ({ cwd: workspace, providerId: 'mock', modelId: MOCK_MODEL }),
      prompts: mockContractPrompts(target),
      waitTimeoutMs: 20_000,
      testTimeoutMs: 60_000,
      ...CODEX_CONTRACT_HOOKS,
    },
  );
});
