// 契约测试第 3 层（ADR-0005 决策 7）：真实 codex-app-server + 网关 + 真实模型。要同时设 WEVIR_TEST_API_KEY 与
// WEVIR_TEST_PROVIDER（见 test-fixtures/real-model.ts 的 realProviderFromEnv），否则整层跳过并打印原因；二进制不在时
// 同样跳过。Key 只交给 Host 进程里的网关，不进 Codex 的环境与 CODEX_HOME。不在 CI 里跑；Codex 升级时在本机跑一次
// （docs/upstream/UPSTREAM.md「Codex 升级检查清单」）。
//
//   WEVIR_TEST_API_KEY=… WEVIR_TEST_PROVIDER=deepseek-official \
//     pnpm vitest run --project adapter-codex src/codex-adapter.contract.real.integration.test.ts
//
// 审批条款依赖模型按提示词申请越出沙箱（require_escalated），与 dsh 第 3 层相同（ADR-0001 未决事项 3）。

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll, describe, it } from 'vitest';
import { codexAdapterCapabilities } from './capabilities.js';
import {
  CODEX_CONTRACT_HOOKS,
  realContractPrompts,
  trackProcesses,
} from './test-fixtures/contract.js';
import { codexBinaryOrSkip, newAdapter, TempDirs } from './test-fixtures/harness.js';
import { makeOutsideDir } from './test-fixtures/outside-dir.js';
import { realProviderFromEnv } from './test-fixtures/real-model.js';

const NAME = 'CodexAdapter 契约（第 3 层：真实 codex-app-server + 真实模型）';
const real = realProviderFromEnv();
const binary = 'skip' in real ? undefined : codexBinaryOrSkip('adapter-codex 契约第 3 层');

if ('skip' in real || binary === undefined) {
  const reason = 'skip' in real ? real.skip : 'codex-app-server 不在（见上面的下载命令）';
  process.stderr.write(`[adapter-codex] 跳过${NAME}：${reason}\n`);
  describe(NAME, () => {
    it.skip(reason, () => {});
  });
} else {
  const { provider, modelId } = real;
  const dirs = new TempDirs();
  const workspace = dirs.make('contract-real-ws').workspace;
  const outside = makeOutsideDir('contract-real');
  const target = join(outside.dir, 'contract.txt');
  afterAll(() => {
    outside.remove();
    dirs.cleanup();
  });

  runAdapterContract(
    () => {
      rmSync(target, { force: true });
      // 真实模型保留 Codex 自己的重试（429、5xx），不用 harness 关掉重试的 providerExtra。
      return trackProcesses(
        newAdapter({
          home: dirs.make('contract-real').home,
          providers: [provider],
          providerExtra: {},
        }),
      );
    },
    codexAdapterCapabilities,
    {
      name: `${NAME}：${provider.id} / ${modelId}`,
      sessionConfig: () => ({ cwd: workspace, providerId: provider.id, modelId }),
      prompts: realContractPrompts(target),
      waitTimeoutMs: 180_000,
      testTimeoutMs: 600_000,
      ...CODEX_CONTRACT_HOOKS,
    },
  );
}
