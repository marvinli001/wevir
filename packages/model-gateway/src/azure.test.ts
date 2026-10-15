import { describe, expect, it } from 'vitest';
import { applyDialects } from './dialects.js';
import { isAzureHost, routeOf } from './providers.js';
import { CODEX_SAMPLES, codexRequest } from './test-fixtures/codex.js';
import { messagesProblem } from './test-fixtures/mock-messages.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

const BASE = 'https://example-resource.openai.azure.com/openai/v1';
const provider = (patch: Partial<GatewayProvider> = {}): GatewayProvider => ({
  id: 'azure',
  kind: 'openai-compatible',
  displayName: 'Azure',
  api: 'openai-responses',
  baseURL: BASE,
  models: [{ id: 'my-deployment', maxTokens: 128000 }],
  defaultModelId: 'my-deployment',
  apiKey: 'placeholder-azure-key',
  ...patch,
});

describe('Azure 全球资源端点', () => {
  it.each(['openai.azure.com', 'services.ai.azure.com', 'cognitiveservices.azure.com'])(
    '%s 的 v1 地址保留部署名，不加 api-version',
    (domain) => {
      const baseURL = `https://my-resource.${domain}/openai/v1/`;
      const p = provider({ baseURL });
      expect(isAzureHost(baseURL)).toBe(true);
      expect(routeOf(p)).toEqual({
        mode: 'responses',
        url: `${baseURL}responses`,
      });
    },
  );

  it.each([
    'https://openai.azure.com/openai/v1',
    'https://services.ai.azure.com/openai/v1',
    'https://resource.openai.azure.com.example.com/openai/v1',
    'https://resource.services.ai.azure.com.example.com/anthropic',
    'https://resource.cognitiveservices.azure.com.example.com/openai/v1',
    'https://resource.openai.azure.cn/openai/v1',
    'https://resource.azure.com/openai/v1',
    'not a URL',
  ])('不把 %s 当作全球 Azure 资源', (baseURL) => {
    expect(isAzureHost(baseURL)).toBe(false);
    const body: ResponsesRequest = {
      model: 'my-deployment',
      input: 'ping',
      store: false,
      tools: [{ type: 'namespace', name: 'functions', description: '', tools: [] }],
    };
    expect(applyDialects(provider({ baseURL }), body).body).toBe(body);
  });
});

