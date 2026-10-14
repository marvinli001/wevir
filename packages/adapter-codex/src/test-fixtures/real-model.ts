// 真实模型的 Provider：设了 WEVIR_TEST_API_KEY 的测试共用（契约第 3 层）。Key 只进网关的内存（ProviderConfig），
// 不进 Codex 的环境与 CODEX_HOME，不打印。照 packages/adapter-dsh/src/test-fixtures/real-model.ts 的
// `realProviderFromEnv`，Provider 的形状换成经网关的（模型列表不能为空）。

import type { ProviderConfig } from '@wevir/runtime-adapter';

export type RealProvider = { provider: ProviderConfig; modelId: string } | { skip: string };

/**
 * 从环境变量读第 3 层的 Provider。要同时设 `WEVIR_TEST_API_KEY` 与 `WEVIR_TEST_PROVIDER`（取 ProviderConfig 的 `kind`）：
 * - `deepseek-official`：DeepSeek 官方，网关透传到它的 Responses 端点，模型默认 `deepseek-flash`（codex-notes §7.3
 *   实测可用，与网关的真实模型测试相同），`WEVIR_TEST_MODEL` 可改；
 * - `openai-compatible`：其他服务，还要 `WEVIR_TEST_BASE_URL` 与 `WEVIR_TEST_MODEL`，协议 `WEVIR_TEST_API`
 *   （`openai-completions` 默认 / `openai-responses` / `anthropic-messages`）。
 * 缺 Key 或 `WEVIR_TEST_PROVIDER` 时返回跳过的原因；值不对、缺地址或模型时直接报错，不悄悄跳过。
 */
export function realProviderFromEnv(env: NodeJS.ProcessEnv = process.env): RealProvider {
  const key = env.WEVIR_TEST_API_KEY || undefined;
  const kind = env.WEVIR_TEST_PROVIDER || undefined;
  if (key === undefined || kind === undefined) {
    const missing = [
      key === undefined && 'WEVIR_TEST_API_KEY',
      kind === undefined && 'WEVIR_TEST_PROVIDER',
    ]
      .filter(Boolean)
      .join('、');
    return {
      skip: `没有设 ${missing}（WEVIR_TEST_PROVIDER 取 deepseek-official 或 openai-compatible，后者另需 WEVIR_TEST_BASE_URL 与 WEVIR_TEST_MODEL）`,
    };
  }
  const model = env.WEVIR_TEST_MODEL || undefined;
  if (kind === 'deepseek-official') {
    const modelId = model ?? 'deepseek-flash';
    return {
      provider: {
        id: 'deepseek-official',
        kind,
        displayName: 'DeepSeek',
        models: [{ id: modelId, contextWindow: 128_000 }],
        defaultModelId: modelId,
        apiKey: key,
      },
      modelId,
    };
  }
  if (kind === 'openai-compatible') {
    const baseURL = env.WEVIR_TEST_BASE_URL || undefined;
    if (baseURL === undefined || model === undefined) {
      throw new Error(
        'WEVIR_TEST_PROVIDER=openai-compatible 时要同时设 WEVIR_TEST_BASE_URL 与 WEVIR_TEST_MODEL',
      );
    }
    return {
      provider: {
        id: 'wevir-real',
        kind,
        displayName: 'Wevir Real',
        api: env.WEVIR_TEST_API || 'openai-completions',
        baseURL,
        models: [{ id: model }],
        defaultModelId: model,
        apiKey: key,
      },
      modelId: model,
    };
  }
  throw new Error(`WEVIR_TEST_PROVIDER 只能是 deepseek-official 或 openai-compatible：${kind}`);
}
