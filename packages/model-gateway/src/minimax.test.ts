import { describe, expect, it } from 'vitest';
import { applyDialects } from './dialects.js';
import { effectiveCompat, isMinimaxHost } from './providers.js';
import { CODEX_SAMPLES, codexRequest } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

const minimax: GatewayProvider = {
  id: 'minimax',
  kind: 'openai-compatible',
  displayName: 'MiniMax',
  api: 'openai-responses',
  baseURL: 'https://api.minimax.cn/v1',
  models: [{ id: 'MiniMax-M3.1-Flash', contextWindow: 524288 }],
  defaultModelId: 'MiniMax-M3.1-Flash',
};
const defaults = {
  supportsCustomTools: false,
  supportsNamespaceTools: false,
  toolChoice: 'auto_only',
} as const;

describe('MiniMax 按量地址与 Responses', () => {
  it.each([
    'https://api.minimax.cn/v1',
    'https://api.minimaxi.com/v1',
    'https://api.minimax.io/v1',
    'https://API.MINIMAX.IO/v1/',
  ])('%s 补工具兼容值', (baseURL) => {
    expect(isMinimaxHost(baseURL)).toBe(true);
    expect(effectiveCompat({ ...minimax, baseURL })).toEqual(defaults);
  });

  it.each([
    'https://api.minimax.cn.example.org/v1',
    'https://notminimax.io/v1',
    'https://minimax.io@proxy.example.org/v1',
    'not a URL',
  ])('%s 不获得 MiniMax 默认值', (baseURL) => {
    expect(isMinimaxHost(baseURL)).toBe(false);
    expect(effectiveCompat({ ...minimax, baseURL })).toEqual({
      supportsCustomTools: true,
      supportsNamespaceTools: true,
      toolChoice: 'any',
    });
  });

  it.each(['openai-completions', 'anthropic-messages'])('%s 不套 Responses 默认值', (api) => {
    expect(effectiveCompat({ ...minimax, api })).toEqual({
      supportsCustomTools: true,
      supportsNamespaceTools: true,
      toolChoice: 'any',
    });
    const body: ResponsesRequest = { ...codexRequest('1-first-turn').body, reasoning: {} };
    expect(applyDialects({ ...minimax, api }, body).applied).not.toContain('minimax-reasoning');
  });

  it('显式字段逐项优先，代理需显式 compat', () => {
    expect(effectiveCompat({ ...minimax, compat: { supportsNamespaceTools: true } })).toEqual({
      ...defaults,
      supportsNamespaceTools: true,
    });
    expect(
      effectiveCompat({ ...minimax, baseURL: 'https://proxy.example.org/v1', compat: defaults }),
    ).toEqual(defaults);
  });

  it.each(CODEX_SAMPLES)('%s 摊平工具与历史，reasoning 只留 effort', (name) => {
    const body: ResponsesRequest = {
      ...codexRequest(name).body,
      model: minimax.defaultModelId,
      tool_choice: 'required',
    };
    const original = structuredClone(body);
    const prepared = prepareUpstream(minimax, body);
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.mode).toBe('responses');
    expect(prepared.url).toBe('https://api.minimax.cn/v1/responses');
    const forwarded = prepared.payload as ResponsesRequest;
    expect(forwarded).not.toHaveProperty('client_metadata');
    expect(forwarded).not.toHaveProperty('max_output_tokens');
    expect(forwarded.reasoning).toEqual({ effort: 'high' });
    for (const field of ['store', 'include', 'prompt_cache_key', 'parallel_tool_calls'])
      expect(forwarded[field]).toEqual(body[field]);
    const tools = forwarded.tools ?? [];
    expect(tools.every((tool) => tool.type === 'function')).toBe(true);
    expect(tools.every((tool) => /^[A-Za-z0-9_-]{1,64}$/.test(tool.name ?? ''))).toBe(true);
    if (name === '4-compact') expect(forwarded).not.toHaveProperty('tool_choice');
    else {
      expect(forwarded.tool_choice).toBe('auto');
      expect(tools.find((tool) => tool.name === 'apply_patch')).toMatchObject({
        type: 'function',
        parameters: { required: ['input'] },
        strict: false,
      });
      expect(tools.some((tool) => tool.name === 'multi_agent_v1__spawn_agent')).toBe(true);
    }
    const input = forwarded.input as ResponsesItem[];
    expect(input.some((item) => item.type.startsWith('custom_tool_call'))).toBe(false);
    expect(input.some((item) => item.namespace !== undefined)).toBe(false);
    expect(
      input.some(
        (item) =>
          item.type === 'reasoning' && (item.content === null || item.encrypted_content === null),
      ),
    ).toBe(false);
    expect(body).toEqual(original);
  });

  it.each([
    ['MiniMax-M3.1-Flash', 'none', 'low'],
    ['MiniMax-M3.1-Flash', 'minimal', 'low'],
    ['minimax-m3.1-flash', 'none', 'low'],
    ['MiniMax-M3.1-Flash', 'max', 'max'],
    ['MiniMax-M3', 'none', 'none'],
    ['MiniMax-M3', 'high', 'high'],
    ['MiniMax-M2.7', 'none', 'none'],
  ])('%s 的 %s 发成 %s，不注入 Chat 开关或输出预算', (model, effort, sent) => {
    const body: ResponsesRequest = {
      ...codexRequest('1-first-turn').body,
      model,
      reasoning: { effort, summary: 'auto' },
    };
    const prepared = prepareUpstream(minimax, body);
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.payload).toHaveProperty('reasoning', { effort: sent });
    for (const field of ['thinking', 'reasoning_effort', 'reasoning_split', 'max_output_tokens'])
      expect(prepared.payload).not.toHaveProperty(field);
  });

  it('没有 effort 时只去掉 summary；没有 reasoning 时不补', () => {
    const body: ResponsesRequest = {
      ...codexRequest('1-first-turn').body,
      reasoning: { summary: 'auto' },
    };
    expect(applyDialects(minimax, body).body.reasoning).toEqual({});
    const { reasoning: _drop, ...bare } = body;
    const result = applyDialects(minimax, bare as ResponsesRequest);
    expect(result.body).not.toHaveProperty('reasoning');
    expect(result.applied).not.toContain('minimax-reasoning');
  });

  it('代理地址不改推理档位；完整显式支持保留原生工具与具名选择', () => {
    const proxied = applyDialects(
      { ...minimax, baseURL: 'https://proxy.example.org/v1', compat: defaults },
      { ...codexRequest('1-first-turn').body, reasoning: { effort: 'none', summary: 'auto' } },
    );
    expect(proxied.body.reasoning).toEqual({ effort: 'none', summary: 'auto' });

    const body: ResponsesRequest = {
      ...codexRequest('1-first-turn').body,
      tool_choice: { type: 'custom', name: 'apply_patch' },
    };
    const prepared = prepareUpstream(
      {
        ...minimax,
        compat: { supportsCustomTools: true, supportsNamespaceTools: true, toolChoice: 'any' },
      },
      body,
    );
    if (!prepared.ok) throw new Error(prepared.message);
    const { client_metadata: _drop, ...expected } = body;
    expect(prepared.payload).toEqual({ ...expected, reasoning: { effort: 'high' } });
    expect(prepared.dialects).toEqual(['minimax-reasoning']);
  });
});
