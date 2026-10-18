import { describe, expect, it } from 'vitest';
import { CODEX_SAMPLES, codexRequest } from '../test-fixtures/codex.js';
import type { ChatMessage, GatewayProvider, ResponsesRequest } from '../types.js';
import {
  decodeReasoning,
  encodeGeminiSignatures,
  encodeReasoning,
  SKIP_THOUGHT_SIGNATURE,
  SYSTEM_AS_USER_NOTE,
  TOOL_IMAGE_NOTE,
  toChatRequest,
} from './request.js';

const provider = (patch: Partial<GatewayProvider> = {}): GatewayProvider => ({
  id: 'chat',
  kind: 'openai-compatible',
  displayName: 'Chat',
  api: 'openai-completions',
  baseURL: 'https://chat.example.com/v1',
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
const roles = (messages: ChatMessage[]) => messages.map((m) => m.role);

describe('Chat 的 toolChoice 开关（录制请求）', () => {
  it.each([
    'required',
    { type: 'function', name: 'exec_command' },
    { type: 'custom', name: 'apply_patch' },
  ])('auto_only 的 %j 改 auto，默认值保持原有选择', (tool_choice) => {
    const body = { ...codexRequest('1-first-turn').body, tool_choice };
    const fixed = toChatRequest(body, provider({ compat: { toolChoice: 'auto_only' } })).request;
    const original = toChatRequest(body, provider()).request;
    expect(fixed.tool_choice).toBe('auto');
    expect(original.tool_choice).not.toBe('auto');
    expect(fixed.tools).toEqual(original.tools);
  });

  it('none 只去掉 tool_choice、保留工具；没有可用工具时不补 auto', () => {
    const body = { ...codexRequest('1-first-turn').body, tool_choice: 'none' };
    const fixed = toChatRequest(body, provider({ compat: { toolChoice: 'auto_only' } })).request;
    expect(fixed).not.toHaveProperty('tool_choice');
    expect(fixed.tools).toEqual(toChatRequest(body, provider()).request.tools);
    expect(
      toChatRequest(body, provider({ compat: { toolChoice: 'any' } })).request.tool_choice,
    ).toBe('none');
    expect(
      toChatRequest(
        codexRequest('4-compact').body,
        provider({ compat: { toolChoice: 'auto_only' } }),
      ).request,
    ).not.toHaveProperty('tool_choice');
  });
});

describe('录制的 Codex 请求 → Chat 请求', () => {
  for (const name of CODEX_SAMPLES) {
    it(`${name} 的转换结果与快照一致`, async () => {
      const { request: chat, dropped } = toChatRequest(codexRequest(name).body, provider());
      await expect(`${JSON.stringify({ request: chat, dropped }, null, 2)}\n`).toMatchFileSnapshot(
        `../__snapshots__/codex-requests/${name}.chat.json`,
      );
    });
  }

  it('第一回合：developer → system，工具全部摊平成函数，Responses 专有字段丢掉', () => {
    const { request: chat, dropped } = toChatRequest(codexRequest('1-first-turn').body, provider());
    expect(roles(chat.messages)).toEqual(['system', 'system', 'user', 'user']);
    expect(chat.tools?.map((t) => t.function.name)).toEqual([
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
    const applyPatch = chat.tools?.find((t) => t.function.name === 'apply_patch');
    expect(applyPatch?.function.parameters).toMatchObject({ required: ['input'] });
    expect(applyPatch?.function.description).toContain('begin_patch');
    expect(chat.tool_choice).toBe('auto');
    expect(chat.reasoning_effort).toBe('high');
    expect(chat.stream).toBe(true);
    expect(chat.stream_options).toEqual({ include_usage: true });
    for (const field of [
      'client_metadata',
      'prompt_cache_key',
      'store',
      'include',
      'parallel_tool_calls',
    ]) {
      expect(dropped).toContain(`field:${field}`);
      expect(chat).not.toHaveProperty(field);
    }
    expect(JSON.stringify(chat)).not.toContain('x-codex-installation-id');
  });

  it('带工具结果的请求：推理挂到 assistant，两个工具调用合成一条，输出是 tool 消息', () => {
    const { request: chat, dropped } = toChatRequest(
      codexRequest('2-tool-results').body,
      provider(),
    );
    expect(roles(chat.messages)).toEqual([
      'system',
      'system',
      'user',
      'user',
      'assistant',
      'tool',
      'tool',
    ]);
    const assistant = chat.messages[4];
    expect(assistant?.reasoning_content).toBe('先建文件，再看目录。');
    expect(assistant?.content).toBeNull();
    expect(assistant?.tool_calls?.map((c) => [c.id, c.function.name])).toEqual([
      ['call_1', 'apply_patch'],
      ['call_2', 'exec_command'],
    ]);
    expect(JSON.parse(assistant?.tool_calls?.[0]?.function.arguments ?? '')).toEqual({
      input: '*** Begin Patch\n*** Add File: notes.md\n+# 笔记\n*** End Patch',
    });
    expect(chat.messages[5]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(chat.messages[5]?.content).toContain('Success. Updated the following files');
    expect(chat.messages[6]).toMatchObject({ role: 'tool', tool_call_id: 'call_2' });
    expect(dropped.filter((d) => !d.startsWith('field:'))).toEqual([]);
  });

  it('跨回合：上一回合的推理仍回传；对话中间的 developer 消息原位转 system；图片转 image_url', () => {
    const { request: chat } = toChatRequest(codexRequest('3-next-turn').body, provider());
    expect(roles(chat.messages)).toEqual([
      'system',
      'system',
      'user',
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
      'system',
      'user',
    ]);
    expect(chat.messages[7]).toMatchObject({
      role: 'assistant',
      content: '已新建 notes.md。',
      reasoning_content: '文件建好了。',
    });
    expect(String(chat.messages[8]?.content)).toContain('<permissions instructions>');
    const parts = chat.messages[9]?.content;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts).toEqual([
      { type: 'text', text: '[rec-2] 这张图里是什么？' },
      {
        type: 'image_url',
        image_url: { url: expect.stringMatching(/^data:image\/png;base64,/), detail: 'high' },
      },
    ]);
  });

  it('压缩请求：tools 为空时不发 tools 与 tool_choice', () => {
    const { request: chat } = toChatRequest(codexRequest('4-compact').body, provider());
    expect(chat).not.toHaveProperty('tools');
    expect(chat).not.toHaveProperty('tool_choice');
    expect(chat.messages.at(-1)?.role).toBe('user');
  });
});

describe('对话中间的 developer 消息（compat.systemMessageMode）', () => {
  const body = codexRequest('3-next-turn').body;

  it('merge：全部并进开头的一条 system，之后没有 system', () => {
    const { request: chat } = toChatRequest(
      body,
      provider({ compat: { systemMessageMode: 'merge' } }),
    );
    expect(roles(chat.messages).filter((r) => r === 'system')).toHaveLength(1);
    expect(chat.messages[0]?.role).toBe('system');
    const text = String(chat.messages[0]?.content);
    expect(text.indexOf('<BASE_INSTRUCTIONS')).toBeLessThan(text.indexOf('<skills_instructions>'));
    expect(text.indexOf('<skills_instructions>')).toBeLessThan(
      text.lastIndexOf('<permissions instructions>'),
    );
  });

  it('user：开头连续的并成一条 system，之后的转成注明来源的 user', () => {
    const { request: chat } = toChatRequest(
      body,
      provider({ compat: { systemMessageMode: 'user' } }),
    );
    expect(roles(chat.messages)).toEqual([
      'system',
      'user',
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
      'user',
      'user',
    ]);
    expect(String(chat.messages[0]?.content)).toContain('<skills_instructions>');
    const converted = String(chat.messages[7]?.content);
    expect(converted.startsWith(`${SYSTEM_AS_USER_NOTE}\n<permissions instructions>`)).toBe(true);
  });

  it('inline 且 supportsDeveloperRole：developer 保持 developer 角色', () => {
    const { request: chat } = toChatRequest(
      request([developer('d'), user('u')], { instructions: 'i' }),
      provider({ compat: { supportsDeveloperRole: true } }),
    );
    expect(chat.messages).toEqual([
      { role: 'system', content: 'i' },
      { role: 'developer', content: 'd' },
      { role: 'user', content: 'u' },
    ]);
  });
});

describe('MCP 服务的说明', () => {
  const namespace = (name: string, description: string | undefined) => ({
    type: 'namespace',
    name,
    ...(description === undefined ? {} : { description }),
    tools: [{ type: 'function', name: 'ping', parameters: { type: 'object' } }],
  });

  it('命名空间工具的说明（Codex 放 MCP 服务的 instructions 的地方）接在 system 消息后面，不随摊平丢掉', () => {
    const { request: chat } = toChatRequest(
      request([user('u')], {
        instructions: 'base',
        tools: [
          namespace('mcp__wevir__', 'Use wevir_process_start for dev servers.'),
          namespace('mcp__other__', 'Tools in the mcp__other__ namespace.'),
          namespace('mcp__empty__', ' \n '),
          namespace('multi_agent_v1', 'Tools for spawning and managing sub-agents.'),
        ],
      }),
      provider(),
    );
    const system = chat.messages[0]?.content as string;
    expect(chat.messages[0]?.role).toBe('system');
    expect(system.startsWith('base\n\n# Instructions from MCP servers')).toBe(true);
    expect(system).toContain('## mcp__wevir__\nUse wevir_process_start for dev servers.');
    // 默认句、空白、Codex 自带的命名空间都不加。
    expect(system).not.toContain('mcp__other__');
    expect(system).not.toContain('mcp__empty__');
    expect(system).not.toContain('sub-agents');
  });

  it('没有 instructions 时说明自己成为第一条 system 消息；没有说明时请求不变', () => {
    const withNotes = toChatRequest(
      request([user('u')], { tools: [namespace('mcp__a__', 'Note A.')] }),
      provider(),
    ).request;
    expect(withNotes.messages[0]).toMatchObject({ role: 'system' });
    expect(withNotes.messages[0]?.content).toContain('Note A.');
    const plain = toChatRequest(
      request([user('u')], { tools: [namespace('mcp__a__', undefined)] }),
      provider(),
    ).request;
    expect(roles(plain.messages)).toEqual(['user']);
  });
});

describe('工具名', () => {
  it('namespace 摊平后超过 64 个字符或含非法字符：改成截断加哈希，历史调用与工具定义得到同一个名字', () => {
    const namespace = 'mcp__a_really_long_server_name_for_testing.example';
    const name = 'list_all_the_things_in_the_workspace';
    const { request: chat, names } = toChatRequest(
      request(
        [
          user('u'),
          { type: 'function_call', call_id: 'c1', name, namespace, arguments: '{}' },
          { type: 'function_call_output', call_id: 'c1', output: 'ok' },
        ],
        {
          tools: [
            {
              type: 'namespace',
              name: namespace,
              tools: [{ type: 'function', name, parameters: { type: 'object' } }],
            },
          ],
        },
      ),
      provider(),
    );
    const flat = chat.tools?.[0]?.function.name ?? '';
    expect(flat).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(flat.startsWith('mcp__a_really_long_server_name_for_testing_example__')).toBe(true);
    expect(chat.messages[1]?.tool_calls?.[0]?.function.name).toBe(flat);
    expect(names.origin(flat)).toEqual({ kind: 'function', name, namespace });
  });

  it('摊平后撞名的两个工具得到不同的名字', () => {
    const { request: chat, names } = toChatRequest(
      request([user('u')], {
        tools: [
          { type: 'function', name: 'a__b' },
          { type: 'namespace', name: 'a', tools: [{ type: 'function', name: 'b' }] },
        ],
      }),
      provider(),
    );
    const [first, second] = chat.tools?.map((t) => t.function.name) ?? [];
    expect(first).toBe('a__b');
    expect(second).not.toBe('a__b');
    expect(names.origin(second ?? '')).toEqual({ kind: 'function', name: 'b', namespace: 'a' });
  });

  it('托管工具丢掉；tool_choice 指定的函数按摊平后的名字发', () => {
    const { request: chat, dropped } = toChatRequest(
      request([user('u')], {
        tools: [
          { type: 'web_search' },
          { type: 'custom', name: 'apply_patch', format: { type: 'text' } },
        ],
        tool_choice: { type: 'custom', name: 'apply_patch' },
      }),
      provider(),
    );
    expect(dropped).toContain('tool:web_search');
    expect(chat.tools?.map((t) => t.function.name)).toEqual(['apply_patch']);
    expect(chat.tools?.[0]?.function.description).toBe(
      'Put the raw tool input in the `input` string.',
    );
    expect(chat.tool_choice).toEqual({ type: 'function', function: { name: 'apply_patch' } });
  });
});

describe('输入项', () => {
  it('input 是字符串时当作一条 user 消息', () => {
    expect(toChatRequest(request('hi'), provider()).request.messages).toEqual([
      { role: 'user', content: 'hi' },
    ]);
  });

  it('图片：detail 保留，file_id 引用的图片没法转，丢掉', () => {
    const { request: chat, dropped } = toChatRequest(
      request([
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '看图' },
            { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'low' },
            { type: 'input_image', file_id: 'file_1' },
          ],
        },
      ]),
      provider(),
    );
    expect(chat.messages[0]?.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'low' } },
    ]);
    expect(dropped).toContain('input_image:file_id');
  });

  it('工具输出带图片（view_image）：tool 消息只放文本，图片在这批 tool 消息之后补一条 user', () => {
    const { request: chat } = toChatRequest(
      request([
        user('u'),
        { type: 'function_call', call_id: 'a', name: 'view_image', arguments: '{}' },
        { type: 'function_call', call_id: 'b', name: 'exec_command', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'a',
          output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
        },
        {
          type: 'function_call_output',
          call_id: 'b',
          output: [{ type: 'input_text', text: 'done' }],
        },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '看完了' }] },
      ]),
      provider(),
    );
    expect(roles(chat.messages)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'assistant',
    ]);
    expect(chat.messages[2]).toEqual({ role: 'tool', tool_call_id: 'a', content: TOOL_IMAGE_NOTE });
    expect(chat.messages[3]).toEqual({ role: 'tool', tool_call_id: 'b', content: 'done' });
    expect(chat.messages[4]?.content).toEqual([
      { type: 'text', text: TOOL_IMAGE_NOTE },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('推理之后没有输出就换了说话人（回合被中断）：推理丢掉，不挂到下一条 assistant', () => {
    const { request: chat, dropped } = toChatRequest(
      request([
        user('u1'),
        { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: '想到一半' }] },
        user('u2'),
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
      ]),
      provider(),
    );
    expect(chat.messages[2]).toEqual({ role: 'assistant', content: 'a' });
    expect(dropped).toContain('reasoning:orphan');
  });

  it('推理只剩网关写的 encrypted_content 时解出来', () => {
    const { request: chat } = toChatRequest(
      request([
        user('u'),
        { type: 'reasoning', summary: [], encrypted_content: encodeReasoning('密文里的推理') },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
      ]),
      provider(),
    );
    expect(chat.messages[1]?.reasoning_content).toBe('密文里的推理');
    expect(decodeReasoning({ type: 'reasoning', encrypted_content: 'gAAAA-openai' })).toBe('');
  });

  it('DeepSeek 的地址（或 compat 打开）：没有推理的 assistant 也带空的 reasoning_content', () => {
    const body = request([
      user('u'),
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
    ]);
    const deepseek = toChatRequest(body, provider({ baseURL: 'https://api.deepseek.com' })).request;
    expect(deepseek.messages[1]).toEqual({
      role: 'assistant',
      content: 'a',
      reasoning_content: '',
    });
    const other = toChatRequest(body, provider()).request;
    expect(other.messages[1]).toEqual({ role: 'assistant', content: 'a' });
    const forced = toChatRequest(
      body,
      provider({ compat: { requiresReasoningContentOnAssistantMessages: true } }),
    ).request;
    expect(forced.messages[1]?.reasoning_content).toBe('');
  });

  it('不认识的输入项丢掉并记下', () => {
    const { dropped } = toChatRequest(
      request([
        user('u'),
        { type: 'web_search_call', id: 'ws' },
        { type: 'compaction', encrypted_content: 'x' },
      ]),
      provider(),
    );
    expect(dropped).toEqual(expect.arrayContaining(['web_search_call', 'compaction']));
  });
});

