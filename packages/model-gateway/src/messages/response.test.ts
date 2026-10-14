import { describe, expect, it } from 'vitest';
import { codexProblems, doneItems } from '../test-fixtures/codex.js';
import { flatToolName, ToolNames } from '../tools.js';
import type { ResponsesEvent } from '../types.js';
import { decodeThinking } from './request.js';
import { MessagesStreamTranslator, toResponsesUsage, UPSTREAM_PROTOCOL_ERROR } from './response.js';

const ORIGIN = { provider: 'claude', model: 'm' };

const start = (usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 1 }) => ({
  type: 'message_start',
  message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage },
});
const blockStart = (index: number, content_block: Record<string, unknown>) => ({
  type: 'content_block_start',
  index,
  content_block,
});
const delta = (index: number, d: Record<string, unknown>) => ({
  type: 'content_block_delta',
  index,
  delta: d,
});
const stop = (index: number) => ({ type: 'content_block_stop', index });
const messageDelta = (
  stop_reason: string,
  usage: Record<string, unknown> = { output_tokens: 5 },
) => ({
  type: 'message_delta',
  delta: { stop_reason, stop_sequence: null },
  usage,
});
const messageStop = { type: 'message_stop' };

/** 把一串事件（对象或原样的 data 字符串）喂给翻译器，最后按流正常结束收尾。 */
function run(events: unknown[], names = new ToolNames(), { finish = true } = {}): ResponsesEvent[] {
  const t = new MessagesStreamTranslator(names, ORIGIN, 'resp_test');
  const out = [...t.start()];
  for (const e of events) {
    out.push(...(typeof e === 'string' ? t.data(e) : t.event(e)));
    if (t.ended) return out;
  }
  if (finish) out.push(...t.finish());
  return out;
}

const types = (events: ResponsesEvent[]) => events.map((e) => e.type);
const terminal = (events: ResponsesEvent[]) => events.at(-1) as ResponsesEvent;

describe('文本与思考', () => {
  it('thinking 块 → reasoning 项（签名进 encrypted_content），text 块 → message 项，usage 含缓存读写', () => {
    const events = run([
      start({
        input_tokens: 30,
        cache_creation_input_tokens: 6,
        cache_read_input_tokens: 64,
        output_tokens: 1,
      }),
      blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: '先' }),
      delta(0, { type: 'thinking_delta', thinking: '想' }),
      delta(0, { type: 'signature_delta', signature: 'EqQB' }),
      stop(0),
      blockStart(1, { type: 'text', text: '' }),
      { type: 'ping' },
      delta(1, { type: 'text_delta', text: '你' }),
      delta(1, { type: 'text_delta', text: '好' }),
      stop(1),
      messageDelta('end_turn', {
        output_tokens: 20,
        output_tokens_details: { thinking_tokens: 7 },
      }),
      messageStop,
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
      summary: [],
      content: [{ type: 'reasoning_text', text: '先想' }],
    });
    expect(decodeThinking(reasoning?.encrypted_content)).toEqual({
      provider: 'claude',
      model: 'm',
      type: 'thinking',
      thinking: '先想',
      signature: 'EqQB',
    });
    expect(message).toMatchObject({ content: [{ type: 'output_text', text: '你好' }] });
    expect(terminal(events).response).toMatchObject({
      id: 'resp_test',
      status: 'completed',
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 64, cache_write_tokens: 6 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 7 },
        total_tokens: 120,
      },
    });
  });

  it('display: omitted（思考文本为空，只有签名）：reasoning 项照样提交，没有 content', () => {
    const events = run([
      start(),
      blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: '' }),
      delta(0, { type: 'signature_delta', signature: 'sig' }),
      stop(0),
      blockStart(1, { type: 'text', text: '' }),
      delta(1, { type: 'text_delta', text: '答' }),
      stop(1),
      messageDelta('end_turn'),
      messageStop,
    ]);
    expect(codexProblems(events)).toEqual([]);
    expect(types(events)).not.toContain('response.reasoning_text.delta');
    const [reasoning] = doneItems(events);
    expect(reasoning).not.toHaveProperty('content');
    expect(decodeThinking(reasoning?.encrypted_content)).toMatchObject({
      thinking: '',
      signature: 'sig',
    });
  });

  it('redacted_thinking → 只有 encrypted_content 的 reasoning 项；上游没给签名时 encrypted_content 里也没有', () => {
    const events = run([
      start(),
      blockStart(0, { type: 'thinking', thinking: '' }),
      delta(0, { type: 'thinking_delta', thinking: '想' }),
      stop(0),
      blockStart(1, { type: 'redacted_thinking', data: 'opaque' }),
      stop(1),
      blockStart(2, { type: 'text', text: '' }),
      delta(2, { type: 'text_delta', text: '答' }),
      stop(2),
      messageDelta('end_turn'),
      messageStop,
    ]);
    expect(codexProblems(events)).toEqual([]);
    const [unsigned, redacted] = doneItems(events);
    expect(decodeThinking(unsigned?.encrypted_content)).toEqual({
      ...ORIGIN,
      type: 'thinking',
      thinking: '想',
    });
    expect(redacted).toEqual({
      type: 'reasoning',
      id: expect.any(String),
      summary: [],
      encrypted_content: expect.any(String),
    });
    expect(decodeThinking(redacted?.encrypted_content)).toEqual({
      ...ORIGIN,
      type: 'redacted_thinking',
      data: 'opaque',
    });
  });

  it('相邻的 text 块（带引用时被拆开）并进同一个 message 项；被别的块隔开就是两项', () => {
    const events = run([
      start(),
      blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'a' }),
      stop(0),
      blockStart(1, { type: 'text', text: '' }),
      delta(1, { type: 'citations_delta', citation: {} }),
      delta(1, { type: 'text_delta', text: 'b' }),
      stop(1),
      blockStart(2, { type: 'thinking', thinking: '' }),
      stop(2),
      blockStart(3, { type: 'text', text: '' }),
      delta(3, { type: 'text_delta', text: 'c' }),
      stop(3),
      messageDelta('end_turn'),
      messageStop,
    ]);
    expect(codexProblems(events)).toEqual([]);
    expect(
      doneItems(events)
        .filter((i) => i.type === 'message')
        .map((i) => (i.content as Array<{ text: string }>)[0]?.text),
    ).toEqual(['ab', 'c']);
  });

  it('没有 usage 时不带 usage；message_delta 的 usage 是累计值，按字段覆盖 message_start 的', () => {
    expect(toResponsesUsage(undefined)).toBeUndefined();
    const events = run([
      { type: 'message_start', message: { content: [] } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      messageStop,
    ]);
    expect(terminal(events).response).not.toHaveProperty('usage');
    const merged = run([
      start({ input_tokens: 10, output_tokens: 1 }),
      messageDelta('end_turn', { input_tokens: 12, output_tokens: 9 }),
      messageStop,
    ]);
    expect(terminal(merged).response).toMatchObject({
      usage: { input_tokens: 12, output_tokens: 9, total_tokens: 21 },
    });
  });
});

