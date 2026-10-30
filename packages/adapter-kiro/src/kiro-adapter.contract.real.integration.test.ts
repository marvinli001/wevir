// 真实官方 CLI + 用户自己的 Kiro 登录（或 KIRO_API_KEY），会消费账号额度（credits）；只有维护者设置 WEVIR_TEST_KIRO=1 才跑。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acpAdapterCapabilities } from '@wevir/adapter-acp';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll, describe, expect, it } from 'vitest';
import { KiroAccounts } from './accounts.js';
import { KIRO_ENGINE } from './engine.js';
import { KiroAdapter } from './kiro-adapter.js';

const ENABLED = process.env.WEVIR_TEST_KIRO === '1';
const MODEL = process.env.WEVIR_TEST_KIRO_MODEL ?? 'kiro-default';

const root = ENABLED ? realpathSync(mkdtempSync(join(tmpdir(), 'wevir-kiro-contract-'))) : '';
const cwd = join(root, 'workspace');
if (ENABLED) {
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'hello.txt'), 'wevir fixture\n');
}

afterAll(() => {
  if (ENABLED) rmSync(root, { recursive: true, force: true });
});

if (!ENABLED) {
  describe.skip('Kiro 适配器契约（真实 kiro-cli）：设 WEVIR_TEST_KIRO=1 才跑', () => {
    it('跳过', () => {});
  });
} else {
  describe('Kiro 账号（真实 kiro-cli）', () => {
    it('账号：找到 kiro-cli、读到版本、已登录、有模型', async () => {
      const accounts = new KiroAccounts({ workDir: join(root, 'probe') });
      try {
        const state = await accounts.read('kiro', { refresh: true });
        expect(state).toMatchObject({ installed: true, status: 'signed_in' });
        expect(state.version).toMatch(/^\d+\.\d+\.\d+/);
        const models = await accounts.models('kiro');
        expect(models.models.length).toBeGreaterThan(0);
        console.info('kiro', state.version, state.executablePath, state.email, models);
      } finally {
        await accounts.dispose();
      }
    }, 90_000);
  });

  runAdapterContract(
    () => new KiroAdapter({ home: join(root, 'home') }),
    acpAdapterCapabilities(KIRO_ENGINE),
    {
      name: `Kiro 适配器契约（真实 kiro-cli，${MODEL}）`,
      sessionConfig: { cwd, providerId: 'kiro', modelId: MODEL },
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
