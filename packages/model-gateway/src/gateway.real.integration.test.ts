// 真实模型（可选）：设了 WEVIR_TEST_API_KEY 与 WEVIR_TEST_PROVIDER=deepseek（或 deepseek-official）时，
// 经网关对 DeepSeek 各跑一次 Responses 透传、Chat 转换与 Messages 转换（DeepSeek 的 Anthropic 端点）的最小对话，
// 外加 testProvider；Messages 另跑一次带工具调用与跨回合思考的对话。否则跳过并打印原因。
// 模型默认 deepseek-flash（codex-notes §7.3 实测前两条路都能用），WEVIR_TEST_MODEL 可改。Key 只从环境变量读，不打印。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ModelGateway, startModelGateway } from './gateway.js';
import { decodeThinking } from './messages/request.js';
import { codexProblems, doneItems, postResponses, readEvents } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';

const key = process.env.WEVIR_TEST_API_KEY || undefined;
const kind = process.env.WEVIR_TEST_PROVIDER || undefined;
const model = process.env.WEVIR_TEST_MODEL || 'deepseek-flash';
const skip =
  key === undefined || kind === undefined
    ? `没有设 ${[key === undefined && 'WEVIR_TEST_API_KEY', kind === undefined && 'WEVIR_TEST_PROVIDER'].filter(Boolean).join('、')}`
    : kind !== 'deepseek' && kind !== 'deepseek-official'
      ? `WEVIR_TEST_PROVIDER=${kind}：网关的真实模型测试只认 deepseek`
      : undefined;
if (skip !== undefined) console.log(`跳过网关的真实模型测试：${skip}`);

const providers: GatewayProvider[] = [
  {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [],
    defaultModelId: model,
    apiKey: key,
  },
  {
    id: 'deepseek-chat',
    kind: 'openai-compatible',
    displayName: 'DeepSeek（Chat）',
    api: 'openai-completions',
    baseURL: 'https://api.deepseek.com',
    models: [{ id: model }],
    defaultModelId: model,
    apiKey: key,
  },
  {
    id: 'deepseek-anthropic',
    kind: 'openai-compatible',
    displayName: 'DeepSeek（Anthropic Messages）',
    api: 'anthropic-messages',
    baseURL: 'https://api.deepseek.com/anthropic',
    models: [{ id: model }],
    defaultModelId: model,
    apiKey: key,
  },
];

const userMessage = (text: string): ResponsesItem => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});

describe.skipIf(skip !== undefined)('真实 DeepSeek 经网关', () => {
  let gw: ModelGateway;
  beforeAll(async () => {
    gw = await startModelGateway();
    gw.setProviders(providers);
  });
  afterAll(() => gw?.close());

  for (const provider of providers) {
    it(`${provider.id}：最小对话完成，事件能被 Codex 解析`, { timeout: 120_000 }, async () => {
      const res = await postResponses(gw.baseURL(provider.id), gw.token, {
        model,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '只回答一个数字：1+1 等于几？' }],
          },
        ],
        stream: true,
        store: false,
      });
      expect(res.status).toBe(200);
      const events = await readEvents(res);
      expect(codexProblems(events)).toEqual([]);
      expect(events.at(-1)?.type).toBe('response.completed');
      const text = doneItems(events)
        .filter((i) => i.type === 'message')
        .map((i) => JSON.stringify(i.content))
        .join('');
      expect(text).toContain('2');
    });

    it(`${provider.id}：testProvider 成功`, { timeout: 60_000 }, async () => {
      expect(await gw.testProvider(provider, model)).toMatchObject({ ok: true });
    });
  }

  it('deepseek-anthropic：工具调用与跨回合思考（思考块连同签名带回）', {
    timeout: 300_000,
  }, async () => {
    const code = 'WV-4271';
    const base: Omit<ResponsesRequest, 'input'> = {
      model,
      stream: true,
      store: false,
      reasoning: { effort: 'high', summary: 'auto' },
      tool_choice: 'auto',
      parallel_tool_calls: true,
      tools: [
        {
          type: 'function',
          name: 'read_note',
          description: 'Read the note with the given name and return its content.',
          strict: false,
          parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
        },
      ],
    };
    const turn = async (input: ResponsesItem[]) => {
      const res = await postResponses(gw.baseURL('deepseek-anthropic'), gw.token, {
        ...base,
        input,
      });
      expect(res.status).toBe(200);
      const events = await readEvents(res);
      expect(codexProblems(events)).toEqual([]);
      expect(events.at(-1)?.type).toBe('response.completed');
      return doneItems(events) as ResponsesItem[];
    };
    const signed = (items: ResponsesItem[]) =>
      items.filter((i) => i.type === 'reasoning' && decodeThinking(i.encrypted_content)?.signature)
        .length;

    const history: ResponsesItem[] = [
      userMessage('用 read_note 工具读取名为 deploy 的笔记，然后告诉我笔记里的编号。'),
    ];
    const first = await turn(history);
    const call = first.find((i) => i.type === 'function_call');
    expect(call?.name).toBe('read_note');
    history.push(...first, {
      type: 'function_call_output',
      call_id: call?.call_id,
      output: `deploy 笔记：发布编号 ${code}。`,
    });
    const answer = await turn(history);
    expect(JSON.stringify(answer)).toContain(code);
    history.push(...answer, userMessage('上一轮你查到的编号是多少？只回答编号。'));
    const recall = await turn(history);
    expect(JSON.stringify(recall.filter((i) => i.type === 'message'))).toContain(code);
    // 只打印数量：DeepSeek 是否给思考块签名决定了思考能不能带回（model-gateway.md §5.3）。
    console.log(
      `deepseek-anthropic：推理项 ${[...first, ...answer, ...recall].filter((i) => i.type === 'reasoning').length} 个，带签名 ${signed([...first, ...answer, ...recall])} 个`,
    );
  });
});
