// AgentRuntimeAdapter 契约（runtime-adapter 的 ./contract）跑在假 SDK 上（test-fixtures/fake-sdk.ts：提示词选回放脚本）。
// 真实的 Cursor 回合要账号，见 docs/architecture/cursor-event-mapping.md §8 的手动验证步骤。
// Cursor 的 SDK 没有审批、没有可订阅的子 agent 会话、没有插话，这三组条款跳过。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll } from 'vitest';
import { CursorAdapter } from './cursor-adapter.js';
import { FakeCursorSdk } from './test-fixtures/fake-sdk.js';

const home = mkdtempSync(join(tmpdir(), 'wevir-cursor-contract-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

runAdapterContract(
  () => {
    const sdk = new FakeCursorSdk();
    return new CursorAdapter({
      home,
      env: { CURSOR_API_KEY: 'contract-key' },
      sdk: async () => sdk,
    });
  },
  {
    incrementalStream: true,
    toolCalls: true,
    approvals: false,
    resume: true,
    concurrentSessions: true,
    subagents: false,
    steer: false,
  },
  {
    name: 'CursorAdapter 契约（假 SDK）',
    sessionConfig: () => ({ cwd: home, providerId: 'cursor', modelId: 'auto' }),
  },
);
