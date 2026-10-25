import { describe, expect, it } from 'vitest';
import { codexProblems, codexRequest, doneItems } from '../test-fixtures/codex.js';
import { ToolNames } from '../tools.js';
import type { GatewayProvider, JsonObject, ResponsesItem, ResponsesRequest } from '../types.js';
import { decodeReasoning, toChatRequest } from './request.js';
import { ChatStreamTranslator } from './response.js';
import {
  CHAT_THINKING_FORMATS,
  type ChatThinkingFormat,
  decodeChatReplay,
  encodeChatReplay,
} from './thinking.js';

const provider = (
  format: string | undefined,
  patch: Partial<GatewayProvider> = {},
): GatewayProvider => ({
  id: 'chat',
  kind: 'openai-compatible',
  displayName: 'Chat',
  api: 'openai-completions',
  baseURL: 'https://proxy.example.com/v1',
  defaultModelId: 'm',
  models: [{ id: 'm' }],
  compat: { thinkingFormat: format },
  ...patch,
});
const translated = (
  format: string | undefined,
  effort: string | undefined,
  model = 'm',
  patch: Partial<GatewayProvider> = {},
) => {
  const body: ResponsesRequest = {
    ...codexRequest('2-tool-results').body,
    model,
    reasoning: effort === undefined ? undefined : { effort },
  };
  return toChatRequest(body, provider(format, patch)).request;
};

