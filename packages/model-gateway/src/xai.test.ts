import { describe, expect, it } from 'vitest';
import { applyDialects, xaiReasoningEffort } from './dialects.js';
import { effectiveCompat, isXaiHost } from './providers.js';
import { CODEX_SAMPLES, codexRequest } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

const provider: GatewayProvider = {
  id: 'xai',
  kind: 'openai-compatible',
  displayName: 'SpaceXAI',
  api: 'openai-responses',
  baseURL: 'https://api.x.ai/v1',
  models: [{ id: 'grok-4.7' }],
  defaultModelId: 'grok-4.7',
};

describe('SpaceXAI Responses 推理档位', () => {
  it.each([
    ['none', 'low'],
    ['minimal', 'low'],
    ['max', 'xhigh'],
  ])('%s → %s，保留其他 reasoning 字段与原始请求', (effort, expected) => {
    for (const baseURL of ['https://api.x.ai/v1', 'https://us.api.x.ai/v1', 'https://X.AI/v1']) {
      const body: ResponsesRequest = {
        model: 'grok-4.7',
        input: 'ping',
        reasoning: { effort, summary: 'auto', context: 'all_turns' },
      };
      const original = structuredClone(body);
      expect(isXaiHost(baseURL)).toBe(true);
      const fixed = applyDialects({ ...provider, baseURL }, body);
      expect(fixed.applied).toContain('xai-reasoning-effort');
      expect(fixed.body.reasoning).toEqual({
        effort: expected,
        summary: 'auto',
        context: 'all_turns',
      });
      expect(body).toEqual(original);
    }
  });

  it.each([
    undefined,
    null,
    {},
    { summary: 'auto' },
    ...['low', 'medium', 'high', 'xhigh', 'future'].map((effort) => ({ effort })),
  ])('缺失、非对象与不需要映射的值 %j 不改写或补默认力度', (reasoning) => {
    const body: ResponsesRequest = {
      model: 'grok-4.7',
      input: [],
      ...(reasoning === undefined ? {} : { reasoning }),
    };
    expect(xaiReasoningEffort.apply(body).body).toBe(body);
  });

  it.each([
    { baseURL: 'https://api.x.ai.example.org/v1' },
    { baseURL: 'https://notx.ai/v1' },
    { baseURL: 'https://x.ai@proxy.example.org/v1' },
    { baseURL: 'https://proxy.example.org/x.ai/v1' },
    { baseURL: 'https://api.openai.com/v1' },
    { baseURL: 'invalid URL' },
    { api: 'openai-completions' },
    { api: 'anthropic-messages' },
    { kind: 'deepseek-official' as const },
  ])('其他地址或路由 %j 不套用力度映射', (overrides) => {
    const other = { ...provider, ...overrides, compat: { supportsCustomTools: false } };
    expect(xaiReasoningEffort.applies(other)).toBe(false);
    expect(
      applyDialects(other, { model: 'grok-4.7', input: [], reasoning: { effort: 'max' } }).body
        .reasoning,
    ).toEqual({ effort: 'max' });
  });

  it.each(CODEX_SAMPLES)('%s 保留缓存、存储与推理历史，只作已登记的修正', (sample) => {
    const body: ResponsesRequest = {
      ...codexRequest(sample).body,
      model: 'grok-4.7',
      reasoning: { effort: 'max', summary: 'auto' },
    };
    const original = structuredClone(body);
    const prepared = prepareUpstream(provider, body);
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.mode).toBe('responses');
    expect(prepared.url).toBe('https://api.x.ai/v1/responses');
    const forwarded = prepared.payload as ResponsesRequest;
    expect(forwarded.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
    for (const field of ['prompt_cache_key', 'store', 'include', 'parallel_tool_calls'])
      expect(forwarded[field]).toEqual(body[field]);
    for (const field of ['max_output_tokens', 'reasoning_effort', 'thinking', 'client_metadata'])
      expect(forwarded).not.toHaveProperty(field);
    expect(prepared.headers).not.toHaveProperty('x-grok-conv-id');
    expect(forwarded.tools?.every((tool) => tool.type === 'function')).toBe(true);
    const input = forwarded.input as ResponsesItem[];
    expect(
      input.some(
        (item) => item.type.startsWith('custom_tool_call') || item.namespace !== undefined,
      ),
    ).toBe(false);
    const expectedReasoning = (body.input as ResponsesItem[])
      .filter((item) => item.type === 'reasoning')
      .map((item) => {
        const cleaned = { ...item };
        if (cleaned.content === null) delete cleaned.content;
        if (cleaned.encrypted_content === null) delete cleaned.encrypted_content;
        return cleaned;
      });
    expect(input.filter((item) => item.type === 'reasoning')).toEqual(expectedReasoning);
    expect(body).toEqual(original);
  });

  it('工具显式支持仍优先于地址默认，且不控制独立的力度映射', () => {
    const explicit = {
      ...provider,
      compat: { supportsCustomTools: true, supportsNamespaceTools: true },
    };
    expect(effectiveCompat(explicit)).toMatchObject({
      supportsCustomTools: true,
      supportsNamespaceTools: true,
      toolChoice: 'any',
    });
    const body = { ...codexRequest('1-first-turn').body, reasoning: { effort: 'none' } };
    const fixed = applyDialects(explicit, body);
    expect(fixed.body.tools).toBe(body.tools);
    expect(fixed.applied).toEqual(['xai-reasoning-effort']);
  });
});
