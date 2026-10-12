// 一条命令重跑整个 Spike：
//   npm run spike          真实模型（需要 WEVIR_SPIKE_API_KEY，可选 WEVIR_SPIKE_BASE_URL / WEVIR_SPIKE_MODEL）
//   npm run spike:mock     全流程，模型换成本地脚本化 mock，不需要 Key
//   npm run spike:keyless  只跑不调用模型的协议部分
// 附加参数：--only=<step,...> 只跑指定步骤；--keep-home 不清空 .dsh-home。
// 默认从干净的 .dsh-home 开始，使冷启动的第一个样本就是首次启动；临时工作区在结束时删除。

import { rmSync } from 'node:fs';
import {
  cleanupWorkspaces,
  DSH_HOME,
  keyMissingMessage,
  realTarget,
  setTarget,
  type Target,
} from './env.ts';
import { MOCK_KEY, MOCK_MODEL, type MockLlm, setActiveMock, startMockLlm } from './mock-llm.ts';
import { failures, flushSummary } from './report.ts';
import { mockScript } from './scenarios.ts';
import { acpFlow } from './steps/acp-flow.ts';
import { checkSecrets } from './steps/check-secrets.ts';
import { concurrency } from './steps/concurrency.ts';
import { envHygiene } from './steps/env-hygiene.ts';
import { lifecycle } from './steps/lifecycle.ts';
import { measure } from './steps/measure.ts';
import { providers } from './steps/providers.ts';
import { sdkCompare } from './steps/sdk-compare.ts';
import { streamTap } from './steps/stream-tap.ts';

const argv = process.argv.slice(2);
const mode = argv.includes('--keyless') ? 'keyless' : argv.includes('--mock') ? 'mock' : 'real';
const only = argv
  .find((a) => a.startsWith('--only='))
  ?.slice('--only='.length)
  .split(',');

let target: Target | undefined;
let mock: MockLlm | undefined;
if (mode === 'real') {
  target = realTarget();
  if (target === undefined) {
    console.error(keyMissingMessage());
    process.exit(2);
  }
} else if (mode === 'mock') {
  mock = await startMockLlm(mockScript);
  setActiveMock(mock);
  target = {
    kind: 'mock',
    providerId: 'wevir-mock',
    baseURL: mock.baseURL,
    model: MOCK_MODEL,
    key: MOCK_KEY,
  };
}
if (target !== undefined) setTarget(target);
if (!argv.includes('--keep-home') && only === undefined) {
  rmSync(DSH_HOME, { recursive: true, force: true });
}

const steps: Array<[string, () => Promise<void>, boolean]> = [
  ['measure', measure, false],
  ['lifecycle', lifecycle, false],
  ['providers', providers, true],
  ['env-hygiene', envHygiene, true],
  ['acp-flow', acpFlow, true],
  ['stream-tap', streamTap, true],
  ['concurrency', concurrency, true],
  ['sdk-compare', sdkCompare, true],
  ['check-secrets', checkSecrets, false],
];

const startedAt = new Date().toISOString();
let crashed: unknown;
try {
  for (const [name, fn, needsModel] of steps) {
    if (only !== undefined && !only.includes(name) && name !== 'check-secrets') continue;
    if (needsModel && target === undefined) {
      console.log(`\n– 跳过 ${name}（--keyless）`);
      continue;
    }
    await fn();
  }
} catch (error) {
  crashed = error;
  console.error(error);
} finally {
  const removed = cleanupWorkspaces();
  await mock?.close();
  console.log(`\n已删除 ${removed} 个临时工作区。`);
}

flushSummary({
  startedAt,
  finishedAt: new Date().toISOString(),
  mode,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  target:
    target === undefined
      ? undefined
      : {
          kind: target.kind,
          providerId: target.providerId,
          baseURL: target.baseURL,
          model: target.model,
        },
  crashed: crashed === undefined ? undefined : String(crashed),
});

const failed = failures();
const ok = failed.length === 0 && crashed === undefined;
console.log(
  ok
    ? '\n全部检查通过。'
    : `\n${failed.length} 项检查失败${crashed ? '，且运行中断' : ''}，见上方 ✗。`,
);
process.exit(ok ? 0 : 1);
