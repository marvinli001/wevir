import {
  MethodSchemas,
  type ProviderTestFailure,
  ProviderTestFailureSchema,
} from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  connectionChanged,
  deepseekModelChoices,
  type EditableProvider,
  editForm,
  modelRow,
  newDeepSeekForm,
  newOpenAIForm,
  toUpsertParams,
  validateForm,
} from './provider-form';
import { OPENAI_PRESETS } from './provider-presets';
import { presentTestError, presentTestResult } from './provider-test-result';

const kimi = OPENAI_PRESETS.find((preset) => preset.id === 'kimi');
const deepseekOpenAI = OPENAI_PRESETS.find((preset) => preset.id === 'deepseek-openai');
const ollama = OPENAI_PRESETS.find((preset) => preset.id === 'local-ollama');
if (!kimi || !deepseekOpenAI || !ollama) throw new Error('缺少模板');

const upsertSchema = MethodSchemas['provider.upsert'].params;

function profile(overrides: Partial<EditableProvider>): EditableProvider {
  return {
    id: 'kimi',
    kind: 'openai-compatible',
    displayName: 'Kimi',
    api: 'openai-completions',
    baseURL: 'https://api.moonshot.cn/v1',
    models: [{ id: 'kimi-k2.6', contextWindow: 262144, supportsImages: true }],
    defaultModelId: 'kimi-k2.6',
    hasSecret: true,
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('预设模板（providers.md §7）', () => {
  it('每个模板只填 Key 就是合法的 provider.upsert 参数', () => {
    for (const preset of OPENAI_PRESETS) {
      const form = { ...newOpenAIForm(preset, []), apiKey: 'sk-test' };
      expect(validateForm(form, [])).toEqual({});
      const params = toUpsertParams(form);
      expect(upsertSchema.safeParse(params).success, preset.id).toBe(true);
      expect(params).toMatchObject({
        id: preset.id,
        kind: 'openai-compatible',
        api: preset.api,
        baseURL: preset.baseURL,
        defaultModelId: preset.defaultModelId,
        apiKey: 'sk-test',
      });
    }
  });

  it('模板里模型的图片、推理档位原样保留', () => {
    const params = toUpsertParams(newOpenAIForm(deepseekOpenAI, []));
    expect(params.models).toEqual(deepseekOpenAI.models);
  });

  it('建议的 ID 已被占用时加序号', () => {
    expect(newOpenAIForm(kimi, ['kimi']).id).toBe('kimi-2');
    expect(newOpenAIForm(kimi, ['kimi', 'kimi-2']).id).toBe('kimi-3');
  });

  it('本机服务预先填一个任意的 Key', () => {
    expect(newOpenAIForm(ollama, []).apiKey).toBe('ollama');
    expect(newOpenAIForm(kimi, []).apiKey).toBe('');
  });
});

describe('DeepSeek 官方', () => {
  it('ID 固定，模型不列（用 dsh 自带目录），地址留空时不带 baseURL', () => {
    const form = { ...newDeepSeekForm(), apiKey: ' sk-ds ' };
    expect(deepseekModelChoices(form)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(validateForm(form, [])).toEqual({});
    const params = toUpsertParams(form);
    expect(params).toEqual({
      id: 'deepseek-official',
      kind: 'deepseek-official',
      displayName: 'DeepSeek',
      models: [],
      defaultModelId: 'deepseek-flash',
      apiKey: 'sk-ds',
    });
    expect(upsertSchema.safeParse(params).success).toBe(true);
  });

  it('编辑时保留已列出的自定义模型，默认模型只能从中选', () => {
    const form = editForm(
      profile({
        id: 'deepseek-official',
        kind: 'deepseek-official',
        displayName: 'DeepSeek',
        api: undefined,
        baseURL: undefined,
        models: [{ id: 'deepseek-flash', contextWindow: 1000000, supportsImages: true }],
        defaultModelId: 'deepseek-flash',
      }),
    );
    expect(deepseekModelChoices(form)).toEqual(['deepseek-flash']);
    expect(toUpsertParams(form)).toMatchObject({
      models: [{ id: 'deepseek-flash', contextWindow: 1000000, supportsImages: true }],
    });
    expect(validateForm({ ...form, defaultModelId: 'deepseek-v4-pro' }, [])).toHaveProperty(
      'defaultModelId',
    );
  });
});

describe('编辑已有 Provider', () => {
  it('Key 留空时不带 apiKey（Host 保留已存的 Key），表单里也没有 Key', () => {
    const form = editForm(profile({}));
    expect(form.apiKey).toBe('');
    expect(form.hasSecret).toBe(true);
    expect(toUpsertParams(form)).not.toHaveProperty('apiKey');
    expect(toUpsertParams({ ...form, apiKey: 'sk-new' }).apiKey).toBe('sk-new');
  });

  it('ID 被自己占用不算重复；compat 原样带回', () => {
    const form = editForm(profile({ compat: { thinkingFormat: 'qwen' } }));
    expect(validateForm(form, ['kimi'])).toEqual({});
    expect(toUpsertParams(form)).toMatchObject({ compat: { thinkingFormat: 'qwen' } });
  });

  it('改了上下文长度保留其他字段；改了模型 ID 就不再沿用原模型的设置', () => {
    const form = editForm(profile({}));
    const [row] = form.models;
    if (!row) throw new Error('缺少模型行');
    expect(
      toUpsertParams({ ...form, models: [{ ...row, contextWindow: '131072' }] }).models,
    ).toEqual([{ id: 'kimi-k2.6', contextWindow: 131072, supportsImages: true }]);
    expect(
      toUpsertParams({ ...form, models: [{ ...row, id: 'kimi-latest', contextWindow: '' }] })
        .models,
    ).toEqual([{ id: 'kimi-latest' }]);
  });

  it('默认模型跟着选中的那一行', () => {
    const form = editForm(
      profile({
        models: [{ id: 'a' }, { id: 'b' }],
        defaultModelId: 'b',
      }),
    );
    expect(form.defaultIndex).toBe(1);
    expect(toUpsertParams({ ...form, defaultIndex: 0 }).defaultModelId).toBe('a');
  });
});

describe('保存后要不要重测连接', () => {
  it('新建的总要测', () => {
    const form = newOpenAIForm(kimi, []);
    expect(connectionChanged(form, form)).toBe(true);
    expect(connectionChanged(newDeepSeekForm(), newDeepSeekForm())).toBe(true);
  });

  it('编辑时只改名称或增加非默认模型不测；改 Key、地址、协议、默认模型要测', () => {
    const initial = editForm(profile({ models: [{ id: 'a' }, { id: 'b' }], defaultModelId: 'a' }));
    expect(connectionChanged(initial, { ...initial, displayName: '新名字' })).toBe(false);
    expect(
      connectionChanged(initial, {
        ...initial,
        models: [...initial.models, modelRow({ id: 'c' })],
      }),
    ).toBe(false);
    expect(connectionChanged(initial, { ...initial, apiKey: 'sk-new' })).toBe(true);
    expect(connectionChanged(initial, { ...initial, baseURL: 'https://api.moonshot.ai/v1' })).toBe(
      true,
    );
    expect(connectionChanged(initial, { ...initial, api: 'openai-responses' })).toBe(true);
    expect(connectionChanged(initial, { ...initial, defaultIndex: 1 })).toBe(true);
  });

  it('DeepSeek 官方换默认模型要测', () => {
    const initial = editForm(
      profile({
        id: 'deepseek-official',
        kind: 'deepseek-official',
        api: undefined,
        baseURL: undefined,
        models: [],
        defaultModelId: 'deepseek-flash',
      }),
    );
    expect(connectionChanged(initial, { ...initial, displayName: 'DS' })).toBe(false);
    expect(connectionChanged(initial, { ...initial, defaultModelId: 'deepseek-v4-pro' })).toBe(
      true,
    );
  });
});

describe('本地检查', () => {
  const blank = newOpenAIForm(undefined, []);

  it('空白表单：名称、ID、地址、模型 ID 都必填', () => {
    expect(Object.keys(validateForm(blank, [])).sort()).toEqual(
      ['baseURL', 'displayName', 'id', 'models.0.id'].sort(),
    );
  });

  it('ID 的格式、dsh 占用的路由名、已有的 ID', () => {
    const base = { ...newOpenAIForm(kimi, []) };
    expect(validateForm({ ...base, id: 'Kimi' }, [])).toHaveProperty('id');
    expect(validateForm({ ...base, id: 'deepseek-official' }, [])).toHaveProperty('id');
    expect(validateForm({ ...base, id: 'deepseek-account' }, [])).toHaveProperty('id');
    expect(validateForm({ ...base, id: 'kimi' }, ['kimi'])).toHaveProperty('id');
  });

  it('地址只能是 http / https，不能带凭据、查询参数或片段', () => {
    const base = newOpenAIForm(kimi, []);
    for (const baseURL of [
      'ftp://example.com',
      'api.moonshot.cn/v1',
      'https://user:pw@example.com/v1',
      'https://example.com/v1?key=1',
      'https://example.com/v1#x',
    ]) {
      expect(validateForm({ ...base, baseURL }, []), baseURL).toHaveProperty('baseURL');
    }
    expect(validateForm({ ...base, baseURL: 'http://127.0.0.1:8000/v1' }, [])).toEqual({});
  });

  it('模型 ID 不能重复，上下文长度是正整数，至少一个模型', () => {
    const base = newOpenAIForm(kimi, []);
    const rows = [modelRow({ id: 'm' }), { ...modelRow({ id: 'm' }), contextWindow: '1.5' }];
    expect(validateForm({ ...base, models: rows }, [])).toEqual({
      'models.1.id': expect.any(String),
      'models.1.contextWindow': expect.any(String),
    });
    expect(validateForm({ ...base, models: [] }, [])).toHaveProperty('models');
  });
});

describe('测试连接的结果', () => {
  it('成功：带用时，不到 1 秒用毫秒', () => {
    expect(presentTestResult({ ok: true, latencyMs: 812 }).title).toBe('连接成功，用时 812 毫秒');
    expect(presentTestResult({ ok: true, latencyMs: 2345 }).title).toBe('连接成功，用时 2.3 秒');
    expect(presentTestResult({ ok: true }).title).toBe('连接成功');
  });

  it('每种失败原因都有中文结论与建议，原文放在详情里', () => {
    const titles = new Set<string>();
    for (const reason of ProviderTestFailureSchema.options as ProviderTestFailure[]) {
      const presentation = presentTestResult({
        ok: false,
        reason,
        error: { category: 'provider', message: `原文 ${reason}` },
      });
      expect(presentation.ok).toBe(false);
      expect(presentation.title).toMatch(/[一-龥]/);
      expect(presentation.hint).toMatch(/[一-龥]/);
      expect(presentation.detail).toBe(`原文 ${reason}`);
      titles.add(presentation.title);
    }
    expect(titles.size).toBe(ProviderTestFailureSchema.options.length);
  });

  it('没有 reason 的旧 Host 按“测试失败”处理', () => {
    expect(
      presentTestResult({ ok: false, error: { category: 'unknown', message: 'x' } }).title,
    ).toBe('测试失败');
  });

  it('测试没能完成时如实说明', () => {
    expect(presentTestError(new Error('connection lost'))).toEqual({
      ok: false,
      title: '测试没有完成',
      detail: 'connection lost',
    });
  });
});
