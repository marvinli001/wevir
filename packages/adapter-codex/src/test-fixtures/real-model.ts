// 真实模型的 Provider：设了 WEVIR_TEST_API_KEY 的测试共用（契约第 3 层）。Key 只进网关的内存（ProviderConfig），
// 不进 Codex 的环境与 CODEX_HOME，不打印。照 packages/adapter-dsh/src/test-fixtures/real-model.ts 的
// `realProviderFromEnv`，Provider 的形状换成经网关的（模型列表不能为空）。

import { readFileSync } from 'node:fs';
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
  if (env.WEVIR_TEST_PROVIDER === 'google-vertex') {
    const json = env.WEVIR_TEST_VERTEX_SERVICE_ACCOUNT_JSON;
    const file = env.WEVIR_TEST_VERTEX_SERVICE_ACCOUNT_FILE;
    if (json && file) throw new Error('服务账号 JSON 与文件路径只选一种');
    if (!json && !file)
      return {
        skip: '缺少 WEVIR_TEST_VERTEX_SERVICE_ACCOUNT_JSON 或 WEVIR_TEST_VERTEX_SERVICE_ACCOUNT_FILE',
      };
    const project = env.WEVIR_TEST_VERTEX_PROJECT;
    if (!project) throw new Error('google-vertex 需要 WEVIR_TEST_VERTEX_PROJECT');
    const api = env.WEVIR_TEST_API || 'openai-completions';
    if (!['openai-completions', 'anthropic-messages'].includes(api))
      throw new Error('Vertex 只支持 openai-completions 或 anthropic-messages');
    let serviceAccountJson: string;
    try {
      serviceAccountJson = json || readFileSync(file ?? '', 'utf8');
    } catch {
      throw new Error('无法读取 Vertex 服务账号文件');
    }
    const modelId =
      env.WEVIR_TEST_MODEL ||
      (api === 'anthropic-messages' ? 'claude-sonnet-5-5' : 'google/gemini-3.8-flash');
    return {
      modelId,
      provider: {
        id: 'vertex-real',
        kind: 'google-vertex',
        displayName: 'Google Vertex AI',
        api,
        vertex: { project, location: env.WEVIR_TEST_VERTEX_LOCATION || 'global' },
        serviceAccountJson,
        models: [
          {
            id: modelId,
            contextWindow: api === 'anthropic-messages' ? 1000000 : 1048576,
            maxTokens: api === 'anthropic-messages' ? 128000 : 65536,
            supportsImages: true,
            reasoningEfforts:
              api === 'anthropic-messages'
                ? ['low', 'medium', 'high', 'xhigh', 'max']
                : ['low', 'medium', 'high'],
          },
        ],
        defaultModelId: modelId,
      },
    };
  }
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
    const known = modelId === 'deepseek-flash' || modelId === 'deepseek-v4-pro';
    return {
      provider: {
        id: 'deepseek-official',
        kind,
        displayName: 'DeepSeek',
        models: [
          {
            id: modelId,
            contextWindow: known ? 1048576 : 128_000,
            ...(known && { reasoningEfforts: ['off', 'low', 'high', 'max'] }),
            ...(modelId === 'deepseek-flash' && { supportsImages: true }),
          },
        ],
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
  throw new Error(
    `WEVIR_TEST_PROVIDER 只能是 deepseek-official、openai-compatible 或 google-vertex：${kind}`,
  );
}
