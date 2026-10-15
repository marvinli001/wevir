// AgentRuntimeAdapter 契约（runtime-adapter 的 ./contract）跑在假的 opencode 上（test-fixtures/fake-opencode.ts：按提示词回放真实
// opencode 录下的事件）。真实 opencode 上的同一套契约见 opencode-adapter.contract.real.integration.test.ts。插话回放录音 steer
// （慢回答的第 3 个增量处插话，fake-opencode.ts 在 action 行上换过去）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll } from 'vitest';
import { OpenCodeAdapter } from './opencode-adapter.js';
import { FakeOpenCode } from './test-fixtures/fake-opencode.js';
import { fakeAdapterOptions } from './test-fixtures/harness.js';

const home = mkdtempSync(join(tmpdir(), 'wevir-opencode-contract-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const fakes = new WeakMap<OpenCodeAdapter, FakeOpenCode>();

runAdapterContract(
  () => {
    const fake = new FakeOpenCode();
    const adapter = new OpenCodeAdapter(fakeAdapterOptions(fake, home));
    fakes.set(adapter, fake);
    return adapter;
  },
  {
    incrementalStream: true,
    toolCalls: true,
    approvals: true,
    resume: true,
    concurrentSessions: true,
    subagents: true,
    steer: true,
  },
  {
    name: 'OpenCodeAdapter 契约（假 opencode）',
    sessionConfig: () => ({ cwd: home, providerId: 'opencode', modelId: 'mock/echo' }),
    simulateEngineExit: async (adapter) => fakes.get(adapter)?.crash(),
    resourcesReleased: (adapter) => fakes.get(adapter)?.running !== true,
  },
);
