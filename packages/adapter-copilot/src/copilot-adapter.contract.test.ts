import { join } from 'node:path';
import { acpAdapterCapabilities } from '@wevir/adapter-acp';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll } from 'vitest';
import type { CopilotAdapter } from './copilot-adapter.js';
import { COPILOT_ENGINE } from './engine.js';
import { fakeCopilotAdapter, fakeCopilotEnv, tempRoot } from './test-fixtures/harness.js';

const temp = tempRoot('contract');
afterAll(() => temp.remove());

const launched = new WeakMap<CopilotAdapter, number[]>();
let seq = 0;

function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

runAdapterContract<CopilotAdapter>(
  () => {
    seq += 1;
    const adapter = fakeCopilotAdapter(
      join(temp.dir(`home-${seq}`)),
      fakeCopilotEnv({
        FAKE_COPILOT_STORE: temp.dir(`store-${seq}`),
        FAKE_COPILOT_SIGNED_IN: '1',
        COPILOT_HOME: temp.dir(`copilot-home-${seq}`),
      }),
    );
    const pids: number[] = [];
    launched.set(adapter, pids);
    // dispose 之前记下各进程的 pid，`resourcesReleased` 确认它们都已退出。
    const dispose = adapter.dispose.bind(adapter);
    adapter.dispose = () => {
      if (adapter.process.pid !== undefined) pids.push(adapter.process.pid);
      return dispose();
    };
    return adapter;
  },
  // 逐字增量由适配器合成，所以有增量；没有子会话与插话（ACP）。
  acpAdapterCapabilities(COPILOT_ENGINE),
  {
    name: 'CopilotAdapter 契约（假 copilot 合成 ACP 样本）',
    sessionConfig: () => ({
      cwd: temp.dir('ws'),
      providerId: 'copilot',
      modelId: 'fixture-model-a',
    }),
    prompts: { plain: 'plain', toolCall: 'tool', approval: 'approval' },
    simulateEngineExit: async (adapter) => {
      const pid = adapter.process.pid;
      if (pid === undefined) throw new Error('copilot 进程没在运行');
      launched.get(adapter)?.push(pid);
      process.kill(pid, 'SIGKILL');
    },
    resourcesReleased: (adapter) =>
      adapter.process.state === 'disposed' && (launched.get(adapter) ?? []).every(exited),
  },
);
