import { describe, expect, it } from 'vitest';
import { applyDialects, openrouterAssistantMessageState } from './dialects.js';
import {
  effectiveCompat,
  isArkHost,
  isBedrockMantleHost,
  isFireworksHost,
  isGroqHost,
  isOpenRouterHost,
  isVercelGatewayHost,
} from './providers.js';
import { codexRequest } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

const provider = (
  baseURL: string,
  api: GatewayProvider['api'] = 'openai-responses',
  model = 'm',
): GatewayProvider => ({
  id: 'p',
  kind: 'openai-compatible',
  displayName: 'P',
  api,
  baseURL,
  models: [{ id: model, maxTokens: 128000 }],
  defaultModelId: model,
  apiKey: 'k',
});
const conservative = {
  supportsCustomTools: false,
  supportsNamespaceTools: false,
  toolChoice: 'auto_only',
};

describe('地址默认 compat', () => {
  it.each([
    { matches: isOpenRouterHost, baseURL: 'https://openrouter.ai/api/v1', compat: conservative },
    {
      matches: isVercelGatewayHost,
      baseURL: 'https://ai-gateway.vercel.sh/v1',
      compat: conservative,
    },
    {
      matches: isVercelGatewayHost,
      baseURL: 'https://ai-gateway.vercel.sh/codex/v1/',
      compat: conservative,
    },
    {
      matches: isGroqHost,
      baseURL: 'https://api.groq.com/openai/v1',
      compat: { supportsCustomTools: false, supportsNamespaceTools: false, toolChoice: 'any' },
    },
    {
      matches: isFireworksHost,
      baseURL: 'https://api.fireworks.ai/inference/v1',
      compat: { supportsCustomTools: false, supportsNamespaceTools: true, toolChoice: 'any' },
    },
    {
      matches: isArkHost,
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      compat: conservative,
    },
    {
      matches: isBedrockMantleHost,
      baseURL: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1',
      compat: conservative,
    },
  ])('$baseURL 的 Responses 默认值，显式 compat 优先', ({ matches, baseURL, compat }) => {
    expect(matches(baseURL)).toBe(true);
    expect(effectiveCompat(provider(baseURL))).toMatchObject(compat);
    expect(
      effectiveCompat({ ...provider(baseURL), compat: { supportsCustomTools: true } }),
    ).toMatchObject({ ...compat, supportsCustomTools: true });
    expect(effectiveCompat(provider(baseURL, 'openai-completions'))).toMatchObject({
      supportsCustomTools: true,
      supportsNamespaceTools: true,
      toolChoice: 'any',
    });
  });

  it('Bedrock Mantle 的 Messages 只发 auto 工具选择', () => {
    const baseURL = 'https://bedrock-mantle.ap-southeast-4.api.aws/anthropic/v1';
    expect(isBedrockMantleHost(baseURL)).toBe(true);
    expect(effectiveCompat(provider(baseURL, 'anthropic-messages'))).toHaveProperty(
      'toolChoice',
      'auto_only',
    );
  });

  it.each([
    'https://openrouter.ai.example.com/api/v1',
    'https://openrouter.ai/v1',
    'https://ai-gateway.vercel.sh/v2',
    'https://api.groq.com/v1',
    'https://api.fireworks.ai/v1',
    'https://ark.cn-beijing.volces.com/api/coding/v3',
    'https://ark.cn-beijing.volces.com.example.com/api/v3',
    'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    'https://bedrock-mantle.us-east-1.api.aws.example.com/openai/v1',
    'not a URL',
  ])('%s 不套用这些默认', (baseURL) => {
    for (const matches of [
      isOpenRouterHost,
      isVercelGatewayHost,
      isGroqHost,
      isFireworksHost,
      isArkHost,
      isBedrockMantleHost,
    ])
      expect(matches(baseURL)).toBe(false);
    expect(effectiveCompat(provider(baseURL))).toHaveProperty('toolChoice', 'any');
  });
});

