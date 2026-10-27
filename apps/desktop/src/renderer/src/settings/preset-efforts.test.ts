import { MethodSchemas } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { type EditableProvider, editForm, modelRow, toUpsertParams } from './provider-form';

const upsertSchema = MethodSchemas['provider.upsert'].params;

function profile(overrides: Partial<EditableProvider>): EditableProvider {
  return {
    id: 'kimi',
    kind: 'openai-compatible',
    displayName: 'Kimi',
    api: 'openai-responses',
    baseURL: 'https://api.moonshot.cn/v1',
    models: [
      {
        id: 'kimi-k3',
        contextWindow: 1048576,
        maxTokens: 1048576,
        supportsImages: true,
        reasoningEfforts: ['low', 'high', 'max'],
      },
      { id: 'kimi-k3.1-pro', contextWindow: 1048576, supportsImages: true },
    ],
    defaultModelId: 'kimi-k3',
    hasSecret: true,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}

function saved(provider: EditableProvider, edit?: (form: ReturnType<typeof editForm>) => void) {
  const form = editForm(provider);
  edit?.(form);
  const params = upsertSchema.parse(toUpsertParams(form));
  if (!('models' in params)) throw new Error('表单保存的 Provider 应带模型');
  return params.models;
}

describe('缺档位的模型按同地址模板补齐', () => {
  it('模板更新前存的 Kimi Provider 编辑保存一次，后加的 K3.1 Pro 补上档位与最大输出', () => {
    expect(saved(profile({}))).toEqual([
      profile({}).models[0],
      {
        id: 'kimi-k3.1-pro',
        contextWindow: 1048576,
        maxTokens: 1048576,
        supportsImages: true,
        reasoningEfforts: ['low', 'high', 'max'],
      },
    ]);
  });

  it('表单里新加的行同样补齐，地址末尾斜杠与大小写不影响匹配', () => {
    const models = saved(profile({ baseURL: 'https://API.moonshot.cn/v1/' }), (form) => {
      form.models.push({ ...modelRow(), id: 'kimi-k3.1-pro-highspeed' });
    });
    expect(models.at(-1)).toEqual({
      id: 'kimi-k3.1-pro-highspeed',
      maxTokens: 1048576,
      reasoningEfforts: ['low', 'high', 'max'],
    });
  });

  it('已有档位与最大输出不覆盖，空档位视为已声明', () => {
    const models = saved(
      profile({
        models: [
          { id: 'kimi-k3', reasoningEfforts: ['high'] },
          { id: 'kimi-k3.1-pro', maxTokens: 8192 },
          { id: 'kimi-k3.1-pro-highspeed', reasoningEfforts: [] },
        ],
      }),
    );
    expect(models).toEqual([
      { id: 'kimi-k3', reasoningEfforts: ['high'] },
      { id: 'kimi-k3.1-pro', maxTokens: 8192, reasoningEfforts: ['low', 'high', 'max'] },
      { id: 'kimi-k3.1-pro-highspeed', reasoningEfforts: [] },
    ]);
  });

  it('别的地址与模板里没有的模型不补', () => {
    expect(saved(profile({ baseURL: 'https://kimi-proxy.example.com/v1' }))[1]).not.toHaveProperty(
      'reasoningEfforts',
    );
    expect(saved(profile({ models: [{ id: 'kimi-k9' }], defaultModelId: 'kimi-k9' }))[0]).toEqual({
      id: 'kimi-k9',
    });
  });

  it('模板地址的占位匹配填好的地域', () => {
    const models = saved(
      profile({
        id: 'bedrock',
        baseURL: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1',
        models: [{ id: 'openai.gpt-6-luna' }],
        defaultModelId: 'openai.gpt-6-luna',
      }),
    );
    expect(models[0]).toMatchObject({
      maxTokens: 128000,
      reasoningEfforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    });
  });

  it('Vertex 没有地址，按协议对应的模板补', () => {
    const models = saved(
      profile({
        id: 'vertex',
        kind: 'google-vertex',
        api: 'openai-completions',
        baseURL: undefined,
        vertex: { project: 'my-project', location: 'global' },
        models: [{ id: 'google/gemini-3.8-flash' }],
        defaultModelId: 'google/gemini-3.8-flash',
      }),
    );
    expect(models[0]).toMatchObject({
      maxTokens: 65536,
      reasoningEfforts: ['low', 'medium', 'high'],
    });
  });
});