describe('请求参数', () => {
  it('max_output_tokens 按 compat.maxTokensField 写；默认 max_tokens，OpenAI 官方是 max_completion_tokens', () => {
    const body = request('hi', { max_output_tokens: 16 });
    expect(toChatRequest(body, provider()).request.max_tokens).toBe(16);
    expect(
      toChatRequest(body, provider({ baseURL: 'https://api.openai.com/v1' })).request
        .max_completion_tokens,
    ).toBe(16);
    expect(
      toChatRequest(body, provider({ compat: { maxTokensField: 'max_completion_tokens' } })).request
        .max_completion_tokens,
    ).toBe(16);
  });

  it('reasoning.effort → reasoning_effort；none 不发', () => {
    expect(
      toChatRequest(request('hi', { reasoning: { effort: 'low' } }), provider()).request
        .reasoning_effort,
    ).toBe('low');
    expect(
      toChatRequest(request('hi', { reasoning: { effort: 'none' } }), provider()).request,
    ).not.toHaveProperty('reasoning_effort');
  });

  it('text.format 的 json_schema → response_format', () => {
    const { request: chat } = toChatRequest(
      request('hi', {
        text: {
          format: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true },
        },
      }),
      provider(),
    );
    expect(chat.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'out', schema: { type: 'object' }, strict: true },
    });
  });
});

