import {
  MethodSchemas,
  type ProviderTestFailure,
  ProviderTestFailureSchema,
} from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { catalogAvailable, catalogEntry, providerLogo } from './provider-catalog';
import {
  ASSUMED_CONTEXT_WINDOW,
  connectionChanged,
  contextWindowMissing,
  deepseekModelChoices,
  type EditableProvider,
  editForm,
  hasProviderPlaceholder,
  modelRow,
  newDeepSeekForm,
  newOpenAIForm,
  serviceAccountEmail,
  toUpsertParams,
  validateForm,
} from './provider-form';
import {
  DEEPSEEK_OFFICIAL_PRESET,
  OPENAI_PRESETS,
  type OpenAIPreset,
  VERTEX_PRESETS,
} from './provider-presets';
import { presentTestError, presentTestResult } from './provider-test-result';

const kimi = OPENAI_PRESETS.find((preset) => preset.id === 'kimi');
const deepseekOpenAI = OPENAI_PRESETS.find((preset) => preset.id === 'deepseek-openai');
const ollama = OPENAI_PRESETS.find((preset) => preset.id === 'local-ollama');
if (!kimi || !deepseekOpenAI || !ollama) throw new Error('缺少模板');

const upsertSchema = MethodSchemas['provider.upsert'].params;

