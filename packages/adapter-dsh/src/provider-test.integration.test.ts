// provider.test 对真实 Provider 的集成测试（T3.4 验收）：设了 WEVIR_TEST_API_KEY 才跑。默认 DeepSeek 官方路由
// （Anthropic Messages，模型 WEVIR_TEST_MODEL，默认 deepseek-flash）；设了 WEVIR_TEST_BASE_URL 时改走 OpenAI
// 兼容服务（openai-completions），这时要同时设 WEVIR_TEST_MODEL。与 dsh-adapter.approval.integration.test.ts
// 的真实模型用例用同一组变量。

import type { ProviderConfig } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import { testProvider } from './provider-test.js';

const KEY = process.env.WEVIR_TEST_API_KEY;
const BASE_URL = process.env.WEVIR_TEST_BASE_URL;
const MODEL =
  process.env.WEVIR_TEST_MODEL ?? (BASE_URL === undefined ? 'deepseek-flash' : undefined);

function realProvider(apiKey: string): ProviderConfig {
  if (BASE_URL === undefined) {
    return {
      id: 'deepseek-official',
      kind: 'deepseek-official',
      displayName: 'DeepSeek',
      models: [],
      defaultModelId: 'deepseek-flash',
      apiKey,
    };
  }
  if (MODEL === undefined) throw new Error('设了 WEVIR_TEST_BASE_URL 时要同时设 WEVIR_TEST_MODEL');
  return {
    id: 'wevir-real',
    kind: 'openai-compatible',
    displayName: 'Real',
    api: 'openai-completions',
    baseURL: BASE_URL,
    models: [{ id: MODEL }],
    defaultModelId: MODEL,
    apiKey,
  };
}

describe.skipIf(KEY === undefined || KEY === '')('testProvider（真实 Provider）', () => {
  it('正确的 Key：成功', { timeout: 30_000 }, async () => {
    const result = await testProvider(realProvider(KEY as string), MODEL as string);
    expect(result.error?.message).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('错误的 Key：401 类错误（auth），消息里没有 Key', { timeout: 30_000 }, async () => {
    const wrong = `sk-wevir-wrong-${Date.now()}`;
    const result = await testProvider(realProvider(wrong), MODEL as string);
    expect(result).toMatchObject({ ok: false, reason: 'auth', error: { category: 'provider' } });
    expect([401, 403]).toContain(result.httpStatus);
    expect(result.error?.message).not.toContain(wrong);
  });

  it('不存在的模型：model_not_found', { timeout: 30_000 }, async () => {
    const result = await testProvider(realProvider(KEY as string), 'wevir-no-such-model');
    expect(result).toMatchObject({ ok: false, reason: 'model_not_found' });
  });
});
