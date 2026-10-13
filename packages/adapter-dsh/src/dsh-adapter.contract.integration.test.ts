// T3.6 契约测试第 2 层：真实 dsh + 本地 mock Provider（test-fixtures/mock-model.ts，照 T0.3 spike 的 mock-llm 重写），
// 不需要 Key。Provider 经 DshAdapter 的 Provider 桥接（T3.4）交给 dsh，增量旁路（T3.2a）开启，端到端覆盖工具、
// 审批（工作区外写入的沙箱升级，T3.3）、取消、resume（T3.5）与增量。每条用例一个新的 DSH_HOME 与 dsh 进程。
// 是否进 CI 由 T6.2 按耗时决定。dsh 升级时必须重跑（docs/upstream/UPSTREAM.md §7）：增量旁路依赖的
// agent/assistant-stream 不是 dsh 的公开契约。

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll, beforeAll } from 'vitest';
import { dshAdapterCapabilities } from './capabilities.js';
import { DshAdapter } from './dsh-adapter.js';
import {
  contractScript,
  DSH_CONTRACT_HOOKS,
  mockContractPrompts,
  mockProvider,
  tempRoot,
  trackProcesses,
} from './test-fixtures/contract.js';
import { MOCK_MODEL, type MockModel, startMockModel } from './test-fixtures/mock-model.js';
import { makeOutsideDir } from './test-fixtures/outside-dir.js';

const temp = tempRoot('mock');
// 审批用例写的文件：工作区外、且不在系统临时目录（dsh 的 workspace-write 对两者都不要审批，T0.3 场景 B0）。
const outside = makeOutsideDir('contract');
const target = join(outside.dir, 'contract.txt');
let model: MockModel;
beforeAll(async () => {
  model = await startMockModel(contractScript);
});
afterAll(async () => {
  await model?.close();
  outside.remove();
  temp.remove();
});

runAdapterContract(
  () => {
    // 上一条用例批准过的写入留下的文件。
    rmSync(target, { force: true });
    return trackProcesses(
      new DshAdapter({
        home: temp.dir('home'),
        providers: [mockProvider(model.baseURL)],
        logger: { warn: () => {} },
      }),
    );
  },
  // 旁路开启：要求它在 dsh 里真的生效（active），增量条款不跳过；插件没加载时该条款失败。
  dshAdapterCapabilities('active'),
  {
    name: 'DshAdapter 契约（第 2 层：真实 dsh + mock Provider）',
    sessionConfig: () => ({ cwd: temp.dir('ws'), providerId: 'wevir-test', modelId: MOCK_MODEL }),
    prompts: mockContractPrompts(target),
    waitTimeoutMs: 20_000,
    testTimeoutMs: 60_000,
    ...DSH_CONTRACT_HOOKS,
  },
);
