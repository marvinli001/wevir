import { MethodSchemas } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { t } from '@/i18n';
import { catalogEntry, providerLogo } from './provider-catalog';
import { type EditableProvider, editForm, newOpenAIForm, toUpsertParams } from './provider-form';
import { OPENAI_PRESETS } from './provider-presets';

const preset = OPENAI_PRESETS.find((candidate) => candidate.id === 'xai');
if (preset === undefined) throw new Error('缺少 SpaceXAI 模板');

describe('SpaceXAI 改名与已有配置', () => {
  it('目录和新建显示新名称，保留 ID、地址、标志、模型与四档力度', () => {
    const entry = catalogEntry('xai');
    expect(entry).toMatchObject({
      id: 'xai',
      logo: 'xai',
      group: 'global',
      keyURL: 'https://console.x.ai/team/default/api-keys',
    });
    expect(t(entry?.name ?? 'provider.catalog.xai')).toBe('SpaceXAI');
    expect(preset.note).toBe('provider.preset.xai.note');
    expect(t('provider.preset.xai.note')).toContain('xAI');
    expect(preset.docsURL).toBe('https://docs.x.ai/developers/models');
    const params = MethodSchemas['provider.upsert'].params.parse(
      toUpsertParams(newOpenAIForm(preset, [])),
    );
    if (params.kind !== 'openai-compatible') throw new Error('SpaceXAI 模板的 Provider 类型不对');
    expect(params).toMatchObject({
      id: 'xai',
      displayName: t(preset.name),
      api: 'openai-responses',
      baseURL: 'https://api.x.ai/v1',
      defaultModelId: 'grok-4.7',
      compat: { supportsCustomTools: false, supportsNamespaceTools: false },
    });
    expect(params.models).toEqual([
      {
        id: 'grok-4.7',
        contextWindow: 500000,
        supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      },
      { id: 'grok-build-0.1', contextWindow: 256000 },
    ]);
    expect(params).not.toHaveProperty('apiKey');
    for (const baseURL of ['https://api.x.ai/v1', 'https://us.api.x.ai/v1'])
      expect(providerLogo({ kind: 'openai-compatible', baseURL })).toBe('xai');
  });

  it('已有 xAI Provider 的名字、模型、显式 compat 与 Key 不被新模板覆盖', () => {
    const saved: EditableProvider = {
      id: 'xai',
      kind: 'openai-compatible',
      displayName: 'xAI（我的配置）',
      api: 'openai-responses',
      baseURL: 'https://api.x.ai/v1',
      models: [{ id: 'grok-4.5', contextWindow: 500000, reasoningEfforts: ['high'] }],
      defaultModelId: 'grok-4.5',
      compat: { supportsCustomTools: true, supportsNamespaceTools: true },
      hasSecret: true,
      createdAt: '2026-10-14T00:00:00Z',
      updatedAt: '2026-10-14T00:00:00Z',
    };
    const form = editForm(saved);
    expect(form.preset).toBeUndefined();
    expect(toUpsertParams(form)).toMatchObject({
      id: saved.id,
      displayName: saved.displayName,
      api: saved.api,
      baseURL: saved.baseURL,
      models: saved.models,
      defaultModelId: saved.defaultModelId,
      compat: saved.compat,
    });
    expect(toUpsertParams(form)).not.toHaveProperty('apiKey');
  });
});