describe('Gemini 的 thought signature（model-gateway.md §4.5）', () => {
  const gemini = provider({
    id: 'gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  });
  const call = (callId: string, name = 'exec_command') => ({
    type: 'function_call',
    call_id: callId,
    name,
    arguments: '{}',
  });
  const output = (callId: string) => ({
    type: 'function_call_output',
    call_id: callId,
    output: 'ok',
  });
  const envelope = (signatures: Record<string, string>, model = 'm', id = 'gemini') => ({
    type: 'reasoning',
    id: 'rs_x',
    summary: [],
    encrypted_content: encodeGeminiSignatures({ provider: id, model, signatures }),
  });
  const toolCalls = (messages: ChatMessage[]) =>
    messages.filter((m) => m.tool_calls !== undefined).map((m) => m.tool_calls ?? []);

  it('信封里的签名挂回同一个调用；并行调用只有带签名的那个有；不加 reasoning_content', () => {
    const { request: chat, signatures } = toChatRequest(
      request([
        user('看看目录'),
        envelope({ c1: 'sig-1' }),
        call('c1'),
        call('c2'),
        output('c1'),
        output('c2'),
      ]),
      gemini,
    );
    expect(signatures).toEqual({ provider: 'gemini', model: 'm' });
    const [first] = toolCalls(chat.messages);
    expect(first?.[0]?.extra_content).toEqual({ google: { thought_signature: 'sig-1' } });
    expect(first?.[1]).not.toHaveProperty('extra_content');
    expect(roles(chat.messages)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(chat.messages.slice(2).map((m) => m.tool_call_id)).toEqual(['c1', 'c2']);
    expect(chat.messages.some((m) => 'reasoning_content' in m)).toBe(false);
  });

  it('同一回合多步各带自己的签名，同批结果（含图片）连续排放', () => {
    const { request: chat } = toChatRequest(
      request([
        user('检查两个文件再修改'),
        envelope({ c1: 'step-1' }),
        call('c1'),
        call('c2'),
        {
          ...output('c2'),
          output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
        },
        output('c1'),
        envelope({ c3: 'step-2' }),
        call('c3'),
        output('c3'),
      ]),
      gemini,
    );
    expect(roles(chat.messages)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'assistant',
      'tool',
    ]);
    expect(chat.messages.slice(2, 4).map((m) => m.tool_call_id)).toEqual(['c2', 'c1']);
    expect(toolCalls(chat.messages).map((step) => step.map((c) => c.extra_content))).toEqual([
      [{ google: { thought_signature: 'step-1' } }, undefined],
      [{ google: { thought_signature: 'step-2' } }],
    ]);
  });

  it('缺签名的一步（没有信封、别的模型或 Provider 的信封）给第一个调用填占位值', () => {
    const { request: chat, dropped } = toChatRequest(
      request([
        user('a'),
        call('c1'),
        output('c1'),
        envelope({ c2: 'sig-2' }, 'other-model'),
        call('c2'),
        output('c2'),
        envelope({ c3: 'sig-3' }, 'm', 'other-provider'),
        call('c3'),
        call('c4'),
        output('c3'),
        output('c4'),
      ]),
      gemini,
    );
    const steps = toolCalls(chat.messages);
    expect(steps.map((step) => step.map((c) => c.extra_content))).toEqual([
      [{ google: { thought_signature: SKIP_THOUGHT_SIGNATURE } }],
      [{ google: { thought_signature: SKIP_THOUGHT_SIGNATURE } }],
      [{ google: { thought_signature: SKIP_THOUGHT_SIGNATURE } }, undefined],
    ]);
    expect(dropped.filter((d) => d === 'reasoning:foreign_signature')).toHaveLength(2);
  });

  it('别的上游不处理信封与签名', () => {
    const { request: chat, signatures } = toChatRequest(
      request([user('a'), envelope({ c1: 'sig' }), call('c1'), output('c1')]),
      provider(),
    );
    expect(signatures).toBeUndefined();
    expect(toolCalls(chat.messages)[0]?.[0]).not.toHaveProperty('extra_content');
  });
});

describe('Gemini 工具 Schema 的可选清洗', () => {
  const gemini = provider({ baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' });

  it('默认与显式 false 都不清洗，录制请求不被修改；true 对代理同样生效', () => {
    for (const name of CODEX_SAMPLES) {
      const body = codexRequest(name).body;
      const before = structuredClone(body);
      const original = toChatRequest(body, gemini).request;
      expect(
        toChatRequest(body, { ...gemini, compat: { geminiToolSchema: false } }).request,
      ).toEqual(original);
      const cleaned = toChatRequest(body, {
        ...gemini,
        compat: { geminiToolSchema: true },
      }).request;
      const proxy = toChatRequest(body, provider({ compat: { geminiToolSchema: true } })).request;
      expect(cleaned.tools).toEqual(proxy.tools);
      expect(body).toEqual(before);
      for (const tool of cleaned.tools ?? []) {
        expect(JSON.stringify(tool.function.parameters)).not.toContain('"additionalProperties":');
      }
    }
    const patch = toChatRequest(codexRequest('1-first-turn').body, gemini).request.tools?.find(
      (t) => t.function.name === 'apply_patch',
    );
    expect(patch?.function.parameters).toHaveProperty('additionalProperties', false);
  });

  it('只清洗 Schema 结构，保留同名业务属性与 enum / default；空对象补可省略参数', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        additionalProperties: { type: 'string' },
        empty: { type: 'object', properties: {}, required: [], additionalProperties: true },
        list: { type: 'array', items: { anyOf: [{ type: 'object' }, { type: 'null' }] } },
        literal: { default: { additionalProperties: false }, enum: [{ properties: {} }] },
      },
      $defs: { empty: { type: 'object', additionalProperties: { type: 'string' } } },
      required: ['additionalProperties', 'list'],
    };
    const body = request('hi', {
      tools: [
        { type: 'function', name: 'f', parameters: schema },
        { type: 'function', name: 'no_args' },
      ],
      text: { format: { type: 'json_schema', schema } },
    });
    const { request: chat } = toChatRequest(body, provider({ compat: { geminiToolSchema: true } }));
    const placeholder = {
      _wevir_unused: { type: 'boolean', description: 'Unused parameter; omit it.' },
    };
    expect(chat.tools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: {
        additionalProperties: { type: 'string' },
        empty: { type: 'object', properties: placeholder, required: [] },
        list: {
          type: 'array',
          items: { anyOf: [{ type: 'object', properties: placeholder }, { type: 'null' }] },
        },
        literal: schema.properties.literal,
      },
      $defs: { empty: { type: 'object', properties: placeholder } },
      required: schema.required,
    });
    expect(chat.tools?.[1]?.function.parameters).toEqual({
      type: 'object',
      properties: placeholder,
    });
    expect(chat.response_format).toMatchObject({ json_schema: { schema } });
    expect(schema).toHaveProperty('additionalProperties', false);
  });
});
