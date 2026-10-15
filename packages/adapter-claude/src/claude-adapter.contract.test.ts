// 第 1 层契约：假的 Claude Agent SDK 回放真实录音（test-fixtures/sdk/，审批按决定走对应录音的分支；中断、插话、子 agent 的审批
// 与慢回合是照真实消息形状拼的脚本）。真实 `claude` 上的一遍在 claude-adapter.contract.real.integration.test.ts。

import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll } from 'vitest';
import { claudeAdapterCapabilities } from './capabilities.js';
import { newFakeAdapter, removeHome } from './test-fixtures/harness.js';

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) removeHome(home);
});

runAdapterContract(
  () => {
    const { adapter, home } = newFakeAdapter();
    homes.push(home);
    return adapter;
  },
  claudeAdapterCapabilities,
  {
    name: 'Claude 适配器契约（假 SDK 回放）',
    sessionConfig: { cwd: process.cwd(), providerId: 'claude', modelId: 'claude-haiku-4-5' },
  },
);
