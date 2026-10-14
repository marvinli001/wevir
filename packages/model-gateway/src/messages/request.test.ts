import { describe, expect, it } from 'vitest';
import { SYSTEM_AS_USER_NOTE } from '../chat/request.js';
import { CODEX_SAMPLES, codexRequest } from '../test-fixtures/codex.js';
import { flatToolName } from '../tools.js';
import type {
  GatewayProvider,
  MessagesMessage,
  ResponsesItem,
  ResponsesRequest,
} from '../types.js';
import {
  DEFAULT_MAX_TOKENS,
  decodeThinking,
  encodeThinking,
  PLACEHOLDER_TOOL_DESCRIPTION,
  THINKING_ENVELOPE_PREFIX,
  toMessagesRequest,
  toolUseId,
} from './request.js';

const provider = (patch: Partial<GatewayProvider> = {}): GatewayProvider => ({
  id: 'claude',
  kind: 'openai-compatible',
  displayName: 'Messages',
  api: 'anthropic-messages',
  baseURL: 'https://messages.example.com',
  models: [{ id: 'm' }],
  defaultModelId: 'm',
  apiKey: 'k',
  ...patch,
});

const request = (input: ResponsesRequest['input'], extra: Partial<ResponsesRequest> = {}) =>
  ({ model: 'm', input, ...extra }) as ResponsesRequest;

const user = (text: string) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});
const developer = (text: string) => ({
  type: 'message',
  role: 'developer',
  content: [{ type: 'input_text', text }],
});
const assistant = (text: string) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});
/** 网关自己在响应里写的 reasoning 项（同一个 Provider 与模型、带签名）。 */
const signedReasoning = (thinking: string, patch: Record<string, unknown> = {}): ResponsesItem => ({
  type: 'reasoning',
  summary: [],
  content: [{ type: 'reasoning_text', text: thinking }],
  encrypted_content: encodeThinking({
    provider: 'claude',
    model: 'm',
    type: 'thinking',
    thinking,
    signature: `sig-${thinking}`,
    ...patch,
  }),
});
const roles = (messages: MessagesMessage[]) => messages.map((m) => m.role);
const types = (message: MessagesMessage | undefined) => message?.content.map((b) => b.type);

