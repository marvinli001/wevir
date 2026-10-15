import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { realProviderFromEnv } from './test-fixtures/real-model.js';

describe('Vertex 契约第 3 层配置', () => {
  const env = {
    WEVIR_TEST_PROVIDER: 'google-vertex',
    WEVIR_TEST_VERTEX_PROJECT: 'vertex-example',
    WEVIR_TEST_VERTEX_SERVICE_ACCOUNT_JSON: 'fake-service-account-json',
  };
  it('不要求 API Key，Gemini 默认值与 Claude 协议都能构造', () => {
    expect(realProviderFromEnv(env)).toMatchObject({
      modelId: 'google/gemini-3.8-flash',
      provider: {
        kind: 'google-vertex',
        api: 'openai-completions',
        vertex: { project: 'vertex-example', location: 'global' },
        serviceAccountJson: env.WEVIR_TEST_VERTEX_SERVICE_ACCOUNT_JSON,
      },
    });
    expect(
      realProviderFromEnv({
        ...env,
        WEVIR_TEST_API: 'anthropic-messages',
        WEVIR_TEST_VERTEX_LOCATION: 'us',
      }),
    ).toMatchObject({ modelId: 'claude-sonnet-5-5', provider: { vertex: { location: 'us' } } });
  });
  it('服务账号文件只读进内存，不把路径当密钥，缺凭据时跳过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wevir-vertex-env-'));
    const file = join(dir, 'account.json');
    try {
      writeFileSync(file, 'fake-service-account-json');
      expect(
        realProviderFromEnv({
          ...env,
          WEVIR_TEST_VERTEX_SERVICE_ACCOUNT_JSON: '',
          WEVIR_TEST_VERTEX_SERVICE_ACCOUNT_FILE: file,
        }),
      ).toMatchObject({ provider: { serviceAccountJson: 'fake-service-account-json' } });
      expect(realProviderFromEnv({ WEVIR_TEST_PROVIDER: 'google-vertex' })).toHaveProperty('skip');
      expect(() =>
        realProviderFromEnv({ ...env, WEVIR_TEST_VERTEX_SERVICE_ACCOUNT_FILE: file }),
      ).toThrow('只选一种');
      expect(() => realProviderFromEnv({ ...env, WEVIR_TEST_VERTEX_PROJECT: '' })).toThrow(
        'WEVIR_TEST_VERTEX_PROJECT',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
