// 真实官方 CLI + 用户自己的 Devin 登录，会消费账号额度（ACU）；只有维护者设置 WEVIR_TEST_DEVIN=1 才跑。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acpAdapterCapabilities } from '@wevir/adapter-acp';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll, describe, expect, it } from 'vitest';
import { DevinAccounts } from './accounts.js';
import { DevinAdapter } from './devin-adapter.js';
import { DEVIN_ENGINE } from './engine.js';

const ENABLED = process.env.WEVIR_TEST_DEVIN === '1';
const MODEL = process.env.WEVIR_TEST_DEVIN_MODEL ?? 'devin-default';

const root = ENABLED ? realpathSync(mkdtempSync(join(tmpdir(), 'wevir-devin-contract-'))) : '';
const cwd = join(root, 'workspace');
if (ENABLED) {
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'hello.txt'), 'wevir fixture\n');
}

afterAll(() => {
  if (ENABLED) rmSync(root, { recursive: true, force: true });
});

if (!ENABLED) {
  describe.skip('Devin 适配器契约（真实 devin）：设 WEVIR_TEST_DEVIN=1 才跑', () => {
    it('跳过', () => {});
  });
} else {
  describe('Devin 账号（真实 devin）', () => {
    it('账号：找到 devin、读到版本、已登录、有模型', async () => {
      const accounts = new DevinAccounts({ workDir: join(root, 'probe') });
      try {
        const state = await accounts.read('devin', { refresh: true });
        expect(state).toMatchObject({ installed: true, status: 'signed_in' });
        expect(state.version).toMatch(/^\d+\.\d+\.\d+/);
        const models = await accounts.models('devin');
        expect(models.models.length).toBeGreaterThan(0);
        console.info('devin', state.version, state.executablePath, models.defaultModelId);
      } finally {
        await accounts.dispose();
      }
    }, 60_000);
  });

  runAdapterContract(
    () => new DevinAdapter({ home: join(root, 'home') }),
    acpAdapterCapabilities(DEVIN_ENGINE),
    {
      name: `Devin 适配器契约（真实 devin，${MODEL}）`,
      sessionConfig: { cwd, providerId: 'devin', modelId: MODEL },
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