describe('录制的 Codex 请求 → Messages 请求', () => {
  for (const name of CODEX_SAMPLES) {
    it(`${name} 的转换结果与快照一致`, async () => {
      const { request: messages, dropped } = toMessagesRequest(codexRequest(name).body, provider());
      await expect(
        `${JSON.stringify({ request: messages, dropped }, null, 2)}\n`,
      ).toMatchFileSnapshot(`../__snapshots__/codex-requests/${name}.messages.json`);
    });
  }

  it('第一回合：开头的 developer → 顶层 system；工具摊平规则与 Chat 相同；max_tokens 取默认；思考按 enabled', () => {
    const body = codexRequest('1-first-turn').body;
    const { request: messages, dropped } = toMessagesRequest(body, provider());
    expect(messages.system?.map((b) => b.type)).toEqual(['text', 'text']);
    expect(messages.system?.[1]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect(roles(messages.messages)).toEqual(['user']);
    // <environment_context> 与用户输入是相邻的两条 user，合成一条。
    expect(types(messages.messages[0])).toEqual(['text', 'text']);
    expect(messages.messages[0]?.content[1]).toMatchObject({
      cache_control: { type: 'ephemeral' },
    });
    expect(messages.tools?.map((t) => t.name)).toEqual([
      'exec_command',
      'write_stdin',
      'request_user_input',
      'apply_patch',
      'view_image',
      'multi_agent_v1__close_agent',
      'multi_agent_v1__resume_agent',
      'multi_agent_v1__send_input',
      'multi_agent_v1__spawn_agent',
      'multi_agent_v1__wait_agent',
    ]);
    const patch = messages.tools?.find((t) => t.name === 'apply_patch');
    expect(patch?.input_schema).toMatchObject({ required: ['input'] });
    expect(patch?.description).toContain('lark grammar');
    // tool_choice: auto 与 parallel_tool_calls: true 都是 Messages 的默认，不发。
    expect(messages).not.toHaveProperty('tool_choice');
    expect(messages.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(messages.thinking).toEqual({ type: 'enabled', budget_tokens: 16_000 });
    expect(messages.output_config).toEqual({ effort: 'high' });
    expect(messages.stream).toBe(true);
    for (const field of ['store', 'include', 'prompt_cache_key', 'client_metadata', 'reasoning']) {
      expect(messages).not.toHaveProperty(field);
    }
    expect(dropped).toEqual(
      expect.arrayContaining(['field:client_metadata', 'field:prompt_cache_key']),
    );
  });

  it('带工具结果的请求：两个调用是一条 assistant 的两个 tool_use，结果在下一条 user 里；没有签名的推理不发', () => {
    const { request: messages, dropped } = toMessagesRequest(
      codexRequest('2-tool-results').body,
      provider(),
    );
    expect(roles(messages.messages)).toEqual(['user', 'assistant', 'user']);
    expect(messages.messages[1]?.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'apply_patch',
        input: { input: '*** Begin Patch\n*** Add File: notes.md\n+# 笔记\n*** End Patch' },
      },
      { type: 'tool_use', id: 'call_2', name: 'exec_command', input: { cmd: 'ls' } },
    ]);
    expect(messages.messages[2]?.content).toMatchObject([
      { type: 'tool_result', tool_use_id: 'call_1', content: expect.stringContaining('Success') },
      { type: 'tool_result', tool_use_id: 'call_2', content: expect.stringContaining('notes.md') },
    ]);
    // 录制样本的推理来自 Responses mock，encrypted_content 是 null：没有签名，不发。
    expect(dropped).toContain('reasoning:unsigned');
  });

  it('跨回合：对话中间的 developer 转成注明来源的 user；相邻的 user 内容合成一条；图片转 base64 来源', () => {
    const { request: messages } = toMessagesRequest(codexRequest('3-next-turn').body, provider());
    expect(roles(messages.messages)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(messages.messages[3]?.content).toEqual([{ type: 'text', text: '已新建 notes.md。' }]);
    const last = messages.messages[4];
    expect(types(last)).toEqual(['text', 'text', 'image']);
    expect(last?.content[0]?.text).toMatch(
      new RegExp(`^${SYSTEM_AS_USER_NOTE.replace(/[[\]]/g, '\\$&')}\n<permissions instructions>`),
    );
    expect(last?.content[2]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: expect.stringMatching(/^iVBOR/) },
      cache_control: { type: 'ephemeral' },
    });
    expect(messages.system).toHaveLength(2);
  });

  it('压缩请求：没有工具但历史里有工具调用，补上同名的占位工具并禁止调用', () => {
    const { request: messages } = toMessagesRequest(codexRequest('4-compact').body, provider());
    expect(messages.tools).toEqual([
      {
        name: 'apply_patch',
        description: PLACEHOLDER_TOOL_DESCRIPTION,
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'exec_command',
        description: PLACEHOLDER_TOOL_DESCRIPTION,
        input_schema: { type: 'object', properties: {} },
      },
    ]);
    expect(messages.tool_choice).toEqual({ type: 'none' });
  });
});

describe('对话中间的 developer 消息', () => {
  const input = [
    developer('基础'),
    user('你好'),
    assistant('好'),
    developer('权限变了'),
    user('继续'),
  ];

  it('默认（inline、user 同）：转成注明来源的 user 消息，顶层 system 不变', () => {
    for (const mode of [undefined, 'inline', 'user'] as const) {
      const { request: messages } = toMessagesRequest(
        request(input),
        provider({ compat: { systemMessageMode: mode } }),
      );
      expect(messages.system?.map((b) => b.text)).toEqual(['基础']);
      expect(messages.messages[2]?.content.map((b) => b.text)).toEqual([
        `${SYSTEM_AS_USER_NOTE}\n权限变了`,
        '继续',
      ]);
    }
  });

  it('merge：并进顶层 system', () => {
    const { request: messages } = toMessagesRequest(
      request(input),
      provider({ compat: { systemMessageMode: 'merge' } }),
    );
    expect(messages.system?.map((b) => b.text)).toEqual(['基础', '权限变了']);
    expect(messages.messages[2]?.content.map((b) => b.text)).toEqual(['继续']);
  });

  it('instructions 是顶层 system 的第一段', () => {
    const { request: messages } = toMessagesRequest(
      request([developer('二'), user('hi')], { instructions: '一' }),
      provider(),
    );
    expect(messages.system?.map((b) => b.text)).toEqual(['一', '二']);
  });
});