describe('工具调用', () => {
  const names = () => {
    const n = new ToolNames();
    n.flat({ kind: 'custom', name: 'apply_patch' });
    n.flat({ kind: 'function', name: 'wait_agent', namespace: 'multi_agent_v1' });
    return n;
  };

  it('input_json_delta 拼成参数；按原工具类型还原：custom → custom_tool_call，namespace → function_call 带 namespace', () => {
    const patch = '*** Begin Patch\n*** End Patch';
    const json = JSON.stringify({ input: patch });
    const events = run(
      [
        start(),
        blockStart(0, { type: 'tool_use', id: 'toolu_1', name: 'apply_patch', input: {} }),
        delta(0, { type: 'input_json_delta', partial_json: '' }),
        delta(0, { type: 'input_json_delta', partial_json: json.slice(0, 7) }),
        delta(0, { type: 'input_json_delta', partial_json: json.slice(7) }),
        stop(0),
        blockStart(1, {
          type: 'tool_use',
          id: 'toolu_2',
          name: flatToolName('wait_agent', 'multi_agent_v1'),
          input: {},
        }),
        delta(1, { type: 'input_json_delta', partial_json: '{"targets":["x"]}' }),
        stop(1),
        messageDelta('tool_use'),
        messageStop,
      ],
      names(),
    );
    expect(codexProblems(events)).toEqual([]);
    expect(doneItems(events)).toEqual([
      { type: 'custom_tool_call', call_id: 'toolu_1', name: 'apply_patch', input: patch },
      {
        type: 'function_call',
        call_id: 'toolu_2',
        name: 'wait_agent',
        namespace: 'multi_agent_v1',
        arguments: '{"targets":["x"]}',
      },
    ]);
  });

  it('没有 input_json_delta 时参数取 content_block_start 的 input；上游没给 id 时网关补一个；模型编的名字原样交给 Codex', () => {
    const events = run([
      start(),
      blockStart(0, { type: 'tool_use', name: 'ghost', input: { a: 1 } }),
      stop(0),
      messageDelta('tool_use'),
      messageStop,
    ]);
    expect(doneItems(events)).toEqual([
      {
        type: 'function_call',
        call_id: expect.stringMatching(/^call_/),
        name: 'ghost',
        arguments: '{"a":1}',
      },
    ]);
  });

  it('服务端工具等不认识的块忽略', () => {
    const events = run([
      start(),
      blockStart(0, { type: 'server_tool_use', id: 'srv', name: 'web_search', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{}' }),
      stop(0),
      messageDelta('end_turn'),
      messageStop,
    ]);
    expect(doneItems(events)).toEqual([]);
    expect(terminal(events).type).toBe('response.completed');
  });
});

describe('结束与出错', () => {
  it('stop_reason=max_tokens → response.incomplete（max_output_tokens）；已出的文本照常提交，截断的工具调用不提交', () => {
    const events = run([
      start(),
      blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: '截' }),
      stop(0),
      blockStart(1, { type: 'tool_use', id: 't', name: 'exec_command', input: {} }),
      delta(1, { type: 'input_json_delta', partial_json: '{"cmd":' }),
      stop(1),
      messageDelta('max_tokens'),
      messageStop,
    ]);
    expect(codexProblems(events)).toEqual([]);
    expect(doneItems(events).map((i) => i.type)).toEqual(['message']);
    expect(terminal(events)).toMatchObject({
      type: 'response.incomplete',
      response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    });
  });

  it('stop_reason=refusal → response.incomplete（content_filter）；model_context_window_exceeded → context_length_exceeded', () => {
    expect(terminal(run([start(), messageDelta('refusal'), messageStop]))).toMatchObject({
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'content_filter' } },
    });
    expect(
      terminal(run([start(), messageDelta('model_context_window_exceeded'), messageStop])),
    ).toMatchObject({
      type: 'response.failed',
      response: { error: { code: 'context_length_exceeded' } },
    });
  });

  it('end_turn、tool_use、stop_sequence、pause_turn 都是 response.completed', () => {
    for (const reason of ['end_turn', 'tool_use', 'stop_sequence', 'pause_turn']) {
      expect(terminal(run([start(), messageDelta(reason), messageStop])).type).toBe(
        'response.completed',
      );
    }
  });

  it('流里的 error 事件 → response.failed，code 是 Anthropic 的错误类型；之后的事件不再处理', () => {
    const t = new MessagesStreamTranslator(new ToolNames(), ORIGIN, 'resp_test');
    const events = [
      ...t.start(),
      ...t.event(start()),
      ...t.event(blockStart(0, { type: 'text', text: '' })),
      ...t.event(delta(0, { type: 'text_delta', text: '半' })),
      ...t.data(
        '{"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}',
      ),
      ...t.event(delta(0, { type: 'text_delta', text: '不该出现' })),
      ...t.finish(),
    ];
    expect(codexProblems(events)).toEqual([]);
    expect(t.ended).toBe(true);
    expect(terminal(events)).toEqual({
      type: 'response.failed',
      response: {
        id: 'resp_test',
        object: 'response',
        status: 'failed',
        error: { code: 'overloaded_error', message: 'Overloaded' },
      },
    });
    expect(doneItems(events)).toEqual([]);
  });

  it('既没有 message_stop 也没有 stop_reason 就结束：按提前断开处理；有 stop_reason 没有 message_stop 照常完成', () => {
    const cut = run([
      start(),
      blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'x' }),
    ]);
    expect(codexProblems(cut)).toEqual([]);
    expect(terminal(cut)).toMatchObject({
      type: 'response.failed',
      response: { error: { message: expect.stringContaining('结束前断开') } },
    });
    const noStop = run([
      start(),
      blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'x' }),
      messageDelta('end_turn'),
    ]);
    expect(terminal(noStop).type).toBe('response.completed');
    expect(doneItems(noStop)).toHaveLength(1);
  });

  it('不是 JSON 的 data → response.failed，带原文；没有 type 的 JSON（别的协议的流）→ upstream_protocol_error', () => {
    expect(terminal(run(['not json']))).toMatchObject({
      type: 'response.failed',
      response: { error: { message: expect.stringContaining('not json') } },
    });
    expect(terminal(run([{ choices: [] }]))).toMatchObject({
      type: 'response.failed',
      response: { error: { code: UPSTREAM_PROTOCOL_ERROR } },
    });
  });

  it('上游无视 stream 回了整个 Message：拆成流事件处理；回了错误对象 → response.failed', () => {
    const t = new MessagesStreamTranslator(new ToolNames(), ORIGIN, 'resp_test');
    const events = [
      ...t.whole({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '想', signature: 'sig' },
          { type: 'text', text: '答' },
          { type: 'tool_use', id: 'toolu_1', name: 'exec_command', input: { cmd: 'ls' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
      ...t.finish(),
    ];
    expect(codexProblems(events)).toEqual([]);
    expect(doneItems(events).map((i) => i.type)).toEqual(['reasoning', 'message', 'function_call']);
    expect(decodeThinking(doneItems(events)[0]?.encrypted_content)).toMatchObject({
      thinking: '想',
      signature: 'sig',
    });
    expect(doneItems(events)[2]).toMatchObject({ arguments: '{"cmd":"ls"}' });
    expect(terminal(events)).toMatchObject({
      type: 'response.completed',
      response: { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } },
    });
    const failed = new MessagesStreamTranslator(new ToolNames(), ORIGIN, 'resp_test').whole({
      type: 'error',
      error: { type: 'not_found_error', message: 'model: m' },
    });
    expect(terminal(failed)).toMatchObject({
      type: 'response.failed',
      response: { error: { code: 'not_found_error', message: 'model: m' } },
    });
  });
});
