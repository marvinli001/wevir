// 用户接入的 MCP 服务的 elicitation（codex-event-mapping.md §6.11）：CodexAdapter 驱动 test-fixtures/fake-app-server.mjs，回放手写的
// `mcpServer/elicitation/request` 样本（表单与链接），核对上报的提问与审批、以及回给 app-server 的 `{action, content}`。不需要二进制。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_URL_ELICITATION_TOOL } from '@wevir/runtime-adapter';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  collectEvents,
  newAdapter,
  ofType,
  TempDirs,
  waitForEvent,
} from './test-fixtures/harness.js';
import { MOCK_MODEL, MOCK_UPSTREAM_KEY } from './test-fixtures/mock-model.js';

const FAKE_APP_SERVER = fileURLToPath(
  new URL('./test-fixtures/fake-app-server.mjs', import.meta.url),
);
const dirs = new TempDirs();
let adapters: CodexAdapter[] = [];
afterEach(async () => {
  await Promise.allSettled(adapters.map((adapter) => adapter.dispose()));
  adapters = [];
});
afterAll(() => dirs.cleanup());

function findFile(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    const found = entry.isDirectory() ? findFile(path, name) : undefined;
    if (found) return found;
  }
  return undefined;
}

async function start(sample: string) {
  const { home, workspace } = dirs.make(sample);
  const adapter = newAdapter({
    home,
    binary: process.execPath,
    binaryArgs: [FAKE_APP_SERVER],
    providers: [
      {
        id: 'mock',
        kind: 'openai-compatible',
        displayName: 'Wevir Mock',
        api: 'openai-responses',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
        defaultModelId: MOCK_MODEL,
        apiKey: MOCK_UPSTREAM_KEY,
      },
    ],
  });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
  });
  const events = collectEvents(adapter, engineSessionId);
  await adapter.send(engineSessionId, { content: [{ type: 'text', text: `replay:${sample}` }] });
  /** fake app-server 记下的回复（在它的 cwd，CODEX_HOME 下的某一层）。 */
  const replies = () =>
    readFileSync(findFile(home, 'fake-replies.jsonl') ?? '', 'utf8')
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row) as { method: string; result: unknown });
  return { adapter, engineSessionId, events, replies };
}

describe('表单 elicitation', () => {
  it('上报为提问，回答换成 {action: accept, content}', async () => {
    const { adapter, engineSessionId, events, replies } = await start('elicitation-form');
    const asked = await waitForEvent(events, ofType('question.requested'), 'question.requested');
    const tool = events.find(ofType('tool.started'));
    expect(asked.toolCallId).toBe(tool?.toolCallId);
    expect(asked.questions).toEqual([
      {
        id: 'title',
        header: 'Title',
        question: 'New ticket\n\nTitle',
        options: [],
        allowOther: true,
      },
      { id: 'priority', question: 'priority', options: [{ label: 'High' }, { label: 'Low' }] },
    ]);
    await adapter.respondToQuestion(engineSessionId, asked.requestId, {
      title: ['Broken login'],
      priority: ['High'],
    });
    await waitForEvent(events, ofType('turn.settled'), 'turn.settled');
    expect(replies()).toEqual([
      {
        method: 'mcpServer/elicitation/request',
        result: { action: 'accept', content: { title: 'Broken login', priority: 'p1' } },
      },
    ]);
  });

  it('全部跳过时回 decline', async () => {
    const { adapter, engineSessionId, events, replies } = await start('elicitation-form');
    const asked = await waitForEvent(events, ofType('question.requested'), 'question.requested');
    await adapter.respondToQuestion(engineSessionId, asked.requestId, {});
    await waitForEvent(events, ofType('turn.settled'), 'turn.settled');
    expect(replies()).toEqual([
      { method: 'mcpServer/elicitation/request', result: { action: 'decline', content: null } },
    ]);
  });
});

describe('链接 elicitation', () => {
  it.each([
    ['accept', 'completed'],
    ['decline', 'failed'],
  ] as const)('先报工具调用再审批；%s', async (optionId, status) => {
    const { adapter, engineSessionId, events, replies } = await start('elicitation-url');
    const approval = await waitForEvent(events, ofType('approval.requested'), 'approval.requested');
    const tool = events.find(
      (event) => event.type === 'tool.started' && event.toolCallId === approval.toolCallId,
    );
    expect(tool).toMatchObject({
      toolName: MCP_URL_ELICITATION_TOOL,
      display: {
        kind: 'fetch',
        url: 'https://tickets.example.com/authorize?state=abc',
        mcpServer: 'tickets',
      },
      input: { server: 'tickets', message: 'Authorize the ticket tracker' },
    });
    expect(approval.options.map((option) => option.kind)).toEqual([
      'allow_accept',
      'reject_decline',
    ]);
    await adapter.respondToApproval(engineSessionId, approval.requestId, { optionId });
    await waitForEvent(events, ofType('turn.settled'), 'turn.settled');
    expect(
      events.find(
        (event) => event.type === 'tool.finished' && event.toolCallId === approval.toolCallId,
      ),
    ).toMatchObject({ status });
    expect(replies()).toEqual([
      { method: 'mcpServer/elicitation/request', result: { action: optionId, content: null } },
    ]);
  });
});
