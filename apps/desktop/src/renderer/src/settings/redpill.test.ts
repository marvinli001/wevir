import { MethodSchemas } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { t } from '@/i18n';
import { catalogEntry, providerLogo } from './provider-catalog';
import {
  type EditableProvider,
  editForm,
  newOpenAIForm,
  toUpsertParams,
  validateForm,
} from './provider-form';
import catalog from './test-fixtures/redpill-models.json';

const entry = catalogEntry('redpill');
if (entry?.source?.kind !== 'preset') throw new Error('缺少 RedPill 模板');
const preset = entry.source.preset;

describe('RedPill 多模型入口', () => {
  it('国际目录和 Key 入口使用 RedPill', () => {
    expect(entry).toMatchObject({ group: 'global', keyURL: 'https://www.redpill.ai/dashboard' });
    expect(entry.logo).toBeUndefined();
    expect(providerLogo({ kind: 'openai-compatible', baseURL: preset.baseURL })).toBeUndefined();
    expect(t(preset.name)).toBe('RedPill');
    expect(preset.note).toBeUndefined();
    expect(preset.docsURL).toBe(
      'https://docs.redpill.ai/guides/integrations/coding-tools/codex-cli',
    );
  });

  it('选中的三款模型具有工具声明，保存完整 ID、目录能力与代理 compat', () => {
    const available = catalog.data.filter(
      (model) =>
        model.supported_features.includes('tools') &&
        model.supported_parameters.includes('tools') &&
        model.supported_parameters.includes('tool_choice'),
    );
    expect(preset.models.map((model) => model.id)).toEqual(available.map((model) => model.id));
    expect(preset.models).toHaveLength(3);
    for (const model of preset.models) {
      const metadata = available.find((candidate) => candidate.id === model.id);
      expect(model.contextWindow).toBe(metadata?.context_length);
      expect(model.maxTokens).toBe(metadata?.max_output_length);
      expect(model.supportsImages === true).toBe(metadata?.input_modalities.includes('image'));
      expect(model.reasoningEfforts).toBeUndefined();
    }
    expect(available.map((model) => model.is_tee)).toEqual([false, false, true]);
    const form = { ...newOpenAIForm(preset, []), apiKey: 'placeholder-not-a-real-key' };
    expect(validateForm(form, [])).toEqual({});
    const created = MethodSchemas['provider.upsert'].params.parse(toUpsertParams(form));
    expect(created).toMatchObject({
      id: 'redpill',
      kind: 'openai-compatible',
      api: 'openai-responses',
      baseURL: 'https://api.redpill.ai/v1',
      defaultModelId: 'openai/gpt-5.5',
      models: preset.models,
      compat: {
        supportsCustomTools: false,
        supportsNamespaceTools: false,
        toolChoice: 'auto_only',
      },
    });
    expect(toUpsertParams({ ...form, baseURL: 'https://proxy.example.com/v1' })).toHaveProperty(
      'compat',
      preset.compat,
    );
  });

  it('编辑已有 Provider 保留原协议、模型与显式能力，不套用新模板', () => {
    const saved: EditableProvider = {
      id: 'redpill',
      kind: 'openai-compatible',
      displayName: 'Old RedPill',
      api: 'openai-completions',
      baseURL: 'https://api.redpill.ai/v1',
      defaultModelId: 'custom-model',
      models: [{ id: 'custom-model', contextWindow: 65536 }],
      compat: { supportsCustomTools: true, toolChoice: 'any' },
      hasSecret: true,
      createdAt: '2026-10-17T00:00:00Z',
      updatedAt: '2026-10-17T00:00:00Z',
    };
    const form = editForm(saved);
    expect(form.preset).toBeUndefined();
    const updated = toUpsertParams(form);
    expect(updated).toMatchObject({
      api: saved.api,
      baseURL: saved.baseURL,
      models: saved.models,
      defaultModelId: saved.defaultModelId,
      compat: saved.compat,
    });
    expect(updated).not.toHaveProperty('apiKey');
  });
});
