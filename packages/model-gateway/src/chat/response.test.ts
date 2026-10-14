import { describe, expect, it } from 'vitest';
import { codexProblems, doneItems } from '../test-fixtures/codex.js';
import { flatToolName, ToolNames } from '../tools.js';
import type { ResponsesEvent } from '../types.js';
import { decodeGeminiSignatures, decodeReasoning } from './request.js';
import { ChatStreamTranslator, toResponsesUsage } from './response.js';

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

/** 把一串 chunk（对象或原样的 data 字符串）喂给翻译器，最后按流正常结束收尾。 */
function run(chunks: unknown[], names = new ToolNames(), { finish = true } = {}): ResponsesEvent[] {
  const t = new ChatStreamTranslator(names, { responseId: 'resp_test' });
  const events = [...t.start()];
  for (const c of chunks) {
    events.push(...(typeof c === 'string' ? t.data(c) : t.chunk(c)));
    if (t.ended) return events;
  }
  if (finish) events.push(...t.finish());
  return events;
}

const types = (events: ResponsesEvent[]) => events.map((e) => e.type);
const terminal = (events: ResponsesEvent[]) => events.at(-1) as ResponsesEvent;

describe('文本与推理', () => {
  it('推理增量 → reasoning 项，文本增量 → message 项，usage 映射到 response.completed', () => {
    const events = run([
      chunk({ role: 'assistant', content: '' }),
      chunk({ reasoning_content: '先' }),
      chunk({ reasoning_content: '想' }),
      chunk({ content: '你' }),
      chunk({ content: '好' }),
      chunk({}, 'stop'),
      {
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 64 },
          completion_tokens_details: { reasoning_tokens: 7 },
        },
      },
      '[DONE]',
    ]);
    expect(types(events)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.reasoning_text.delta',
      'response.reasoning_text.delta',
      'response.output_item.done',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(codexProblems(events)).toEqual([]);
    const [reasoning, message] = doneItems(events);
    expect(reasoning).toMatchObject({
      type: 'reasoning',
      content: [{ type: 'reasoning_text', text: '先想' }],
    });
    // encrypted_content 也放全文：Codex 只带回其中一个字段时也能还原。
    expect(
      decodeReasoning({ type: 'reasoning', encrypted_content: reasoning?.encrypted_content }),
    ).toBe('先想');
    expect(message).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '你好' }],
    });
    expect(terminal(events).response).toMatchObject({
      id: 'resp_test',
      status: 'completed',
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 64 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 7 },
        total_tokens: 120,
      },
    });
  });

  it('OpenRouter 等用 delta.reasoning；output_index 按项递增', () => {
    const events = run([chunk({ reasoning: 'r' }), chunk({ content: 't' }), chunk({}, 'stop')]);
    const added = events.filter((e) => e.type === 'response.output_item.added');
    expect(added.map((e) => [(e.item as { type: string }).type, e.output_index])).toEqual([
      ['reasoning', 0],
      ['message', 1],
    ]);
  });

  it('DeepSeek 的缓存命中 prompt_cache_hit_tokens；没有 usage 时不带 usage', () => {
    expect(
      toResponsesUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 8 }),
    ).toEqual({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 8 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 12,
    });
    const events = run([chunk({ content: 'x' }), chunk({}, 'stop')]);
    expect(terminal(events).response).not.toHaveProperty('usage');
  });

  it('只有 [DONE] 没有 finish_reason 也按完成处理', () => {
    expect(terminal(run([chunk({ content: 'x' }), '[DONE]'])).type).toBe('response.completed');
  });
});

