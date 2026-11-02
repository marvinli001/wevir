import { describe, expect, it } from 'vitest';
import { accountModels, modelSelection } from './models.js';
import { FAKE_MODELS } from './test-fixtures/fake-sdk.js';

describe('Cursor 的模型', () => {
  it('第一个是 Auto（默认）；推理档位只取 effort 参数里 Wevir 认识的；SDK 的 default 与重复、空的去掉', () => {
    const models = accountModels([
      ...FAKE_MODELS,
      { id: 'default', displayName: 'Default' },
      { id: 'gpt-6', displayName: 'GPT-6 again' },
      { id: ' ', displayName: 'Blank' },
      {
        id: 'sonnet',
        displayName: 'Sonnet',
        parameters: [{ id: 'reasoning', values: [{ value: 'HIGH' }, { value: 'off' }] }],
      },
    ]);
    expect(models).toEqual({
      defaultModelId: 'auto',
      models: [
        { id: 'auto', displayName: 'Auto' },
        {
          id: 'composer-2',
          displayName: 'Composer 2',
          reasoningEfforts: ['low', 'medium', 'high'],
          supportsFast: true,
        },
        { id: 'gpt-6', displayName: 'GPT-6' },
        { id: 'sonnet', displayName: 'Sonnet', reasoningEfforts: ['off', 'high'] },
      ],
    });
  });

  it('选择：auto 交给 SDK 是 default；档位换成模型自己的参数 ID 与原值，模型没有这个参数或不认识时不带', () => {
    expect(modelSelection('auto', undefined, undefined, FAKE_MODELS)).toEqual({ id: 'default' });
    expect(modelSelection('composer-2', 'high', undefined, FAKE_MODELS)).toEqual({
      id: 'composer-2',
      params: [
        { id: 'effort', value: 'high' },
        { id: 'fast', value: 'false' },
      ],
    });
    expect(modelSelection('composer-2', 'xhigh', undefined, FAKE_MODELS)).toEqual({
      id: 'composer-2',
      params: [{ id: 'fast', value: 'false' }],
    });
    expect(modelSelection('gpt-6', 'high', true, FAKE_MODELS)).toEqual({ id: 'gpt-6' });
    expect(modelSelection('composer-2', 'high', true, undefined)).toEqual({ id: 'composer-2' });
  });

  it('快速模式（0.148.0）：有 fast 参数的模型 supportsFast，默认变体带 fast: true 的 fastByDefault；选择时明确带 true / false', () => {
    const fastByDefault = {
      id: 'composer-2.5',
      displayName: 'Composer 2.5',
      parameters: [{ id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }],
      variants: [
        { displayName: 'Composer 2.5', isDefault: true, params: [{ id: 'fast', value: 'true' }] },
      ],
    };
    const odd = {
      id: 'odd',
      displayName: 'Odd',
      parameters: [{ id: 'fast', values: [{ value: 'turbo' }] }],
    };
    expect(accountModels([fastByDefault, odd]).models.slice(1)).toEqual([
      { id: 'composer-2.5', displayName: 'Composer 2.5', supportsFast: true, fastByDefault: true },
      { id: 'odd', displayName: 'Odd' },
    ]);
    expect(modelSelection('composer-2', undefined, true, FAKE_MODELS)).toEqual({
      id: 'composer-2',
      params: [{ id: 'fast', value: 'true' }],
    });
  });
});
