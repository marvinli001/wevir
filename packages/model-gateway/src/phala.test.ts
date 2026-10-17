import { describe, expect, it } from 'vitest';
import { effectiveCompat, isPhalaHost } from './providers.js';
import { CODEX_SAMPLES, codexRequest } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

const phala: GatewayProvider = {
  id: 'phala',
  kind: 'openai-compatible',
  displayName: 'Phala Private AI',
  api: 'openai-responses',
  baseURL: 'https://inference.phala.com/v1',
  models: [{ id: 'z-ai/glm-5.3' }],
  defaultModelId: 'z-ai/glm-5.3',
};
const conservative = {
  supportsCustomTools: false,
  supportsNamespaceTools: false,
  toolChoice: 'auto_only',
};

describe('Phala Responses 默认兼容与录制请求', () => {
  it.each([
    'https://inference.phala.com/v1',
    'https://api.redpill.ai/v1/',
    'https://tee.redpill.ai/v1',
  ])('%s 只给 Responses 补默认，显式 compat 优先', (baseURL) => {
    expect(isPhalaHost(baseURL)).toBe(true);
    expect(effectiveCompat({ ...phala, baseURL })).toMatchObject(conservative);
    for (const api of ['openai-completions', 'anthropic-messages']) {
      expect(effectiveCompat({ ...phala, baseURL, api })).toMatchObject({
        supportsCustomTools: true,
        supportsNamespaceTools: true,
        toolChoice: 'any',
      });
    }
    expect(
      effectiveCompat({ ...phala, baseURL, compat: { supportsNamespaceTools: true } }),
    ).toMatchObject({ ...conservative, supportsNamespaceTools: true });
    expect(effectiveCompat({ ...phala, baseURL, compat: { toolChoice: 'any' } })).toMatchObject({
      ...conservative,
      toolChoice: 'any',
    });
  });

  it.each([
    'https://api.redpill.ai.example.com/v1',
    'https://inference.phala.com.example.com/v1',
    'https://other.phala.com/v1',
    'https://coding.redpill.ai/v1',
    'https://api.redpill.ai/coding/v1',
    'https://api.redpill.ai',
    'not a URL',
  ])('%s 不套用 Phala 默认', (baseURL) => {
    expect(isPhalaHost(baseURL)).toBe(false);
    expect(effectiveCompat({ ...phala, baseURL })).toHaveProperty('toolChoice', 'any');
  });

  it.each(CODEX_SAMPLES)('%s 摊平工具与历史，不改推理或输入样本', (name) => {
    const body: ResponsesRequest = {
      ...codexRequest(name).body,
      model: 'z-ai/glm-5.3',
      tool_choice: 'required',
      provider: { aci_verified: true, zdr: true },
    };
    const original = structuredClone(body);
    const prepared = prepareUpstream(phala, body);
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.url).toBe('https://inference.phala.com/v1/responses');
    const forwarded = prepared.payload as ResponsesRequest;
    expect(forwarded).not.toHaveProperty('client_metadata');
    for (const field of ['model', 'store', 'include', 'reasoning', 'prompt_cache_key', 'provider'])
      expect(forwarded[field]).toEqual(body[field]);
    expect(forwarded.tools?.every((tool) => tool.type === 'function')).toBe(true);
    if (name === '4-compact') expect(forwarded).not.toHaveProperty('tool_choice');
    else {
      expect(forwarded.tool_choice).toBe('auto');
      expect(forwarded.tools?.find((tool) => tool.name === 'apply_patch')).toMatchObject({
        type: 'function',
        parameters: { required: ['input'] },
      });
      expect(forwarded.tools?.some((tool) => tool.name === 'multi_agent_v1__spawn_agent')).toBe(
        true,
      );
    }
    const input = forwarded.input as ResponsesItem[];
    expect(input.some((item) => item.type.startsWith('custom_tool_call'))).toBe(false);
    expect(input.some((item) => item.namespace !== undefined)).toBe(false);
    for (const item of input.filter((item) => item.type === 'reasoning')) {
      const source = (body.input as ResponsesItem[]).find(
        (originalItem) => originalItem.id === item.id,
      );
      expect(item.summary).toEqual(source?.summary);
      expect(item.content).not.toBeNull();
      expect(item.encrypted_content).not.toBeNull();
    }
    for (const call of input.filter(
      (item) => item.type === 'function_call' && item.name === 'apply_patch',
    )) {
      const source = (body.input as ResponsesItem[]).find((item) => item.call_id === call.call_id);
      expect(JSON.parse(String(call.arguments))).toEqual({ input: source?.input });
    }
    expect(body).toEqual(original);
  });

  it('代理显式开关与原生支持覆盖；非空推理和缓存字段保留', () => {
    const body: ResponsesRequest = {
      ...codexRequest('1-first-turn').body,
      input: [
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'reason' }],
          encrypted_content: 'opaque',
        },
      ],
      tool_choice: { type: 'custom', name: 'apply_patch' },
      prompt_cache_options: { ttl: '30m' },
    };
    const prepared = prepareUpstream(
      {
        ...phala,
        compat: { supportsCustomTools: true, supportsNamespaceTools: true, toolChoice: 'any' },
      },
      body,
    );
    if (!prepared.ok) throw new Error(prepared.message);
    const { client_metadata: _drop, ...expected } = body;
    expect(prepared.payload).toEqual(expected);
    const proxy = prepareUpstream(
      {
        ...phala,
        baseURL: 'https://proxy.example.com/v1',
        compat: {
          supportsCustomTools: false,
          supportsNamespaceTools: false,
          toolChoice: 'auto_only',
        },
      },
      body,
    );
    if (!proxy.ok) throw new Error(proxy.message);
    expect(proxy.payload).toHaveProperty('tool_choice', 'auto');
    expect(
      (proxy.payload as ResponsesRequest).tools?.every((tool) => tool.type === 'function'),
    ).toBe(true);
  });
});
