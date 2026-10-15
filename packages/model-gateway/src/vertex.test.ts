import { describe, expect, it } from 'vitest';
import { validateProvider } from './providers.js';
import { CODEX_SAMPLES, codexRequest } from './test-fixtures/codex.js';
import { vertexProvider } from './test-fixtures/vertex.js';
import type { JsonObject } from './types.js';
import { prepareUpstream } from './upstream.js';

describe('Vertex 路由与录制请求', () => {
  it.each(['openai-completions', 'anthropic-messages'])(
    '%s 转换全部录制样本，凭据不进 payload',
    (api) => {
      const provider = vertexProvider(api);
      for (const sample of CODEX_SAMPLES) {
        const prepared = prepareUpstream(provider, {
          ...codexRequest(sample).body,
          model: provider.defaultModelId,
        });
        if (!prepared.ok) throw new Error(prepared.message);
        expect(prepared.url).toContain('/v1/projects/vertex-example/locations/global/');
        expect(prepared.headers).not.toHaveProperty('x-api-key');
        expect(JSON.stringify(prepared.payload)).not.toContain('PRIVATE KEY');
        expect(prepared.payload).not.toHaveProperty('client_metadata');
        const payload = prepared.payload as JsonObject;
        if (api === 'anthropic-messages') {
          expect(payload).not.toHaveProperty('model');
          expect(payload.anthropic_version).toBe('vertex-2023-10-16');
          expect(prepared.url).toContain('/models/claude-sonnet-5-5:streamRawPredict');
          expect(prepared.headers).not.toHaveProperty('anthropic-version');
        } else {
          expect(payload.model).toBe('google/gemini-3.8-flash');
          expect(prepared.chat?.signatures).toEqual({
            provider: provider.id,
            model: provider.defaultModelId,
          });
        }
      }
    },
  );

  it.each(['openai-completions', 'anthropic-messages'])('%s 的地域域名与版本正确', (api) => {
    const provider = {
      ...vertexProvider(api),
      vertex: { project: 'vertex-example', location: 'us' },
    };
    const prepared = prepareUpstream(provider, { model: provider.defaultModelId, input: 'ping' });
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.url).toContain('https://us-aiplatform.googleapis.com/');
    expect(prepared.url).toContain(api === 'anthropic-messages' ? '/v1/' : '/v1beta1/');
  });

  it('Claude 模型日期后缀在 URL 里，不能注入路径；不接其他第三方模型', () => {
    const model = 'claude-sonnet-4-5@20250929';
    const provider = {
      ...vertexProvider('anthropic-messages'),
      models: [{ id: model }],
      defaultModelId: model,
    };
    const prepared = prepareUpstream(provider, { model, input: 'ping' });
    expect(prepared).toMatchObject({
      ok: true,
      url: expect.stringContaining('/models/claude-sonnet-4-5%4020250929:streamRawPredict'),
    });
    expect(
      prepareUpstream(provider, { model: '../google/gemini-3.8-flash', input: 'ping' }).ok,
    ).toBe(false);
    expect(
      validateProvider({ ...vertexProvider(), models: [{ id: 'other/model' }] }).length,
    ).toBeGreaterThan(0);
    expect(
      validateProvider({
        ...vertexProvider(),
        vertex: { project: '../escape', location: 'global' },
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateProvider({
        ...vertexProvider(),
        vertex: { project: 'vertex-example', location: 'evil.example/path' },
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateProvider({ ...vertexProvider(), api: 'openai-responses' }).length,
    ).toBeGreaterThan(0);
  });

  it('Gemini 只修正 Vertex 的力度，显式 compat 优先', () => {
    const provider = vertexProvider();
    for (const [effort, expected] of [
      ['none', 'low'],
      ['minimal', 'low'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['xhigh', 'high'],
      ['max', 'high'],
    ]) {
      const prepared = prepareUpstream(provider, {
        model: provider.defaultModelId,
        input: 'ping',
        reasoning: { effort },
      });
      expect(prepared).toMatchObject({ ok: true, payload: { reasoning_effort: expected } });
    }
    expect(
      prepareUpstream(
        { ...provider, compat: { thinkingFormat: 'openai' } },
        { model: provider.defaultModelId, input: 'ping', reasoning: { effort: 'minimal' } },
      ),
    ).toMatchObject({ ok: true, payload: { reasoning_effort: 'minimal' } });
    expect(
      prepareUpstream(provider, {
        model: 'google/gemini-3.5-flash',
        input: 'ping',
        reasoning: { effort: 'minimal' },
      }),
    ).toMatchObject({ ok: true, payload: { reasoning_effort: 'minimal' } });
  });

  it('Claude 拒绝 URL 图片（包括工具返回图片），允许内嵌图片；其他 Messages 服务不受影响', () => {
    const provider = vertexProvider('anthropic-messages');
    for (const input of [
      [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }],
        },
      ],
      [
        {
          type: 'function_call_output',
          call_id: 'x',
          output: [{ type: 'input_image', image_url: 'https://example.com/a.png' }],
        },
      ],
    ]) {
      expect(prepareUpstream(provider, { model: provider.defaultModelId, input })).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(
        prepareUpstream(
          { ...provider, kind: 'openai-compatible', baseURL: 'https://api.anthropic.com' },
          { model: provider.defaultModelId, input },
        ).ok,
      ).toBe(true);
    }
    expect(
      prepareUpstream(provider, {
        model: provider.defaultModelId,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
          },
        ],
      }).ok,
    ).toBe(true);
  });

  it('Claude 按转换后的 UTF-8 字节数执行 30 MB 限制', () => {
    const provider = vertexProvider('anthropic-messages');
    expect(
      prepareUpstream(provider, { model: provider.defaultModelId, input: '中'.repeat(10_000_000) }),
    ).toMatchObject({ ok: false, status: 413 });
  });

  it('工具参数中的普通 JSON 即使长得像图片块，也不是 URL 图片', () => {
    const provider = vertexProvider('anthropic-messages');
    expect(
      prepareUpstream(provider, {
        model: provider.defaultModelId,
        input: [
          {
            type: 'function_call',
            call_id: 'call-data',
            name: 'process_json',
            arguments: JSON.stringify({
              type: 'image',
              source: { type: 'url', url: 'https://example.com/data' },
            }),
          },
        ],
      }).ok,
    ).toBe(true);
  });
});
