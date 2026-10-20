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

const entry = catalogEntry('stepfun');
if (entry?.source?.kind !== 'preset') throw new Error('缺少阶跃星辰模板');
const preset = entry.source.preset;

describe('阶跃星辰按量模板', () => {
  it('从国内目录创建两款 Responses 模型，三档思考不含 off', () => {
    expect(entry).toMatchObject({
      logo: 'stepfun',
      group: 'cn',
      keyURL: 'https://platform.stepfun.com/interface-key',
    });
    expect(t(entry.name)).toBe('阶跃星辰');
    expect(preset.note).toBe('provider.preset.stepfun.note');
    expect(t('provider.preset.stepfun.note')).toContain('大陆直连');
    expect(preset.docsURL).toBe(
      'https://platform.stepfun.com/docs/zh/api-reference/responses/responses-create.md',
    );
    const form = { ...newOpenAIForm(preset, []), apiKey: 'placeholder-not-a-real-key' };
    expect(validateForm(form, [])).toEqual({});
    const created = MethodSchemas['provider.upsert'].params.parse(toUpsertParams(form));
    if (created.kind !== 'openai-compatible') throw new Error('阶跃星辰的 Provider 类型不对');
    expect(created).toMatchObject({
      id: 'stepfun',
      displayName: '阶跃星辰',
      api: 'openai-responses',
      baseURL: 'https://api.stepfun.com/v1',
      defaultModelId: 'step-5-preview',
      compat: { supportsCustomTools: true, supportsNamespaceTools: false, toolChoice: 'auto_only' },
    });
    expect(created.models).toEqual([
      {
        id: 'step-5-preview',
        contextWindow: 1000000,
        maxTokens: 64000,
        supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high'],
      },
      {
        id: 'step-3.7-flash',
        contextWindow: 256000,
        supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high'],
      },
    ]);
    for (const baseURL of ['https://api.stepfun.ai/v1', 'https://proxy.example.org/v1']) {
      expect(toUpsertParams({ ...form, baseURL })).toMatchObject({
        baseURL,
        compat: created.compat,
        models: created.models,
      });
    }
    expect(toUpsertParams({ ...form, defaultIndex: 1 })).toHaveProperty(
      'defaultModelId',
      'step-3.7-flash',
    );
  });

  it('标志识别两个站点，拒绝相似域名', () => {
    for (const baseURL of ['https://api.stepfun.com/v1', 'https://api.stepfun.ai/v1'])
      expect(providerLogo({ kind: 'openai-compatible', baseURL })).toBe('stepfun');
    for (const baseURL of [
      'https://api.stepfun.com.example.org/v1',
      'https://notstepfun.ai/v1',
      'https://api.stepfun.com@proxy.example.org/v1',
    ])
      expect(providerLogo({ kind: 'openai-compatible', baseURL })).toBeUndefined();
  });

  it('已有 Chat Provider 的模型、名字、显式配置与 Key 不被模板覆盖', () => {
    const saved: EditableProvider = {
      id: 'stepfun',
      kind: 'openai-compatible',
      displayName: '我的 Step',
      api: 'openai-completions',
      baseURL: 'https://api.stepfun.com/v1',
      models: [{ id: 'step-3.5-flash', contextWindow: 128000, reasoningEfforts: ['low', 'high'] }],
      defaultModelId: 'step-3.5-flash',
      compat: { thinkingFormat: 'openai', supportsNamespaceTools: true, toolChoice: 'any' },
      hasSecret: true,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
    };
    const form = editForm(saved);
    expect(form.preset).toBeUndefined();
    expect(toUpsertParams(form)).toMatchObject({
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
