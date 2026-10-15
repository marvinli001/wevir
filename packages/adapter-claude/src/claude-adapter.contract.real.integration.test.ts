// 真实 `claude` 上的契约（用户自己装的 `claude` 与登录，会用掉订阅额度）。平时跳过；要跑时（可以用 -t 只跑几条）：
//
//   env -i HOME="$HOME" PATH="$PATH" USER="$USER" WEVIR_TEST_CLAUDE=1 \
//     pnpm vitest run --project adapter-claude contract.real -t '一问一答|审批：选允许'
//
// 模型用最便宜的 claude-haiku-4-5（`WEVIR_TEST_CLAUDE_MODEL` 可换）。会话在临时目录里跑，结束时删掉 claude 为这个临时目录
// 记下的会话记录（~/.claude/projects 下以临时目录命名的那一个文件夹），不碰别的。

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll, describe, it } from 'vitest';
import { claudeAdapterCapabilities } from './capabilities.js';
import { ClaudeAdapter } from './claude-adapter.js';

const ENABLED = process.env.WEVIR_TEST_CLAUDE === '1';
const MODEL = process.env.WEVIR_TEST_CLAUDE_MODEL ?? 'claude-haiku-4-5';

const root = ENABLED ? realpathSync(mkdtempSync(join(tmpdir(), 'wevir-claude-contract-'))) : '';
const cwd = join(root, 'workspace');
if (ENABLED) {
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'hello.txt'), 'wevir fixture\n');
}

afterAll(() => {
  if (!ENABLED) return;
  rmSync(root, { recursive: true, force: true });
  // claude 按工作目录记会话（路径里的 / 与 . 换成 -）；只删这个临时目录的那一个。
  const key = cwd.replaceAll(/[/.]/g, '-');
  if (
    basename(root).startsWith('wevir-claude-contract-') &&
    key.includes('wevir-claude-contract-')
  ) {
    rmSync(join(homedir(), '.claude', 'projects', key), { recursive: true, force: true });
  }
});

if (!ENABLED) {
  describe.skip('Claude 适配器契约（真实 claude）：设 WEVIR_TEST_CLAUDE=1 才跑', () => {
    it('跳过', () => {});
  });
} else {
  const write =
    'Use the Write tool to create a file named approve.txt containing the text ok. Then reply with the single word done.';
  runAdapterContract(
    () => new ClaudeAdapter({ home: join(root, 'home') }),
    claudeAdapterCapabilities,
    {
      name: `Claude 适配器契约（真实 claude，${MODEL}）`,
      sessionConfig: { cwd, providerId: 'claude', modelId: MODEL },
      waitTimeoutMs: 90_000,
      testTimeoutMs: 240_000,
      prompts: {
        plain: 'Reply with exactly the word hello.',
        toolCall: 'Use the Read tool to read the file hello.txt, then reply with its contents.',
        approval: write,
        subagent:
          'Use the Agent tool with subagent_type general-purpose to have a subagent reply with exactly the word pong. Then tell me in one word what it said.',
        subagentApproval:
          'Use the Agent tool with subagent_type general-purpose and this prompt for the subagent: "Use the Write tool to create a file named sub.txt containing the text ok, then reply done." Then reply with the single word finished.',
        slow: 'Write the numbers from 1 to 60 in words, one per line, with no other text.',
        steer: 'Also add one final line that says weather.',
      },
    },
  );
}
