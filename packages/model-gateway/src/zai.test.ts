import { describe, expect, it } from 'vitest';
import { effectiveCompat, isZaiHost } from './providers.js';
import { CODEX_SAMPLES, codexRequest } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

const provider = (patch: Partial<GatewayProvider> = {}): GatewayProvider => ({
  id: 'zai',
  kind: 'openai-compatible',
  displayName: 'Z.ai',
  api: 'openai-responses',
  baseURL: 'https://api.z.ai/api/v1',
  models: [{ id: 'glm-5.3' }],
  defaultModelId: 'glm-5.3',
  ...patch,
});

describe('Z.ai / 智谱 Responses 的录制请求', () => {
  for (const baseURL of ['https://api.z.ai/api/v1', 'https://open.bigmodel.cn/api/v1']) {
    it.each(CODEX_SAMPLES)(`${baseURL} / %s 保留 apply_patch，摊平 namespace`, (name) => {
      const body: ResponsesRequest = {
        ...codexRequest(name).body,
        model: 'glm-5.3',
        tool_choice: 'required',
      };
      const original = structuredClone(body);
      const prepared = prepareUpstream(provider({ baseURL }), body);
      if (!prepared.ok) throw new Error(prepared.message);
      expect(prepared.mode).toBe('responses');
      expect(prepared.url).toBe(`${baseURL}/responses`);
      const forwarded = prepared.payload as ResponsesRequest;
      expect(forwarded).not.toHaveProperty('client_metadata');
      expect(forwarded).not.toHaveProperty('max_output_tokens');
      for (const field of ['model', 'store', 'include', 'reasoning', 'prompt_cache_key'])
        expect(forwarded[field]).toEqual(body[field]);
      expect(forwarded.tool_choice).toBe(name === '4-compact' ? undefined : 'auto');
      expect(forwarded.tools?.some((tool) => tool.type === 'namespace')).toBe(false);
      if (name !== '4-compact') {
        expect(forwarded.tools?.find((tool) => tool.name === 'apply_patch')).toEqual(
          body.tools?.find((tool) => tool.name === 'apply_patch'),
        );
        expect(forwarded.tools?.some((tool) => tool.name === 'multi_agent_v1__spawn_agent')).toBe(
          true,
        );
      }
      expect(forwarded.input).toEqual(
        (body.input as ResponsesItem[]).map((item) =>
          item.type === 'reasoning'
            ? Object.fromEntries(
                Object.entries(item).filter(
                  ([key, value]) =>
                    !(['content', 'encrypted_content'].includes(key) && value === null),
                ),
              )
            : item,
        ),
      );
      expect(prepared.dialects).not.toContain('flatten-custom-tools');
      expect(body).toEqual(original);
    });
  }

  it.each(['glm-5.3', 'glm-5.3-flash'])('%s 的三档思考原样透传，不注入 Chat 参数', (model) => {
    for (const effort of ['low', 'high', 'max', undefined]) {
      const body: ResponsesRequest = {
        model,
        input: '你好',
        ...(effort === undefined ? {} : { reasoning: { effort } }),
      };
      const prepared = prepareUpstream(provider(), body);
      if (!prepared.ok) throw new Error(prepared.message);
      expect(prepared.payload).toEqual(body);
      expect(prepared.payload).not.toHaveProperty('thinking');
      expect(prepared.payload).not.toHaveProperty('reasoning_effort');
    }
  });

  it('显式开关逐字段优先，代理仍可保留同样的兼容行为', () => {
    const body: ResponsesRequest = {
      ...codexRequest('1-first-turn').body,
      tool_choice: { type: 'custom', name: 'apply_patch' },
    };
    const declared = prepareUpstream(
      provider({ compat: { supportsNamespaceTools: true, toolChoice: 'any' } }),
      body,
    );
    if (!declared.ok) throw new Error(declared.message);
    const { client_metadata: _drop, ...expected } = body;
    expect(declared.payload).toEqual(expected);
    const custom = prepareUpstream(provider({ compat: { supportsCustomTools: false } }), body);
    if (!custom.ok) throw new Error(custom.message);
    expect(custom.dialects).toContain('flatten-custom-tools');
    expect(custom.dialects).toContain('flatten-namespace-tools');
    const proxied = prepareUpstream(
      provider({
        baseURL: 'https://proxy.example.com/v1',
        compat: {
          supportsCustomTools: true,
          supportsNamespaceTools: false,
          toolChoice: 'auto_only',
        },
      }),
      body,
    );
    const addressed = prepareUpstream(provider(), body);
    if (!proxied.ok || !addressed.ok) throw new Error('无法准备请求');
    expect(proxied.payload).toEqual(addressed.payload);
  });
});

describe('Z.ai / 智谱的地址边界与 Chat 兜底', () => {
  it('只给两个域名的标准路径补值，Messages、套餐与相似地址保持原规则', () => {
    for (const host of ['z.ai', 'api.z.ai', 'bigmodel.cn', 'open.bigmodel.cn']) {
      for (const path of ['/api/v1', '/api/paas/v4/']) {
        const baseURL = `https://${host}${path}`;
        expect(isZaiHost(baseURL)).toBe(true);
        expect(effectiveCompat(provider({ baseURL }))).toMatchObject({
          supportsCustomTools: true,
          supportsNamespaceTools: false,
          toolChoice: 'auto_only',
        });
        expect(effectiveCompat(provider({ baseURL, api: 'openai-completions' }))).toMatchObject({
          supportsCustomTools: true,
          supportsNamespaceTools: true,
          toolChoice: 'auto_only',
        });
        expect(effectiveCompat(provider({ baseURL, api: 'anthropic-messages' })).toolChoice).toBe(
          'any',
        );
      }
    }
    for (const baseURL of [
      'https://api.z.ai/api/coding/paas/v4',
      'https://open.bigmodel.cn/api/coding/paas/v4',
      'https://coding.z.ai/api/v1',
      'https://coding-plan.bigmodel.cn/api/v1',
      'https://token-plan.bigmodel.cn/api/v1',
      'https://api.z.ai/api/%63oding/paas/v4',
      'https://api.z.ai.example.com/api/v1',
      'https://notbigmodel.cn/api/v1',
      'https://example.com/api.z.ai/api/v1',
      'https://api.z.ai/unknown',
      'invalid',
    ]) {
      expect(isZaiHost(baseURL)).toBe(false);
      expect(effectiveCompat(provider({ baseURL }))).toMatchObject({
        supportsCustomTools: true,
        supportsNamespaceTools: true,
        toolChoice: 'any',
      });
    }
  });

  it.each(['https://api.z.ai/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4'])(
    '%s 的显式 zai 格式保留历史推理，GLM-5.3 的 none 降 low',
    (baseURL) => {
      const prepared = prepareUpstream(
        provider({ baseURL, api: 'openai-completions', compat: { thinkingFormat: 'zai' } }),
        {
          ...codexRequest('2-tool-results').body,
          model: 'glm-5.3',
          reasoning: { effort: 'none' },
          tool_choice: 'required',
        },
      );
      if (!prepared.ok || !prepared.chat) throw new Error('无法准备 Chat 请求');
      expect(prepared.url).toBe(`${baseURL}/chat/completions`);
      expect(prepared.chat.request).toMatchObject({
        thinking: { type: 'enabled', clear_thinking: false },
        reasoning_effort: 'low',
        tool_choice: 'auto',
      });
      expect(
        prepared.chat.request.messages.find((message) => message.tool_calls)?.reasoning_content,
      ).toBe('先建文件，再看目录。');
    },
  );
});
