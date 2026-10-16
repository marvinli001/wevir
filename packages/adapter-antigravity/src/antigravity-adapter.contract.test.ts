// AgentRuntimeAdapter 契约（runtime-adapter 的 ./contract）跑在假 Antigravity 运行体上（test-fixtures/fake-agent.mjs）：
// 真实进程、真实 ACP 连接，回合由提示词决定。Antigravity 经 ACP 没有可订阅的子 agent 会话、不能插话，这两组条款跳过。
// 真实运行体的回合要 Google 账号与约 1 GB 的下载，见 docs/architecture/antigravity-event-mapping.md §8。
// Windows 上跳过（同本包其他起假运行体的测试）：那里的运行体是 agy_acp_server.exe，假运行体是带 shebang 的脚本，起不了。

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll, describe } from 'vitest';
import { AntigravityAdapter } from './antigravity-adapter.js';
import {
  collectingLogger,
  installFakeRuntime,
  removeDir,
  tempDir,
  writeFakeToken,
} from './test-fixtures/runtime.js';

const home = tempDir('wevir-agy-contract-');
const bin = path.join(home, 'bin');
installFakeRuntime(bin);
writeFakeToken(home);
const workspace = realpathSync(home);
afterAll(() => removeDir(home));

describe.skipIf(process.platform === 'win32')('AntigravityAdapter 契约', () => {
  runAdapterContract(
    () =>
      new AntigravityAdapter({
        home,
        logger: collectingLogger(),
        // 运行体从 PATH 上找到（account.setPath 之外的第三条路）。
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: home },
      }),
    {
      incrementalStream: true,
      toolCalls: true,
      approvals: true,
      resume: true,
      concurrentSessions: true,
      subagents: false,
      steer: false,
    },
    {
      name: 'AntigravityAdapter 契约（假运行体）',
      sessionConfig: () => ({
        cwd: workspace,
        providerId: 'antigravity',
        modelId: 'gemini-3.7-flash-high',
      }),
      waitTimeoutMs: 15_000,
    },
  );
});
