import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverOllamaModels, ollamaOrigin } from './ollama-models.js';

afterEach(() => vi.unstubAllGlobals());
const baseURL = 'http://127.0.0.1:11434/v1';
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('Ollama discovery network boundary', () => {
  it.each([
    'http://192.168.1.2:11434/v1',
    'http://0.0.0.0:11434/v1',
    'http://169.254.169.254/v1',
    'https://ollama.com.evil.test/v1',
    'https://api.ollama.com/v1',
    'http://ollama.com/v1',
    'https://ollama.com:8443/v1',
    'http://localhost.evil.test/v1',
    'file:///v1',
    'http://user:password@localhost:11434/v1',
    'http://localhost:11434/v1?target=x',
    'http://localhost:11434/v1#fragment',
    'http://localhost:11434/api/pull',
    'http://localhost:11434/v1/else',
    'not a URL',
  ])('rejects %s before fetch', async (url) => {
    const send = vi.fn();
    await expect(
      discoverOllamaModels({ baseURL: url, apiKey: 'test-key' }, send),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(send).not.toHaveBeenCalled();
  });

  it('pins localhost to loopback and accepts explicit IPv6/custom local port', () => {
    expect(ollamaOrigin('http://localhost:12345/v1/')).toEqual({
      origin: 'http://127.0.0.1:12345',
      cloud: false,
    });
    expect(ollamaOrigin('http://[::1]:11434/v1')).toEqual({
      origin: 'http://[::1]:11434',
      cloud: false,
    });
  });

  it('does not request Cloud without a key', async () => {
    const send = vi.fn();
    expect(await discoverOllamaModels({ baseURL: 'https://ollama.com/v1' }, send)).toEqual({
      ok: false,
      models: [],
      reason: 'missing_key',
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('Ollama model metadata', () => {
  it('allocated context beats num_ctx and model limit; records native thinking levels, images and tag details', async () => {
    const send = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toHaveProperty('authorization', 'Bearer ollama');
      if (String(url).endsWith('/api/tags'))
        return json({
          models: [
            {
              name: 'gpt-oss:20b',
              size: 12_000_000_000,
              details: { parameter_size: '20B', quantization_level: 'Q4_K_M' },
            },
            { name: 'gpt-oss:20b' },
            { name: 'vision' },
            { name: 'plain' },
          ],
        });
      if (String(url).endsWith('/api/ps'))
        return json({ models: [{ name: 'gpt-oss:20b', context_length: 8192 }] });
      const { model } = JSON.parse(String(init?.body));
      return json({
        parameters: 'temperature 0.7\nnum_ctx 32768\n',
        model_info: { 'gptoss.context_length': 131072 },
        capabilities:
          model === 'vision'
            ? ['completion', 'vision', 'tools', 'thinking']
            : ['completion', 'tools'],
        thinking:
          model === 'gpt-oss:20b'
            ? { values: ['low', 'medium', 'high'], default: 'medium' }
            : model === 'vision'
              ? { values: [false, true], default: true }
              : { values: [false], default: false },
      });
    });
    const result = await discoverOllamaModels({ baseURL, apiKey: 'ollama' }, send);
    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(3);
    expect(result.models[0]).toMatchObject({
      model: {
        id: 'gpt-oss:20b',
        contextWindow: 8192,
        reasoningEfforts: ['low', 'medium', 'high'],
        supportsImages: false,
      },
      maxContextWindow: 131072,
      contextSource: 'running',
      parameterSize: '20B',
      quantization: 'Q4_K_M',
      sizeBytes: 12_000_000_000,
    });
    expect(result.models[1]).toMatchObject({
      model: { contextWindow: 32768, supportsImages: true, reasoningEfforts: ['off', 'medium'] },
      contextSource: 'configured',
    });
    expect(result.models[2]?.model.reasoningEfforts).toEqual([]);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('never substitutes a local model maximum for actual context or guesses missing thinking', async () => {
    const send = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/api/tags')
        ? json({ models: [{ name: 'unknown' }] })
        : String(url).endsWith('/api/ps')
          ? new Response('', { status: 404 })
          : json({
              model_info: { 'llama.context_length': 262144 },
              capabilities: ['completion', 'tools'],
            }),
    );
    const result = await discoverOllamaModels({ baseURL }, send);
    expect(result.models[0]).toMatchObject({ model: { id: 'unknown' }, maxContextWindow: 262144 });
    expect(result.models[0]?.model).not.toHaveProperty('contextWindow');
    expect(result.models[0]?.model).not.toHaveProperty('reasoningEfforts');
  });

  it('bounds returned metadata and removes credentials and query strings from remote_host', async () => {
    const send = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/api/tags')
        ? json({
            models: [
              {
                name: 'remote',
                remote_host: 'https://private-test-key@ollama.com/?key=private-test-key',
                details: { parameter_size: 'x'.repeat(1000), quantization_level: 'y'.repeat(1000) },
              },
            ],
          })
        : String(url).endsWith('/api/ps')
          ? json({ models: [] })
          : json({ capabilities: Array.from({ length: 100 }, () => 'z'.repeat(1000)) }),
    );
    const result = await discoverOllamaModels({ baseURL }, send);
    expect(result.models[0]?.remoteHost).toBe('https://ollama.com');
    expect(result.models[0]?.parameterSize).toHaveLength(128);
    expect(result.models[0]?.quantization).toHaveLength(128);
    expect(result.models[0]?.capabilities).toHaveLength(64);
    expect(result.models[0]?.capabilities?.[0]).toHaveLength(128);
    expect(JSON.stringify(result)).not.toContain('private-test-key');
  });

  it('uses direct Cloud names and maximum, without calling /ps or following remote_host', async () => {
    const send = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url).startsWith('https://ollama.com/api/')).toBe(true);
      expect(init?.headers).toHaveProperty('authorization', 'Bearer cloud-test-key');
      if (String(url).endsWith('/api/tags'))
        return json({ models: [{ name: 'gpt-oss:120b', remote_host: 'http://169.254.169.254' }] });
      expect(String(url).endsWith('/api/show')).toBe(true);
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'gpt-oss:120b' });
      return json({
        model_info: { 'gptoss.context_length': 131072 },
        thinking: { values: ['low', 'high'] },
      });
    });
    const result = await discoverOllamaModels(
      { baseURL: 'https://ollama.com/v1', apiKey: 'cloud-test-key' },
      send,
    );
    expect(result.models[0]).toMatchObject({
      model: { id: 'gpt-oss:120b', contextWindow: 131072 },
      contextSource: 'cloud',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('requests only the selected model details and recognizes :latest in running models', async () => {
    const send = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/api/tags'))
        return json({ models: [{ name: 'qwen3:latest' }, { name: 'other' }] });
      if (String(url).endsWith('/api/ps'))
        return json({ models: [{ name: 'qwen3', context_length: 65536 }] });
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'qwen3:latest' });
      return json({});
    });
    expect(
      (await discoverOllamaModels({ baseURL, modelId: 'qwen3' }, send)).models[0],
    ).toMatchObject({ model: { id: 'qwen3:latest', contextWindow: 65536 } });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('retains tags when /show is unavailable, without exposing the response or key', async () => {
    const send = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/api/tags')
        ? json({ models: [{ name: 'model' }] })
        : new Response('sensitive-test-key', { status: 500 }),
    );
    const result = await discoverOllamaModels({ baseURL, apiKey: 'sensitive-test-key' }, send);
    expect(result).toEqual({
      ok: true,
      models: [{ model: { id: 'model' }, detailsAvailable: false }],
    });
    expect(JSON.stringify(result)).not.toContain('sensitive-test-key');
  });

  it('caps models at 64 and metadata concurrency at two', async () => {
    let active = 0;
    let peak = 0;
    const send = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/api/tags'))
        return json({ models: Array.from({ length: 70 }, (_, i) => ({ name: `model-${i}` })) });
      if (String(url).endsWith('/api/ps')) return json({ models: [] });
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return json({});
    });
    const result = await discoverOllamaModels({ baseURL }, send);
    expect(result.models).toHaveLength(64);
    expect(result.truncated).toBe(true);
    expect(peak).toBe(2);
    expect(send).toHaveBeenCalledTimes(66);
  });

  it.each([401, 403, 429, 500, 404])(
    'HTTP %s returns a fixed reason without upstream text',
    async (status) => {
      const result = await discoverOllamaModels(
        { baseURL },
        vi.fn(async () => new Response('secret-echo', { status })),
      );
      expect(result.ok).toBe(false);
      expect(result.models).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('secret-echo');
    },
  );

  it('bounds bytes before parsing and cancels the oversized response', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    expect(
      await discoverOllamaModels(
        { baseURL },
        vi.fn(async () => response),
      ),
    ).toEqual({ ok: false, models: [], reason: 'protocol' });
    expect(cancelled).toBe(true);
  });

  it('rejects HTML/malformed tags and redacts transport errors', async () => {
    expect(
      await discoverOllamaModels(
        { baseURL },
        vi.fn(async () => new Response('<html>wrong service</html>')),
      ),
    ).toMatchObject({ ok: false, reason: 'protocol' });
    expect(
      await discoverOllamaModels(
        { baseURL },
        vi.fn(async () => {
          throw new Error('credential echo');
        }),
      ),
    ).toEqual({ ok: false, models: [], reason: 'network' });
  });
});