describe('方言修正', () => {
  const assistantMessages = (body: ResponsesRequest) =>
    (body.input as ResponsesItem[]).filter(
      (item) => item.type === 'message' && item.role === 'assistant',
    );

  it('OpenRouter：历史里的 assistant 消息补 status，缺 id 时补 id，其余不动', () => {
    const recorded = codexRequest('3-next-turn').body;
    expect(assistantMessages(recorded).every((item) => item.status === undefined)).toBe(true);
    const input = [
      ...(recorded.input as ResponsesItem[]),
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    ];
    const body = { ...recorded, input };
    const { body: fixed, applied } = applyDialects(provider('https://openrouter.ai/api/v1'), body);
    expect(applied).toContain('openrouter-assistant-message-state');
    const fixedAssistants = assistantMessages(fixed);
    expect(fixedAssistants.map((item) => item.status)).toEqual(['completed', 'completed']);
    expect(fixedAssistants[0]?.id).toBe(assistantMessages(body)[0]?.id);
    expect(fixedAssistants[1]?.id).toBe(`msg_wevir_${input.length - 1}`);
    const others = (items: ResponsesItem[]) =>
      items.filter((item) => item.type !== 'message' || item.role !== 'assistant');
    const alone = openrouterAssistantMessageState.apply(body).body.input as ResponsesItem[];
    expect(others(alone)).toEqual(others(input));
    expect(assistantMessages({ ...body, input: alone })).toEqual(fixedAssistants);
    expect(applyDialects(provider('https://example.com/v1'), body).applied).not.toContain(
      'openrouter-assistant-message-state',
    );
  });

  it('Groq：去掉 include 与 prompt_cache_key，保留 store: false', () => {
    const body = codexRequest('3-next-turn').body;
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body).toHaveProperty('prompt_cache_key');
    const { body: fixed, applied } = applyDialects(
      provider('https://api.groq.com/openai/v1'),
      body,
    );
    expect(applied).toContain('groq-unsupported-fields');
    expect(fixed).not.toHaveProperty('include');
    expect(fixed).not.toHaveProperty('prompt_cache_key');
    expect(fixed.store).toBe(false);
  });

  it('Fireworks：include 只留 logprobs，namespace 工具原样透传', () => {
    const fireworks = provider('https://api.fireworks.ai/inference/v1');
    const body = codexRequest('3-next-turn').body;
    const { body: fixed, applied } = applyDialects(fireworks, body);
    expect(applied).toContain('fireworks-include');
    expect(applied).not.toContain('flatten-namespace-tools');
    expect(fixed).not.toHaveProperty('include');
    expect(fixed.tools?.some((tool) => tool.type === 'namespace')).toBe(true);
    const mixed = {
      ...body,
      include: ['reasoning.encrypted_content', 'message.output_text.logprobs'],
    };
    expect(applyDialects(fireworks, mixed).body.include).toEqual(['message.output_text.logprobs']);
  });
});

describe('Bedrock Mantle 的路由与 Claude 模型 ID', () => {
  it('OpenAI 路径透传到 /openai/v1/responses，Bearer 认证', () => {
    const prepared = prepareUpstream(
      provider(
        'https://bedrock-mantle.us-east-1.api.aws/openai/v1',
        'openai-responses',
        'openai.gpt-6.1-sol',
      ),
      { ...codexRequest('1-first-turn').body, model: 'openai.gpt-6.1-sol' },
    );
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.url).toBe('https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses');
    expect(prepared.headers.authorization).toBe('Bearer k');
  });

  it('anthropic. 前缀的 Opus 5.5 与裸 ID 得到相同的 Claude 请求，发往 /anthropic/v1/messages', () => {
    const baseURL = 'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1';
    const translate = (model: string) => {
      const bedrock = {
        ...provider(baseURL, 'anthropic-messages', model),
        compat: { thinkingFormat: 'adaptive', systemMessageMode: 'inline' },
      } satisfies GatewayProvider;
      const prepared = prepareUpstream(bedrock, {
        ...codexRequest('3-next-turn').body,
        model,
        tool_choice: 'required',
        reasoning: { effort: 'high' },
      });
      if (!prepared.ok) throw new Error(prepared.message);
      return prepared;
    };
    const prefixed = translate('anthropic.claude-opus-5-5');
    expect(prefixed.url).toBe('https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages');
    expect(prefixed.headers['x-api-key']).toBe('k');
    expect(prefixed.headers).not.toHaveProperty('authorization');
    const payload = prefixed.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      model: 'anthropic.claude-opus-5-5',
      thinking: { type: 'adaptive' },
    });
    // required 降为 auto：Mantle 上的 Claude 只认 auto / none（auto 是默认值，不发）。
    expect(payload).not.toHaveProperty('tool_choice');
    const { model: _bare, ...bare } = translate('claude-opus-5-5').payload as Record<
      string,
      unknown
    >;
    const { model: _prefixed, ...rest } = payload;
    expect(rest).toEqual(bare);
  });
});
