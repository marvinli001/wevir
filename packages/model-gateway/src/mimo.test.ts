import { describe, expect, it } from 'vitest';
import { effectiveCompat, isMimoHost } from './providers.js';
import { CODEX_SAMPLES, codexRequest } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

const mimo: GatewayProvider = {
  id: 'mimo',
  kind: 'openai-compatible',
  displayName: 'Xiaomi MiMo',
  api: 'openai-responses',
  baseURL: 'https://api.xiaomimimo.com/v1',
  models: [{ id: 'mimo-v2.6-pro', maxTokens: 131072 }],
  defaultModelId: 'mimo-v2.6-pro',
};
const defaults = {
  supportsCustomTools: false,
  supportsNamespaceTools: false,
  toolChoice: 'auto_only',
} as const;

describe('MiMo 按量地址与普通 Responses', () => {
  it.each([
    'https://api.xiaomimimo.com/v1',
    'https://xiaomimimo.com/v1',
    'https://CN.API.XIAOMIMIMO.COM/v1/',
  ])('%s 补现有工具兼容值', (baseURL) => {
    expect(isMimoHost(baseURL)).toBe(true);
    expect(effectiveCompat({ ...mimo, baseURL })).toEqual(defaults);
  });

  it.each([
    'https://token-plan-cn.xiaomimimo.com/v1',
    'https://token-plan-us.xiaomimimo.com/v1',
    'https://token-plan.xiaomimimo.com/v1',
    'https://api.token-plan-cn.xiaomimimo.com/v1',
    'https://api.xiaomimimo.com.example.org/v1',
    'https://notxiaomimimo.com/v1',
    'https://xiaomimimo.com@proxy.example.org/v1',
    'not a URL',
  ])('%s 不获得 MiMo 默认值', (baseURL) => {
    expect(isMimoHost(baseURL)).toBe(false);
    expect(effectiveCompat({ ...mimo, baseURL })).toEqual({
      supportsCustomTools: true,
      supportsNamespaceTools: true,
      toolChoice: 'any',
    });
  });

  it.each(['openai-completions', 'anthropic-messages'])('%s 不套 Responses 默认值', (api) => {
    expect(effectiveCompat({ ...mimo, api })).toEqual({
      supportsCustomTools: true,
      supportsNamespaceTools: true,
      toolChoice: 'any',
    });
  });

  it('显式字段逐项优先，代理需显式 compat', () => {
    expect(effectiveCompat({ ...mimo, compat: { supportsNamespaceTools: true } })).toEqual({
      ...defaults,
      supportsNamespaceTools: true,
    });
    expect(
      effectiveCompat({ ...mimo, baseURL: 'https://proxy.example.org/v1', compat: defaults }),
    ).toEqual(defaults);
  });

  it.each(CODEX_SAMPLES)('%s 摊平工具与历史，不开启 Lite 或改写推理', (name) => {
    const body: ResponsesRequest = {
      ...codexRequest(name).body,
      model: mimo.defaultModelId,
      tool_choice: 'required',
    };
    const original = structuredClone(body);
    const prepared = prepareUpstream(mimo, body);
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.mode).toBe('responses');
    expect(prepared.url).toBe('https://api.xiaomimimo.com/v1/responses');
    expect(prepared.headers).not.toHaveProperty('x-openai-internal-codex-responses-lite');
    const forwarded = prepared.payload as ResponsesRequest;
    expect(forwarded).not.toHaveProperty('client_metadata');
    expect(forwarded).not.toHaveProperty('max_output_tokens');
    for (const field of [
      'store',
      'include',
      'reasoning',
      'prompt_cache_key',
      'parallel_tool_calls',
    ])
      expect(forwarded[field]).toEqual(body[field]);
    const tools = forwarded.tools ?? [];
    expect(tools.every((tool) => tool.type === 'function')).toBe(true);
    expect(tools.every((tool) => /^[A-Za-z0-9_-]{1,64}$/.test(tool.name ?? ''))).toBe(true);
    if (name === '4-compact') expect(forwarded).not.toHaveProperty('tool_choice');
    else {
      expect(forwarded.tool_choice).toBe('auto');
      const patch = tools.find((tool) => tool.name === 'apply_patch');
      expect(patch).toMatchObject({
        type: 'function',
        parameters: { required: ['input'] },
        strict: false,
      });
      expect(patch?.description).toContain('begin_patch');
      expect(tools.some((tool) => tool.name === 'multi_agent_v1__spawn_agent')).toBe(true);
    }
    const input = forwarded.input as ResponsesItem[];
    expect(input.some((item) => item.type.startsWith('custom_tool_call'))).toBe(false);
    expect(input.some((item) => item.namespace !== undefined)).toBe(false);
    expect(input.some((item) => item.type === 'additional_tools')).toBe(false);
    const recordedReasoning = (body.input as ResponsesItem[])
      .filter((item) => item.type === 'reasoning')
      .map((item) => {
        const cleaned = { ...item };
        if (cleaned.content === null) delete cleaned.content;
        if (cleaned.encrypted_content === null) delete cleaned.encrypted_content;
        return cleaned;
      });
    expect(input.filter((item) => item.type === 'reasoning')).toEqual(recordedReasoning);
    for (const call of input.filter((item) => item.type === 'function_call')) {
      if (call.name !== 'apply_patch') continue;
      const source = (body.input as ResponsesItem[]).find((item) => item.call_id === call.call_id);
      expect(JSON.parse(String(call.arguments))).toEqual({ input: source?.input });
    }
    expect(body).toEqual(original);
  });

  it.each(['mimo-v2.6-pro', 'mimo-v2.6-flash'])(
    '%s 的 none / high 原样发送，不注入 Chat 开关或输出预算',
    (model) => {
      for (const effort of ['none', 'high']) {
        const body: ResponsesRequest = {
          ...codexRequest('1-first-turn').body,
          model,
          reasoning: { effort },
        };
        const prepared = prepareUpstream(mimo, body);
        if (!prepared.ok) throw new Error(prepared.message);
        expect(prepared.payload).toHaveProperty('reasoning', { effort });
        for (const field of ['thinking', 'reasoning_effort', 'max_output_tokens'])
          expect(prepared.payload).not.toHaveProperty(field);
      }
    },
  );

  it('完整显式支持可保留原生工具与具名选择', () => {
    const body: ResponsesRequest = {
      ...codexRequest('1-first-turn').body,
      tool_choice: { type: 'custom', name: 'apply_patch' },
    };
    const prepared = prepareUpstream(
      {
        ...mimo,
        compat: { supportsCustomTools: true, supportsNamespaceTools: true, toolChoice: 'any' },
      },
      body,
    );
    if (!prepared.ok) throw new Error(prepared.message);
    const { client_metadata: _drop, ...expected } = body;
    expect(prepared.payload).toEqual(expected);
    expect(prepared.dialects).toEqual([]);
  });
});
