import { describe, expect, it } from 'vitest';
import { effectiveCompat, isKimiHost } from './providers.js';
import { CODEX_SAMPLES, codexRequest } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

const kimi = (patch: Partial<GatewayProvider> = {}): GatewayProvider => ({
  id: 'kimi',
  kind: 'openai-compatible',
  displayName: 'Kimi',
  api: 'openai-responses',
  baseURL: 'https://api.moonshot.cn/v1',
  models: [{ id: 'kimi-k3' }],
  defaultModelId: 'kimi-k3',
  ...patch,
});

describe('Kimi Responses 的录制请求', () => {
  for (const baseURL of ['https://api.moonshot.cn/v1', 'https://api.moonshot.ai/v1']) {
    it.each(CODEX_SAMPLES)(`${baseURL} / %s 保留原生工具、图片与推理历史`, (name) => {
      const body: ResponsesRequest = {
        ...codexRequest(name).body,
        model: 'kimi-k3',
        reasoning: { effort: 'high' },
        tool_choice: 'required',
      };
      const original = structuredClone(body);
      const prepared = prepareUpstream(kimi({ baseURL }), body);
      if (!prepared.ok) throw new Error(prepared.message);
      expect(prepared.mode).toBe('responses');
      expect(prepared.url).toBe(`${baseURL}/responses`);
      const forwarded = prepared.payload as ResponsesRequest;
      expect(forwarded).not.toHaveProperty('client_metadata');
      expect(forwarded).not.toHaveProperty('max_output_tokens');
      for (const field of ['model', 'tools', 'reasoning', 'include', 'store', 'prompt_cache_key'])
        expect(forwarded[field]).toEqual(body[field]);
      expect(forwarded.tool_choice).toBe(name === '4-compact' ? undefined : 'auto');
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
      expect(prepared.dialects).not.toContain('flatten-namespace-tools');
      expect(body).toEqual(original);
    });
  }

  it.each(['low', 'high', 'max', undefined])(
    '%s 档位或服务默认原样保留，不发 Chat 思考开关',
    (effort) => {
      const body: ResponsesRequest = {
        model: 'kimi-k3',
        input: '你好',
        ...(effort === undefined ? {} : { reasoning: { effort } }),
      };
      const prepared = prepareUpstream(kimi(), body);
      if (!prepared.ok) throw new Error(prepared.message);
      expect(prepared.payload).toEqual(body);
      expect(prepared.payload).not.toHaveProperty('thinking');
      expect(prepared.payload).not.toHaveProperty('reasoning_effort');
    },
  );

  it('保留 content 与 summary 的各自原文，让上游按 content 优先回放', () => {
    const reasoning = {
      type: 'reasoning',
      id: 'rs_kimi',
      summary: [{ type: 'summary_text', text: '摘要' }],
      content: [{ type: 'reasoning_text', text: '完整推理' }],
      encrypted_content: null,
    };
    const prepared = prepareUpstream(kimi(), { model: 'kimi-k3', input: [reasoning] });
    if (!prepared.ok) throw new Error(prepared.message);
    const { encrypted_content: _drop, ...expected } = reasoning;
    expect(prepared.payload).toHaveProperty('input', [expected]);
  });

  it('仅过滤用户消息与两种工具输出中的非 data URL 图片，不改文本或输入对象', () => {
    const data = {
      type: 'input_image',
      image_url: 'data:image/png;base64,AAA',
      detail: 'original',
    };
    const parts = [
      { type: 'input_text', text: '保留说明' },
      data,
      { type: 'input_image', image_url: 'https://images.example.com/photo.png' },
      { type: 'input_image', image_url: 'http://127.0.0.1/private.png' },
      { type: 'input_image', file_id: 'file_1' },
    ];
    const body: ResponsesRequest = {
      model: 'kimi-k3',
      input: [
        { type: 'message', role: 'user', content: parts },
        { type: 'function_call_output', call_id: 'view', output: parts },
        { type: 'custom_tool_call_output', call_id: 'patch', output: parts },
        { type: 'function_call_output', call_id: 'text', output: '保持原样' },
        { type: 'message', role: 'user', content: [parts[2]] },
      ],
    };
    const original = structuredClone(body);
    const prepared = prepareUpstream(kimi(), body);
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.payload).toHaveProperty('input', [
      { type: 'message', role: 'user', content: [parts[0], data] },
      { type: 'function_call_output', call_id: 'view', output: [parts[0], data] },
      { type: 'custom_tool_call_output', call_id: 'patch', output: [parts[0], data] },
      { type: 'function_call_output', call_id: 'text', output: '保持原样' },
      { type: 'message', role: 'user', content: [] },
    ]);
    expect(prepared.dialects).toEqual(['kimi-data-images-only']);
    expect(body).toEqual(original);
    const unrelated = prepareUpstream(kimi({ baseURL: 'https://example.com/v1' }), body);
    if (!unrelated.ok) throw new Error(unrelated.message);
    expect(unrelated.payload).toEqual(body);
  });
});

describe('Kimi 开放平台地址与显式 compat', () => {
  it('仅识别两个开放平台域名，Responses 默认 auto_only，其他协议保持原规则', () => {
    for (const host of ['moonshot.cn', 'api.moonshot.cn', 'moonshot.ai', 'api.moonshot.ai']) {
      const baseURL = `https://${host}/v1`;
      expect(isKimiHost(baseURL)).toBe(true);
      expect(effectiveCompat(kimi({ baseURL }))).toMatchObject({
        toolChoice: 'auto_only',
        supportsCustomTools: true,
        supportsNamespaceTools: true,
      });
      for (const api of ['openai-completions', 'anthropic-messages'])
        expect(effectiveCompat(kimi({ baseURL, api })).toolChoice).toBe('any');
    }
    for (const baseURL of [
      'https://api.kimi.com/coding/v1',
      'https://api.kimi.com/coding',
      'https://api.moonshot.cn.example.com/v1',
      'https://notmoonshot.ai/v1',
      'https://example.com/api.moonshot.cn',
      'invalid',
    ]) {
      expect(isKimiHost(baseURL)).toBe(false);
      expect(effectiveCompat(kimi({ baseURL })).toolChoice).toBe('any');
    }
  });

  it('显式 any / 工具开关优先；代理地址可以显式 auto_only', () => {
    const body: ResponsesRequest = {
      ...codexRequest('1-first-turn').body,
      model: 'kimi-k3',
      tool_choice: { type: 'custom', name: 'apply_patch' },
    };
    const explicit = prepareUpstream(kimi({ compat: { toolChoice: 'any' } }), body);
    if (!explicit.ok) throw new Error(explicit.message);
    expect(explicit.payload).toHaveProperty('tool_choice', body.tool_choice);
    const flattened = prepareUpstream(
      kimi({ compat: { supportsCustomTools: false, supportsNamespaceTools: false } }),
      body,
    );
    if (!flattened.ok) throw new Error(flattened.message);
    expect(flattened.dialects).toContain('flatten-custom-tools');
    expect(flattened.dialects).toContain('flatten-namespace-tools');
    const proxy = prepareUpstream(
      kimi({ baseURL: 'https://proxy.example.com/v1', compat: { toolChoice: 'auto_only' } }),
      body,
    );
    if (!proxy.ok) throw new Error(proxy.message);
    expect(proxy.payload).toHaveProperty('tool_choice', 'auto');
    expect(proxy.payload).toHaveProperty('tools', body.tools);
  });
});
