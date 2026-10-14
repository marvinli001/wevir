// 真实模型（可选）：设了 WEVIR_TEST_API_KEY 与 WEVIR_TEST_PROVIDER=deepseek（或 deepseek-official）时，
// 经网关对 DeepSeek 各跑一次 Responses 透传与 Chat 转换的最小对话，外加 testProvider；否则跳过并打印原因。
// 模型默认 deepseek-flash（codex-notes §7.3 实测两条路都能用），WEVIR_TEST_MODEL 可改。Key 只从环境变量读，不打印。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ModelGateway, startModelGateway } from './gateway.js';
import { codexProblems, doneItems, postResponses, readEvents } from './test-fixtures/codex.js';
import type { GatewayProvider } from './types.js';

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
];

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
});