describe('推理项 → 思考块', () => {
  it('网关写的、同一个 Provider 与模型的、带签名的推理：原样还原成 assistant 开头的思考块', () => {
    const { request: messages, dropped } = toMessagesRequest(
      request([
        user('问'),
        signedReasoning('先想'),
        { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
        { type: 'function_call_output', call_id: 'c1', output: 'a.txt' },
        signedReasoning('再想'),
        assistant('答'),
        user('下一回合'),
      ]),
      provider(),
    );
    expect(dropped).toEqual([]);
    expect(messages.messages[1]?.content).toEqual([
      { type: 'thinking', thinking: '先想', signature: 'sig-先想' },
      { type: 'tool_use', id: 'c1', name: 'exec_command', input: { cmd: 'ls' } },
    ]);
    expect(messages.messages[3]?.content).toEqual([
      { type: 'thinking', thinking: '再想', signature: 'sig-再想' },
      { type: 'text', text: '答' },
    ]);
  });

  it('思考文本以 encrypted_content 里的为准（content 只剩空数组也能还原）；redacted_thinking 原样带回', () => {
    const omitted = signedReasoning('');
    omitted.content = [];
    const { request: messages } = toMessagesRequest(
      request([
        user('问'),
        omitted,
        {
          type: 'reasoning',
          summary: [],
          encrypted_content: encodeThinking({
            provider: 'claude',
            model: 'm',
            type: 'redacted_thinking',
            data: 'opaque',
          }),
        },
        assistant('答'),
        user('再问'),
      ]),
      provider(),
    );
    expect(messages.messages[1]?.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig-' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: '答' },
    ]);
  });

  it('没有签名、来自别的协议、别的 Provider 或模型：不发思考块', () => {
    const { request: messages, dropped } = toMessagesRequest(
      request([
        user('问'),
        signedReasoning('无签名', { signature: undefined }),
        { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'Chat 的' }] },
        { type: 'reasoning', summary: [], encrypted_content: 'wevir-gw:v1:5aW9' },
        signedReasoning('别的模型', { model: 'm2' }),
        signedReasoning('别的 Provider', { provider: 'other' }),
        assistant('答'),
        user('再问'),
      ]),
      provider(),
    );
    expect(messages.messages[1]?.content).toEqual([{ type: 'text', text: '答' }]);
    expect(dropped).toEqual([
      'reasoning:unsigned',
      'reasoning:unsigned',
      'reasoning:unsigned',
      'reasoning:other_model',
      'reasoning:other_model',
    ]);
  });

  it('推理之后没有输出就换了说话人（回合被中断）：丢掉，不挂到下一条 assistant', () => {
    const { request: messages, dropped } = toMessagesRequest(
      request([user('问'), signedReasoning('想到一半'), user('算了'), assistant('好'), user('嗯')]),
      provider(),
    );
    expect(messages.messages[1]?.content).toEqual([{ type: 'text', text: '好' }]);
    expect(dropped).toContain('reasoning:orphan');
  });

  it('encrypted_content 的编码可以还原，坏的不认', () => {
    const envelope = {
      provider: 'p',
      model: 'm',
      type: 'thinking' as const,
      thinking: '中文',
      signature: 's',
    };
    const encoded = encodeThinking(envelope);
    expect(encoded.startsWith(THINKING_ENVELOPE_PREFIX)).toBe(true);
    expect(decodeThinking(encoded)).toEqual(envelope);
    expect(decodeThinking(`${THINKING_ENVELOPE_PREFIX}!!!`)).toBeUndefined();
    expect(decodeThinking(null)).toBeUndefined();
    expect(
      decodeThinking(
        THINKING_ENVELOPE_PREFIX +
          Buffer.from('{"provider":"p","model":"m","type":"x"}').toString('base64'),
      ),
    ).toBeUndefined();
  });
});

