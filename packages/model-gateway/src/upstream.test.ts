import { describe, expect, it } from 'vitest';
import { CODEX_SAMPLES, codexRequest } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

const openai: GatewayProvider = {
  id: 'openai',
  kind: 'openai-compatible',
  displayName: 'OpenAI',
  api: 'openai-responses',
  baseURL: 'https://api.openai.com/v1',
  models: [{ id: 'gpt-6.1-sol' }],
  defaultModelId: 'gpt-6.1-sol',
};

describe('OpenAI 官方 Responses 透传（录制请求）', () => {
  it.each(CODEX_SAMPLES)('%s 保留缓存键、推理设置、工具类型与历史顺序，不产生响应改写', (name) => {
    const body = codexRequest(name).body;
    const prepared = prepareUpstream(openai, body);
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.mode).toBe('responses');
    expect(prepared.url).toBe('https://api.openai.com/v1/responses');
    const forwarded = prepared.payload as ResponsesRequest;
    expect(forwarded).not.toHaveProperty('client_metadata');
    for (const field of ['model', 'prompt_cache_key', 'store', 'include', 'reasoning', 'tools']) {
      expect(forwarded[field]).toEqual(body[field]);
    }
    const order = (input: ResponsesRequest['input']) =>
      (input as ResponsesItem[]).map(({ type, call_id }) => [type, call_id]);
    expect(order(forwarded.input)).toEqual(order(body.input));
    expect(prepared.dialects).not.toContain('flatten-custom-tools');
    expect(prepared.dialects).not.toContain('flatten-namespace-tools');
    expect(prepared.dialects).not.toContain('auto-only-tool-choice');
    if (name === '4-compact') expect(forwarded).not.toHaveProperty('tool_choice');
    else expect(forwarded.tool_choice).toEqual(body.tool_choice);
  });

  it.each([
    { prompt_cache_options: { ttl: '30m' } },
    { prompt_cache_retention: '24h' },
    { prompt_cache_options: { ttl: '30m' }, prompt_cache_retention: '24h' },
  ])('保留缓存参数 %j 的独立含义，不互相转换或补默认值', (cache) => {
    const body: ResponsesRequest = { ...codexRequest('1-first-turn').body, ...cache };
    const prepared = prepareUpstream(openai, body);
    if (!prepared.ok) throw new Error(prepared.message);
    const { client_metadata: _drop, ...expected } = body;
    expect(prepared.payload).toEqual(expected);
  });
});
