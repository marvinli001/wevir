// 0.25.0：接力（host-api.md §3.1 `session.configure` 的 `providerId`，domain-model §3.14）。引擎是 `--adapter echo` 在
// WEVIR_ECHO_SUBSCRIPTIONS 下的组合：echo 管 API 类 Provider，另一个 echo 管订阅来源（Claude Agent 等），经 EngineRouter 合在
// 一起。echo 原样回显交给它的输入，所以从回复里能看到接力摘要随消息交给了新引擎。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WevirEvent } from '@wevir/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdapter } from './cli.js';
import { type RunningHost, startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const running: RunningHost[] = [];
const clients: TestRpcClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const host of running.splice(0)) await host.shutdown();
});

async function start() {
  const home = join(tempDir(), 'home');
  const logger = createLogger({ mirror: () => {} });
  const adapter = createAdapter('echo', { home, logger, env: { WEVIR_ECHO_SUBSCRIPTIONS: '1' } });
  const host = await startHost({ adapter, engine: 'echo', home, logger });
  running.push(host);
  const token = (
    JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
  ).token;
  const client = await TestRpcClient.connect(host.url);
  clients.push(client);
  const frame = await client.hello(token, undefined, {
    provider_kind_chatgpt: true,
    subscription_kinds: true,
  });
  expect(frame.error).toBeUndefined();
  // 订阅账号在后台读，已登录的 Claude 建好 Provider 之后才能接力过去。
  await vi.waitFor(async () => {
    const { providers } = await client.request('provider.list');
    expect((providers as { id: string }[]).map((provider) => provider.id)).toContain('claude');
  });
  await client.request('provider.upsert', {
    kind: 'openai-compatible',
    id: 'mock',
    displayName: 'Mock API',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [
      { id: 'mock-pro', displayName: 'Mock Pro' },
      { id: 'mock-mini', displayName: 'Mock Mini' },
    ],
    defaultModelId: 'mock-pro',
  });
  const workspace = (await client.request('workspace.add', { rootPath: tempDir() })).workspace;
  return { home, client, hello: frame.result, workspaceId: workspace.id as string };
}

/** 订阅一个会话，返回读到当前为止事件的函数。 */
async function watch(client: TestRpcClient, sessionId: string) {
  const { subscriptionId } = await client.request('events.subscribe', { sessionId, sinceSeq: 0 });
  return () => client.events(subscriptionId);
}

/** 发一条消息、等回合结束，返回这个回合的回答。 */
async function turn(
  client: TestRpcClient,
  events: () => WevirEvent[],
  sessionId: string,
  text: string,
): Promise<string> {
  const { turnId } = await client.request('session.send', {
    sessionId,
    content: [{ type: 'text', text }],
  });
  await client.until(
    () =>
      events().find((event) => event.type === 'turn.finished' && event.payload.turnId === turnId),
    `turn ${turnId}`,
  );
  return events()
    .flatMap((event) =>
      event.type === 'assistant.message' && event.payload.turnId === turnId
        ? [event.payload.text]
        : [],
    )
    .join('\n');
}

function handoffs(events: WevirEvent[]) {
  return events.flatMap((event) => (event.type === 'session.handoff' ? [event] : []));
}

