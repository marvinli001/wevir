// 真实官方 CLI + 用户自己的 GitHub Copilot 登录，会消费账号额度（高级请求）；只有维护者设置 WEVIR_TEST_COPILOT=1 才跑。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acpAdapterCapabilities } from '@wevir/adapter-acp';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll, describe, expect, it } from 'vitest';
import { CopilotAccounts } from './accounts.js';
import { CopilotAdapter } from './copilot-adapter.js';
import { COPILOT_ENGINE } from './engine.js';

const ENABLED = process.env.WEVIR_TEST_COPILOT === '1';
const MODEL = process.env.WEVIR_TEST_COPILOT_MODEL ?? 'copilot-default';

const root = ENABLED ? realpathSync(mkdtempSync(join(tmpdir(), 'wevir-copilot-contract-'))) : '';
const cwd = join(root, 'workspace');
if (ENABLED) {
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'hello.txt'), 'wevir fixture\n');
}

afterAll(() => {
  if (ENABLED) rmSync(root, { recursive: true, force: true });
});

if (!ENABLED) {
  describe.skip('Copilot 适配器契约（真实 copilot）：设 WEVIR_TEST_COPILOT=1 才跑', () => {
    it('跳过', () => {});
  });
} else {
  describe('Copilot 账号（真实 copilot）', () => {
    it('账号：找到 copilot、读到版本、已登录、有模型', async () => {
      const accounts = new CopilotAccounts({ workDir: join(root, 'probe') });
      try {
        const state = await accounts.read('copilot', { refresh: true });
        expect(state).toMatchObject({ installed: true, status: 'signed_in' });
        expect(state.version).toMatch(/^\d+\.\d+\.\d+/);
        const models = await accounts.models('copilot');
        expect(models.models.length).toBeGreaterThan(0);
        console.info('copilot', state.version, state.executablePath, state.email, models);
      } finally {
        await accounts.dispose();
      }
    }, 90_000);
  });

  runAdapterContract(
    () => new CopilotAdapter({ home: join(root, 'home') }),
    acpAdapterCapabilities(COPILOT_ENGINE),
    {
      name: `Copilot 适配器契约（真实 copilot，${MODEL}）`,
      sessionConfig: { cwd, providerId: 'copilot', modelId: MODEL },
      waitTimeoutMs: 120_000,
      testTimeoutMs: 300_000,
      prompts: {
        plain: 'Reply with exactly the word hello.',
        toolCall: 'Read the file hello.txt, then reply with its contents.',
        approval:
          'Run exactly this shell command: echo ok > approve.txt. Then reply with the single word done.',
      },
    },
  );
}
