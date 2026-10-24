// Codex 的工具搜索（默认对网关 Provider 打开）：真实 Host + 真实 codex-app-server + 假模型，三种上游协议各一次。首个请求不带按需的
// wevir 工具，只带 `tool_search` 与网关加的 `call_tool`；模型搜到 `wevir_models` 再经 `call_tool` 调它，Codex 照常执行、事件里
// 是真正的工具名。基线（baseline.codex.integration.test.ts）里有同一个任务的开 / 关对比。

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexRuntime, resolveCodexBinary } from '@wevir/adapter-codex';
import { type MockScript, startMockModel } from '@wevir/adapter-codex/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import {
  chatCatalog,
  FAKE_SEARCH_PROMPT,
  fakeAgent,
  messagesCatalog,
  responsesCatalog,
  startChatRecorder,
  startMessagesRecorder,
} from './test-fixtures/baseline.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const temp = useTempDir();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
let binary: string | undefined;
try {
  binary = resolveCodexBinary();
} catch {
  console.warn('[tool search + codex] 跳过：运行 bash scripts/fetch-codex.sh 下载锁定 app-server');
}

/** Responses 上的假模型：同 fakeAgent，工具全名还原成命名空间与名字。 */
const script: MockScript = (view) => {
  const tools = responsesCatalog(view.body as unknown as Record<string, unknown>).names;
  const step = fakeAgent({ prompt: view.lastUserText, outputs: view.toolOutputs, tools });
  if ('text' in step) return { text: [step.text] };
  for (const tool of view.body.tools ?? []) {
    const prefix = `${tool.name}__`;
    if (tool.type === 'namespace' && step.call.startsWith(prefix)) {
      return {
        toolCalls: [
          {
            kind: 'function',
            namespace: tool.name as string,
            name: step.call.slice(prefix.length),
            args: step.args,
          },
        ],
      };
    }
  }
  return { toolCalls: [{ kind: 'function', name: step.call, args: step.args }] };
};

const withTools = (requests: readonly { body: unknown }[]) =>
  requests.filter((request) => {
    const tools = (request.body as { tools?: unknown[] }).tools;
    return Array.isArray(tools) && tools.length > 0;
  });

describe.skipIf(!binary || process.platform === 'win32')(
  'Codex 的工具搜索（Host + 真实 Codex + 假模型）',
  { timeout: 180_000 },
  () => {
    it('三种上游协议：首个请求只有常驻工具与 tool_search，搜到后经 call_tool 调按需的工具', async () => {
      const mock = await startMockModel(script);
      const chat = await startChatRecorder(fakeAgent);
      const messages = await startMessagesRecorder(fakeAgent);
      cleanups.push(() => Promise.all([mock.close(), chat.close(), messages.close()]));
      const home = join(temp(), 'home');
      const userHome = join(temp(), 'user');
      mkdirSync(userHome);
      const logger = createLogger({ level: 'error', mirror: () => {} });
      const adapter = new CodexRuntime({
        home,
        binary,
        parentEnv: { ...process.env, HOME: userHome },
        logger,
      });
      const host = await startHost({
        home,
        pluginUserHome: userHome,
        adapter,
        engine: 'codex',
        logger,
      });
      cleanups.push(() => host.shutdown());
      const client = await TestRpcClient.connect(host.url);
      cleanups.push(() => client.ws.terminate());
      const info = JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8'));
      await client.hello(info.token);
      const upstreams = [
        {
          api: 'openai-responses',
          baseURL: mock.baseURL,
          recorder: mock,
          catalog: responsesCatalog,
        },
        { api: 'openai-completions', baseURL: chat.baseURL, recorder: chat, catalog: chatCatalog },
        {
          api: 'anthropic-messages',
          baseURL: messages.baseURL,
          recorder: messages,
          catalog: messagesCatalog,
        },
      ] as const;
      for (const { api, baseURL, recorder, catalog } of upstreams) {
        const model = `search-${api}`;
        await client.request('provider.upsert', {
          id: api,
          kind: 'openai-compatible',
          displayName: api,
          api,
          baseURL,
          models: [{ id: model, contextWindow: 128_000 }],
          defaultModelId: model,
          apiKey: 'tool-search-not-a-secret',
        });
        const { session } = await client.request('session.create', {
          providerId: api,
          permissionMode: 'full_access',
        });
        const { subscriptionId } = await client.request('events.subscribe', {
          sessionId: session.id,
          sinceSeq: 0,
        });
        const before = recorder.requests.length;
        const { turnId } = await client.request('session.send', {
          sessionId: session.id,
          content: [{ type: 'text', text: FAKE_SEARCH_PROMPT }],
        });
        const events = () => client.events(subscriptionId);
        await client.until(
          () =>
            events().find(
              (event) => event.type === 'turn.finished' && event.payload.turnId === turnId,
            ),
          `${api} turn.finished`,
          60_000,
        );
        const agent = withTools(recorder.requests.slice(before));
        const first = catalog(agent[0]?.body as Record<string, unknown>).names;
        expect(first, api).toContain('tool_search');
        expect(first, api).toContain('call_tool');
        expect(first, api).toContain('mcp__wevir__wevir_session_list');
        expect(
          first.some((name) => name.startsWith('mcp__wevir_more')),
          api,
        ).toBe(false);
        // 搜索、调用、回答各一个请求。
        expect(agent, api).toHaveLength(3);
        const started = events().flatMap((event) =>
          event.type === 'tool.started' && event.payload.turnId === turnId
            ? [event.payload.toolName]
            : [],
        );
        expect(started, api).toContain('mcp__wevir_more__wevir_models');
        const answer = events().findLast(
          (event) => event.type === 'assistant.message' && event.payload.turnId === turnId,
        );
        expect(answer?.type === 'assistant.message' && answer.payload.text, api).toBe('listed');
      }
    });
  },
);
