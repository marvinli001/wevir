import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  collectEvents,
  newAdapter,
  ofType,
  runTurn,
  TempDirs,
  waitForEvent,
} from './test-fixtures/harness.js';
import { MOCK_MODEL, MOCK_UPSTREAM_KEY } from './test-fixtures/mock-model.js';

const dirs = new TempDirs();
const adapters: CodexAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
  dirs.cleanup();
});
function setup(extra: Partial<Parameters<typeof newAdapter>[0]> = {}) {
  const { home, workspace } = dirs.make('session-cache');
  const adapter = newAdapter({
    home,
    binary: process.execPath,
    binaryArgs: [fileURLToPath(new URL('./test-fixtures/fake-app-server.mjs', import.meta.url))],
    providers: [
      {
        id: 'mock',
        kind: 'openai-compatible',
        displayName: 'Mock',
        api: 'openai-responses',
        baseURL: 'http://127.0.0.1:9/v1',
        apiKey: MOCK_UPSTREAM_KEY,
        models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
        defaultModelId: MOCK_MODEL,
      },
    ],
    ...extra,
  });
  adapters.push(adapter);
  return { adapter, config: { cwd: workspace, providerId: 'mock', modelId: MOCK_MODEL } };
}

it('closed records are bounded and an evicted thread can resume', async () => {
  const { adapter, config } = setup();
  const first = await adapter.createSession(config);
  const events = collectEvents(adapter, first.engineSessionId);
  await runTurn(adapter, first.engineSessionId, 'replay:stream', events);
  await adapter.close(first.engineSessionId);
  for (let i = 0; i < 40; i += 1) {
    const next = await adapter.createSession(config);
    await adapter.close(next.engineSessionId);
  }
  expect(adapter.sessionCount).toBe(32);
  expect(await adapter.resumeSession(first.engineSessionId, config)).toMatchObject(first);
});

it('retains more than 100 unknown child threads and usage records until adoption', async () => {
  const childId = '11111111-1111-4111-8111-111111111111';
  const observed = vi.fn();
  const { adapter, config } = setup({
    binaryArgs: [
      fileURLToPath(new URL('./test-fixtures/fake-app-server.mjs', import.meta.url)),
      '--child-id',
      childId,
    ],
    gateway: {
      onRequest: observed,
      fetch: async () =>
        new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    },
  });
  const root = await adapter.createSession(config);
  const gateway = adapter.gateway;
  if (!gateway) throw new Error('no gateway');
  for (let i = 0; i < 221; i += 1) {
    const response = await fetch(`${gateway.baseURL('mock')}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MOCK_MODEL,
        input: [],
        client_metadata: {
          thread_id: i < 101 ? `unknown-${i}` : childId,
          'x-codex-turn-metadata': JSON.stringify({
            agent_name: '/root/child',
            parent_thread_id: root.engineSessionId,
          }),
        },
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
  }
  await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(221));
  const parent = collectEvents(adapter, root.engineSessionId);
  await adapter.send(root.engineSessionId, {
    content: [{ type: 'text', text: 'replay:subagent' }],
  });
  const started = await waitForEvent(parent, ofType('subagent.started'), 'child');
  expect(started.childEngineSessionId).toBe(childId);
  const child = collectEvents(adapter, childId);
  await waitForEvent(child, ofType('turn.settled'), 'child ended');
  expect(child.filter(ofType('usage.recorded'))).toHaveLength(120);
});