describe('工具调用', () => {
  const names = () => {
    const n = new ToolNames();
    n.flat({ kind: 'custom', name: 'apply_patch' });
    n.flat({ kind: 'function', name: 'exec_command' });
    n.flat({ kind: 'function', name: 'spawn_agent', namespace: 'multi_agent_v1' });
    return n;
  };
  const call = (
    index: number | undefined,
    id: string | undefined,
    name?: string,
    args?: string,
  ) => ({
    ...(index === undefined ? {} : { index }),
    ...(id === undefined ? {} : { id }),
    type: 'function',
    function: {
      ...(name === undefined ? {} : { name }),
      ...(args === undefined ? {} : { arguments: args }),
    },
  });

  it('按原工具类型还原：custom → custom_tool_call（解出 input），namespace → function_call 带 namespace', () => {
    const events = run(
      [
        chunk({ tool_calls: [call(0, 'c1', 'apply_patch', '{"inp')] }),
        chunk({ tool_calls: [call(0, undefined, undefined, 'ut":"*** Begin Patch"}')] }),
        chunk({ tool_calls: [call(1, 'c2', 'multi_agent_v1__spawn_agent', '{"message":"hi"}')] }),
        chunk({}, 'tool_calls'),
      ],
      names(),
    );
    expect(codexProblems(events)).toEqual([]);
    expect(doneItems(events)).toEqual([
      { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch' },
      {
        type: 'function_call',
        call_id: 'c2',
        name: 'spawn_agent',
        namespace: 'multi_agent_v1',
        arguments: '{"message":"hi"}',
      },
    ]);
  });

  it('并行调用的多个 index 交错到达：按 index 拼接，按 index 的顺序提交', () => {
    const events = run(
      [
        chunk({ tool_calls: [call(1, 'b', 'exec_command', '{"cmd"')] }),
        chunk({ tool_calls: [call(0, 'a', 'exec_command', '{"cmd"')] }),
        chunk({ tool_calls: [call(1, undefined, undefined, ':"ls"}')] }),
        chunk({ tool_calls: [call(0, undefined, undefined, ':"pwd"}')] }),
        chunk({}, 'tool_calls'),
      ],
      names(),
    );
    expect(doneItems(events).map((i) => [i.call_id, i.arguments])).toEqual([
      ['a', '{"cmd":"pwd"}'],
      ['b', '{"cmd":"ls"}'],
    ]);
  });

  it('同一个 index 来了另一个 id（每个调用都用 index 0 的上游）：另开一个调用', () => {
    const events = run(
      [
        chunk({ tool_calls: [call(0, 'a', 'exec_command', '{"cmd":"a"}')] }),
        chunk({ tool_calls: [call(0, 'b', 'exec_command', '{"cmd":"b"}')] }),
        chunk({}, 'tool_calls'),
      ],
      names(),
    );
    expect(doneItems(events).map((i) => [i.call_id, i.arguments])).toEqual([
      ['a', '{"cmd":"a"}'],
      ['b', '{"cmd":"b"}'],
    ]);
  });

  it('没有 index 的上游：带新 id 的开新调用，不带 id 的接到上一个；每片都重复名字时不重复拼接', () => {
    const events = run(
      [
        chunk({ tool_calls: [call(undefined, 'a', 'exec_command', '{"cmd":')] }),
        chunk({ tool_calls: [call(undefined, undefined, 'exec_command', '"x"}')] }),
        chunk({ tool_calls: [call(undefined, 'b', 'exec_command', '{}')] }),
        chunk({}, 'tool_calls'),
      ],
      names(),
    );
    expect(doneItems(events).map((i) => [i.call_id, i.name, i.arguments])).toEqual([
      ['a', 'exec_command', '{"cmd":"x"}'],
      ['b', 'exec_command', '{}'],
    ]);
  });

  it('截断加哈希的长名字还原成原名与命名空间；模型编的名字原样交给 Codex', () => {
    const n = new ToolNames();
    const namespace = 'mcp__server.with.dots';
    const flat = n.flat({ kind: 'function', name: 'x'.repeat(70), namespace });
    expect(flat).toBe(flatToolName('x'.repeat(70), namespace));
    const events = run(
      [
        chunk({ tool_calls: [call(0, 'a', flat, '{}'), call(1, 'b', 'made_up', '{}')] }),
        chunk({}, 'tool_calls'),
      ],
      n,
    );
    expect(doneItems(events)).toEqual([
      { type: 'function_call', call_id: 'a', name: 'x'.repeat(70), namespace, arguments: '{}' },
      { type: 'function_call', call_id: 'b', name: 'made_up', arguments: '{}' },
    ]);
  });

  it('custom 工具的参数不是 {input} 时原样当输入；上游没给 id 时网关补一个', () => {
    const events = run(
      [chunk({ tool_calls: [call(0, undefined, 'apply_patch', 'raw patch')] }), chunk({}, 'stop')],
      names(),
    );
    const [item] = doneItems(events);
    expect(item).toMatchObject({
      type: 'custom_tool_call',
      name: 'apply_patch',
      input: 'raw patch',
    });
    expect(String(item?.call_id)).toMatch(/^call_/);
  });
});

describe('结束与出错', () => {
  it('finish_reason=length → response.incomplete（max_output_tokens）；已出的文本照常提交，截断的工具调用不提交', () => {
    const events = run([
      chunk({ content: '写到一半' }),
      chunk({
        tool_calls: [{ index: 0, id: 'a', function: { name: 'exec_command', arguments: '{"cm' } }],
      }),
      chunk({}, 'length'),
    ]);
    expect(codexProblems(events)).toEqual([]);
    expect(terminal(events)).toMatchObject({
      type: 'response.incomplete',
      response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    });
    expect(doneItems(events).map((i) => i.type)).toEqual(['message']);
  });

  it('finish_reason=content_filter → response.incomplete（content_filter）', () => {
    expect(terminal(run([chunk({ content: 'x' }), chunk({}, 'content_filter')]))).toMatchObject({
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'content_filter' } },
    });
  });

  it('流里的 error → response.failed，带上游原文与 code；之后的 chunk 不再处理', () => {
    const t = new ChatStreamTranslator(new ToolNames(), { responseId: 'resp_test' });
    const events = [
      ...t.chunk(chunk({ content: 'x' })),
      ...t.chunk({
        error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' },
      }),
      ...t.chunk(chunk({ content: 'y' })),
      ...t.finish(),
    ];
    expect(codexProblems(events)).toEqual([]);
    expect(terminal(events)).toEqual({
      type: 'response.failed',
      response: {
        id: 'resp_test',
        object: 'response',
        status: 'failed',
        error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for requests' },
      },
    });
    expect(doneItems(events)).toEqual([]);
  });

  it('既没有 finish_reason 也没有 [DONE] 就结束：按提前断开处理', () => {
    const events = run([chunk({ content: 'x' })]);
    expect(terminal(events)).toMatchObject({
      type: 'response.failed',
      response: {
        error: { code: 'upstream_error', message: expect.stringContaining('结束前断开') },
      },
    });
  });

  it('不是 JSON 的 data → response.failed，带原文', () => {
    const events = run(['<html>bad gateway</html>']);
    expect(terminal(events)).toMatchObject({
      type: 'response.failed',
      response: { error: { message: expect.stringContaining('<html>bad gateway</html>') } },
    });
  });

  it('上游无视 stream 回了整个 chat.completion：按一个 chunk 处理', () => {
    const events = run([
      {
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '整段', reasoning_content: '推理' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]);
    expect(codexProblems(events)).toEqual([]);
    expect(doneItems(events).map((i) => i.type)).toEqual(['reasoning', 'message']);
    expect(terminal(events).type).toBe('response.completed');
  });
});

