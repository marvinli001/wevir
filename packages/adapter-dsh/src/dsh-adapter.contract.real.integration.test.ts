// T3.6 契约测试第 3 层：真实 dsh + 真实模型。要同时设 WEVIR_TEST_API_KEY 与 WEVIR_TEST_PROVIDER（见
// test-fixtures/real-model.ts 的 realProviderFromEnv），否则整层跳过并打印原因。Key 只进 dsh 的子进程环境。
// 不在 CI 里跑（T6.2）；dsh 升级时在本机跑一次（docs/upstream/UPSTREAM.md §7）。
//
//   WEVIR_TEST_API_KEY=… WEVIR_TEST_PROVIDER=deepseek-official \
//     pnpm vitest run --project adapter-dsh src/dsh-adapter.contract.real.integration.test.ts
//
// 审批条款依赖模型按沙箱提示升级（ADR-0001 未决事项 3），提示词与 T3.3 相同。

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll, describe, it } from 'vitest';
import { dshAdapterCapabilities } from './capabilities.js';
import { DshAdapter } from './dsh-adapter.js';
import {
  DSH_CONTRACT_HOOKS,
  realContractPrompts,
  tempRoot,
  trackProcesses,
} from './test-fixtures/contract.js';
import { makeOutsideDir } from './test-fixtures/outside-dir.js';
import { realProviderFromEnv } from './test-fixtures/real-model.js';

const NAME = 'DshAdapter 契约（第 3 层：真实 dsh + 真实模型）';
const real = realProviderFromEnv();

if ('skip' in real) {
  process.stderr.write(`[adapter-dsh] 跳过${NAME}：${real.skip}\n`);
  describe(NAME, () => {
    it.skip(real.skip, () => {});
  });
} else {
  const { provider, modelId } = real;
  const temp = tempRoot('real');
  const outside = makeOutsideDir('contract-real');
  const target = join(outside.dir, 'contract.txt');
  afterAll(() => {
    outside.remove();
    temp.remove();
  });

  runAdapterContract(
    () => {
      rmSync(target, { force: true });
      return trackProcesses(
        new DshAdapter({
          home: temp.dir('home'),
          providers: [provider],
          logger: { warn: () => {} },
        }),
      );
    },
    dshAdapterCapabilities('active'),
    {
      name: `${NAME}：${provider.id} / ${modelId}`,
      sessionConfig: () => ({ cwd: temp.dir('ws'), providerId: provider.id, modelId }),
      prompts: realContractPrompts(target),
      waitTimeoutMs: 180_000,
      testTimeoutMs: 600_000,
      ...DSH_CONTRACT_HOOKS,
    },
  );
}
