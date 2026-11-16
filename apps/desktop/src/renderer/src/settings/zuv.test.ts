import type { WevirClient } from '@wevir/client-sdk';
import { MethodSchemas, type ProviderModel } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import { catalogEntry, PROVIDER_CATALOG, providerLogo } from './provider-catalog';
import { loadProviderCatalog } from './provider-catalog-form';
import {
  type EditableProvider,
  editForm,
  newOpenAIForm,
  toUpsertParams,
  validateForm,
} from './provider-form';
import { OPENAI_PRESETS } from './provider-presets';

const preset = OPENAI_PRESETS.find((item) => item.id === 'zuv');
if (!preset) throw new Error('missing Zuv preset');
const models: [ProviderModel, ProviderModel] = [
  {
    id: 'first-vendor/current-model',
    displayName: 'Current model',
    api: 'openai-responses',
    protocols: ['responses', 'chat', 'messages', 'gemini'],
    vendor: 'first-vendor',
    contextWindow: 98304,
    maxTokens: 24576,
    supportsImages: true,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    capabilities: ['tools', 'vision', 'reasoning'],
    families: ['chat'],
    reasoningEfforts: [],
  },
  {
    id: 'future-vendor/new-model',
    displayName: 'New model',
    api: 'anthropic-messages',
    protocols: ['messages'],
    contextWindow: 262144,
    maxTokens: 65536,
    supportsImages: false,
    reasoningEfforts: [],
  },
];
const clientWith = (result: unknown) =>
  ({
    request: vi.fn(async () => result),
  }) as unknown as Pick<WevirClient, 'request'>;

describe('Zuv API provider', () => {
  it('is the first global catalog entry and uses the API key and integration URLs', () => {
    expect(PROVIDER_CATALOG.find((item) => item.group === 'global')?.id).toBe('zuv');
    expect(catalogEntry('zuv')).toMatchObject({
      logo: 'zuv',
      keyURL: 'https://zuv.wevir.si/console/keys',
      source: { kind: 'preset', preset },
    });
    expect(preset).toMatchObject({
      api: 'openai-responses',
      baseURL: 'https://zuv.wevir.si/v1',
      docsURL: 'https://zuv.wevir.si/console/integrate',
      models: [],
      modelCatalog: 'zuv',
    });
    expect(providerLogo({ kind: 'openai-compatible', baseURL: preset.baseURL })).toBe('zuv');
  });

  it('imports every live model through Host and produces a valid form without manual model entry', async () => {
    const client = clientWith({ ok: true, models: models.map((model) => ({ model })) });
    const form = await loadProviderCatalog(client, {
      ...newOpenAIForm(preset, []),
      apiKey: 'synthetic-key',
    });
    expect(client.request).toHaveBeenCalledWith('provider.discoverModels', {
      baseURL: preset.baseURL,
      apiKey: 'synthetic-key',
    });
    expect(validateForm(form, [])).toEqual({});
    const params = MethodSchemas['provider.upsert'].params.parse(toUpsertParams(form));
    expect(params).toMatchObject({
      kind: 'openai-compatible',
      id: 'zuv-api',
      defaultModelId: models[0]?.id,
      baseURL: preset.baseURL,
      apiKey: 'synthetic-key',
      models,
      compat: {
        supportsCustomTools: false,
        supportsNamespaceTools: false,
        toolChoice: 'auto_only',
      },
    });
  });

  it('keeps imported metadata and the default model across editing and catalog refresh', async () => {
    const saved = {
      id: 'zuv-api',
      kind: 'openai-compatible',
      displayName: 'My Zuv',
      api: preset.api,
      baseURL: preset.baseURL,
      models,
      defaultModelId: models[1].id,
      hasSecret: true,
      createdAt: '',
      updatedAt: '',
    } satisfies EditableProvider;
    const form = editForm(saved);
    expect(form.preset?.modelCatalog).toBe('zuv');
    expect(toUpsertParams(form)).toMatchObject({ models, defaultModelId: models[1]?.id });
    const newModel: ProviderModel = {
      id: 'new-provider/next-release',
      api: 'openai-completions',
      protocols: ['chat'],
    };
    const client = clientWith({
      ok: true,
      models: [newModel, ...models].map((model) => ({ model })),
    });
    const refreshed = await loadProviderCatalog(client, form);
    expect(client.request).toHaveBeenCalledWith('provider.discoverModels', {
      providerId: saved.id,
    });
    expect(toUpsertParams(refreshed)).toMatchObject({
      models: [newModel, ...models],
      defaultModelId: models[1]?.id,
    });
  });

  it('keeps the fixed ZUV subscription ID available regardless of login order', () => {
    expect(newOpenAIForm(preset, []).id).toBe('zuv-api');
    expect(newOpenAIForm(preset, ['zuv', 'zuv-api']).id).toBe('zuv-api-2');
    expect(validateForm({ ...newOpenAIForm(preset, []), id: 'zuv' }, [])).toHaveProperty('id');
  });

  it.each([
    { ok: false, models: [], reason: 'network' },
    { ok: true, models: [] },
    { ok: true, models: [{ model: models[0] }], truncated: true },
  ])(
    'does not silently substitute static or incomplete models after discovery failure',
    async (result) => {
      await expect(
        loadProviderCatalog(clientWith(result), newOpenAIForm(preset, [])),
      ).rejects.toThrow();
      expect(preset.models).toEqual([]);
    },
  );

  it('propagates Host errors and leaves ordinary providers on their existing path', async () => {
    const request = vi.fn(async () => {
      throw new Error('Host unavailable');
    });
    const client = { request } as unknown as Pick<WevirClient, 'request'>;
    await expect(loadProviderCatalog(client, newOpenAIForm(preset, []))).rejects.toThrow(
      'Host unavailable',
    );
    const custom = newOpenAIForm(undefined, []);
    expect(await loadProviderCatalog(client, custom)).toBe(custom);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
