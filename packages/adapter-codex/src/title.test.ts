import { GatewayPrivacyMasker, startModelGateway } from '@wevir/model-gateway';
import { describe, expect, it } from 'vitest';
import { lowestEffort, responsesUsage, TitleCollector, titleViaGateway } from './title.js';

it('标题等辅助请求经过同一网关遮蔽并在返回时还原', async () => {
  const value = 'fictional-title-credential';
  const outbound: unknown[] = [];
  const gateway = await startModelGateway({
    privacy: new GatewayPrivacyMasker({
      settings: () => ({ enabled: true }),
      secrets: () => [value],
    }),
    fetch: async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      outbound.push(body);
      const text = body.input[0].content[0].text as string;
      return new Response(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [] } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  try {
    gateway.setProviders([
      {
        id: 'mock',
        kind: 'openai-compatible',
        api: 'openai-responses',
        baseURL: 'https://mock.invalid/v1',
        apiKey: 'fictional-auth-key',
        displayName: 'Mock',
        models: [{ id: 'mock' }],
        defaultModelId: 'mock',
      },
    ]);
    expect(
      await titleViaGateway(
        gateway,
        'mock',
        { id: 'mock' },
        { instructions: 'title', input: value, outputSchema: {} },
      ),
    ).toBe(value);
    expect(JSON.stringify(outbound)).not.toContain(value);
    expect(JSON.stringify(outbound)).toContain('{{SECRET_');
  } finally {
    await gateway.close();
  }
});

describe('lowestEffort', () => {
  it('取模型支持的最低一档，off 换成 Codex 的 none；不推理的模型没有', () => {
    expect(lowestEffort({ id: 'm', reasoningEfforts: ['high', 'low', 'medium'] })).toBe('low');
    expect(lowestEffort({ id: 'm', reasoningEfforts: ['max', 'off'] })).toBe('none');
    expect(lowestEffort({ id: 'm', reasoningEfforts: [] })).toBeUndefined();
    expect(lowestEffort({ id: 'm' })).toBeUndefined();
  });
});

describe('TitleCollector', () => {
  it('取最后一条已提交的助手消息，回合完成时给出', async () => {
    const collector = new TitleCollector();
    collector.onNotification('item/completed', {
      item: { type: 'agentMessage', text: '{"title":"a"}' },
    });
    collector.onNotification('turn/completed', { turn: { status: 'completed' } });
    await expect(collector.done).resolves.toBe('{"title":"a"}');
  });

  it('回合失败或中断时报错', async () => {
    const collector = new TitleCollector();
    collector.onNotification('turn/completed', {
      turn: { status: 'failed', error: { message: 'boom' } },
    });
    await expect(collector.done).rejects.toMatchObject({ code: 'engine_unavailable' });
  });
});

describe('标题请求的用量', () => {
  it('responsesUsage：输入含缓存的读写，带推理与模型', () => {
    expect(
      responsesUsage({
        model: 'deepseek-flash',
        usage: {
          input_tokens: 1200,
          output_tokens: 40,
          input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 100 },
          output_tokens_details: { reasoning_tokens: 10 },
        },
      }),
    ).toEqual({
      inputTokens: 1200,
      outputTokens: 40,
      cacheReadTokens: 1000,
      cacheWriteTokens: 100,
      reasoningTokens: 10,
      model: 'deepseek-flash',
    });
    expect(responsesUsage({ usage: { input_tokens: 5 } })).toBeUndefined();
  });

  it('TitleCollector：临时 thread 的每个请求报一次，累计没变的重报不算', () => {
    const reported: unknown[] = [];
    const collector = new TitleCollector((usage) => reported.push(usage), 'gpt-6.1-sol');
    const update = (total: number) =>
      collector.onNotification('thread/tokenUsage/updated', {
        threadId: 't',
        turnId: 'u',
        tokenUsage: {
          total: { totalTokens: total },
          last: { inputTokens: 300, cachedInputTokens: 200, outputTokens: 20, totalTokens: 320 },
        },
      });
    update(320);
    update(320);
    update(640);
    expect(reported).toEqual([
      { inputTokens: 300, outputTokens: 20, cacheReadTokens: 200, model: 'gpt-6.1-sol' },
      { inputTokens: 300, outputTokens: 20, cacheReadTokens: 200, model: 'gpt-6.1-sol' },
    ]);
  });
});
