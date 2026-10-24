// Codex 工具搜索的分发翻译（tool-search.ts）：请求与历史翻成普通函数，响应还原成 Codex 认的项；三种上游协议都经它，OpenAI
// 官方地址原样透传。

import { describe, expect, it } from 'vitest';
import { toolSearchMode } from './providers.js';
import { CALL_TOOL_FUNCTION, dispatchToolSearch } from './tool-search.js';
import type { GatewayProvider, ResponsesEvent, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

const SEARCH_TOOL = {
  type: 'tool_search',
  execution: 'client',
  description: 'Search for tools.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' }, limit: { type: 'number' } },
    required: ['query'],
  },
};

const CORE_NAMESPACE = {
  type: 'namespace',
  name: 'mcp__wevir',
  description: 'Wevir tools.',
  tools: [
    { type: 'function', name: 'wevir_show', description: 'Show.', parameters: { type: 'object' } },
  ],
};

const FOUND = {
  type: 'namespace',
  name: 'mcp__wevir_more',
  description: 'More tools.',
  tools: [
    {
      type: 'function',
      name: 'browser_snapshot',
      description: 'Snapshot.',
      defer_loading: true,
      parameters: { type: 'object', properties: { browserId: { type: 'string' } } },
    },
    {
      type: 'function',
      name: 'browser_click',
      description: 'Click.',
      defer_loading: true,
      parameters: { type: 'object', properties: { ref: { type: 'string' } } },
    },
  ],
};

/** 一个搜过、调过搜到的工具、也调过常驻工具的回合。 */
function body(): ResponsesRequest {
  return {
    model: 'm',
    instructions: 'Base.',
    tools: [
      { type: 'function', name: 'exec_command', parameters: {} },
      CORE_NAMESPACE,
      SEARCH_TOOL,
    ],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Click it.' }] },
      {
        type: 'tool_search_call',
        id: 'tsc_1',
        call_id: 'ts1',
        status: 'completed',
        execution: 'client',
        arguments: { query: 'browser click', limit: 5 },
      },
      {
        type: 'tool_search_output',
        call_id: 'ts1',
        status: 'completed',
        execution: 'client',
        tools: [FOUND],
      },
      {
        type: 'function_call',
        call_id: 'c1',
        namespace: 'mcp__wevir_more',
        name: 'browser_click',
        arguments: '{"ref":"@e3"}',
      },
      { type: 'function_call_output', call_id: 'c1', output: 'clicked' },
      {
        type: 'function_call',
        call_id: 'c2',
        namespace: 'mcp__wevir',
        name: 'wevir_show',
        arguments: '{}',
      },
      { type: 'function_call_output', call_id: 'c2', output: 'shown' },
    ],
  };
}

const done = (item: Record<string, unknown>): ResponsesEvent => ({
  type: 'response.output_item.done',
  output_index: 0,
  item,
});

describe('请求', () => {
  it('没有工具搜索时不改', () => {
    expect(dispatchToolSearch({ model: 'm', input: [], tools: [CORE_NAMESPACE] })).toBeUndefined();
  });

  it('tool_search 换成函数并加上 call_tool；历史里的搜索与搜到之后的调用换成函数调用，常驻工具的调用不动', () => {
    const translated = dispatchToolSearch(body());
    if (translated === undefined) throw new Error('expected a translation');
    const { tools, input } = translated.body;
    expect(tools?.map((tool) => [tool.type, tool.name])).toEqual([
      ['function', 'exec_command'],
      ['namespace', 'mcp__wevir'],
      ['function', 'tool_search'],
      ['function', CALL_TOOL_FUNCTION],
    ]);
    expect(tools?.[2]).toMatchObject({ parameters: SEARCH_TOOL.parameters, strict: false });
    expect(tools?.[2]?.description).toContain('call_tool');
    expect(tools?.[2]).not.toHaveProperty('execution');
    const items = input as Array<Record<string, unknown>>;
    expect(items[1]).toEqual({
      type: 'function_call',
      call_id: 'ts1',
      name: 'tool_search',
      arguments: '{"query":"browser click","limit":5}',
    });
    expect(items[2]?.type).toBe('function_call_output');
    const output = String(items[2]?.output);
    const lines = output.split('\n');
    expect(lines[0]).toContain('call_tool');
    // 按全名排序，去掉 defer_loading。
    expect(lines.slice(1).map((line) => JSON.parse(line).name)).toEqual([
      'mcp__wevir_more__browser_click',
      'mcp__wevir_more__browser_snapshot',
    ]);
    expect(output).not.toContain('defer_loading');
    expect(items[3]).toEqual({
      type: 'function_call',
      call_id: 'c1',
      name: CALL_TOOL_FUNCTION,
      arguments: '{"name":"mcp__wevir_more__browser_click","arguments":{"ref":"@e3"}}',
    });
    expect(items[5]).toEqual(body().input[5]);
    // 同一份请求翻两次结果相同（缓存前缀稳定）。
    expect(JSON.stringify(dispatchToolSearch(body())?.body)).toBe(JSON.stringify(translated.body));
  });

  it('只有历史里的搜索、这次没有 tool_search 工具时也翻历史，不加 call_tool', () => {
    const { tools: _drop, ...rest } = body();
    const translated = dispatchToolSearch({ ...rest, tools: [CORE_NAMESPACE] });
    expect(translated?.body.tools?.map((tool) => tool.name)).toEqual(['mcp__wevir']);
    expect((translated?.body.input as Array<{ type: string }>)[1]?.type).toBe('function_call');
  });
});

