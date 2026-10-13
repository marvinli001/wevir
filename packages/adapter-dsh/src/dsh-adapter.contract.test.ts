// T3.6 契约测试第 1 层：回放。DshAdapter 驱动 test-fixtures/fake-dsh.mjs，dsh 写出的 ACP 消息全部来自 T0.3 录制
// （acp/mock/transcripts/），会话 ID 与请求 id 换成当前的；不需要 dsh、模型或 Key，CI 默认跑。
// - plain 回放场景 F（思考 + 一条消息），toolCall 回放场景 A（工作区内 read、write）；
// - approval 回放 B 到审批请求为止，再按回复接 B（允许）、C（拒绝）或 D（取消）的后半段（fake-dsh 的 replay:permission）；
// - FAKE_DSH_STORE=1：会话像真实 dsh 一样记在 DSH_HOME，重启后的新进程能 resume，没建过的会话回放真实 dsh 的
//   not resumable（→ session_lost）；
// - 引擎退出：SIGKILL 假 dsh，DshProcess 照常自动重启。
// 增量条款跳过：T0.3 没有与 ACP 样本对齐的完整旁路录制（stream-tap/frames.sample.json 只是抽样），由第 2 层覆盖
// （ADR-0001 补记 7）。

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll } from 'vitest';
import { dshAdapterCapabilities } from './capabilities.js';
import { DshAdapter } from './dsh-adapter.js';
import { ACP_FIXTURES } from './test-fixtures/acp-fixtures.js';
import { DSH_CONTRACT_HOOKS, tempRoot, trackProcesses } from './test-fixtures/contract.js';

const FAKE_DSH = fileURLToPath(new URL('./test-fixtures/fake-dsh.mjs', import.meta.url));
const temp = tempRoot('replay');
afterAll(() => temp.remove());

runAdapterContract(
  () =>
    trackProcesses(
      new DshAdapter({
        home: temp.dir('home'),
        entry: FAKE_DSH,
        env: {
          FAKE_DSH_MODE: 'acp',
          FAKE_DSH_FIXTURES: join(ACP_FIXTURES, 'mock', 'transcripts'),
          FAKE_DSH_STORE: '1',
        },
        streamTap: false,
        logger: { warn: () => {} },
      }),
    ),
  // 回放层没有旁路（streamTap: false），只有 ACP 的已提交消息。
  dshAdapterCapabilities('off'),
  {
    name: 'DshAdapter 契约（第 1 层：T0.3 样本回放）',
    // 与 fake-dsh 的默认路由相同，建会话时不用 set_config_option。
    sessionConfig: () => ({ cwd: temp.dir('ws'), providerId: 'wevir-test', modelId: 'wevir-mock' }),
    prompts: {
      plain: 'replay:F-stream-granularity',
      toolCall: 'replay:A-read-write',
      approval: 'replay:permission',
    },
    ...DSH_CONTRACT_HOOKS,
  },
);
