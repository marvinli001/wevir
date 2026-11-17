import { describe, expect, it } from 'vitest';
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
  id: 'zuv-api-login',
  kind: 'openai-compatible',
  displayName: 'ZUV API',
  baseURL: 'https://zuv.wevir.si/v1',
  api: 'openai-responses',
  defaultModelId: 'xai/grok-4.7',
  models: [{ id: 'xai/grok-4.7' }, { id: 'deepseek/deepseek-v4.1-flash' }],
};

describe('ZUV Responses replay model boundary', () => {
  it('preserves same-model state and excludes it after a model or provider switch without losing tool history', async () => {
    const reasoning: ResponsesItem = {
      type: 'reasoning',
      id: 'rs',
      summary: [],
      encrypted_content: 'synthetic-opaque-state',
    };
    const output: ResponsesItem[] = [
      reasoning,
      { type: 'function_call', id: 'fc', call_id: 'call', name: 'lookup', arguments: '{}' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Saved context' }],
      },
    ];
    const first = prepareUpstream(provider, { model: provider.defaultModelId, input: 'Start' });
    if (!first.ok) throw new Error(first.message);
    const upstreamEvents = [
      { type: 'response.output_item.added', item: reasoning, output_index: 0 },
      { type: 'response.output_item.done', item: reasoning, output_index: 0 },
      { type: 'response.completed', response: { id: 'resp', status: 'completed', output } },
    ];
    const response = new Response(
      upstreamEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    );
    const parser = new SseParser();
    const events: ResponsesEvent[] = [];
    for await (const chunk of first.translate(response, new AbortController().signal))
      for (const message of parser.push(chunk)) events.push(JSON.parse(message.data));
    const terminal = events.at(-1)?.response as JsonObject;
    const replayed = terminal.output as ResponsesItem[];
    expect(events[0]?.item).toEqual(replayed[0]);
    expect(events[1]?.item).toEqual(replayed[0]);
    expect(replayed[0]?.encrypted_content).toMatch(/^wevir-gw:zuv-replay:v1:/);
    const toolResult = { type: 'function_call_output', call_id: 'call', output: 'Tool result' };
    const input: ResponsesItem[] = [
      ...replayed,
      toolResult,
      { type: 'message', role: 'user', content: 'Continue' },
    ];
    const same = prepareUpstream(provider, {
      model: provider.defaultModelId,
      input,
      reasoning: { effort: 'xhigh' },
    });
    if (!same.ok) throw new Error(same.message);
    expect(same.payload).toMatchObject({
      input: [reasoning, ...input.slice(1)],
      reasoning: { effort: 'xhigh' },
    });
    for (const next of [
      { provider, model: 'deepseek/deepseek-v4.1-flash' },
      { provider: { ...provider, id: 'another-zuv-account' }, model: provider.defaultModelId },
    ]) {
      const prepared = prepareUpstream(next.provider, { model: next.model, input });
      if (!prepared.ok) throw new Error(prepared.message);
      expect((prepared.payload as ResponsesRequest).input).toEqual(input.slice(1));
    }
    expect(input[0]?.encrypted_content).toMatch(/^wevir-gw:zuv-replay:v1:/);
  });

  it('leaves unknown native state intact for server affinity validation', () => {
    const input = [{ type: 'reasoning', encrypted_content: 'legacy-native-state', summary: [] }];
    const prepared = prepareUpstream(provider, { model: provider.defaultModelId, input });
    if (!prepared.ok) throw new Error(prepared.message);
    expect((prepared.payload as ResponsesRequest).input).toEqual(input);
  });
});
