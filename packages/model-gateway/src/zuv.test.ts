import { describe, expect, it, vi } from 'vitest';
import { startModelGateway } from './gateway.js';
import { effectiveCompat, routeOf, validateProvider } from './providers.js';
import { requestStats } from './request-stats.js';
import { SseParser } from './sse.js';
import type {
  GatewayProvider,
  JsonObject,
  ResponsesEvent,
  ResponsesItem,
  ResponsesRequest,
} from './types.js';
import { prepareUpstream } from './upstream.js';

const provider: GatewayProvider = {
  id: 'zuv-api',
  kind: 'openai-compatible',
  displayName: 'Zuv API',
  baseURL: 'https://zuv.wevir.si/v1',
  api: 'openai-responses',
  apiKey: 'synthetic-key',
  defaultModelId: 'vendor/responses-model',
  models: [
    { id: 'vendor/responses-model', api: 'openai-responses', protocols: ['responses', 'chat'] },
    { id: 'vendor/chat-model', api: 'openai-completions', protocols: ['chat'] },
    {
      id: 'vendor/messages-model',
      api: 'anthropic-messages',
      protocols: ['messages'],
      maxTokens: 24576,
    },
    { id: 'vendor/gemini-model', api: 'google-gemini', protocols: ['gemini'] },
  ],
};
const tool = { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } };
const stream = (chunks: unknown[]) =>
  new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
async function eventsOf(response: AsyncIterable<Uint8Array | string>): Promise<ResponsesEvent[]> {
  const parser = new SseParser();
  const result: ResponsesEvent[] = [];
  for await (const chunk of response) {
    for (const message of parser.push(chunk))
      result.push(JSON.parse(message.data) as ResponsesEvent);
  }
  for (const message of parser.end()) result.push(JSON.parse(message.data) as ResponsesEvent);
  return result;
}

