// 通用适配器契约（`@wevir/runtime-adapter/contract`）跑在假 grok 上：GrokAdapter 起真的子进程、说真的 ACP，引擎写出的消息
// 来自 T3 Code 录的 Grok Build 样本（test-fixtures/acp/）——plain 是 simple，toolCall 是 todo_list（第一个工具是不需要审批
// 的 search_tool），approval 是 tool_call_read_only_on_request（选拒绝或取消时由假 grok 接着写失败的工具）。会话记在
// FAKE_GROK_STORE，引擎被杀后新进程能 resume。逐字增量由适配器自己合成（`messageChunks: 'streamed'`），增量条款照跑。

import { join } from 'node:path';
import { acpAdapterCapabilities } from '@wevir/adapter-acp';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll } from 'vitest';
import { GROK_ENGINE } from './engine.js';
import type { GrokAdapter } from './grok-adapter.js';
import { fakeGrokAdapter, fakeGrokEnv, tempRoot } from './test-fixtures/harness.js';

const temp = tempRoot('contract');
afterAll(() => temp.remove());

const launched = new WeakMap<GrokAdapter, number[]>();
let seq = 0;

function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

runAdapterContract<GrokAdapter>(
  () => {
    seq += 1;
    const adapter = fakeGrokAdapter(
      join(temp.dir(`home-${seq}`)),
      fakeGrokEnv({ FAKE_GROK_STORE: temp.dir(`store-${seq}`) }),
    );
    const pids: number[] = [];
    launched.set(adapter, pids);
    // dispose 之前记下各进程的 pid，`resourcesReleased` 确认它们都已退出。
    const dispose = adapter.dispose.bind(adapter);
    adapter.dispose = () => {
      for (const engine of adapter.engines) {
        if (engine.process.pid !== undefined) pids.push(engine.process.pid);
      }
      return dispose();
    };
    return adapter;
  },
  // 逐字增量由适配器合成，所以有增量；没有子会话与插话（ACP）。
  { ...acpAdapterCapabilities(GROK_ENGINE, 'off'), incrementalStream: true },
  {
    name: 'GrokAdapter 契约（假 grok 回放 Grok Build 样本）',
    sessionConfig: () => ({ cwd: temp.dir('ws'), providerId: 'grok', modelId: 'grok-4.7' }),
    prompts: {
      plain: 'replay:simple',
      toolCall: 'replay:todo_list',
      approval: 'replay:tool_call_read_only_on_request',
    },
    simulateEngineExit: async (adapter) => {
      const engine = adapter.engines[0];
      const pid = engine?.process.pid;
      if (pid === undefined) throw new Error('grok 进程没在运行');
      launched.get(adapter)?.push(pid);
      process.kill(pid, 'SIGKILL');
    },
    resourcesReleased: (adapter) =>
      adapter.engines.length === 0 && (launched.get(adapter) ?? []).every(exited),
  },
);
