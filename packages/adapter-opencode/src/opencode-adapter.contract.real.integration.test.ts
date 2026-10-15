// 真实 `opencode` 上的契约：用户装的 opencode（或 WEVIR_TEST_OPENCODE_BIN 指的那一个）+ 本机假模型（test-fixtures/mock-model.ts），
// 不用订阅、不联网。opencode 的数据、配置、缓存都在临时目录里，不碰用户自己的登录与会话。平时跳过；要跑时：
//
//   WEVIR_TEST_OPENCODE=1 WEVIR_TEST_OPENCODE_BIN="$(which opencode)" \
//     pnpm vitest run --project adapter-opencode contract.real
//
// 用订阅真跑一个回合的步骤见 docs/architecture/opencode-event-mapping.md §8。

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPENCODE_BIN_ENV } from './executable.js';
import { OpenCodeAdapter } from './opencode-adapter.js';
import {
  isolatedOpenCodeEnv,
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  type MockModel,
  startMockModel,
} from './test-fixtures/mock-model.js';

const ENABLED = process.env.WEVIR_TEST_OPENCODE === '1';
const BIN = process.env.WEVIR_TEST_OPENCODE_BIN;

const root = ENABLED ? realpathSync(mkdtempSync(join(tmpdir(), 'wevir-opencode-contract-'))) : '';
const workspace = join(root, 'workspace');
let model: MockModel | undefined;

beforeAll(async () => {
  if (!ENABLED) return;
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'hello.txt'), 'wevir fixture\n');
  model = await startMockModel();
});

afterAll(async () => {
  if (!ENABLED) return;
  await model?.close();
  rmSync(root, { recursive: true, force: true });
});

if (ENABLED) {
  runAdapterContract(
    () => {
      if (model === undefined) throw new Error('mock model not started');
      return new OpenCodeAdapter({
        home: join(root, 'home'),
        env: {
          ...isolatedOpenCodeEnv(root, model.baseUrl),
          ...(BIN !== undefined && { [OPENCODE_BIN_ENV]: BIN }),
        },
        idleTtlMs: 1_000,
      });
    },
    {
      incrementalStream: true,
      toolCalls: true,
      approvals: true,
      resume: true,
      concurrentSessions: true,
      subagents: true,
      steer: false,
    },
    {
      name: 'OpenCodeAdapter 契约（真实 opencode + 假模型）',
      sessionConfig: () => ({
        cwd: workspace,
        providerId: 'opencode',
        modelId: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
      }),
      waitTimeoutMs: 20_000,
      testTimeoutMs: 60_000,
      simulateEngineExit: async (adapter) => {
        const pid = adapter.serverPid;
        if (pid === undefined) throw new Error('the OpenCode server is not running');
        process.kill(-pid, 'SIGKILL');
      },
      resourcesReleased: (adapter) => adapter.serverPid === undefined,
    },
  );
}

describe.skipIf(!ENABLED)('OpenCodeAdapter（真实 opencode + 假模型）', { timeout: 60_000 }, () => {
  it('格式正确但不存在的会话恢复时报 session_lost', async () => {
    if (model === undefined) throw new Error('mock model not started');
    const adapter = new OpenCodeAdapter({
      home: join(root, 'home-lost'),
      env: {
        ...isolatedOpenCodeEnv(root, model.baseUrl),
        ...(BIN !== undefined && { [OPENCODE_BIN_ENV]: BIN }),
      },
    });
    try {
      await expect(
        adapter.resumeSession('ses_ffffffffffffffffffffffffff', {
          cwd: workspace,
          providerId: 'opencode',
          modelId: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
        }),
      ).rejects.toMatchObject({ code: 'session_lost', lostReason: 'not_found' });
    } finally {
      await adapter.dispose();
    }
  });
});
