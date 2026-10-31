import { describe, expect, it } from 'vitest';
import type { GatewayProvider } from './types.js';
import { prepareUpstream } from './upstream.js';

const relay = (api: GatewayProvider['api'], model: string): GatewayProvider => ({
  id: 'relay',
  kind: 'openai-compatible',
  displayName: 'Relay',
  api,
  baseURL: api === 'anthropic-messages' ? 'https://relay.example' : 'https://relay.example/v1',
  models: [{ id: model }],
  defaultModelId: model,
  apiKey: 'test-key',
});

describe('new-api/sub2api standard reasoning parameters', () => {
  it.each(['sonnet', 'haiku', 'opus'])(
    'Claude %s 4.5 selects a thinking budget without an explicit format',
    (family) => {
      const model = `claude-${family}-4-5`;
      const prepared = prepareUpstream(relay('anthropic-messages', model), {
        model,
        input: 'ping',
        reasoning: { effort: 'high' },
      });
      if (!prepared.ok) throw new Error(prepared.message);
      expect(prepared.payload).toMatchObject({
        thinking: { type: 'enabled', budget_tokens: 16000 },
      });
      if (family === 'opus')
        expect(prepared.payload).toHaveProperty('output_config.effort', 'high');
      else expect(prepared.payload).toHaveProperty('output_config', undefined);
    },
  );

  it.each(['openai-responses', 'openai-completions'] as const)(
    '%s preserves every requested effort',
    (api) => {
      for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
        const prepared = prepareUpstream(relay(api, 'gpt-6.1-terra'), {
          model: 'gpt-6.1-terra',
          input: 'ping',
          reasoning: { effort },
        });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) throw new Error(prepared.message);
        expect(prepared.payload).toMatchObject(
          api === 'openai-responses' ? { reasoning: { effort } } : { reasoning_effort: effort },
        );
        expect(prepared.url).toBe(
          `https://relay.example/v1/${api === 'openai-responses' ? 'responses' : 'chat/completions'}`,
        );
      }
    },
  );

  it.each(['claude-opus-5-5', 'claude-sonnet-5-5'])(
    '%s uses adaptive effort on an arbitrary Messages relay',
    (model) => {
      for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
        const prepared = prepareUpstream(relay('anthropic-messages', model), {
          model,
          input: 'ping',
          reasoning: { effort },
        });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) throw new Error(prepared.message);
        expect(prepared.url).toBe('https://relay.example/v1/messages');
        expect(prepared.payload).toMatchObject({
          thinking: { type: 'adaptive' },
          output_config: { effort },
        });
      }
    },
  );
});