describe('Azure Responses 录制请求', () => {
  it.each(CODEX_SAMPLES)('%s 保留 custom、namespace、缓存参数与原始部署名', (sample) => {
    const body: ResponsesRequest = { ...codexRequest(sample).body, model: 'my-deployment' };
    const before = structuredClone(body);
    const p = provider();
    const prepared = prepareUpstream(p, body);
    if (!prepared.ok) throw new Error(prepared.message);
    const sent = prepared.payload as ResponsesRequest;
    expect(prepared.mode).toBe('responses');
    expect(prepared.url).toBe(`${BASE}/responses`);
    expect(prepared.headers.authorization).toBe(`Bearer ${p.apiKey}`);
    expect(prepared.headers).not.toHaveProperty('api-key');
    expect(sent).toMatchObject({ model: 'my-deployment', store: false });
    expect(sent.include).toEqual(['reasoning.encrypted_content']);
    expect(sent.tools).toEqual(body.tools);
    expect(sent.prompt_cache_key).toBe(body.prompt_cache_key);
    expect(sent).not.toHaveProperty('client_metadata');
    expect(prepared.contentType('text/event-stream; charset=utf-8')).toBe(
      'text/event-stream; charset=utf-8',
    );
    for (const item of sent.input as ResponsesItem[]) {
      if (item.type === 'reasoning') {
        expect(item.content).not.toBeNull();
        expect(item.encrypted_content).not.toBeNull();
      }
    }
    expect(body).toEqual(before);
  });

  it('只补缺失或空白的 namespace 描述，保留函数描述、工具结构与显式摊平开关', () => {
    const tools = [
      { type: 'namespace', name: 'missing', tools: [] },
      { type: 'namespace', name: 'functions', description: '', tools: [] },
      { type: 'namespace', name: 'blank', description: ' \n ', tools: [] },
      { type: 'namespace', name: 'keep', description: 'Original description', tools: [] },
      { type: 'function', name: 'empty_function', description: '' },
      {
        type: 'namespace',
        name: 'multi_agent_v1',
        description: '',
        tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }],
      },
    ];
    const body: ResponsesRequest = { model: 'my-deployment', input: 'ping', tools };
    const fixed = applyDialects(provider(), body);
    expect(fixed.applied).toEqual(['azure-namespace-description']);
    expect(fixed.rewrite).toBeUndefined();
    expect(fixed.body.tools?.slice(0, 3).map((tool) => tool.description)).toEqual(
      Array(3).fill('Tools in this namespace.'),
    );
    expect(fixed.body.tools?.slice(3, 5)).toEqual(tools.slice(3, 5));
    expect(fixed.body.tools?.[5]).toMatchObject({ name: 'multi_agent_v1', tools: tools[5]?.tools });
    const flat = applyDialects(provider({ compat: { supportsNamespaceTools: false } }), body);
    expect(flat.body.tools?.some((tool) => tool.type === 'namespace')).toBe(false);
    expect(flat.body.tools).toContainEqual({
      type: 'function',
      name: 'multi_agent_v1__spawn_agent',
      parameters: { type: 'object' },
    });
    expect(tools[1]?.description).toBe('');
  });

  it('无状态 include 保留原项、不重复；有状态请求与其他协议不套 Azure 修正', () => {
    const body: ResponsesRequest = {
      model: 'my-deployment',
      input: 'ping',
      store: false,
      include: ['web_search_call.action.sources'],
    };
    const fixed = applyDialects(provider(), body).body;
    expect(fixed.include).toEqual([
      'web_search_call.action.sources',
      'reasoning.encrypted_content',
    ]);
    expect(applyDialects(provider(), fixed).body).toBe(fixed);
    for (const store of [true, undefined]) {
      const stateful = { ...body, store };
      expect(applyDialects(provider(), stateful).body).toBe(stateful);
    }
    expect(applyDialects(provider({ api: 'anthropic-messages' }), body).body).toBe(body);
  });
});

describe('Foundry Claude 录制请求', () => {
  it('真实契约的部署别名即使未传模板 compat 也默认 adaptive，显式 enabled 仍优先', () => {
    const p = provider({
      api: 'anthropic-messages',
      baseURL: 'https://example-resource.services.ai.azure.com/anthropic',
    });
    const body: ResponsesRequest = {
      model: 'my-deployment',
      input: 'ping',
      reasoning: { effort: 'high' },
    };
    const prepared = prepareUpstream(p, body);
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.messages?.request.thinking).toEqual({ type: 'adaptive' });
    const enabled = prepareUpstream({ ...p, compat: { thinkingFormat: 'enabled' } }, body);
    if (!enabled.ok) throw new Error(enabled.message);
    expect(enabled.messages?.request.thinking).toMatchObject({
      type: 'enabled',
      budget_tokens: 16000,
    });
  });

  it.each(CODEX_SAMPLES)('%s 使用现有 Messages 转换，部署别名不丢推理与输出配置', (sample) => {
    const p = provider({
      api: 'anthropic-messages',
      baseURL: 'https://example-resource.services.ai.azure.com/anthropic',
      compat: { thinkingFormat: 'adaptive', systemMessageMode: 'inline' },
    });
    const prepared = prepareUpstream(p, { ...codexRequest(sample).body, model: 'my-deployment' });
    if (!prepared.ok || !prepared.messages) throw new Error('缺少 Messages 转换');
    expect(prepared.url).toBe(`${p.baseURL}/v1/messages`);
    expect(prepared.headers['x-api-key']).toBe(p.apiKey);
    expect(prepared.headers['anthropic-version']).toBe('2023-06-01');
    expect(prepared.headers).not.toHaveProperty('authorization');
    expect(prepared.messages.request).toMatchObject({ model: 'my-deployment', max_tokens: 128000 });
    expect(messagesProblem(prepared.messages.request)).toBeUndefined();
    if (sample !== '4-compact')
      expect(prepared.messages.request.thinking).toMatchObject({ type: 'adaptive' });
  });
});
