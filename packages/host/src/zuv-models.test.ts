import { MethodSchemas } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import { discoverZuvModels, isZuvApiBaseURL } from './zuv-models.js';

const model = (id: string, protocols = ['responses', 'chat', 'messages', 'gemini']) => ({
  id,
  name: id,
  vendor: 'new-vendor',
  contextLength: 98304,
  maxOutput: 24576,
  inputModalities: ['text', 'image'],
  outputModalities: ['text'],
  capabilities: ['tools', 'vision', 'reasoning'],
  protocols,
  families: ['chat'],
});

describe('Zuv public model discovery', () => {
  it('imports the full current catalog without a model allowlist, key or Ollama limit', async () => {
    const data = Array.from({ length: 90 }, (_, index) => model(`new-vendor/release-${index}`));
    data.push(model('another-vendor/new-model', ['messages']));
    data.push(model('new-vendor/release-0'));
    const send = vi.fn<typeof fetch>(async () => Response.json({ data }));
    const result = MethodSchemas['provider.discoverModels'].result.parse(
      await discoverZuvModels(undefined, send),
    );
    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(91);
    expect(result.truncated).toBeUndefined();
    expect(result.models[0]?.model).toEqual({
      id: data[0]?.id,
      displayName: data[0]?.name,
      api: 'openai-responses',
      protocols: ['responses', 'chat', 'messages', 'gemini'],
      vendor: 'new-vendor',
      contextWindow: 98304,
      maxTokens: 24576,
      supportsImages: true,
      reasoningEfforts: [],
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      capabilities: ['tools', 'vision', 'reasoning'],
      families: ['chat'],
    });
    expect(result.models.at(-1)?.model.api).toBe('anthropic-messages');
    const url = send.mock.calls[0]?.[0];
    const init = send.mock.calls[0]?.[1];
    expect(url).toBe('https://zuv.wevir.si/api/public/models');
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' });
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it.each([
    ['responses', 'openai-responses'],
    ['chat', 'openai-completions'],
    ['messages', 'anthropic-messages'],
    ['gemini', 'google-gemini'],
  ])('routes a model advertised only for %s', async (protocol, api) => {
    const result = await discoverZuvModels('vendor/new-model', async () =>
      Response.json({ data: [model('other/model'), model('vendor/new-model', [protocol])] }),
    );
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.model).toMatchObject({
      id: 'vendor/new-model',
      api,
      protocols: [protocol],
    });
  });

  it('does not invent context, output budgets, modalities or reasoning levels', async () => {
    const result = await discoverZuvModels(undefined, async () =>
      Response.json({
        data: [
          {
            ...model('openai/gpt-6.1-sol'),
            contextLength: null,
            maxOutput: null,
            inputModalities: ['text'],
            outputModalities: ['text'],
            capabilities: ['tools'],
          },
        ],
      }),
    );
    expect(result.models[0]?.model).toMatchObject({
      supportsImages: false,
      reasoningEfforts: [],
      capabilities: ['tools'],
    });
    expect(result.models[0]?.model.contextWindow).toBeUndefined();
    expect(result.models[0]?.model.maxTokens).toBeUndefined();
  });

  it.each([
    () => new Response('unavailable', { status: 503 }),
    () => new Response('invalid json'),
    () => Response.json({ data: [{ id: 'invalid', protocols: [] }] }),
    () => Response.json({ data: 'invalid' }),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
  ])('returns a failure without a static fallback', async (response) => {
    expect(await discoverZuvModels(undefined, async () => response())).toMatchObject({
      ok: false,
      models: [],
    });
  });

  it('reports network failure without leaking the exception', async () => {
    expect(
      await discoverZuvModels(undefined, async () => {
        throw new Error('private detail');
      }),
    ).toEqual({ ok: false, models: [], reason: 'network' });
  });

  it('only recognizes the public HTTPS Zuv API endpoint', () => {
    expect(isZuvApiBaseURL('https://zuv.wevir.si/v1/')).toBe(true);
    for (const url of [
      'https://zuv.wevir.si.evil.test/v1',
      'http://zuv.wevir.si/v1',
      'https://user@zuv.wevir.si/v1',
      'https://zuv.wevir.si/api/wevir/v1',
      'https://zuv.wevir.si/v1?key=hidden',
      'https://zuv.wevir.si:8443/v1',
    ])
      expect(isZuvApiBaseURL(url), url).toBe(false);
  });
});
