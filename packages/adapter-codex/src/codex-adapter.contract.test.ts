// 契约测试第 1 层（ADR-0005 决策 7）：录制回放。CodexAdapter 驱动 test-fixtures/fake-app-server.mjs（用 node 运行），
// app-server 写出的通知与审批请求都来自真实二进制录的 test-fixtures/app-server/*.jsonl，ID 换成当前的；不需要二进制、
// 模型或 Key，CI 默认跑。网关照常在 Host 进程里启动，但没有请求经过它。
// - plain 回放 `stream`（推理与文本增量 → 已提交消息），toolCall 回放 `tool-shell`（命令与输出增量）；
// - approval 回放 `approval-exec` 到审批请求为止，再按回复接 accept / decline / cancel 的分支，审批挂起时取消接
//   interrupt 分支（serverRequest/resolved 在 turn/completed 之后）；
// - 有过回合的 thread 记在 CODEX_HOME，进程被杀、重启之后能 thread/resume；没见过的回放真实的 no rollout found。

import { fileURLToPath } from 'node:url';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll } from 'vitest';
import { codexAdapterCapabilities } from './capabilities.js';
import { CODEX_CONTRACT_HOOKS, trackProcesses } from './test-fixtures/contract.js';
import { newAdapter, TempDirs } from './test-fixtures/harness.js';
import { MOCK_MODEL, MOCK_UPSTREAM_KEY } from './test-fixtures/mock-model.js';

const FAKE_APP_SERVER = fileURLToPath(
  new URL('./test-fixtures/fake-app-server.mjs', import.meta.url),
);
const dirs = new TempDirs();
const workspace = dirs.make('replay-ws').workspace;
afterAll(() => dirs.cleanup());

runAdapterContract(
  () =>
    trackProcesses(
      newAdapter({
        home: dirs.make('replay').home,
        binary: process.execPath,
        binaryArgs: [FAKE_APP_SERVER],
        providers: [
          {
            id: 'mock',
            kind: 'openai-compatible',
            displayName: 'Wevir Mock',
            api: 'openai-responses',
            // 回放层没有模型请求。
            baseURL: 'http://127.0.0.1:9/v1',
            models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
            defaultModelId: MOCK_MODEL,
            apiKey: MOCK_UPSTREAM_KEY,
          },
        ],
      }),
    ),
  // 子会话与插话的条款要真实二进制（第 2 层）：回放层的假 app-server 不模拟子 thread，也没有录 turn/steer。
  { ...codexAdapterCapabilities, subagents: false, steer: false },
  {
    name: 'CodexAdapter 契约（第 1 层：录制回放）',
    sessionConfig: () => ({ cwd: workspace, providerId: 'mock', modelId: MOCK_MODEL }),
    prompts: {
      plain: 'replay:stream',
      toolCall: 'replay:tool-shell',
      approval: 'replay:approval-exec',
    },
    ...CODEX_CONTRACT_HOOKS,
  },
);
