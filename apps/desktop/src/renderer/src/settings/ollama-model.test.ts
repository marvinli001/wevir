import { describe, expect, it } from 'vitest';
import {
  discoveryParams,
  lowOllamaContext,
  ollamaEndpoint,
  toggleDiscoveredModel,
} from './ollama-model';
import { catalogEntry, providerLogo } from './provider-catalog';
import { editForm, newOpenAIForm, toUpsertParams, validateForm } from './provider-form';
import { presentTestResult } from './provider-test-result';

function formOf(id: string) {
  const entry = catalogEntry(id);
  if (entry?.source?.kind !== 'preset') throw new Error('missing Ollama preset');
  return newOpenAIForm(entry.source.preset, []);
}

describe('Ollama presets and discovered selections', () => {
  it('uses Responses, no invented installed model, local placeholder key and official Cloud key page', () => {
    const local = formOf('ollama');
    expect(local).toMatchObject({
      api: 'openai-responses',
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'ollama',
      models: [],
      compat: { supportsCustomTools: false, toolChoice: 'auto_only' },
    });
    expect(validateForm(local, [])).toHaveProperty('models');
    const cloud = formOf('ollama-cloud');
    expect(cloud).toMatchObject({
      api: 'openai-responses',
      apiKey: '',
      models: [],
      compat: { supportsNamespaceTools: false },
    });
    expect(catalogEntry('ollama-cloud')).toMatchObject({
      group: 'global',
      logo: 'ollama',
      keyURL: 'https://ollama.com/settings/keys',
    });
    expect(catalogEntry('ollama')).toMatchObject({ group: 'local' });
    expect(providerLogo({ kind: 'openai-compatible', baseURL: 'https://ollama.com/v1' })).toBe(
      'ollama',
    );
    expect(
      providerLogo({ kind: 'openai-compatible', baseURL: 'https://ollama.com.evil.test/v1' }),
    ).toBeUndefined();
  });

  it('imports actual context and exact reasoning choices, retaining the default when toggling another model', () => {
    let form = formOf('ollama');
    const first = {
      model: {
        id: 'gpt-oss:20b',
        contextWindow: 65536,
        reasoningEfforts: ['low', 'medium', 'high'] as const,
      },
    };
    const entry = {
      ...first,
      model: { ...first.model, reasoningEfforts: [...first.model.reasoningEfforts] },
    };
    form = { ...form, ...toggleDiscoveredModel(form, entry) };
    form = {
      ...form,
      ...toggleDiscoveredModel(form, {
        model: { id: 'vision', contextWindow: 8192, supportsImages: true },
      }),
    };
    expect(form.defaultIndex).toBe(0);
    expect(validateForm(form, [])).toEqual({});
    expect(toUpsertParams(form)).toMatchObject({
      defaultModelId: 'gpt-oss:20b',
      models: [entry.model, { id: 'vision', contextWindow: 8192, supportsImages: true }],
    });
    form = { ...form, ...toggleDiscoveredModel(form, entry) };
    expect(toUpsertParams(form)).toMatchObject({ defaultModelId: 'vision' });
  });

  it('never invents context or offers off for an always-thinking model', () => {
    const form = formOf('ollama');
    const selected = {
      ...form,
      ...toggleDiscoveredModel(form, {
        model: { id: 'unknown', reasoningEfforts: ['low', 'high'] },
        maxContextWindow: 131072,
      }),
    };
    expect(selected.models[0]?.contextWindow).toBe('');
    expect(toUpsertParams(selected).models[0]).toEqual({
      id: 'unknown',
      reasoningEfforts: ['low', 'high'],
    });
    expect(lowOllamaContext({ model: { id: 'm', contextWindow: 32768 } })).toBe(32768);
    expect(lowOllamaContext({ model: { id: 'm', contextWindow: 65536 } })).toBeUndefined();
    expect(lowOllamaContext({ model: { id: 'm' }, maxContextWindow: 4096 })).toBeUndefined();
  });

  it('preserves saved old Chat profiles and uses stored credentials only at the saved address', () => {
    const old = {
      id: 'local-ollama',
      kind: 'openai-compatible' as const,
      api: 'openai-completions' as const,
      baseURL: 'http://localhost:11434/v1',
      displayName: 'Local',
      models: [{ id: 'qwen3:8b', contextWindow: 32768 }],
      defaultModelId: 'qwen3:8b',
      hasSecret: true,
      createdAt: '',
      updatedAt: '',
    };
    const form = editForm(old);
    expect(toUpsertParams(form)).toMatchObject({ api: old.api, models: old.models });
    expect(discoveryParams(form)).toEqual({ providerId: old.id });
    expect(discoveryParams({ ...form, baseURL: 'https://ollama.com/v1' })).toEqual({
      baseURL: 'https://ollama.com/v1',
    });
    expect(discoveryParams({ ...form, apiKey: 'unsaved-test-key' })).toEqual({
      baseURL: old.baseURL,
      apiKey: 'unsaved-test-key',
    });
  });

  it('hides discovery at remote, malformed, credential-bearing or non-v1 endpoints', () => {
    for (const url of [
      'http://10.0.0.1:11434/v1',
      'https://ollama.com.evil/v1',
      'http://ollama.com/v1',
      'https://ollama.com:999/v1',
      'http://localhost:11434/api',
      'http://key@localhost:11434/v1',
      'http://localhost:11434/v1?x=1',
    ])
      expect(ollamaEndpoint(url)).toBeUndefined();
    expect(ollamaEndpoint('http://localhost:11434/v1')).toBe('local');
    expect(ollamaEndpoint('https://ollama.com/v1')).toBe('cloud');
  });

  it('shows an actionable Responses 404 hint', () => {
    expect(
      presentTestResult({
        ok: false,
        reason: 'protocol',
        httpStatus: 404,
        error: {
          category: 'provider',
          message: 'endpoint unavailable',
          code: 'ollama_responses_unavailable',
        },
      }).hint,
    ).toContain('升级 Ollama');
  });
});
