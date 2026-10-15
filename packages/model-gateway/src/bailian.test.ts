import { describe, expect, it } from 'vitest';
import { CODEX_SAMPLES, codexRequest } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

const bailian: GatewayProvider = {
  id: 'dashscope',
  kind: 'openai-compatible',
  displayName: 'Bailian',
  api: 'openai-responses',
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  models: [{ id: 'qwen3.8-max' }],
  defaultModelId: 'qwen3.8-max',
};

describe('百炼 Responses（录制请求）', () => {
  it.each(CODEX_SAMPLES)('%s 按地址摊平工具，保留推理与 store: false', (name) => {
    const recorded = codexRequest(name).body;
    const body: ResponsesRequest = { ...recorded, model: 'qwen3.8-max', tool_choice: 'required' };
    const original = structuredClone(body);
    const prepared = prepareUpstream(bailian, body);
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.mode).toBe('responses');
    expect(prepared.url).toBe(`${bailian.baseURL}/responses`);
    const forwarded = prepared.payload as ResponsesRequest;
    expect(forwarded).not.toHaveProperty('client_metadata');
    for (const field of ['model', 'store', 'include', 'reasoning', 'prompt_cache_key'])
      expect(forwarded[field]).toEqual(body[field]);
    expect(forwarded.tools?.every((tool) => tool.type === 'function')).toBe(true);
    if (name === '4-compact') expect(forwarded).not.toHaveProperty('tool_choice');
    else {
      expect(forwarded.tool_choice).toBe('auto');
      const patch = forwarded.tools?.find((tool) => tool.name === 'apply_patch');
      expect(patch).toMatchObject({ type: 'function', parameters: { required: ['input'] } });
      expect(patch?.description).toContain('begin_patch');
      expect(forwarded.tools?.some((tool) => tool.name === 'multi_agent_v1__spawn_agent')).toBe(
        true,
      );
    }
    const input = forwarded.input as ResponsesItem[];
    expect(input.some((item) => item.type.startsWith('custom_tool_call'))).toBe(false);
    expect(input.some((item) => item.namespace !== undefined)).toBe(false);
    const reasoning = input.filter((item) => item.type === 'reasoning');
    const originalReasoning = (body.input as ResponsesItem[]).filter(
      (item) => item.type === 'reasoning',
    );
    expect(reasoning.map(({ id, summary }) => ({ id, summary }))).toEqual(
      originalReasoning.map(({ id, summary }) => ({ id, summary })),
    );
    for (const item of reasoning) {
      expect(item.content).not.toBeNull();
      expect(item.encrypted_content).not.toBeNull();
    }
    for (const call of input.filter((item) => item.type === 'function_call')) {
      if (call.name === 'apply_patch') {
        const source = (body.input as ResponsesItem[]).find(
          (item) => item.call_id === call.call_id,
        );
        expect(JSON.parse(String(call.arguments))).toEqual({ input: source?.input });
      }
    }
    expect(body).toEqual(original);
  });

  it.each(['none', 'low', 'medium', 'xhigh'])(
    'Qwen3.8 的 effort %s 原样透传，不注入 Chat 开关',
    (effort) => {
      const body: ResponsesRequest = {
        ...codexRequest('1-first-turn').body,
        model: 'qwen3.8-flash',
        reasoning: { effort },
      };
      const prepared = prepareUpstream(bailian, body);
      if (!prepared.ok) throw new Error(prepared.message);
      expect(prepared.payload).toHaveProperty('reasoning', { effort });
      expect(prepared.payload).not.toHaveProperty('enable_thinking');
      expect(prepared.payload).not.toHaveProperty('thinking_budget');
      expect(prepared.payload).not.toHaveProperty('reasoning_effort');
    },
  );

  it('显式支持可关闭全部摊平与 auto_only，原生工具与具名选择保留', () => {
    const body: ResponsesRequest = {
      ...codexRequest('1-first-turn').body,
      tool_choice: { type: 'custom', name: 'apply_patch' },
    };
    const prepared = prepareUpstream(
      {
        ...bailian,
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