describe('Zuv API model protocols', () => {
  it.each([
    ['vendor/responses-model', 'responses', '/v1/responses', 'authorization'],
    ['vendor/chat-model', 'chat', '/v1/chat/completions', 'authorization'],
    ['vendor/messages-model', 'messages', '/v1/messages', 'x-api-key'],
    [
      'vendor/gemini-model',
      'gemini',
      '/v1beta/models/vendor%2Fgemini-model:streamGenerateContent?alt=sse',
      'x-goog-api-key',
    ],
  ])('routes %s inside a single provider', (model, mode, path, keyHeader) => {
    expect(validateProvider(provider)).toEqual([]);
    expect(routeOf(provider, undefined, model)).toEqual({
      mode,
      url: `https://zuv.wevir.si${path}`,
    });
    const prepared = prepareUpstream(provider, {
      model,
      input: 'ping',
      tools: [tool],
      tool_choice: 'required',
      client_metadata: { private: 'not-for-upstream' },
    });
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.mode).toBe(mode);
    expect(prepared.headers[keyHeader]).toBe(
      keyHeader === 'authorization' ? 'Bearer synthetic-key' : 'synthetic-key',
    );
    expect(JSON.stringify(prepared.payload)).not.toContain('not-for-upstream');
    if (mode === 'messages') expect(prepared.payload).toHaveProperty('max_tokens', 24576);
    if (mode === 'gemini') {
      expect(prepared.headers).not.toHaveProperty('authorization');
      expect(prepared.payload).toMatchObject({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      });
    }
  });

  it('keeps legacy provider-level routing and rejects invalid model overrides', () => {
    expect(
      routeOf({ ...provider, models: [{ id: 'legacy' }], defaultModelId: 'legacy' }).mode,
    ).toBe('responses');
    expect(
      validateProvider({ ...provider, models: [{ id: 'invalid', api: 'unknown' }] }),
    ).toContainEqual(expect.objectContaining({ path: ['models', 0, 'api'] }));
    expect(provider.api).toBe('openai-responses');
    expect(
      effectiveCompat({
        ...provider,
        kind: 'zuv',
        apiKey: undefined,
        baseURL: 'https://zuv.wevir.si/api/wevir/v1',
      }),
    ).toMatchObject({
      supportsCustomTools: true,
      supportsNamespaceTools: true,
      toolChoice: 'any',
    });
  });

  it('flattens custom and namespace tools and uses conservative Zuv tool choice defaults', () => {
    expect(effectiveCompat(provider)).toMatchObject({
      supportsCustomTools: false,
      supportsNamespaceTools: false,
      toolChoice: 'auto_only',
    });
    const prepared = prepareUpstream(provider, {
      model: provider.defaultModelId,
      input: 'ping',
      tool_choice: 'required',
      tools: [
        { type: 'custom', name: 'apply_patch' },
        { type: 'namespace', name: 'functions', tools: [tool] },
      ],
    });
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.dialects).toEqual(
      expect.arrayContaining(['flatten-custom-tools', 'flatten-namespace-tools']),
    );
    const payload = prepared.payload as ResponsesRequest;
    expect(payload.tools).toHaveLength(2);
    expect(payload.tools?.every((item) => item.type === 'function')).toBe(true);
    expect(payload.tool_choice).toBe('auto');
  });

  it('converts native Gemini reasoning, tool signatures and usage and replays them on the next request', async () => {
    const model = 'vendor/gemini-model';
    const prepared = prepareUpstream(provider, { model, input: 'look up', tools: [tool] });
    if (!prepared.ok) throw new Error(prepared.message);
    const events = await eventsOf(
      prepared.translate(
        stream([
          { candidates: [{ content: { parts: [{ thought: true, text: 'Thinking' }] } }] },
          {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: { name: 'lookup', args: { query: 'value' } },
                      thoughtSignature: 'opaque-signature',
                    },
                  ],
                },
              },
            ],
          },
          {
            candidates: [{ finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 17,
              candidatesTokenCount: 4,
              thoughtsTokenCount: 3,
              cachedContentTokenCount: 5,
              totalTokenCount: 24,
            },
          },
        ]),
        new AbortController().signal,
      ),
    );
    const output = events
      .filter((event) => event.type === 'response.output_item.done')
      .map((event) => event.item as ResponsesItem);
    const call = output.find((item) => item.type === 'function_call');
    expect(call).toMatchObject({ name: 'lookup', arguments: '{"query":"value"}' });
    expect(events.at(-1)).toMatchObject({
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 17,
          output_tokens: 7,
          total_tokens: 24,
          input_tokens_details: { cached_tokens: 5 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
    });
    const replay: ResponsesRequest = {
      model,
      tools: [tool],
      input: [
        { type: 'message', role: 'user', content: 'look up' },
        ...output,
        { type: 'function_call_output', call_id: call?.call_id, output: 'result' },
      ],
    };
    const next = prepareUpstream(provider, replay);
    if (!next.ok) throw new Error(next.message);
    expect(next.payload).toMatchObject({
      contents: [
        { role: 'user' },
        {
          role: 'model',
          parts: [
            {
              functionCall: { id: call?.call_id, name: 'lookup', args: { query: 'value' } },
              thoughtSignature: 'opaque-signature',
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: call?.call_id,
                name: 'lookup',
                response: { result: 'result' },
              },
            },
          ],
        },
      ],
    });
  });

  it('converts native images, instructions and structured output without fetching image URLs', () => {
    const prepared = prepareUpstream(provider, {
      model: 'vendor/gemini-model',
      instructions: 'Return JSON',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'inspect' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          ],
        },
      ],
      text: { format: { type: 'json_schema', schema: { type: 'object' } } },
      max_output_tokens: 4096,
    });
    expect(prepared).toMatchObject({
      ok: true,
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'inspect' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
          },
        ],
        systemInstruction: { parts: [{ text: 'Return JSON' }] },
        generationConfig: {
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          responseJsonSchema: { type: 'object' },
        },
      },
    });
  });

  it('rejects malformed native tool history before contacting the upstream', () => {
    const prepared = prepareUpstream(provider, {
      model: 'vendor/gemini-model',
      input: [{ type: 'function_call', call_id: 'invalid', name: 'lookup', arguments: '{' }],
    });
    expect(prepared).toMatchObject({ ok: false, status: 400 });
  });

  it.each([
    [
      { candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] },
      'response.incomplete',
    ],
    [{ error: { message: 'upstream error', code: 500 } }, 'response.failed'],
    [{ candidates: [{ content: { parts: [{ text: 'unfinished' }] } }] }, 'response.failed'],
  ])('preserves native stream failure and truncation semantics', async (chunk, expected) => {
    const prepared = prepareUpstream(provider, { model: 'vendor/gemini-model', input: 'ping' });
    if (!prepared.ok) throw new Error(prepared.message);
    const events = await eventsOf(
      prepared.translate(stream([chunk]), new AbortController().signal),
    );
    expect(events.at(-1)?.type).toBe(expected);
  });

  it('records native tool catalogs, instructions and Wevir output bytes', () => {
    const source: ResponsesRequest = {
      model: 'vendor/gemini-model',
      instructions: 'system instruction',
      tools: [{ ...tool, name: 'wevir_lookup' }],
      input: [
        { type: 'function_call', call_id: 'call', name: 'wevir_lookup', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call', output: 'result' },
      ],
    };
    const prepared = prepareUpstream(provider, source);
    if (!prepared.ok) throw new Error(prepared.message);
    const serialized = JSON.stringify(prepared.payload);
    const stats = requestStats(prepared.payload as JsonObject, prepared.mode, serialized, source);
    expect(stats).toMatchObject({
      toolCount: 1,
      requestBytes: Buffer.byteLength(serialized),
      wevirOutputBytes: Buffer.byteLength('{"result":"result"}'),
    });
    expect(stats.instructionBytes).toBeGreaterThan(0);
  });

  it('serves models with different protocols through the same live gateway provider route', async () => {
    const send = vi.fn<typeof fetch>(async (url) => {
      const target = String(url);
      if (target.endsWith('/responses'))
        return stream([
          {
            type: 'response.completed',
            response: { id: 'resp_fixture', status: 'completed', output: [] },
          },
        ]);
      if (target.endsWith('/chat/completions'))
        return stream([
          {
            choices: [{ delta: { content: 'chat ok' }, finish_reason: 'stop' }],
          },
        ]);
      if (target.endsWith('/messages'))
        return stream([
          {
            type: 'message_start',
            message: { id: 'msg_fixture', usage: { input_tokens: 1, output_tokens: 0 } },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'messages ok' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ]);
      return stream([
        { candidates: [{ content: { parts: [{ text: 'gemini ok' }] }, finishReason: 'STOP' }] },
      ]);
    });
    const gateway = await startModelGateway({ fetch: send });
    gateway.setProviders([provider]);
    try {
      for (const model of provider.models) {
        const response = await fetch(`${gateway.baseURL(provider.id)}/responses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: model.id, input: 'ping', stream: true }),
        });
        expect(response.status).toBe(200);
        const output = await response.text();
        expect(output).toContain('response.completed');
        expect(output).not.toContain('response.failed');
      }
      expect(send).toHaveBeenCalledTimes(4);
      expect(new Set(send.mock.calls.map(([url]) => String(url))).size).toBe(4);
    } finally {
      await gateway.close();
    }
  });
});
