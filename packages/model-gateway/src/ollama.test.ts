import { describe, expect, it } from 'vitest';
import { testProvider } from './provider-test.js';
import { effectiveCompat, isOllamaHost } from './providers.js';
import { CODEX_SAMPLES, codexRequest } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

export const ollamaProvider = (baseURL: string): GatewayProvider => ({
  id: 'ollama',
  kind: 'openai-compatible',
  displayName: 'Ollama',
  api: 'openai-responses',
  baseURL,
  models: [{ id: 'gpt-oss:20b' }],
  defaultModelId: 'gpt-oss:20b',
  apiKey: 'ollama',
});

describe('Ollama Responses recorded requests', () => {
  it.each(CODEX_SAMPLES)(
    '%s flattens custom declarations and replay, preserving local namespaces',
    (sample) => {
      const body = { ...codexRequest(sample).body, tool_choice: 'required' };
      const before = structuredClone(body);
      const prepared = prepareUpstream(ollamaProvider('http://127.0.0.1:11434/v1'), body);
      if (!prepared.ok) throw new Error(prepared.message);
      const forwarded = prepared.payload as ResponsesRequest;
      expect(prepared.mode).toBe('responses');
      expect(prepared.headers.authorization).toBe('Bearer ollama');
      expect(prepared.url).toBe('http://127.0.0.1:11434/v1/responses');
      expect(forwarded).not.toHaveProperty('client_metadata');
      expect(forwarded.store).toBe(false);
      expect(JSON.stringify(forwarded)).not.toContain('custom_tool_call');
      expect(forwarded.tools?.some((tool) => tool.type === 'custom')).toBe(false);
      if (sample === '4-compact') expect(forwarded).not.toHaveProperty('tool_choice');
      else {
        expect(forwarded.tool_choice).toBe('auto');
        expect(forwarded.tools?.some((tool) => tool.type === 'namespace')).toBe(true);
      }
      expect(body).toEqual(before);
    },
  );

  it('Cloud conservatively flattens namespaces; explicit overrides win and Chat remains unchanged', () => {
    const cloud = ollamaProvider('https://ollama.com/v1');
    expect(effectiveCompat(cloud)).toMatchObject({
      supportsCustomTools: false,
      supportsNamespaceTools: false,
      toolChoice: 'auto_only',
    });
    expect(
      effectiveCompat({
        ...cloud,
        compat: { supportsCustomTools: true, supportsNamespaceTools: true, toolChoice: 'any' },
      }),
    ).toMatchObject({ supportsCustomTools: true, supportsNamespaceTools: true, toolChoice: 'any' });
    expect(effectiveCompat({ ...cloud, api: 'openai-completions' }).toolChoice).toBe('any');
    const prepared = prepareUpstream(cloud, codexRequest('1-first-turn').body);
    if (!prepared.ok) throw new Error(prepared.message);
    expect(
      (prepared.payload as ResponsesRequest).tools?.every((tool) => tool.type === 'function'),
    ).toBe(true);
  });

  it('host detection stays narrow', () => {
    for (const base of [
      'http://localhost:11434/v1',
      'http://[::1]:11434/v1',
      'https://ollama.com/v1',
    ])
      expect(isOllamaHost(base)).toBe(true);
    for (const base of [
      'https://api.ollama.com/v1',
      'https://ollama.com.evil.test/v1',
      'http://ollama.com/v1',
      'http://192.168.1.1:11434/v1',
      'http://127.0.0.1:8080/v1',
    ])
      expect(isOllamaHost(base)).toBe(false);
  });

  it('Responses 404 suggests upgrading, without masking a missing model', async () => {
    const provider = ollamaProvider('http://127.0.0.1:11434/v1');
    const result = await testProvider(provider, provider.defaultModelId, {
      fetch: async () => new Response('404 page not found', { status: 404 }),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'protocol',
      httpStatus: 404,
      error: { code: 'ollama_responses_unavailable' },
    });
    const missing = await testProvider(provider, 'missing', {
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'model does not exist' } }), {
          status: 404,
        }),
    });
    expect(missing).toMatchObject({ reason: 'model_not_found' });
    expect(missing.error?.code).not.toBe('ollama_responses_unavailable');
  });
});
