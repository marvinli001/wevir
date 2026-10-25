import { MethodSchemas } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { t } from '@/i18n';
import { catalogEntry, providerLogo } from './provider-catalog';
import { newOpenAIForm, toUpsertParams, validateForm } from './provider-form';

const upsertSchema = MethodSchemas['provider.upsert'].params;
const conservative = {
  supportsCustomTools: false,
  supportsNamespaceTools: false,
  toolChoice: 'auto_only',
};

function presetOf(id: string) {
  const entry = catalogEntry(id);
  if (entry?.source?.kind !== 'preset') throw new Error(`缺少 ${id} 模板`);
  return { entry, preset: entry.source.preset };
}

describe('Responses 聚合与按量服务模板', () => {
  it.each([
    {
      id: 'openrouter',
      group: 'global',
      name: 'OpenRouter',
      keyURL: 'https://openrouter.ai/keys',
      baseURL: 'https://openrouter.ai/api/v1',
      defaultModelId: 'openai/gpt-6.1-sol',
      models: [
        'openai/gpt-6.1-sol',
        'anthropic/claude-opus-5.5',
        'google/gemini-4-argon',
        'moonshotai/kimi-k3.1-pro',
      ],
      compat: conservative,
    },
    {
      id: 'vercel',
      group: 'global',
      name: 'Vercel AI Gateway',
      keyURL: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys',
      baseURL: 'https://ai-gateway.vercel.sh/v1',
      defaultModelId: 'openai/gpt-6-astra',
      models: [
        'openai/gpt-6-astra',
        'anthropic/claude-opus-5.5',
        'google/gemini-4-argon',
        'moonshotai/kimi-k3.1-pro',
      ],
      compat: conservative,
    },
    {
      id: 'groq',
      group: 'global',
      name: 'Groq',
      keyURL: 'https://console.groq.com/keys',
      baseURL: 'https://api.groq.com/openai/v1',
      defaultModelId: 'openai/gpt-oss-120b',
      models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
      compat: { supportsCustomTools: false, supportsNamespaceTools: false, toolChoice: 'any' },
    },
    {
      id: 'fireworks',
      group: 'global',
      name: 'Fireworks AI',
      keyURL: 'https://app.fireworks.ai/settings/users/api-keys',
      baseURL: 'https://api.fireworks.ai/inference/v1',
      defaultModelId: 'accounts/fireworks/models/kimi-k3',
      models: ['accounts/fireworks/models/kimi-k3', 'accounts/fireworks/models/glm-5p3'],
      compat: { supportsCustomTools: false, supportsNamespaceTools: true, toolChoice: 'any' },
    },
    {
      id: 'volcengine',
      group: 'cn',
      name: '火山方舟',
      keyURL: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      defaultModelId: 'doubao-seed-2-1-pro-260915',
      models: [
        'doubao-seed-2-1-pro-260915',
        'deepseek-v4-pro-ga-260813',
        'kimi-k3-1-pro-261024',
        'glm-5-2-260617',
      ],
      compat: conservative,
    },
  ])('$id：目录、标志、模型与代理沿用的 compat', (expected) => {
    const { entry, preset } = presetOf(expected.id);
    expect(entry).toMatchObject({
      group: expected.group,
      logo: expected.id,
      keyURL: expected.keyURL,
    });
    expect(t(preset.name)).toBe(expected.name);
    expect(providerLogo({ kind: 'openai-compatible', baseURL: preset.baseURL })).toBe(expected.id);
    expect(preset.models.map((model) => model.id)).toEqual(expected.models);
    for (const model of preset.models) expect(model.contextWindow).toBeGreaterThan(0);
    const form = { ...newOpenAIForm(preset, []), apiKey: 'placeholder-not-a-real-key' };
    expect(validateForm(form, [])).toEqual({});
    const created = upsertSchema.parse(toUpsertParams(form));
    expect(created).toMatchObject({
      id: expected.id,
      kind: 'openai-compatible',
      api: 'openai-responses',
      baseURL: expected.baseURL,
      defaultModelId: expected.defaultModelId,
      models: preset.models,
      compat: expected.compat,
    });
    expect(toUpsertParams({ ...form, baseURL: 'https://proxy.example.com/v1' })).toHaveProperty(
      'compat',
      preset.compat,
    );
  });

  it('只有模型目录给出力度的才列档位', () => {
    expect(presetOf('fireworks').preset.models[1]?.reasoningEfforts).toBeUndefined();
    expect(presetOf('groq').preset.models[2]?.reasoningEfforts).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ]);
    expect(presetOf('openrouter').preset.models[3]?.reasoningEfforts).toEqual([
      'off',
      'low',
      'high',
      'max',
    ]);
    expect(presetOf('vercel').preset.models[3]?.reasoningEfforts).toEqual(['low', 'high', 'max']);
  });

  it.each([
    'https://openrouter.ai.example.com/api/v1',
    'https://gateway.vercel.sh/v1',
    'https://groq.com/openai/v1',
    'https://ark.cn-beijing.volces.com.example.com/api/v3',
  ])('%s 不认作对应服务的标志', (baseURL) => {
    expect(providerLogo({ kind: 'openai-compatible', baseURL })).toBeUndefined();
  });
});

describe('Amazon Bedrock（Mantle，API Key）', () => {
  it.each([
    {
      id: 'bedrock',
      api: 'openai-responses',
      path: '/openai/v1',
      defaultModelId: 'openai.gpt-6.1-sol',
      models: ['openai.gpt-6.1-sol', 'openai.gpt-6-astra', 'openai.gpt-6-luna'],
      compat: conservative,
    },
    {
      id: 'bedrock-claude',
      api: 'anthropic-messages',
      path: '/anthropic/v1',
      defaultModelId: 'anthropic.claude-opus-5-5',
      models: ['anthropic.claude-opus-5-5'],
      compat: { thinkingFormat: 'adaptive', systemMessageMode: 'inline', toolChoice: 'auto_only' },
    },
  ])('$id 的地域未替换前不能保存，替换后按地域保存', (expected) => {
    const { entry, preset } = presetOf(expected.id);
    expect(entry).toMatchObject({
      group: 'global',
      logo: 'bedrock',
      keyURL: 'https://console.aws.amazon.com/bedrock/home#/api-keys/long-term/create',
    });
    expect(preset.note).toBeDefined();
    expect(preset.baseURL).toBe(`https://bedrock-mantle.<region>.api.aws${expected.path}`);
    expect(preset.models.map((model) => model.id)).toEqual(expected.models);
    const form = { ...newOpenAIForm(preset, []), apiKey: 'placeholder-not-a-real-key' };
    expect(Object.keys(validateForm(form, []))).toEqual(['baseURL']);
    const regional = { ...form, baseURL: form.baseURL.replace('<region>', 'us-east-1') };
    expect(validateForm(regional, [])).toEqual({});
    expect(providerLogo({ kind: 'openai-compatible', baseURL: regional.baseURL })).toBe('bedrock');
    const created = upsertSchema.parse(toUpsertParams(regional));
    expect(created).toMatchObject({
      id: expected.id,
      kind: 'openai-compatible',
      api: expected.api,
      baseURL: `https://bedrock-mantle.us-east-1.api.aws${expected.path}`,
      defaultModelId: expected.defaultModelId,
      models: preset.models,
      compat: expected.compat,
    });
  });

  it('只认 Mantle 主机名的标志', () => {
    for (const baseURL of [
      'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
      'https://bedrock-mantle.us-east-1.api.aws.example.com/openai/v1',
    ])
      expect(providerLogo({ kind: 'openai-compatible', baseURL })).toBeUndefined();
  });
});
