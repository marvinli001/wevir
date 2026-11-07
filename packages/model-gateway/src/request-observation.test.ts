import { describe, expect, it, vi } from 'vitest';
import { ResponseObservation } from './request-observation.js';
import { sseEvent } from './sse.js';
import { prepareUpstream } from './upstream.js';

const completed = {
  type: 'response.completed',
  response: { id: 'r1', usage: { input_tokens: 12, output_tokens: 3 } },
};

describe('ResponseObservation', () => {
  it('带事件名的增量不解析 JSON，最终用量仍提取', () => {
    const observation = new ResponseObservation(performance.now());
    const parse = vi.spyOn(JSON, 'parse');
    try {
      for (let i = 0; i < 100; i++) {
        observation.push(sseEvent({ type: 'response.output_text.delta', delta: 'text' }));
      }
      observation.push(sseEvent(completed));
      observation.end();
      expect(parse).toHaveBeenCalledTimes(1);
      expect(observation.firstTokenMs).toBeTypeOf('number');
      expect(observation.responseId).toBe('r1');
      expect(observation.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 });
    } finally {
      parse.mockRestore();
    }
  });

  it('没有event行的服务仍从JSON识别，转换模式直接接收结构化事件', async () => {
    const observation = new ResponseObservation(performance.now());
    observation.push('data: {"type":"response.reasoning_text.delta","delta":"a"}\n\n');
    observation.push(`data: ${JSON.stringify(completed)}\n\n`);
    expect(observation.firstTokenMs).toBeTypeOf('number');
    expect(observation.usage?.outputTokens).toBe(3);
    const prepared = prepareUpstream(
      {
        id: 'p',
        kind: 'openai-compatible',
        displayName: 'Mock',
        models: [{ id: 'm', displayName: 'm' }],
        defaultModelId: 'm',
        api: 'openai-completions',
        baseURL: 'https://local.invalid/v1',
      },
      { model: 'm', input: [], stream: true },
    );
    if (!prepared.ok) throw new Error(prepared.message);
    const translated = new ResponseObservation(performance.now());
    const body =
      'data: {"id":"r2","choices":[{"delta":{"content":"text"}}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
    for await (const _piece of prepared.translate(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      new AbortController().signal,
      (event) => translated.observe(event),
    )) {
      /* Drain the translated response. */
    }
    expect(translated.firstTokenMs).toBeTypeOf('number');
    expect(translated.usage).toMatchObject({ inputTokens: 9, outputTokens: 2 });
  });
});
