// 真实模型的 dsh 配置：设了 WEVIR_TEST_API_KEY 的集成测试共用（审批 T3.3、恢复 T3.5）。Key 只进子进程环境，
// overlay 里只有变量名。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 集成测试打开会话要的引擎配置：`--patch` overlay、子进程环境、会话的路由。 */
export interface ModelSetup {
  patches: string[];
  env: Record<string, string>;
  providerId: string;
  modelId: string;
}

/** 测试用的真实模型 Key；没设时为 undefined，真实模型用例跳过。 */
export const REAL_KEY = process.env.WEVIR_TEST_API_KEY || undefined;

/**
 * 真实模型的 overlay（写在 `dir` 下），只写 Key 的环境变量名。默认 dsh acp profile 自带的 DeepSeek 官方路由（`deepseek-official`，
 * llm-deepseek）；设了 WEVIR_TEST_BASE_URL 时改走 OpenAI 兼容服务（llm-pi-ai），模型取 WEVIR_TEST_MODEL。
 */
export function realModelSetup(dir: string, key: string): ModelSetup {
  const keyEnv = 'WEVIR_PROVIDER_WEVIR_REAL_KEY';
  const baseURL = process.env.WEVIR_TEST_BASE_URL;
  const model = process.env.WEVIR_TEST_MODEL;
  const file = join(dir, 'provider.yml');
  if (baseURL === undefined) {
    const lines = ['- id: llm-deepseek', '  config:', `    apiKeyEnv: ${keyEnv}`];
    if (model !== undefined) {
      lines.push(
        '- id: acp',
        '  config:',
        '    provider: deepseek-official',
        `    model: ${model}`,
      );
    }
    writeFileSync(file, `${lines.join('\n')}\n`);
    return {
      patches: [file],
      env: { [keyEnv]: key },
      providerId: 'deepseek-official',
      modelId: model ?? 'deepseek-v4-flash',
    };
  }
  if (model === undefined) throw new Error('设了 WEVIR_TEST_BASE_URL 时要同时设 WEVIR_TEST_MODEL');
  const deepseek = /(^|\.)deepseek\.com$/.test(new URL(baseURL).hostname);
  writeFileSync(
    file,
    [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      wevir-real:',
      `        apiKeyEnv: ${keyEnv}`,
      '        api: openai-completions',
      `        baseURL: ${baseURL}`,
      '        compat:',
      '          supportsDeveloperRole: false',
      '          maxTokensField: max_tokens',
      // DeepSeek 的 OpenAI 兼容端点（T0.3 §6.2）。
      ...(deepseek
        ? [
            '          thinkingFormat: deepseek',
            '          requiresReasoningContentOnAssistantMessages: true',
          ]
        : []),
      '        models:',
      `          - id: ${model}`,
      '- id: acp',
      '  config:',
      '    provider: wevir-real',
      `    model: ${model}`,
      '',
    ].join('\n'),
  );
  return { patches: [file], env: { [keyEnv]: key }, providerId: 'wevir-real', modelId: model };
}
