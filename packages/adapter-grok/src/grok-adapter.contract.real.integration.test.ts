// 真实 `grok` 上的账号检测与契约（用户自己装的 Grok Build 与 `grok login`，会用掉订阅额度）。平时跳过；要跑时（可以用 -t
// 只跑几条）：
//
//   env -i HOME="$HOME" PATH="$PATH" USER="$USER" WEVIR_TEST_GROK=1 \
//     pnpm vitest run --project adapter-grok contract.real -t '账号|一问一答|审批：选允许'
//
// 模型默认 `grok-build`（不换模型，用 Grok 自己的默认），`WEVIR_TEST_GROK_MODEL` 可换。会话在临时目录里跑，结束时删掉临时
// 目录；Grok 记在 ~/.grok/sessions 下的会话记录不动（目录的命名还没核实，见 grok-event-mapping.md §8）。

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acpAdapterCapabilities } from '@wevir/adapter-acp';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll, describe, expect, it } from 'vitest';
import { GrokAccounts } from './accounts.js';
import { GROK_ENGINE } from './engine.js';
import { GrokAdapter } from './grok-adapter.js';

const ENABLED = process.env.WEVIR_TEST_GROK === '1';
const MODEL = process.env.WEVIR_TEST_GROK_MODEL ?? 'grok-build';

const root = ENABLED ? realpathSync(mkdtempSync(join(tmpdir(), 'wevir-grok-contract-'))) : '';
const cwd = join(root, 'workspace');
if (ENABLED) {
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'hello.txt'), 'wevir fixture\n');
}

afterAll(() => {
  if (ENABLED) rmSync(root, { recursive: true, force: true });
});

if (!ENABLED) {
  describe.skip('Grok 适配器契约（真实 grok）：设 WEVIR_TEST_GROK=1 才跑', () => {
    it('跳过', () => {});
  });
} else {
  describe('Grok 账号（真实 grok）', () => {
    it('账号：找到 grok、读到版本、已登录、有模型', async () => {
      const accounts = new GrokAccounts({ workDir: join(root, 'probe') });
      try {
        const state = await accounts.read('grok', { refresh: true });
        expect(state).toMatchObject({ installed: true, status: 'signed_in' });
        expect(state.version).toMatch(/^\d+\.\d+\.\d+/);
        const models = await accounts.models('grok');
        expect(models.models.length).toBeGreaterThan(0);
        console.info('grok', state.version, state.executablePath, models.defaultModelId);
      } finally {
        accounts.dispose();
      }
    }, 60_000);
  });

  runAdapterContract(
    () => new GrokAdapter({ home: join(root, 'home') }),
    { ...acpAdapterCapabilities(GROK_ENGINE, 'off'), incrementalStream: true },
    {
      name: `Grok 适配器契约（真实 grok，${MODEL}）`,
      sessionConfig: { cwd, providerId: 'grok', modelId: MODEL },
      waitTimeoutMs: 120_000,
      testTimeoutMs: 300_000,
      prompts: {
        plain: 'Reply with exactly the word hello.',
        toolCall: 'Use the read_file tool to read hello.txt, then reply with its contents.',
        approval:
          'Use the run_terminal_command tool to run exactly: echo ok > approve.txt. Then reply with the single word done.',
      },
    },
  );
}