describe('Azure 模板与通用占位', () => {
  it.each(['azure-openai', 'azure-claude'])('%s 的资源名和每一条部署名未替换前不能保存', (id) => {
    const entry = catalogEntry(id);
    if (entry?.source?.kind !== 'preset') throw new Error('缺少 Azure 模板');
    expect(entry).toMatchObject({ group: 'global', logo: 'azure', keyURL: 'https://ai.azure.com' });
    const preset = entry.source.preset;
    const form = newOpenAIForm(preset, []);
    expect(Object.keys(validateForm(form, [])).sort()).toEqual([
      'baseURL',
      'models.0.id',
      'models.1.id',
      'models.2.id',
    ]);
    const renamed = {
      ...form,
      baseURL: form.baseURL.replace('<resource>', 'my-resource'),
      models: form.models.map((row, i) => ({ ...row, id: `production-${i}` })),
      defaultIndex: 1,
    };
    expect(validateForm(renamed, [])).toEqual({});
    const created = upsertSchema.parse(toUpsertParams(renamed));
    if (created.kind !== 'openai-compatible') throw new Error('Azure 模板的 Provider 类型不对');
    expect(created).toMatchObject({
      api: id === 'azure-openai' ? 'openai-responses' : 'anthropic-messages',
      baseURL: renamed.baseURL,
      defaultModelId: 'production-1',
      models: preset.models.map((model, i) => ({ ...model, id: `production-${i}` })),
    });
    expect(created).not.toHaveProperty('apiKey');
    if (id === 'azure-claude') {
      expect(created).toHaveProperty('compat', {
        thinkingFormat: 'adaptive',
        systemMessageMode: 'inline',
      });
      expect(preset.models.map((model) => model.displayName)).toEqual([
        'Claude Sonnet 5.5',
        'Claude Opus 5.5',
        'Claude Haiku 5.5',
      ]);
      for (const model of preset.models) expect(model.reasoningEfforts).not.toContain('off');
    } else {
      expect(created).not.toHaveProperty('compat');
      expect(preset.models[2]?.reasoningEfforts).toContain('off');
    }
    const saved = profile({ ...created, hasSecret: true } as Partial<EditableProvider>);
    expect(toUpsertParams(editForm(saved))).toMatchObject({
      models: created.models,
      defaultModelId: created.defaultModelId,
    });
  });

  it('删除未部署的行后只保存现有行，默认部署跟随所选行', () => {
    const form = newOpenAIForm(
      OPENAI_PRESETS.find((preset) => preset.id === 'azure-openai'),
      [],
    );
    const selected = form.models[2];
    if (!selected) throw new Error('缺少 Luna 占位行');
    const filled = {
      ...form,
      baseURL: 'https://resource.openai.azure.com/openai/v1',
      models: [{ ...selected, id: 'my-luna' }],
      defaultIndex: 0,
    };
    expect(validateForm(filled, [])).toEqual({});
    expect(toUpsertParams(filled)).toMatchObject({
      defaultModelId: 'my-luna',
      models: [
        {
          id: 'my-luna',
          maxTokens: 128000,
          reasoningEfforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
      ],
    });
  });

  it.each(['<resource>', '{WorkspaceId}', '%3Cresource%3E', '%7Bproject%7D'])(
    '占位 %s 在自定义模板、URL 路径和模型 ID 上同样阻止保存',
    (placeholder) => {
      const form = newOpenAIForm(kimi, []);
      expect(hasProviderPlaceholder(placeholder)).toBe(true);
      expect(
        validateForm({ ...form, baseURL: `https://example.com/${placeholder}/v1` }, []),
      ).toHaveProperty('baseURL');
      expect(
        validateForm(
          {
            ...form,
            models: [
              { ...form.models[0], key: 'test', id: placeholder, contextWindow: '', images: false },
            ],
          },
          [],
        ),
      ).toHaveProperty('models.0.id');
    },
  );

  it('Azure 三种主机名显示标志，不匹配世纪互联与伪装域名', () => {
    for (const domain of [
      'openai.azure.com',
      'services.ai.azure.com',
      'cognitiveservices.azure.com',
    ]) {
      expect(
        providerLogo({
          kind: 'openai-compatible',
          baseURL: `https://my-resource.${domain}/openai/v1`,
        }),
      ).toBe('azure');
      expect(
        providerLogo({
          kind: 'openai-compatible',
          baseURL: `https://my-resource.${domain}.example.com/v1`,
        }),
      ).toBeUndefined();
    }
    expect(
      providerLogo({
        kind: 'openai-compatible',
        baseURL: 'https://resource.openai.azure.cn/openai/v1',
      }),
    ).toBeUndefined();
  });
});

describe('Vertex 服务账号表单', () => {
  const account = JSON.stringify({
    type: 'service_account',
    client_email: 'agent@vertex-example.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----fake-test-key',
  });
  it.each(VERTEX_PRESETS)('$api 保存 project/location 与对应模型，JSON 只走密钥字段', (preset) => {
    const empty = newOpenAIForm(preset, []);
    expect(validateForm(empty, [])).toHaveProperty('vertex.project');
    const form = {
      ...empty,
      vertex: { project: 'vertex-example', location: 'global' },
      serviceAccountJson: account,
    };
    expect(validateForm(form, [])).toEqual({});
    const params = upsertSchema.parse(toUpsertParams(form));
    expect(params).toMatchObject({
      kind: 'google-vertex',
      api: preset.api,
      vertex: form.vertex,
      models: preset.models,
      serviceAccountJson: account,
    });
    expect(params).not.toHaveProperty('apiKey');
    expect(params).not.toHaveProperty('baseURL');
    expect(serviceAccountEmail(account)).toBe('agent@vertex-example.iam.gserviceaccount.com');
    expect(serviceAccountEmail('{broken')).toBeUndefined();
  });

  it('编辑时不带回密钥，project/location 或协议变化需要重新测试', () => {
    const form = editForm(
      profile({
        kind: 'google-vertex',
        id: 'vertex',
        api: 'openai-completions',
        vertex: { project: 'vertex-example' },
        models: [{ id: 'google/gemini-3.8-flash' }],
        defaultModelId: 'google/gemini-3.8-flash',
        baseURL: undefined,
      }),
    );
    expect(toUpsertParams(form)).not.toHaveProperty('serviceAccountJson');
    expect(toUpsertParams(form)).not.toHaveProperty('apiKey');
    expect(connectionChanged(form, { ...form, displayName: 'New name' })).toBe(false);
    expect(connectionChanged(form, { ...form, vertex: { project: 'other-project' } })).toBe(true);
    expect(
      connectionChanged(form, { ...form, vertex: { project: 'vertex-example', location: 'us' } }),
    ).toBe(true);
    expect(connectionChanged(form, { ...form, serviceAccountJson: account })).toBe(true);
    expect(connectionChanged(form, { ...form, api: 'anthropic-messages' })).toBe(true);
  });

  it('错误不含 JSON/私钥；不接受路径注入、混合发布方或非法 location', () => {
    const form = newOpenAIForm(VERTEX_PRESETS[0], []);
    const errors = validateForm(
      {
        ...form,
        vertex: { project: '../escape', location: 'a/b' },
        serviceAccountJson: 'invalid-private-key',
      },
      [],
    );
    expect(errors).toHaveProperty('vertex.project');
    expect(errors).toHaveProperty('vertex.location');
    expect(errors).toHaveProperty('serviceAccountJson');
    expect(JSON.stringify(errors)).not.toContain('invalid-private-key');
    expect(
      validateForm(
        {
          ...form,
          vertex: { project: 'vertex-example' },
          models: [modelRow({ id: 'claude-sonnet-5-5' })],
        },
        [],
      ),
    ).toHaveProperty('models.0.id');
  });

  it('目录已可选，旧 Host 入口关闭，标志认新 kind 与地域域名', () => {
    const entry = catalogEntry('google-vertex');
    expect(entry?.source).toBeDefined();
    expect(catalogAvailable(entry, true)).toBe(true);
    expect(catalogAvailable(entry, false)).toBe(false);
    expect(providerLogo({ kind: 'google-vertex' })).toBe('vertex');
    expect(
      providerLogo({ kind: 'openai-compatible', baseURL: 'https://us-aiplatform.googleapis.com' }),
    ).toBe('vertex');
  });
});

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
  it('百炼按量目录保存 Responses、三款 Qwen、明确档位与代理所需的工具 compat', () => {
    const entry = catalogEntry('dashscope');
    if (entry?.source?.kind !== 'preset') throw new Error('缺少百炼模板');
    expect(entry).toMatchObject({
      group: 'cn',
      logo: 'qwen',
      keyURL: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
    });
    const preset = entry.source.preset;
    expect(preset.docsURL).toBe('https://help.aliyun.com/zh/model-studio/codex');
    const form = { ...newOpenAIForm(preset, []), apiKey: 'placeholder-not-a-real-key' };
    expect(validateForm(form, [])).toEqual({});
    const created = upsertSchema.parse(toUpsertParams(form));
    if (created.kind !== 'openai-compatible') throw new Error('百炼模板的 Provider 类型不对');
    expect(created).toMatchObject({
      api: 'openai-responses',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      defaultModelId: 'qwen3.8-max',
      compat: {
        supportsCustomTools: false,
        supportsNamespaceTools: false,
        toolChoice: 'auto_only',
      },
    });
    expect(created.models).toEqual([
      {
        id: 'qwen3.8-max',
        contextWindow: 1000000,
        supportsImages: true,
        reasoningEfforts: ['off', 'low', 'medium', 'xhigh'],
      },
      {
        id: 'qwen3.8-flash',
        contextWindow: 1000000,
        reasoningEfforts: ['off', 'low', 'medium', 'xhigh'],
      },
      {
        id: 'qwen3.7-plus',
        contextWindow: 1000000,
        supportsImages: true,
        reasoningEfforts: ['off', 'low', 'medium', 'high', 'xhigh'],
      },
    ]);
    expect(toUpsertParams({ ...form, baseURL: 'https://proxy.example.com/v1' })).toHaveProperty(
      'compat',
      created.compat,
    );
  });

  it('已有百炼 Chat Provider 经编辑仍保留旧模型、地址与显式 compat', () => {
    const old = profile({
      id: 'dashscope',
      displayName: '通义千问',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: [{ id: 'qwen-plus', contextWindow: 131072 }],
      defaultModelId: 'qwen-plus',
      compat: { thinkingFormat: 'qwen', supportsCustomTools: true },
    });
    const edited = upsertSchema.parse(toUpsertParams(editForm(old)));
    expect(edited).toMatchObject({
      api: 'openai-completions',
      baseURL: old.baseURL,
      models: old.models,
      defaultModelId: old.defaultModelId,
      compat: old.compat,
    });
    expect(edited).not.toHaveProperty('apiKey');
  });

  it('百炼标志认两个旧域名与 maas 专属域名，不认相似域名或其他阿里云服务', () => {
    for (const host of [
      'dashscope.aliyuncs.com',
      'dashscope-intl.aliyuncs.com',
      'workspace.cn-beijing.maas.aliyuncs.com',
    ]) {
      expect(providerLogo({ kind: 'openai-compatible', baseURL: `https://${host}/v1` })).toBe(
        'qwen',
      );
    }
    for (const host of ['maas.aliyuncs.com.example.com', 'ecs.aliyuncs.com']) {
      expect(
        providerLogo({ kind: 'openai-compatible', baseURL: `https://${host}/v1` }),
      ).toBeUndefined();
    }
  });

  it('Gemini 按量目录用 Chat 与已有标志，模型不列 off / minimal，Schema 清洗默认关闭', () => {
    const entry = catalogEntry('google-ai-studio');
    if (entry?.source?.kind !== 'preset') throw new Error('缺少 Gemini 模板');
    const preset = entry.source.preset;
    expect(entry).toMatchObject({
      group: 'global',
      logo: 'gemini',
      keyURL: 'https://aistudio.google.com/apikey',
    });
    expect(preset).toMatchObject({
      api: 'openai-completions',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      docsURL: 'https://ai.google.dev/gemini-api/docs/openai',
    });
    expect(preset.compat?.geminiToolSchema).not.toBe(true);
    expect(preset.models.map((model) => model.id)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.1-pro-preview',
      'gemini-4-argon',
    ]);
    expect(preset.defaultModelId).toBe('gemini-3.8-flash');
    for (const model of preset.models)
      expect(model).toMatchObject({
        contextWindow: 1048576,
        maxTokens: 65536,
        supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high'],
      });
    expect(providerLogo({ kind: 'openai-compatible', baseURL: preset.baseURL })).toBe('gemini');
    for (const apiKey of ['AQ.mock-not-a-real-key', 'AIza-mock-not-a-real-key']) {
      const form = { ...newOpenAIForm(preset, []), apiKey };
      expect(validateForm(form, [])).toEqual({});
      expect(upsertSchema.parse(toUpsertParams(form))).toMatchObject({
        apiKey,
        models: preset.models,
      });
    }
  });

  it('已有 Gemini Profile 的模型不套新模板，手动 Schema 开关经编辑与协议解析保留', () => {
    const original = profile({
      id: 'gemini',
      models: [{ id: 'gemini-old' }],
      defaultModelId: 'gemini-old',
      compat: { geminiToolSchema: true },
    });
    const form = editForm(original);
    expect(upsertSchema.parse(toUpsertParams(form))).toMatchObject({
      models: original.models,
      defaultModelId: original.defaultModelId,
      compat: original.compat,
    });
  });
  it('新建与编辑都保留 namespace / toolChoice，经过协议解析也不丢开关', () => {
    const preset: OpenAIPreset = {
      ...kimi,
      compat: { supportsNamespaceTools: false, toolChoice: 'auto_only' },
    };
    const created = upsertSchema.parse(toUpsertParams(newOpenAIForm(preset, [])));
    expect(created).toMatchObject({ compat: preset.compat });
    const form = editForm(profile({ compat: preset.compat }));
    expect(upsertSchema.parse(toUpsertParams({ ...form, displayName: '改名' }))).toMatchObject({
      displayName: '改名',
      compat: preset.compat,
    });
  });
  it('每个模板填 Key 并替换资源与部署占位后都是合法的 provider.upsert 参数', () => {
    for (const preset of OPENAI_PRESETS) {
      const initial = newOpenAIForm(preset, []);
      const form = {
        ...initial,
        apiKey: 'sk-test',
        baseURL: initial.baseURL.replace('<resource>', 'my-resource'),
        models: (initial.models.length > 0
          ? initial.models
          : [modelRow({ id: 'discovered-model', contextWindow: 65536 })]
        ).map((row, index) =>
          hasProviderPlaceholder(row.id) ? { ...row, id: `deployment-${index}` } : row,
        ),
      };
      expect(validateForm(form, [])).toEqual({});
      const params = toUpsertParams(form);
      expect(upsertSchema.safeParse(params).success, preset.id).toBe(true);
      expect(params).toMatchObject({
        id: preset.id,
        kind: 'openai-compatible',
        api: preset.api,
        baseURL: form.baseURL,
        defaultModelId: form.models[form.defaultIndex]?.id,
        apiKey: 'sk-test',
      });
    }
  });

  it('模板里模型的图片、推理档位原样保留', () => {
    const params = toUpsertParams(newOpenAIForm(deepseekOpenAI, []));
    expect(params.models).toEqual(deepseekOpenAI.models);
  });

  it('OpenAI 目录使用 Responses 模板，只有 Luna 提供关闭推理，保存后仍保留各模型的档位', () => {
    const entry = catalogEntry('openai');
    if (entry?.source?.kind !== 'preset') throw new Error('缺少 OpenAI 模板');
    const params = upsertSchema.parse(toUpsertParams(newOpenAIForm(entry.source.preset, [])));
    if (params.kind !== 'openai-compatible') throw new Error('OpenAI 模板的 Provider 类型不对');
    expect(params).toMatchObject({
      api: 'openai-responses',
      baseURL: 'https://api.openai.com/v1',
      defaultModelId: 'gpt-6.1-sol',
    });
    const five = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect(params.models.map(({ id, reasoningEfforts }) => ({ id, reasoningEfforts }))).toEqual([
      { id: 'gpt-6.1-sol', reasoningEfforts: five },
      { id: 'gpt-6-astra', reasoningEfforts: five },
      { id: 'gpt-6-luna', reasoningEfforts: ['off', ...five] },
    ]);
  });

  it('编辑旧 OpenAI Provider 不自动把 Luna 的档位换成新模板', () => {
    const models: EditableProvider['models'] = [
      { id: 'gpt-6-luna', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ];
    const form = editForm(
      profile({
        id: 'openai',
        api: 'openai-responses',
        baseURL: 'https://api.openai.com/v1',
        models,
        defaultModelId: 'gpt-6-luna',
      }),
    );
    const params = upsertSchema.parse(toUpsertParams(form));
    expect(params).toMatchObject({ models });
    expect(params).not.toHaveProperty('apiKey');
  });

  it('Anthropic 目录的按量模板保存四款模型、五档思考与代理所需 compat，编辑旧 Profile 不套模板', () => {
    const entry = catalogEntry('anthropic');
    if (entry?.source?.kind !== 'preset') throw new Error('缺少 Anthropic 模板');
    expect(entry).toMatchObject({
      group: 'global',
      logo: 'anthropic',
      keyURL: 'https://platform.claude.com/settings/keys',
    });
    const created = upsertSchema.parse(toUpsertParams(newOpenAIForm(entry.source.preset, [])));
    if (created.kind !== 'openai-compatible') throw new Error('Anthropic 模板的 Provider 类型不对');
    expect(created).toMatchObject({
      api: 'anthropic-messages',
      baseURL: 'https://api.anthropic.com',
      defaultModelId: 'claude-opus-5-5',
      compat: { thinkingFormat: 'adaptive', systemMessageMode: 'inline' },
    });
    expect(created.models.map(({ id }) => id)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5-1',
    ]);
    for (const model of created.models) {
      expect(model).toMatchObject({
        contextWindow: 1000000,
        maxTokens: 128000,
        supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      });
    }
    const old = profile({
      id: 'anthropic',
      api: 'anthropic-messages',
      baseURL: 'https://proxy.example.com',
      models: [{ id: 'claude-opus-5-5' }],
      defaultModelId: 'claude-opus-5-5',
      compat: { systemMessageMode: 'user' },
    });
    const edited = upsertSchema.parse(toUpsertParams(editForm(old)));
    expect(edited).toMatchObject({ baseURL: old.baseURL, models: old.models, compat: old.compat });
    expect(edited).not.toHaveProperty('apiKey');
  });

  it('建议的 ID 已被占用时加序号', () => {
    expect(newOpenAIForm(kimi, ['kimi']).id).toBe('kimi-2');
    expect(newOpenAIForm(kimi, ['kimi', 'kimi-2']).id).toBe('kimi-3');
  });

  it('本机服务预先填一个任意的 Key', () => {
    expect(newOpenAIForm(ollama, []).apiKey).toBe('ollama');
    expect(newOpenAIForm(kimi, []).apiKey).toBe('');
  });

  it('模板的 compat 带进 Provider：xAI 不支持自定义工具；没写 compat 的模板不带', () => {
    const xai = OPENAI_PRESETS.find((preset) => preset.id === 'xai');
    expect(toUpsertParams(newOpenAIForm(xai, []))).toMatchObject({
      compat: { supportsCustomTools: false },
    });
    const gemini = OPENAI_PRESETS.find((preset) => preset.id === 'gemini');
    expect(toUpsertParams(newOpenAIForm(gemini, []))).not.toHaveProperty('compat');
  });
});

