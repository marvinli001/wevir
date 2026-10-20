import { describe, expect, it } from 'vitest';
import { applyDialects } from './dialects.js';
import { effectiveCompat, isStepfunHost } from './providers.js';
import { CODEX_SAMPLES, codexRequest } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

const provider = (patch: Partial<GatewayProvider> = {}): GatewayProvider => ({
  id: 'stepfun',
  kind: 'openai-compatible',
  displayName: 'StepFun',
  api: 'openai-responses',
  baseURL: 'https://api.stepfun.com/v1',
  models: [{ id: 'step-5-preview' }],
  defaultModelId: 'step-5-preview',
  ...patch,
});
const defaults = {
  supportsCustomTools: true,
  supportsNamespaceTools: false,
  toolChoice: 'auto_only',
} as const;

describe('StepFun 按量地址与 compat', () => {
  it.each([
    'https://api.stepfun.com/v1',
    'https://api.stepfun.ai/v1/',
    'https://STEPFUN.COM/v1',
    'https://stepfun.ai/v1',
    'https://region.api.stepfun.com/v1',
  ])('%s 只给 Responses 补工具默认值', (baseURL) => {
    expect(isStepfunHost(baseURL)).toBe(true);
    expect(effectiveCompat(provider({ baseURL }))).toEqual(defaults);
    for (const api of ['openai-completions', 'anthropic-messages'])
      expect(effectiveCompat(provider({ baseURL, api }))).toEqual({
        supportsCustomTools: true,
        supportsNamespaceTools: true,
        toolChoice: 'any',
      });
  });

  it.each([
    'https://api.stepfun.com/step_plan/v1',
    'https://api.stepfun.ai/step_plan/v1',
    'https://api.stepfun.com/%73tep_plan/v1',
    'https://step-plan.stepfun.com/v1',
    'https://api.step-plan.stepfun.ai/v1',
    'https://stepplan.stepfun.ai/v1',
    'https://coding.stepfun.com/v1',
    'https://api.stepfun.com/v1/step_plan',
    'https://api.stepfun.com',
    'https://api.stepfun.com/other',
    'https://api.stepfun.com.example.org/v1',
    'https://notstepfun.ai/v1',
    'https://api.stepfun.com@proxy.example.org/v1',
    'ftp://api.stepfun.com/v1',
    'invalid',
  ])('%s 不获得按量默认值', (baseURL) => {
    expect(isStepfunHost(baseURL)).toBe(false);
    expect(effectiveCompat(provider({ baseURL }))).toEqual({
      supportsCustomTools: true,
      supportsNamespaceTools: true,
      toolChoice: 'any',
    });
  });

  it('逐字段声明优先，代理可显式保留兼容值', () => {
    expect(effectiveCompat(provider({ compat: { supportsNamespaceTools: true } }))).toEqual({
      ...defaults,
      supportsNamespaceTools: true,
    });
    const body: ResponsesRequest = {
      ...codexRequest('1-first-turn').body,
      tool_choice: 'required',
    };
    const explicit = prepareUpstream(
      provider({ compat: { supportsNamespaceTools: true, toolChoice: 'any' } }),
      body,
    );
    if (!explicit.ok) throw new Error(explicit.message);
    const { client_metadata: _drop, ...expected } = body;
    expect(explicit.payload).toEqual(expected);
    const proxy = prepareUpstream(
      provider({ baseURL: 'https://proxy.example.org/v1', compat: defaults }),
      body,
    );
    const addressed = prepareUpstream(provider(), body);
    if (!proxy.ok || !addressed.ok) throw new Error('无法准备请求');
    expect(proxy.payload).toEqual(addressed.payload);
    const flattened = prepareUpstream(provider({ compat: { supportsCustomTools: false } }), body);
    if (!flattened.ok) throw new Error(flattened.message);
    expect(flattened.dialects).toContain('flatten-custom-tools');
  });
});

describe('StepFun Responses 的录制请求', () => {
  for (const model of ['step-5-preview', 'step-3.7-flash']) {
    it.each(CODEX_SAMPLES)(`${model} / %s 保留 custom，摊平 namespace 和历史`, (name) => {
      const body: ResponsesRequest = {
        ...codexRequest(name).body,
        model,
        tool_choice: { type: 'custom', name: 'apply_patch' },
      };
      const original = structuredClone(body);
      const prepared = prepareUpstream(provider(), body);
      if (!prepared.ok) throw new Error(prepared.message);
      expect(prepared.mode).toBe('responses');
      expect(prepared.url).toBe('https://api.stepfun.com/v1/responses');
      const forwarded = prepared.payload as ResponsesRequest;
      for (const field of [
        'model',
        'reasoning',
        'store',
        'include',
        'prompt_cache_key',
        'parallel_tool_calls',
      ])
        expect(forwarded[field]).toEqual(body[field]);
      for (const field of ['client_metadata', 'max_output_tokens', 'thinking', 'reasoning_effort'])
        expect(forwarded).not.toHaveProperty(field);
      expect(forwarded.tool_choice).toBe(name === '4-compact' ? undefined : 'auto');
      expect(forwarded.tools?.some((tool) => tool.type === 'namespace')).toBe(false);
      expect(
        forwarded.tools?.every((tool) => /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(tool.name ?? '')),
      ).toBe(true);
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

    it(`${model} 的三档 effort 原样发送，不补未指定的档位或预算`, () => {
      for (const effort of ['low', 'medium', 'high', undefined]) {
        const body: ResponsesRequest = {
          model,
          input: '你好',
          ...(effort === undefined ? {} : { reasoning: { effort } }),
        };
        const prepared = prepareUpstream(provider(), body);
        if (!prepared.ok) throw new Error(prepared.message);
        expect(prepared.payload).toEqual(body);
      }
    });
  }

  it('长 MCP 名字清理到 64 字符，定义、历史、响应一致，使用说明仍可见', () => {
    const namespace = `mcp__corp.service.${'x'.repeat(70)}`;
    const call: ResponsesItem = {
      type: 'function_call',
      id: 'fc_long',
      call_id: 'long',
      namespace,
      name: 'read.file',
      arguments: '{}',
    };
    const body: ResponsesRequest = {
      model: 'step-5-preview',
      input: [call],
      instructions: '原指令',
      tools: [
        {
          type: 'namespace',
          name: namespace,
          description: '先读取索引，再读取文件。',
          tools: [
            { type: 'function', name: 'read.file', parameters: { type: 'object' }, strict: true },
          ],
        },
      ],
    };
    const result = applyDialects(provider(), body);
    const flat = result.body.tools?.[0]?.name;
    expect(flat).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]{63}$/);
    expect(result.body.tools?.[0]?.strict).toBe(true);
    expect(result.body.input).toEqual([{ ...call, name: flat, namespace: undefined }]);
    expect(result.body.instructions).toContain('原指令');
    expect(result.body.instructions).toContain('先读取索引，再读取文件。');
    const event = {
      type: 'response.output_item.done',
      item: { ...call, namespace: undefined, name: flat },
    };
    expect(result.rewrite?.(event)).toHaveProperty('item', call);
    expect(applyDialects(provider(), body).body).toEqual(result.body);
    const native = applyDialects(provider({ compat: { supportsNamespaceTools: true } }), body);
    expect(native.body).toEqual(body);
    expect(native.applied).not.toContain('stepfun-mcp-instructions');
  });
});