describe('工具与工具结果', () => {
  it('namespace 与长名字的摊平与 Chat 相同；历史调用与工具定义得到同一个名字', () => {
    const long = 'mcp__some.server:with-a-very-long-name-that-goes-on-and-on-and-on';
    const { request: messages } = toMessagesRequest(
      request(
        [
          user('问'),
          { type: 'function_call', call_id: 'c1', name: long, arguments: '{}' },
          {
            type: 'function_call',
            call_id: 'c2',
            name: 'wait_agent',
            namespace: 'multi_agent_v1',
            arguments: '{}',
          },
          { type: 'function_call_output', call_id: 'c1', output: 'x' },
          { type: 'function_call_output', call_id: 'c2', output: 'y' },
        ],
        {
          tools: [
            { type: 'function', name: long, parameters: { type: 'object', properties: {} } },
            {
              type: 'namespace',
              name: 'multi_agent_v1',
              tools: [{ type: 'function', name: 'wait_agent' }],
            },
            { type: 'web_search' },
          ],
        },
      ),
      provider(),
    );
    const flat = flatToolName(long);
    expect(messages.tools?.map((t) => t.name)).toEqual([flat, 'multi_agent_v1__wait_agent']);
    expect(messages.tools?.[1]?.input_schema).toEqual({ type: 'object', properties: {} });
    expect(messages.messages[1]?.content.map((b) => b.name)).toEqual([
      flat,
      'multi_agent_v1__wait_agent',
    ]);
  });

  it('不合 Anthropic 规则的 call_id 换成确定性的哈希，调用与结果对得上', () => {
    const id = 'functions.exec_command:0';
    const { request: messages } = toMessagesRequest(
      request([
        user('问'),
        { type: 'function_call', call_id: id, name: 'exec_command', arguments: '{}' },
        { type: 'function_call_output', call_id: id, output: 'ok' },
      ]),
      provider(),
    );
    expect(toolUseId(id)).toMatch(/^toolu_wevir_[0-9a-f]{24}$/);
    expect(toolUseId(id)).toBe(toolUseId(id));
    expect(toolUseId('toolu_01AbC-x')).toBe('toolu_01AbC-x');
    expect(messages.messages[1]?.content[0]?.id).toBe(toolUseId(id));
    expect(messages.messages[2]?.content[0]?.tool_use_id).toBe(toolUseId(id));
  });

  it('参数不是 JSON 对象时用空对象并记下', () => {
    const { request: messages, dropped } = toMessagesRequest(
      request([
        user('问'),
        { type: 'function_call', call_id: 'c', name: 'exec_command', arguments: '{oops' },
        { type: 'function_call_output', call_id: 'c', output: 'x' },
      ]),
      provider(),
    );
    expect(messages.messages[1]?.content[0]?.input).toEqual({});
    expect(dropped).toContain('arguments:not_object');
  });

  it('工具输出带图片：文本与图片都放进 tool_result；空输出不带 content；之后的用户文本排在结果后面', () => {
    const { request: messages } = toMessagesRequest(
      request([
        user('看图'),
        { type: 'function_call', call_id: 'a', name: 'view_image', arguments: '{}' },
        { type: 'function_call', call_id: 'b', name: 'exec_command', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'a',
          output: [
            { type: 'input_text', text: '截图' },
            { type: 'input_image', image_url: 'https://img.example.com/a.png' },
          ],
        },
        user('顺便说一句'),
        { type: 'function_call_output', call_id: 'b', output: '' },
      ]),
      provider(),
    );
    expect(messages.messages[2]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'a',
        content: [
          { type: 'text', text: '截图' },
          { type: 'image', source: { type: 'url', url: 'https://img.example.com/a.png' } },
        ],
      },
      { type: 'tool_result', tool_use_id: 'b' },
      { type: 'text', text: '顺便说一句', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('tool_choice：required → any，指定函数 → tool（摊平后的名字），parallel_tool_calls=false → disable_parallel_tool_use', () => {
    const tools = [
      { type: 'function', name: 'exec_command' },
      { type: 'custom', name: 'apply_patch' },
    ];
    const choice = (tool_choice: unknown, parallel_tool_calls?: boolean) =>
      toMessagesRequest(
        request([user('x')], { tools, tool_choice, parallel_tool_calls }),
        provider(),
      ).request.tool_choice;
    expect(choice('none')).toEqual({ type: 'none' });
    expect(choice('required')).toEqual({ type: 'any' });
    expect(choice({ type: 'custom', name: 'apply_patch' })).toEqual({
      type: 'tool',
      name: 'apply_patch',
    });
    expect(choice('auto', false)).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(choice('required', false)).toEqual({ type: 'any', disable_parallel_tool_use: true });
    expect(choice('auto', true)).toBeUndefined();
  });
});

describe('输入项', () => {
  it('input 是字符串时当作一条 user 消息；空文本不发', () => {
    const { request: messages } = toMessagesRequest(request('hi'), provider());
    expect(messages.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
      },
    ]);
    const empty = toMessagesRequest(
      request([user('问'), assistant(''), user('')]),
      provider(),
    ).request;
    expect(roles(empty.messages)).toEqual(['user']);
  });

  it('图片：data URL 拆成 base64，网址用 url 来源；file_id 与非 base64 的 data URL 丢掉', () => {
    const { request: messages, dropped } = toMessagesRequest(
      request([
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/', detail: 'low' },
            { type: 'input_image', image_url: 'https://img.example.com/b.png' },
            { type: 'input_image', file_id: 'file_1' },
            { type: 'input_image', image_url: 'data:image/svg+xml,<svg/>' },
          ],
        },
      ]),
      provider(),
    );
    expect(messages.messages[0]?.content.map((b) => b.source)).toEqual([
      { type: 'base64', media_type: 'image/jpeg', data: '/9j/' },
      { type: 'url', url: 'https://img.example.com/b.png' },
    ]);
    expect(dropped).toEqual(['input_image:file_id', 'input_image:unsupported_url']);
  });

  it('不认识的输入项丢掉并记下', () => {
    const { dropped } = toMessagesRequest(
      request([user('x'), { type: 'web_search_call' }, { type: 'compaction' }]),
      provider(),
    );
    expect(dropped).toEqual(['web_search_call', 'compaction']);
  });
});