describe('DeepSeek 官方', () => {
  it('ID 固定，新建时显式列出 Codex 所需的模型能力，地址留空时不带 baseURL', () => {
    const form = { ...newDeepSeekForm(), apiKey: ' sk-ds ' };
    expect(deepseekModelChoices(form)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(validateForm(form, [])).toEqual({});
    const params = toUpsertParams(form);
    expect(params).toEqual({
      id: 'deepseek-official',
      kind: 'deepseek-official',
      displayName: 'DeepSeek',
      models: [
        {
          id: 'deepseek-flash',
          contextWindow: 1048576,
          supportsImages: true,
          reasoningEfforts: ['off', 'low', 'high', 'max'],
        },
        {
          id: 'deepseek-v4-pro',
          contextWindow: 1048576,
          reasoningEfforts: ['off', 'low', 'high', 'max'],
        },
      ],
      defaultModelId: 'deepseek-flash',
      apiKey: 'sk-ds',
    });
    expect(upsertSchema.safeParse(params).success).toBe(true);
    expect(form.preset).toBe(DEEPSEEK_OFFICIAL_PRESET);
    expect(form.preset?.note).toBe('provider.preset.deepseek.note');
    expect(form.preset?.docsURL).toBe(
      'https://api-docs.deepseek.com/quick_start/agent_integrations/codex',
    );
  });

  it('官方与 Chat 目录共用模型能力、国内分组和现有标志，Chat 显式保留代理所需 compat', () => {
    expect(catalogEntry('deepseek')).toMatchObject({
      group: 'cn',
      logo: 'deepseek',
      keyURL: 'https://platform.deepseek.com/api_keys',
      source: { kind: 'deepseek-official' },
    });
    const entry = catalogEntry('deepseek-openai');
    expect(entry).toMatchObject({
      group: 'cn',
      logo: 'deepseek',
      keyURL: 'https://platform.deepseek.com/api_keys',
    });
    if (entry?.source?.kind !== 'preset') throw new Error('缺少 DeepSeek Chat 模板');
    const params = upsertSchema.parse(toUpsertParams(newOpenAIForm(entry.source.preset, [])));
    if (params.kind !== 'openai-compatible') throw new Error('DeepSeek Chat 的 Provider 类型不对');
    expect(params).toMatchObject({
      api: 'openai-completions',
      baseURL: 'https://api.deepseek.com',
      compat: {
        thinkingFormat: 'deepseek',
        requiresReasoningContentOnAssistantMessages: true,
        toolChoice: 'auto_only',
      },
      models: DEEPSEEK_OFFICIAL_PRESET.models,
    });
    expect(params.models.every((m) => m.maxTokens === undefined)).toBe(true);
    expect(
      providerLogo({ kind: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1' }),
    ).toBe('deepseek');
  });

  it('旧官方 Profile 的空模型列表不自动套新模板', () => {
    const form = editForm(
      profile({
        id: 'deepseek-official',
        kind: 'deepseek-official',
        models: [],
        defaultModelId: 'deepseek-flash',
      }),
    );
    expect(toUpsertParams(form).models).toEqual([]);
    expect(form.preset).toBeUndefined();
    expect(deepseekModelChoices(form)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
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
    expect(toUpsertParams({ ...form, apiKey: 'sk-new' })).toHaveProperty('apiKey', 'sk-new');
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
    ).toEqual([{ id: 'kimi-latest', supportsImages: true }]);
    expect(
      toUpsertParams({
        ...form,
        models: [{ ...row, id: 'kimi-latest', contextWindow: '', images: false }],
      }).models,
    ).toEqual([{ id: 'kimi-latest' }]);
  });

  it('图片输入：勾选写 supportsImages: true，取消时原模型标过的写 false、没标过的不写', () => {
    const form = editForm(
      profile({
        models: [
          { id: 'vision', supportsImages: true, reasoningEfforts: ['low', 'high'] },
          { id: 'text', supportsImages: false },
          { id: 'plain' },
        ],
        defaultModelId: 'vision',
      }),
    );
    expect(form.models.map((row) => row.images)).toEqual([true, false, false]);
    // 原样保存：标记与表单不编辑的字段都保留。
    expect(toUpsertParams(form).models).toEqual([
      { id: 'vision', supportsImages: true, reasoningEfforts: ['low', 'high'] },
      { id: 'text', supportsImages: false },
      { id: 'plain' },
    ]);
    const toggled = form.models.map((row) => ({ ...row, images: !row.images }));
    const params = toUpsertParams({ ...form, models: toggled });
    expect(params.models).toEqual([
      { id: 'vision', supportsImages: false, reasoningEfforts: ['low', 'high'] },
      { id: 'text', supportsImages: true },
      { id: 'plain', supportsImages: true },
    ]);
    expect(upsertSchema.safeParse(params).success).toBe(true);
  });

  it('手填的新模型默认不收图片，勾选后带上标记', () => {
    const form = newOpenAIForm(undefined, []);
    const [row] = form.models;
    if (!row) throw new Error('缺少模型行');
    expect(row.images).toBe(false);
    const filled = {
      ...form,
      id: 'gateway',
      displayName: 'Gateway',
      baseURL: 'https://gateway.example.com/v1',
      models: [
        { ...row, id: 'gpt-vision' },
        { ...modelRow(), id: 'gpt-text' },
      ],
    };
    expect(toUpsertParams(filled).models).toEqual([{ id: 'gpt-vision' }, { id: 'gpt-text' }]);
    const [vision, text] = filled.models;
    if (!vision || !text) throw new Error('缺少模型行');
    expect(
      toUpsertParams({ ...filled, models: [{ ...vision, images: true }, text] }).models,
    ).toEqual([{ id: 'gpt-vision', supportsImages: true }, { id: 'gpt-text' }]);
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
      // 缺少 Key 的结论本身就是该做的事，不另给建议。
      if (reason !== 'unknown' && reason !== 'missing_key') {
        expect(presentation.hint).toMatch(/[一-龥]/);
      }
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
      title: '测试未完成',
      detail: 'connection lost',
    });
  });
});

describe('上下文长度没填', () => {
  it('空着的模型行提示按 128k 估算；每个预设模型都填了上下文长度', () => {
    expect(ASSUMED_CONTEXT_WINDOW).toBe(128_000);
    expect(contextWindowMissing({ contextWindow: '' })).toBe(true);
    expect(contextWindowMissing({ contextWindow: '  ' })).toBe(true);
    expect(contextWindowMissing({ contextWindow: '262144' })).toBe(false);
    for (const preset of [...OPENAI_PRESETS, ...VERTEX_PRESETS]) {
      for (const model of preset.models) {
        expect(model.contextWindow, `${preset.id} / ${model.id}`).toBeGreaterThan(0);
      }
    }
  });
});