describe('响应', () => {
  const rewrite = (event: ResponsesEvent) => {
    const translated = dispatchToolSearch(body());
    if (translated === undefined) throw new Error('expected a translation');
    return translated.rewrite(event);
  };

  it('tool_search 调用还原成 tool_search_call，参数是对象', () => {
    expect(
      rewrite(
        done({
          type: 'function_call',
          id: 'fc_9',
          call_id: 'ts2',
          status: 'completed',
          name: 'tool_search',
          arguments: '{"query":"lsp references"}',
        }),
      ),
    ).toEqual(
      done({
        type: 'tool_search_call',
        id: 'fc_9',
        call_id: 'ts2',
        status: 'completed',
        execution: 'client',
        arguments: { query: 'lsp references' },
      }),
    );
  });

  it('call_tool 还原成对搜到的工具的调用；认不出的全名按最后的 __ 拆开', () => {
    const call = (name: string) =>
      rewrite(
        done({
          type: 'function_call',
          call_id: 'c3',
          name: CALL_TOOL_FUNCTION,
          arguments: JSON.stringify({ name, arguments: { browserId: 'tab_1' } }),
        }),
      ).item;
    expect(call('mcp__wevir_more__browser_snapshot')).toEqual({
      type: 'function_call',
      call_id: 'c3',
      namespace: 'mcp__wevir_more',
      name: 'browser_snapshot',
      arguments: '{"browserId":"tab_1"}',
    });
    expect(call('mcp__wevir__wevir_show')).toMatchObject({
      namespace: 'mcp__wevir',
      name: 'wevir_show',
    });
    expect(call('exec_command')).toMatchObject({ name: 'exec_command' });
    expect(call('exec_command')).not.toHaveProperty('namespace');
    expect(call('mcp__other__thing')).toMatchObject({ namespace: 'mcp__other', name: 'thing' });
  });

  it('开始的项不改，终结事件的 output 也还原', () => {
    const added = {
      type: 'response.output_item.added',
      item: { type: 'function_call', name: 'tool_search', arguments: '' },
    };
    expect(rewrite(added)).toEqual(added);
    const completed = rewrite({
      type: 'response.completed',
      response: {
        output: [{ type: 'function_call', call_id: 'ts3', name: 'tool_search', arguments: '{}' }],
      },
    });
    expect((completed.response as { output: Array<{ type: string }> }).output[0]?.type).toBe(
      'tool_search_call',
    );
  });
});

const provider = (overrides: Partial<GatewayProvider>): GatewayProvider => ({
  id: 'p',
  kind: 'openai-compatible',
  displayName: 'P',
  models: [{ id: 'm' }],
  defaultModelId: 'm',
  apiKey: 'k',
  ...overrides,
});

describe('三种上游协议', () => {
  it('OpenAI 官方 Responses 默认 native，原样透传；其余默认 dispatch，compat 可以改', () => {
    const openai = provider({ api: 'openai-responses', baseURL: 'https://api.openai.com/v1' });
    expect(toolSearchMode(openai)).toBe('native');
    const prepared = prepareUpstream(openai, body());
    if (!prepared.ok) throw new Error(prepared.message);
    expect((prepared.payload as ResponsesRequest).tools?.[2]).toEqual(SEARCH_TOOL);
    const other = provider({ api: 'openai-responses', baseURL: 'https://example.test/v1' });
    expect(toolSearchMode(other)).toBe('dispatch');
    expect(toolSearchMode({ ...other, compat: { toolSearch: 'off' } })).toBe('off');
    expect(toolSearchMode({ ...provider({}), kind: 'deepseek-official' })).toBe('dispatch');
  });

  it('Responses 透传、转 Chat、转 Messages 的请求里都是普通函数，没有搜索项', () => {
    for (const api of ['openai-responses', 'openai-completions', 'anthropic-messages'] as const) {
      const prepared = prepareUpstream(
        provider({ api, baseURL: 'https://example.test/v1' }),
        body(),
      );
      if (!prepared.ok) throw new Error(prepared.message);
      const text = JSON.stringify(prepared.payload);
      expect(text, api).not.toContain('"tool_search_call"');
      expect(text, api).not.toContain('"tool_search_output"');
      expect(text, api).not.toContain('"type":"tool_search"');
      expect(text, api).toContain(CALL_TOOL_FUNCTION);
      expect(text, api).toContain('mcp__wevir_more__browser_click');
    }
  });

  it('转 Chat 时上游调 call_tool，Codex 收到的是对搜到的工具的调用', async () => {
    const prepared = prepareUpstream(
      provider({ api: 'openai-completions', baseURL: 'https://example.test/v1' }),
      body(),
    );
    if (!prepared.ok) throw new Error(prepared.message);
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const sse = [
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_9',
            type: 'function',
            function: {
              name: CALL_TOOL_FUNCTION,
              arguments: '{"name":"mcp__wevir_more__browser_snapshot","arguments":{}}',
            },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ].join('');
    const response = new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    let text = '';
    for await (const piece of prepared.translate(response, new AbortController().signal)) {
      text += typeof piece === 'string' ? piece : new TextDecoder().decode(piece);
    }
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as ResponsesEvent);
    const finished = events.find((event) => event.type === 'response.output_item.done');
    expect(finished?.item).toMatchObject({
      type: 'function_call',
      call_id: 'call_9',
      namespace: 'mcp__wevir_more',
      name: 'browser_snapshot',
      arguments: '{}',
    });
  });
});