describe('请求参数', () => {
  it('max_tokens：max_output_tokens 优先，其次 Provider 里这个模型的 maxTokens，最后默认值', () => {
    const maxTokens = (extra: Partial<ResponsesRequest>, patch: Partial<GatewayProvider> = {}) =>
      toMessagesRequest(request('x', extra), provider(patch)).request.max_tokens;
    expect(maxTokens({ max_output_tokens: 16 })).toBe(16);
    expect(maxTokens({}, { models: [{ id: 'm', maxTokens: 8192 }] })).toBe(8192);
    expect(maxTokens({}, { models: [{ id: 'other', maxTokens: 8192 }] })).toBe(DEFAULT_MAX_TOKENS);
  });

  it('思考开关：claude- 模型默认 adaptive（有 summary 时 display: summarized），其余 enabled；thinkingFormat 可改', () => {
    const thinking = (
      model: string,
      reasoning: unknown,
      patch: Partial<GatewayProvider> = {},
      extra: Partial<ResponsesRequest> = {},
    ) => {
      const { request: r } = toMessagesRequest(
        request('x', { model, reasoning, ...extra }),
        provider(patch),
      );
      return { thinking: r.thinking, output_config: r.output_config };
    };
    expect(thinking('claude-opus-5-5', { effort: 'high', summary: 'auto' })).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    });
    expect(thinking('claude-opus-5-5', { effort: 'medium' })).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    });
    expect(thinking('deepseek-flash', { effort: 'low' })).toEqual({
      thinking: { type: 'enabled', budget_tokens: 4000 },
      output_config: { effort: 'low' },
    });
    expect(
      thinking('claude-sonnet-4-5', { effort: 'xhigh' }, { compat: { thinkingFormat: 'enabled' } }),
    ).toEqual({
      thinking: { type: 'enabled', budget_tokens: 31_999 },
      output_config: { effort: 'xhigh' },
    });
    expect(
      thinking('kimi', { effort: 'high' }, { compat: { thinkingFormat: 'adaptive' } }).thinking,
    ).toEqual({ type: 'adaptive' });
    // minimal 写成 low；none 关掉思考；没有档位不发。
    expect(thinking('m', { effort: 'minimal' }).output_config).toEqual({ effort: 'low' });
    expect(thinking('m', { effort: 'none' })).toEqual({
      thinking: { type: 'disabled' },
      output_config: undefined,
    });
    expect(thinking('m', { summary: 'auto' })).toEqual({
      thinking: undefined,
      output_config: undefined,
    });
    // budget_tokens 必须小于 max_tokens：不够 1025 时不开思考，只带档位。
    expect(thinking('m', { effort: 'high' }, {}, { max_output_tokens: 4000 }).thinking).toEqual({
      type: 'enabled',
      budget_tokens: 3999,
    });
    expect(thinking('m', { effort: 'high' }, {}, { max_output_tokens: 16 })).toEqual({
      thinking: undefined,
      output_config: { effort: 'high' },
    });
  });

  it('temperature、top_p 原样；text.format 的 json_schema → output_config.format', () => {
    const { request: r } = toMessagesRequest(
      request('x', {
        temperature: 0.2,
        top_p: 0.9,
        reasoning: { effort: 'low' },
        text: { format: { type: 'json_schema', name: 'out', schema: { type: 'object' } } },
      }),
      provider(),
    );
    expect(r).toMatchObject({
      temperature: 0.2,
      top_p: 0.9,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } },
    });
  });
});
