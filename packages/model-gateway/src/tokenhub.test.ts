import { describe, expect, it } from 'vitest';
import { applyDialects } from './dialects.js';
import { effectiveCompat, isTencentHost } from './providers.js';
import { CODEX_SAMPLES, codexRequest } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

const tokenhub: GatewayProvider = {
  id: 'tencent',
  kind: 'openai-compatible',
  displayName: 'TokenHub',
  api: 'openai-responses',
  baseURL: 'https://tokenhub.tencentcloudmaas.com/v1',
  models: [{ id: 'hy3', contextWindow: 262144 }],
  defaultModelId: 'hy3',
};
const defaults = {
  supportsCustomTools: false,
  supportsNamespaceTools: false,
  toolChoice: 'auto_only',
} as const;

describe('TokenHub 按量 Responses', () => {
  it.each([
    'https://tokenhub.tencentcloudmaas.com/v1',
    'https://tokenhub.tencentmaas.com/v1',
    'https://tokenhub-intl.tencentcloudmaas.com/v1',
    'https://tokenhub-us.tencentcloudmaas.tech/v1',
    'https://tokenhub.tencentcloudmaas.tech/v1',
    'https://TOKENHUB.TENCENTCLOUDMAAS.COM/v1/',
    'https://tokenhub-intl.tencentcloudmaas.com',
  ])('%s 使用保守工具默认值', (baseURL) => {
    expect(isTencentHost(baseURL)).toBe(true);
    expect(effectiveCompat({ ...tokenhub, baseURL })).toEqual(defaults);
  });

  it.each([
    'https://api.hunyuan.cloud.tencent.com',
    'https://api.lkeap.cloud.tencent.com/plan/v3',
    'https://token-plan.tencentcloudmaas.com/v1',
    'https://tokenhub-coding.tencentcloudmaas.com/v1',
    'https://tokenplan.tencentmaas.com/v1',
    'https://tokenhub.tencentcloudmaas.com/plan/v3',
    'https://tokenhub.tencentcloudmaas.com/v1/plan',
    'https://tokenhub.tencentcloudmaas.com.example.org/v1',
    'https://nottencentmaas.com/v1',
    'https://tokenhub.tencentcloudmaas.com@proxy.example.org/v1',
    'ftp://tokenhub.tencentcloudmaas.com/v1',
    'not a URL',
  ])('%s 不获得按量默认值', (baseURL) => {
    expect(isTencentHost(baseURL)).toBe(false);
    expect(effectiveCompat({ ...tokenhub, baseURL })).toEqual({
      supportsCustomTools: true,
      supportsNamespaceTools: true,
      toolChoice: 'any',
    });
  });

  it.each(['openai-completions', 'anthropic-messages'])('%s 不套 Responses 默认值', (api) => {
    expect(effectiveCompat({ ...tokenhub, api })).toEqual({
      supportsCustomTools: true,
      supportsNamespaceTools: true,
      toolChoice: 'any',
    });
  });

  it('显式字段逐项优先，代理显式配置保留工具兼容值', () => {
    expect(effectiveCompat({ ...tokenhub, compat: { supportsNamespaceTools: true } })).toEqual({
      ...defaults,
      supportsNamespaceTools: true,
    });
    expect(
      effectiveCompat({ ...tokenhub, baseURL: 'https://proxy.example.org/v1', compat: defaults }),
    ).toEqual(defaults);
    const body: ResponsesRequest = {
      ...codexRequest('1-first-turn').body,
      tool_choice: 'required',
    };
    const prepared = prepareUpstream(
      {
        ...tokenhub,
        compat: { supportsCustomTools: true, supportsNamespaceTools: true, toolChoice: 'any' },
      },
      body,
    );
    if (!prepared.ok) throw new Error(prepared.message);
    const { client_metadata: _drop, ...expected } = body;
    expect(prepared.payload).toEqual(expected);
  });

  it.each(
    ['hy3', 'hy4-preview', 'deepseek-v4-pro', 'glm-5.3', 'kimi-k3'].flatMap((model) =>
      CODEX_SAMPLES.map((name) => ({ model, name })),
    ),
  )('$model / $name 摊平工具与历史，保留完整推理与缓存字段', ({ model, name }) => {
    const body: ResponsesRequest = {
      ...codexRequest(name).body,
      model,
      tool_choice: { type: 'custom', name: 'apply_patch' },
    };
    const original = structuredClone(body);
    const prepared = prepareUpstream(tokenhub, body);
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.mode).toBe('responses');
    expect(prepared.url).toBe('https://tokenhub.tencentcloudmaas.com/v1/responses');
    const forwarded = prepared.payload as ResponsesRequest;
    expect(forwarded.model).toBe(model);
    for (const field of ['client_metadata', 'thinking', 'reasoning_effort', 'max_output_tokens'])
      expect(forwarded).not.toHaveProperty(field);
    for (const field of [
      'reasoning',
      'include',
      'store',
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
      expect(tools.find((tool) => tool.name === 'apply_patch')).toMatchObject({
        parameters: { required: ['input'], additionalProperties: false },
        strict: false,
      });
      expect(tools.some((tool) => tool.name === 'multi_agent_v1__spawn_agent')).toBe(true);
    }
    const input = forwarded.input as ResponsesItem[];
    expect(input.some((item) => item.type.startsWith('custom_tool_call'))).toBe(false);
    expect(input.some((item) => item.namespace !== undefined)).toBe(false);
    for (const item of input.filter((item) => item.type === 'reasoning')) {
      expect(item.content).not.toBeNull();
      expect(item.encrypted_content).not.toBeNull();
    }
    expect(body).toEqual(original);
  });

  it.each(['none', 'low', 'high'])('Responses 的 %s 原样传递，不套 Chat 思考格式', (effort) => {
    const body = { ...codexRequest('1-first-turn').body, reasoning: { effort, summary: 'auto' } };
    expect(applyDialects(tokenhub, body).body.reasoning).toEqual(body.reasoning);
  });

  it('摊平前保留 MCP 使用说明，显式 namespace 支持优先，其他地址不套用', () => {
    const body: ResponsesRequest = {
      model: 'hy3',
      input: 'ping',
      instructions: '原有指令',
      tools: [
        {
          type: 'namespace',
          name: 'mcp__work_tools',
          description: '读取工作区前先读取记忆索引。',
          tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
        },
      ],
    };
    const result = applyDialects(tokenhub, body);
    expect(result.body.instructions).toBe(
      '原有指令\n\n# Instructions from MCP servers\n\n## mcp__work_tools\n读取工作区前先读取记忆索引。',
    );
    expect(result.body.tools).toMatchObject([{ type: 'function', name: 'mcp__work_tools__read' }]);
    expect(result.applied).toContain('flatten-mcp-instructions');
    expect(
      applyDialects({ ...tokenhub, compat: { supportsNamespaceTools: true } }, body).body,
    ).toEqual(body);
    expect(
      applyDialects({ ...tokenhub, baseURL: 'https://proxy.example.org/v1' }, body).body,
    ).toEqual(body);
    expect(body.instructions).toBe('原有指令');
  });
});