describe('Gemini 的 thought signature', () => {
  // Gemini 的流式工具调用一个 chunk 给全（没有 index），签名在 extra_content 里，finish_reason 是 stop（python-genai#2868）。
  const geminiCall = (id: string, signature?: string) =>
    chunk({
      tool_calls: [
        {
          id,
          type: 'function',
          function: { name: 'exec_command', arguments: '{"cmd":"ls"}' },
          ...(signature === undefined
            ? {}
            : { extra_content: { google: { thought_signature: signature } } }),
        },
      ],
    });

  it('带签名的调用之前提交一个 reasoning 项，信封里按 call_id 记签名、Provider 与模型', () => {
    const t = new ChatStreamTranslator(new ToolNames(), {
      responseId: 'resp_test',
      signatures: { provider: 'gemini', model: 'gemini-3.8-flash' },
    });
    const events = [
      ...t.start(),
      ...t.chunk(geminiCall('call_1', 'sig-1')),
      ...t.chunk(geminiCall('call_2')),
      ...t.chunk(chunk({}, 'stop')),
      ...t.finish(),
    ];
    const items = doneItems(events);
    expect(items.map((i) => i.type)).toEqual(['reasoning', 'function_call', 'function_call']);
    expect(items[0]).not.toHaveProperty('content');
    expect(decodeReasoning(items[0] as never)).toBe('');
    expect(decodeGeminiSignatures(items[0]?.encrypted_content)).toEqual({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      signatures: { call_1: 'sig-1' },
    });
    expect(items.slice(1).map((i) => i.call_id)).toEqual(['call_1', 'call_2']);
    expect(codexProblems(events)).toEqual([]);
  });

  it('没有签名、或不是 Gemini 时不加 reasoning 项', () => {
    const plain = run([geminiCall('call_1', 'sig-1'), chunk({}, 'stop')]);
    expect(doneItems(plain).map((i) => i.type)).toEqual(['function_call']);
    const t = new ChatStreamTranslator(new ToolNames(), {
      signatures: { provider: 'gemini', model: 'm' },
    });
    const unsigned = [
      ...t.start(),
      ...t.chunk(geminiCall('call_1')),
      ...t.chunk(chunk({}, 'stop')),
      ...t.finish(),
    ];
    expect(doneItems(unsigned).map((i) => i.type)).toEqual(['function_call']);
  });
});
