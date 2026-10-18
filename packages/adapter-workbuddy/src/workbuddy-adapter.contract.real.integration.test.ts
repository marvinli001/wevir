// 真实官方 CLI + 用户自己的登录，会消费订阅额度；只有维护者设置 WEVIR_TEST_WORKBUDDY=1 才跑。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acpAdapterCapabilities } from '@wevir/adapter-acp';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll, describe, expect, it } from 'vitest';
import { WorkBuddyAccounts } from './accounts.js';
import { WORKBUDDY_ENGINE } from './engine.js';
import { WorkBuddyAdapter } from './workbuddy-adapter.js';

const ENABLED = process.env.WEVIR_TEST_WORKBUDDY === '1';
const MODEL = process.env.WEVIR_TEST_WORKBUDDY_MODEL ?? 'workbuddy-auto';

const root = ENABLED ? realpathSync(mkdtempSync(join(tmpdir(), 'wevir-workbuddy-contract-'))) : '';
const cwd = join(root, 'workspace');
if (ENABLED) {
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'hello.txt'), 'wevir fixture\n');
}

afterAll(() => {
  if (ENABLED) rmSync(root, { recursive: true, force: true });
});

if (!ENABLED) {
  describe.skip('WorkBuddy 适配器契约（真实 codebuddy）：设 WEVIR_TEST_WORKBUDDY=1 才跑', () => {
    it('跳过', () => {});
  });
} else {
  describe('WorkBuddy 账号（真实 codebuddy）', () => {
    it('账号：找到 codebuddy、读到版本、已登录、有模型', async () => {
      const accounts = new WorkBuddyAccounts({ workDir: join(root, 'probe') });
      try {
        const state = await accounts.read('workbuddy', { refresh: true });
        expect(state).toMatchObject({ installed: true, status: 'signed_in' });
        expect(state.version).toMatch(/^\d+\.\d+\.\d+/);
        const models = await accounts.models('workbuddy');
        expect(models.models.length).toBeGreaterThan(0);
        console.info('workbuddy', state.version, state.executablePath, models.defaultModelId);
      } finally {
        await accounts.dispose();
      }
    }, 60_000);
  });

  runAdapterContract(
    () => new WorkBuddyAdapter({ home: join(root, 'home') }),
    acpAdapterCapabilities(WORKBUDDY_ENGINE),
    {
      name: `WorkBuddy 适配器契约（真实 codebuddy，${MODEL}）`,
      sessionConfig: { cwd, providerId: 'workbuddy', modelId: MODEL },
      waitTimeoutMs: 120_000,
      testTimeoutMs: 300_000,
      prompts: {
        plain: 'Reply with exactly the word hello.',
        toolCall: 'Use the Read tool to read hello.txt, then reply with its contents.',
        approval:
          'Use the Bash tool to run exactly: echo ok > approve.txt. Then reply with the single word done.',
      },
    },
  );
}
