// 生成 --patch overlay 文件。只写非密钥参数（baseURL、模型、apiKeyEnv 变量名）。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, GENERATED_DIR, KEY_ENV, SPIKE_DIR, type Target, target } from './env.ts';

export const DEEPSEEK_OFFICIAL_OVERLAY = join(SPIKE_DIR, 'overlays/deepseek-official.yml');

/**
 * 与 overlays/openai-compatible.example.yml 同结构，填入当前目标的 baseURL 与模型。
 * `acpRow: false` 用于 sdk profile：那里没有 acp 条目，路由由 SDK initialize 参数决定。
 */
export function writeProviderOverlay(
  t: Target = target(),
  { acpRow = true }: { acpRow?: boolean } = {},
): string {
  const isDeepSeek = /(^|\.)deepseek\.com$/.test(new URL(t.baseURL).hostname);
  // DeepSeek 的 OpenAI 兼容端点：思考默认开启，回放 assistant 消息需要 reasoning_content。
  const deepseekCompat = isDeepSeek
    ? [
        '          thinkingFormat: deepseek',
        '          requiresReasoningContentOnAssistantMessages: true',
        '          supportsStore: false',
      ]
    : [];
  const yaml = [
    '# 由 src/overlays.ts 生成；不含密钥。',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${t.providerId}:`,
    '        displayName: Wevir Spike',
    `        apiKeyEnv: ${KEY_ENV}`,
    '        api: openai-completions',
    `        baseURL: ${t.baseURL}`,
    '        compat:',
    '          supportsDeveloperRole: false',
    '          maxTokensField: max_tokens',
    ...deepseekCompat,
    '        models:',
    `          - id: ${t.model}`,
    '',
    ...(acpRow
      ? ['- id: acp', '  config:', `    provider: ${t.providerId}`, `    model: ${t.model}`, '']
      : []),
  ].join('\n');
  const name = `provider-${t.kind}${acpRow ? '' : '.sdk'}.yml`;
  const file = join(ensureDir(GENERATED_DIR), name);
  writeFileSync(file, yaml);
  return file;
}

/** mock 模式下把 deepseek-official 路由指到本地 mock 的 Anthropic Messages 端点。 */
export function writeDeepSeekOfficialMockOverlay(mockOrigin: string): string {
  const yaml = [
    '# 由 src/overlays.ts 生成：deepseek-official 最小配置 + 指向本地 mock 的 baseURL。',
    '- id: llm-deepseek',
    '  config:',
    `    apiKeyEnv: ${KEY_ENV}`,
    `    baseURL: ${mockOrigin}/anthropic`,
    '',
  ].join('\n');
  const file = join(ensureDir(GENERATED_DIR), 'deepseek-official-mock.yml');
  writeFileSync(file, yaml);
  return file;
}