describe('思考格式的请求（同一份录制工具结果）', () => {
  it.each(['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-4-argon'])(
    'Gemini 官方地址的 %s 将 minimal 降 low，none 省略，不混发 thinking_config',
    (model) => {
      const patch = { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' };
      expect(translated(undefined, 'minimal', model, patch).reasoning_effort).toBe('low');
      for (const effort of ['low', 'medium', 'high'])
        expect(translated(undefined, effort, model, patch).reasoning_effort).toBe(effort);
      expect(translated(undefined, 'none', model, patch)).not.toHaveProperty('reasoning_effort');
      expect(translated(undefined, undefined, model, patch)).not.toHaveProperty('reasoning_effort');
      expect(translated(undefined, 'minimal', model, patch)).not.toHaveProperty('extra_body');
      expect(translated('openai', 'minimal', model, patch).reasoning_effort).toBe('minimal');
      expect(translated('openrouter', 'minimal', model, patch).reasoning_effort).toBe('minimal');
      for (const baseURL of [
        'https://proxy.example.com',
        'https://generativelanguage.googleapis.com.example.com',
        'https://example.com/generativelanguage.googleapis.com',
      ])
        expect(translated(undefined, 'minimal', model, { baseURL }).reasoning_effort).toBe(
          'minimal',
        );
    },
  );

  it.each([
    ['openai', { reasoning_effort: 'high' }],
    ['deepseek', { thinking: { type: 'enabled' }, reasoning_effort: 'high' }],
    ['qwen', { enable_thinking: true, preserve_thinking: true, thinking_budget: 16384 }],
    ['zai', { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: 'high' }],
    ['minimax', { reasoning_split: true, thinking: { type: 'adaptive' } }],
    ['tencent', { thinking: { type: 'enabled' }, reasoning_effort: 'high' }],
  ] as const)('%s 的开关、力度与历史推理', (format, expected) => {
    const chat = translated(format, 'high');
    expect(chat).toMatchObject(expected);
    if (format === 'qwen' || format === 'minimax')
      expect(chat).not.toHaveProperty('reasoning_effort');
    const original = translated(undefined, 'high');
    expect(chat.tools).toEqual(original.tools);
    expect(chat.messages).toEqual(original.messages);
    expect(
      chat.messages.find((message) => message.tool_calls !== undefined)?.reasoning_content,
    ).toBe('先建文件，再看目录。');
  });

  it.each([
    ['openai', { reasoning_effort: 'none' }],
    ['deepseek', { thinking: { type: 'disabled' } }],
    ['qwen', { enable_thinking: false }],
    ['zai', { thinking: { type: 'disabled' } }],
    ['minimax', { reasoning_split: true, thinking: { type: 'disabled' } }],
    ['tencent', { thinking: { type: 'disabled' } }],
  ] as const)('%s 的 none 关思考', (format, expected) => {
    const chat = translated(format, 'none', format === 'minimax' ? 'MiniMax-M3' : 'm');
    expect(chat).toMatchObject(expected);
    if (format !== 'openai') expect(chat).not.toHaveProperty('reasoning_effort');
    expect(chat).not.toHaveProperty('thinking_budget');
  });

  it('不发 effort 时不强制思考；MiniMax 仍请求拆开输出', () => {
    for (const format of CHAT_THINKING_FORMATS) {
      const chat = translated(format, undefined);
      for (const key of ['thinking', 'enable_thinking', 'reasoning_effort', 'thinking_budget'])
        expect(chat).not.toHaveProperty(key);
      if (format === 'minimax') expect(chat.reasoning_split).toBe(true);
    }
    expect(translated(undefined, 'none')).not.toHaveProperty('reasoning_effort');
    expect(translated('openrouter', 'none')).not.toHaveProperty('reasoning_effort');
  });

  it.each(['minimal', 'medium', 'xhigh'])('DeepSeek 的 %s 映射为有效档位', (effort) => {
    expect(translated('deepseek', effort).reasoning_effort).toBe(
      effort === 'minimal' ? 'low' : 'high',
    );
  });

  it.each([
    ['minimal', 1024],
    ['low', 4096],
    ['medium', 8192],
    ['high', 16384],
    ['xhigh', 32768],
    ['max', 32768],
  ] as const)('Qwen %s 映射预算 %s', (effort, budget) => {
    expect(translated('qwen', effort).thinking_budget).toBe(budget);
  });

  it('目录不提供 off 时 none 取最低档，空目录不推断；显式格式覆盖 DeepSeek 地址默认', () => {
    expect(
      translated('qwen', 'none', 'm', { models: [{ id: 'm', reasoningEfforts: ['high', 'low'] }] })
        .thinking_budget,
    ).toBe(4096);
    expect(
      translated('qwen', 'none', 'm', { models: [{ id: 'm', reasoningEfforts: [] }] })
        .enable_thinking,
    ).toBe(false);
    expect(
      translated(undefined, 'high', 'm', { baseURL: 'https://api.deepseek.com' }).thinking,
    ).toEqual({ type: 'enabled' });
    expect(
      translated('openai', 'high', 'm', { baseURL: 'https://api.deepseek.com' }),
    ).not.toHaveProperty('thinking');
  });

  it('强制思考的 GLM-5.3 改 low，GLM-5.2 的力度由上游映射', () => {
    for (const model of ['glm-5.3', 'GLM-5.3-FLASH']) {
      expect(translated('zai', 'none', model)).toMatchObject({
        thinking: { type: 'enabled', clear_thinking: false },
        reasoning_effort: 'low',
      });
      expect(translated('zai', 'medium', model).reasoning_effort).toBe('high');
    }
    expect(translated('zai', 'minimal', 'glm-5.2').reasoning_effort).toBe('minimal');
    expect(translated('tencent', 'none', 'glm-5.3').thinking).toEqual({ type: 'enabled' });
  });

  it('Kimi K3 / K3.1 只发 effort，K2.7-code 不发关闭参数，K2.6 开思考并保留历史', () => {
    for (const format of ['deepseek', 'openai', 'qwen']) {
      for (const model of ['kimi-k3', 'kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed']) {
        const k3 = translated(format, 'none', model);
        expect(k3.reasoning_effort).toBe('low');
        for (const key of ['thinking', 'thinking_budget', 'enable_thinking'])
          expect(k3).not.toHaveProperty(key);
      }
      const code = translated(format, 'none', 'kimi-k2.7-code-highspeed');
      expect(code).not.toHaveProperty('thinking');
      expect(code).not.toHaveProperty('reasoning_effort');
    }
    expect(translated('deepseek', 'high', 'kimi-k2.6').thinking).toEqual({
      type: 'enabled',
      keep: 'all',
    });
    expect(translated('deepseek', 'high', 'kimi-k2.6')).not.toHaveProperty('reasoning_effort');
    expect(translated('deepseek', 'none', 'kimi-k2.6').thinking).toEqual({ type: 'disabled' });
    expect(translated('deepseek', 'high', 'kimi-k2.7-code')).not.toHaveProperty('thinking');
  });

  it('MiniMax M3.1 的 none 改 low，M2.x 省略关闭参数，阶跃与腾讯归一化有效档位', () => {
    expect(translated('minimax', 'none', 'MiniMax-M3.1-Flash-Preview')).toMatchObject({
      thinking: { type: 'adaptive' },
      reasoning_effort: 'low',
    });
    expect(translated('minimax', 'minimal', 'MiniMax-M3.1-Flash-Preview').reasoning_effort).toBe(
      'low',
    );
    expect(translated('minimax', 'none', 'MiniMax-M2.7')).not.toHaveProperty('thinking');
    expect(translated('openai', 'none', 'step-5-preview').reasoning_effort).toBe('low');
    expect(translated('openai', 'medium', 'step-3.5-flash-2603').reasoning_effort).toBe('high');
    expect(translated('tencent', 'max', 'hy3')).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
  });

  it('补 reasoning_content 的默认值按格式，false 只停止补空串；工具选择依旧读已有开关', () => {
    const body: ResponsesRequest = {
      model: 'm',
      input: [{ type: 'message', role: 'assistant', content: 'answer' }],
    };
    for (const format of CHAT_THINKING_FORMATS) {
      const msg = toChatRequest(body, provider(format)).request.messages[0];
      if (['deepseek', 'zai', 'minimax', 'tencent'].includes(format))
        expect(msg?.reasoning_content).toBe('');
      else expect(msg).not.toHaveProperty('reasoning_content');
      expect(
        toChatRequest(
          body,
          provider(format, {
            compat: { thinkingFormat: format, requiresReasoningContentOnAssistantMessages: false },
          }),
        ).request.messages[0],
      ).not.toHaveProperty('reasoning_content');
    }
    const tool = { ...codexRequest('2-tool-results').body, tool_choice: 'required' };
    expect(
      toChatRequest(
        tool,
        provider('zai', { compat: { thinkingFormat: 'zai', toolChoice: 'auto_only' } }),
      ).request.tool_choice,
    ).toBe('auto');
  });
});

const chunk = (delta: JsonObject, finish_reason: string | null = null) => ({
  choices: [{ delta, finish_reason }],
});
function stream(format: ChatThinkingFormat, chunks: JsonObject[]) {
  const t = new ChatStreamTranslator(new ToolNames(), {
    responseId: 'r',
    thinking: { provider: 'chat', model: 'm', format },
  });
  const events = [...t.start(), ...chunks.flatMap((part) => t.chunk(part)), ...t.finish()];
  expect(codexProblems(events)).toEqual([]);
  return { events, output: doneItems(events) as ResponsesItem[] };
}
const toolCall = {
  index: 0,
  id: 'call_read',
  type: 'function',
  function: { name: 'read_file', arguments: '{}' },
};
const replayed = (
  format: ChatThinkingFormat,
  input: ResponsesItem[],
  patch: Partial<GatewayProvider> = {},
) => toChatRequest({ model: 'm', input }, provider(format, patch));

describe('推理字段与原样回传', () => {
  it.each(CHAT_THINKING_FORMATS)(
    '%s 读取三个字段，阶跃别名不重复；未知结构与加密块不当文本',
    (format) => {
      const { output } = stream(format, [
        chunk({
          reasoning_content: 'a',
          reasoning: 'a',
          reasoning_details: [{ type: 'reasoning.text', text: 'a' }],
        }),
        chunk({ reasoning_content: '', reasoning: 'b' }),
        chunk({
          reasoning_details: [
            { type: 'reasoning.text', text: 'c' },
            { type: 'reasoning.summary', summary: 'd' },
            { type: 'reasoning.encrypted', data: 'opaque' },
            null,
          ],
        }),
        chunk({ tool_calls: [toolCall] }, 'tool_calls'),
      ]);
      expect(
        output
          .filter((item) => item.content !== undefined)
          .map(decodeReasoning)
          .join(''),
      ).toBe('abcd');
      const assistant = replayed(format, output).request.messages[0];
      expect(assistant?.reasoning_content).toBe('abcd');
      expect(assistant?.reasoning_details).toEqual([
        { type: 'reasoning.text', text: 'ac' },
        { type: 'reasoning.summary', summary: 'd' },
        { type: 'reasoning.encrypted', data: 'opaque' },
      ]);
    },
  );

  it('reasoning_details 的文本分片合并，标识、签名与未知字段保留；不同块保持顺序', () => {
    const first = {
      type: 'reasoning.text',
      id: 'd1',
      index: 0,
      format: 'MiniMax-response-v1',
      text: '先',
      signature: 'sig',
      extra: { keep: true },
    };
    const { output } = stream('minimax', [
      chunk({ reasoning_details: [first] }),
      chunk({ reasoning_details: [{ ...first, text: '检查' }] }),
      chunk({
        reasoning_details: [{ type: 'reasoning.text', id: 'd2', index: 1, text: '再修改' }],
      }),
      chunk({ tool_calls: [toolCall] }, 'tool_calls'),
    ]);
    const withoutPlaintext = output.map((item) =>
      item.type === 'reasoning' ? { ...item, content: null } : item,
    );
    const assistant = replayed('minimax', withoutPlaintext).request.messages[0];
    expect(assistant?.reasoning_content).toBe('先检查再修改');
    expect(assistant?.reasoning_details).toEqual([
      { ...first, text: '先检查' },
      { type: 'reasoning.text', id: 'd2', index: 1, text: '再修改' },
    ]);
  });

  it('MiniMax 前缀标签的每一个分片边界都能拆开，下一步恢复完整原始 content', () => {
    const raw = '\n <think>先检查🙂\n再修改</think>\n已修改。';
    for (let split = 1; split < raw.length; split += 1) {
      const { events, output } = stream('minimax', [
        chunk({ content: raw.slice(0, split) }),
        chunk({ content: raw.slice(split) }),
        chunk({ tool_calls: [toolCall] }, 'tool_calls'),
      ]);
      expect(
        events
          .filter((event) => event.type === 'response.output_text.delta')
          .map((event) => event.delta)
          .join(''),
      ).toBe('\n已修改。');
      expect(
        events
          .filter((event) => event.type === 'response.reasoning_text.delta')
          .map((event) => event.delta)
          .join(''),
      ).toBe('先检查🙂\n再修改');
      const message = replayed('minimax', output).request.messages[0];
      expect(message?.content).toBe(raw);
      expect(message?.reasoning_content).toBe('先检查🙂\n再修改');
    }
  });

  it('字面标签与其他格式的正文原样保留，未闭合的思考只当推理，标签前缀不足时不吞字', () => {
    for (const content of ['示例：<think>text</think>', '<thi', '   ']) {
      const { events } = stream('minimax', [chunk({ content }, 'stop')]);
      expect(
        events
          .filter((event) => event.type === 'response.output_text.delta')
          .map((event) => event.delta)
          .join(''),
      ).toBe(content);
    }
    const open = stream('minimax', [chunk({ content: '<think>还没结束</thi' }, 'length')]);
    expect(open.events.filter((event) => event.type === 'response.output_text.delta')).toHaveLength(
      0,
    );
    expect(
      open.output
        .filter((item) => item.content !== undefined)
        .map(decodeReasoning)
        .join(''),
    ).toBe('还没结束</thi');
    const literal = stream('openai', [chunk({ content: '<think>literal</think>answer' }, 'stop')]);
    expect(literal.output[0]?.content).toEqual([
      { type: 'output_text', text: '<think>literal</think>answer' },
    ]);
  });

  it('整段 JSON 与流式用同样字段；空文本的签名也保留', () => {
    const t = new ChatStreamTranslator(new ToolNames(), {
      thinking: { provider: 'chat', model: 'm', format: 'tencent' },
    });
    const details = [{ type: 'reasoning.encrypted', data: 'signature', index: 0 }];
    const events = [
      ...t.whole({
        choices: [
          {
            message: { reasoning_details: details, tool_calls: [toolCall] },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      ...t.finish(),
    ];
    expect(codexProblems(events)).toEqual([]);
    expect(
      replayed('tencent', doneItems(events) as ResponsesItem[]).request.messages[0]
        ?.reasoning_details,
    ).toEqual(details);
  });

  it('换 Provider、模型或格式不回传专属元数据，孤立信封不制造 assistant，坏信封容忍', () => {
    const replay = {
      provider: 'chat',
      model: 'm',
      format: 'minimax' as const,
      content: '<think>r</think>answer',
      reasoning_details: [{ text: 'r' }],
    };
    const input: ResponsesItem[] = [
      { type: 'reasoning', encrypted_content: encodeChatReplay(replay) },
      { type: 'function_call', call_id: 'c', name: 'read_file', arguments: '{}' },
    ];
    for (const patch of [{ id: 'other' }, {}]) {
      const format = patch.id ? 'minimax' : 'openai';
      const result = replayed(format, input, patch);
      expect(result.dropped).toContain('reasoning:foreign_replay');
      expect(result.request.messages[0]?.content).toBeNull();
      expect(result.request.messages[0]).not.toHaveProperty('reasoning_details');
    }
    expect(
      replayed('minimax', [
        {
          ...input[0],
          encrypted_content: encodeChatReplay({ ...replay, model: 'other' }),
        } as ResponsesItem,
        input[1] as ResponsesItem,
      ]).dropped,
    ).toContain('reasoning:foreign_replay');
    expect(replayed('minimax', [input[0] as ResponsesItem]).request.messages).toEqual([]);
    expect(decodeChatReplay('wevir-gw:chat:v1:broken')).toBeUndefined();
  });
});
