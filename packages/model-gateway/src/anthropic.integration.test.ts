// Anthropic 官方限制的 HTTP mock 验证；真实服务另跑 adapter-codex 的契约第 3 层。

import { afterEach, describe, expect, it } from 'vitest';
import { startModelGateway } from './gateway.js';
import { testProvider } from './provider-test.js';
import {
  codexProblems,
  codexRequest,
  doneItems,
  postResponses,
  readEvents,
} from './test-fixtures/codex.js';
import { startMockMessages } from './test-fixtures/mock-messages.js';
import type { GatewayProvider, MessagesRequest, ResponsesItem, ResponsesRequest } from './types.js';

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const provider = (baseURL: string, model: string): GatewayProvider => ({
  id: 'anthropic',
  kind: 'openai-compatible',
  displayName: 'Anthropic',
  api: 'anthropic-messages',
  baseURL,
  compat: { thinkingFormat: 'adaptive', systemMessageMode: 'inline' },
  models: [{ id: model, maxTokens: 128000 }],
  defaultModelId: model,
  apiKey: 'placeholder-anthropic-key',
});

const direct = (baseURL: string, body: MessagesRequest) =>
  fetch(`${baseURL}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('Anthropic 当前模型 Messages 往返', () => {
  it.each(MODELS)('%s：工具结果、中途指令与下一回合保留思考原文和前缀', async (model) => {
    let step = 0;
    const patch = '*** Begin Patch\n*** Add File: notes.md\n+# 笔记\n*** End Patch';
    const mock = await startMockMessages(() =>
      ++step === 1
        ? {
            reasoning: ['检查文件。'],
            toolCalls: [{ kind: 'custom', name: 'apply_patch', input: patch }],
          }
        : { reasoning: [`完成步骤 ${step}。`], text: ['完成。'] },
    );
    cleanups.push(() => mock.close());
    const gw = await startModelGateway();
    cleanups.push(() => gw.close());
    const p = provider(mock.baseURL, model);
    gw.setProviders([p]);
    const first: ResponsesRequest = {
      ...codexRequest('1-first-turn').body,
      model,
      tool_choice: model === 'claude-haiku-5-5' ? 'auto' : 'required',
      temperature: 0.2,
      top_p: 1,
    };
    const turn = async (body: ResponsesRequest) => {
      const response = await postResponses(gw.baseURL(p.id), gw.token, body);
      expect(response.status).toBe(200);
      const events = await readEvents(response);
      expect(codexProblems(events)).toEqual([]);
      expect(events.at(-1)?.type).toBe('response.completed');
      return doneItems(events) as ResponsesItem[];
    };
    const calls = await turn(first);
    expect(calls[1]).toMatchObject({ type: 'custom_tool_call', name: 'apply_patch', input: patch });
    const second: ResponsesRequest = {
      ...first,
      input: [
        ...(first.input as ResponsesItem[]),
        ...calls,
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: '权限已更新。' }],
        },
        { type: 'custom_tool_call_output', call_id: calls[1]?.call_id, output: 'Success.' },
      ],
    };
    const answer = await turn(second);
    await turn({
      ...first,
      input: [
        ...(second.input as ResponsesItem[]),
        ...answer,
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: '现在只作解释。' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '刚才做了什么？' }],
        },
      ],
    });
    expect(mock.requests.map((r) => r.body.messages.map((m) => m.role))).toEqual([
      ['user'],
      ['user', 'assistant', 'user', 'system'],
      ['user', 'assistant', 'user', 'system', 'assistant', 'user', 'system'],
    ]);
    const sent = mock.requests.map((r) => r.body);
    expect(sent[2]?.messages[1]).toEqual(sent[1]?.messages[1]);
    expect(sent[1]?.messages[1]?.content.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    for (const r of mock.requests) {
      expect(r.apiKey).toBe(p.apiKey);
      expect(r.authorization).toBeUndefined();
      expect(r.headers['anthropic-version']).toBe('2023-06-01');
      expect(r.headers).not.toHaveProperty('session-id');
      expect(r.body).not.toHaveProperty('temperature');
      expect(r.body).not.toHaveProperty('top_p');
      expect(r.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(r.body.tool_choice).toBeUndefined();
      expect(r.body.system).toEqual(sent[0]?.system);
      expect(r.body.tools).toEqual(sent[0]?.tools);
      expect(
        [...(r.body.system ?? []), ...r.body.messages.flatMap((m) => m.content)].filter(
          (b) => b.cache_control !== undefined,
        ),
      ).toHaveLength(2);
    }
    // 旧历史前缀被改动时 mock 必须拒绝，不能靠完整签名掩盖历史重写。
    for (const field of ['system', 'tools', 'messages'] as const) {
      const edited = structuredClone(sent[2]);
      if (edited === undefined) throw new Error('缺少第三步请求');
      if (field === 'system' && edited.system?.[0]) edited.system[0].text = '改写基础指令';
      if (field === 'tools' && edited.tools?.[0]) edited.tools[0].description = '改写工具';
      if (field === 'messages' && edited.messages[0]?.content[0])
        edited.messages[0].content[0].text = '改写历史';
      const rejected = await direct(mock.baseURL, edited);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({
        error: { message: expect.stringContaining('prefix has changed') },
      });
    }
  });

  it.each(MODELS)('%s：none 的小输出请求与 provider.test 都能通过限制校验', async (model) => {
    const mock = await startMockMessages(() => ({ text: ['pong'] }));
    cleanups.push(() => mock.close());
    const gw = await startModelGateway();
    cleanups.push(() => gw.close());
    const p = provider(mock.baseURL, model);
    gw.setProviders([p]);
    const response = await postResponses(gw.baseURL(p.id), gw.token, {
      model,
      input: 'ping',
      reasoning: { effort: 'none' },
      max_output_tokens: 16,
    });
    expect(response.status).toBe(200);
    expect((await readEvents(response)).at(-1)?.type).toBe('response.completed');
    expect(mock.requests[0]?.body.output_config?.effort).toBe('low');
    expect(await testProvider(p, model)).toMatchObject({ ok: true });
    expect(mock.requests[1]?.body.output_config?.effort).toBe(
      model === 'claude-opus-5-5' || model === 'claude-haiku-5-5' ? 'medium' : 'high',
    );
  });
});

describe('Messages mock 拒收官方不支持的请求', () => {
  it('Haiku adaptive 仍接受 forced choice；非法 system 位置、assistant 预填与第五个缓存断点返回 400', async () => {
    const mock = await startMockMessages(() => ({ text: ['ok'] }));
    cleanups.push(() => mock.close());
    const body: MessagesRequest = {
      model: 'claude-haiku-5-5',
      max_tokens: 4096,
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [{ name: 'exec_command', input_schema: { type: 'object' } }],
      thinking: { type: 'adaptive' },
      tool_choice: { type: 'any' },
    };
    const accepted = await direct(mock.baseURL, body);
    expect(accepted.status).toBe(200);
    await accepted.text();
    const cases: MessagesRequest[] = [
      {
        ...body,
        messages: [
          ...body.messages,
          { role: 'assistant', content: [{ type: 'text', text: 'prefill' }] },
        ],
      },
      {
        ...body,
        messages: [
          ...body.messages,
          { role: 'system', content: [{ type: 'text', text: 'instruction' }] },
          { role: 'user', content: [{ type: 'text', text: 'next' }] },
        ],
      },
      {
        ...body,
        system: Array.from({ length: 5 }, () => ({
          type: 'text',
          text: 'cached',
          cache_control: { type: 'ephemeral' },
        })),
      },
    ];
    for (const invalid of cases) {
      const response = await direct(mock.baseURL, invalid);
      expect(response.status).toBe(400);
      await response.text();
    }
  });

  it.each([
    { model: 'claude-opus-5-5', patch: { tool_choice: { type: 'any' } }, reason: 'forced' },
    {
      model: 'claude-sonnet-5-5',
      patch: { tool_choice: { type: 'tool', name: 'exec_command' } },
      reason: 'forced',
    },
    { model: 'claude-fable-5-1', patch: { tool_choice: { type: 'any' } }, reason: 'forced' },
    ...MODELS.map((model) => ({
      model,
      patch: { thinking: { type: 'enabled', budget_tokens: 1024 } },
      reason: 'enabled',
    })),
    ...['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'].map((model) => ({
      model,
      patch: { thinking: { type: 'disabled' } },
      reason: 'disabled',
    })),
    {
      model: 'claude-sonnet-5-5',
      patch: { thinking: { type: 'between_tools' }, output_config: { effort: 'xhigh' } },
      reason: 'high effort or below',
    },
    {
      model: 'claude-haiku-5-5',
      patch: { thinking: { type: 'disabled' }, output_config: { effort: 'max' } },
      reason: 'high effort or below',
    },
    { model: 'claude-opus-4-7', patch: { temperature: 0.2 }, reason: 'temperature' },
    { model: 'claude-haiku-5-5', patch: { top_p: 1 }, reason: 'top_p' },
    { model: 'claude-sonnet-5-5', patch: { temperature: 1, top_p: 0.99 }, reason: 'both' },
  ])('$model 拒收 $patch', async ({ model, patch, reason }) => {
    const mock = await startMockMessages(() => ({ text: ['ok'] }));
    cleanups.push(() => mock.close());
    const response = await direct(mock.baseURL, {
      model,
      max_tokens: 4096,
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      ...patch,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining(reason) },
    });
  });
});