describe('接力（0.25.0）', () => {
  it('hello 声明 session_handoff，engineFeatures 按 Provider 种类给出引擎', async () => {
    const { hello } = await start();
    expect(hello.features.session_handoff).toBe(true);
    expect(hello.engineFeatures['openai-compatible']).toMatchObject({ engine: 'echo' });
    expect(hello.engineFeatures.claude).toMatchObject({
      engine: 'echo-subscriptions',
      configure: true,
      permissionModes: ['on_request', 'auto_review', 'full_access'],
    });
    // 0.27.0：echo 的订阅引擎同真实的订阅引擎，不能代码审查。
    expect(hello.engineFeatures['openai-compatible'].commands).toEqual(['compact', 'review']);
    expect(hello.engineFeatures.claude.commands).toEqual(['compact']);
  });

  it('API 模型与 Claude 之间来回切：第一次给整段摘要，换回时只补错过的那段', async () => {
    const { client, workspaceId } = await start();
    const { session } = await client.request('session.create', {
      workspaceId,
      providerId: 'mock',
    });
    const sessionId = session.id as string;
    const events = await watch(client, sessionId);
    await turn(client, events, sessionId, '第一个问题：登录页为什么白屏');
    await turn(client, events, sessionId, '第二个问题：把修复写成测试');

    // ① API → Claude：新建 Claude 的引擎会话，整段对话的摘要。
    const switched = await client.request('session.configure', {
      sessionId,
      providerId: 'claude',
    });
    expect(switched.session).toMatchObject({ providerId: 'claude', modelId: 'claude-opus-5-5' });
    expect(switched.session.engines).toHaveLength(2);
    await client.until(() => handoffs(events())[0], 'first handoff');
    const h1 = handoffs(events())[0] as Extract<WevirEvent, { type: 'session.handoff' }>;
    expect(h1.payload).toMatchObject({
      from: { providerId: 'mock', modelId: 'mock-pro' },
      to: { providerId: 'claude', modelId: 'claude-opus-5-5' },
      resumed: false,
      strategy: 'full_thread_summary',
      covered: { fromSeq: 1 },
      omittedItems: 0,
    });
    expect(h1.payload.items).toBe(4);
    const context1 = h1.payload.context as string;
    expect(context1).toContain('Context handoff (full_thread_summary)');
    expect(context1).toContain('Mock API · Mock Pro');
    expect(context1).toContain('第一个问题：登录页为什么白屏');
    expect(context1).toContain('Echo: 第二个问题：把修复写成测试');
    // echo 的引擎没有挂读历史的工具，摘要里不提它。
    expect(context1).not.toContain('read_session_history');

    // 摘要随下一条消息的开头交给 Claude 的引擎；消息记录里只有用户写的。
    const answer1 = await turn(client, events, sessionId, '换到 Claude 接着做');
    expect(answer1).toContain('Context handoff (full_thread_summary)');
    expect(answer1).toContain('User message:\n换到 Claude 接着做');
    const lastUser = events().findLast((event) => event.type === 'user.message');
    expect(lastUser?.payload).toMatchObject({
      content: [{ type: 'text', text: '换到 Claude 接着做' }],
    });
    // 交出去之后不再带。
    const answer2 = await turn(client, events, sessionId, 'Claude 的第二句');
    expect(answer2).not.toContain('Context handoff');

    // ② Claude → API：恢复原来的引擎会话，只补它错过的那段（从接力那条开始）。
    const back = await client.request('session.configure', {
      sessionId,
      providerId: 'mock',
      modelId: 'mock-mini',
    });
    expect(back.session).toMatchObject({ providerId: 'mock', modelId: 'mock-mini' });
    await client.until(() => handoffs(events())[1], 'second handoff');
    const h2 = handoffs(events())[1] as Extract<WevirEvent, { type: 'session.handoff' }>;
    expect(h2.payload).toMatchObject({
      from: { providerId: 'claude' },
      to: {
        providerId: 'mock',
        modelId: 'mock-mini',
        engineSessionId: h1.payload.from.engineSessionId,
      },
      resumed: true,
      strategy: 'delta_since_target_last_seen',
    });
    expect(h2.payload.covered?.fromSeq).toBeGreaterThan(1);
    expect(h2.payload.covered?.fromSeq).toBeLessThanOrEqual(h1.seq);
    const context2 = h2.payload.context as string;
    expect(context2).toContain('Context handoff (delta_since_target_last_seen)');
    expect(context2).toContain('Model switch: Mock API · Mock Pro → Claude Agent');
    expect(context2).toContain('换到 Claude 接着做');
    expect(context2).toContain('Claude 的第二句');
    // 原来的引擎看过的不再补。
    expect(context2).not.toContain('第一个问题');
    // 用户消息那一条只有用户写的，交给 Claude 的摘要不算在里面（echo 的回答把它回显了，那是回答的内容）。
    expect(context2).toMatch(
      /\[user; user_message; item=e\d+; turn=trn_\w+\]\n换到 Claude 接着做\n/,
    );
    const answer3 = await turn(client, events, sessionId, '回到 API 了');
    expect(answer3).toContain('Context handoff (delta_since_target_last_seen)');

    // ③ 再切到 Claude：接着用它的引擎会话，只补 API 那一段。
    await client.request('session.configure', { sessionId, providerId: 'claude' });
    await client.until(() => handoffs(events())[2], 'third handoff');
    const h3 = handoffs(events())[2] as Extract<WevirEvent, { type: 'session.handoff' }>;
    expect(h3.payload).toMatchObject({
      resumed: true,
      strategy: 'delta_since_target_last_seen',
      to: { providerId: 'claude', engineSessionId: h1.payload.to.engineSessionId },
    });
    const context3 = h3.payload.context as string;
    expect(context3).toContain('回到 API 了');
    expect(context3).not.toContain('Claude 的第二句');

    // Claude 看到的到它最后一个回合结束为止。
    const claudeSeen = events().findLast(
      (event) => event.type === 'turn.finished' && event.seq < h2.seq,
    )?.seq;
    const { session: final } = await client.request('session.get', { sessionId });
    expect(final.engines).toEqual([
      expect.objectContaining({ providerId: 'mock', modelId: 'mock-mini' }),
      expect.objectContaining({ providerId: 'claude', seenSeq: claudeSeen }),
    ]);
    expect(final.engine.sessionId).toBe(h1.payload.to.engineSessionId);
  });

  it('换回去时对方什么都没错过：不带摘要；同一来源里照常 session.configured', async () => {
    const { client, workspaceId } = await start();
    const { session } = await client.request('session.create', {
      workspaceId,
      providerId: 'mock',
    });
    const sessionId = session.id as string;
    const events = await watch(client, sessionId);
    await turn(client, events, sessionId, 'hello');
    await client.request('session.configure', { sessionId, providerId: 'claude' });
    await client.request('session.configure', { sessionId, providerId: 'mock' });
    await client.until(() => handoffs(events())[1], 'second handoff');
    const back = handoffs(events())[1] as Extract<WevirEvent, { type: 'session.handoff' }>;
    expect(back.payload).toMatchObject({ resumed: true, items: 1, omittedItems: 0 });
    // 只有一条“换了模型”的记录：Claude 什么都没做。
    expect(back.payload.context).toContain('Model switch');

    await client.request('session.configure', { sessionId, modelId: 'mock-mini' });
    await client.until(
      () => events().find((event) => event.type === 'session.configured'),
      'configured',
    );
    expect(handoffs(events())).toHaveLength(2);
  });

  it('回合进行中不能接力；不认识的 Provider、不在列表里的模型被拒绝', async () => {
    const { client, workspaceId } = await start();
    const { session } = await client.request('session.create', {
      workspaceId,
      providerId: 'mock',
    });
    const sessionId = session.id as string;
    const events = await watch(client, sessionId);
    await client.request('session.send', {
      sessionId,
      content: [{ type: 'text', text: 'slow 慢慢回答' }],
    });
    const busy = await client.call('session.configure', { sessionId, providerId: 'claude' });
    expect(busy.error?.data).toMatchObject({ state: 'running' });
    await client.until(
      () => events().find((event) => event.type === 'turn.finished'),
      'turn finished',
    );

    const missing = await client.call('session.configure', { sessionId, providerId: 'nope' });
    expect(missing.error?.message).toContain('nope');
    const badModel = await client.call('session.configure', {
      sessionId,
      providerId: 'claude',
      modelId: 'gpt-9',
    });
    const issues = (badModel.error?.data as { issues?: { path: string[] }[] } | undefined)?.issues;
    expect(issues?.[0]?.path).toEqual(['modelId']);
    expect(handoffs(events())).toHaveLength(0);
  });
});
