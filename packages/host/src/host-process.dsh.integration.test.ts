// T3.5 验收：真实的 Host 进程组装（startHost）+ 真实 dsh，客户端只走 Host API（WebSocket JSON-RPC）。
// - 建会话 → 对话 → 重启 Host（host.shutdown 的同一条退出路径，dsh 随适配器回收）→ 追问：send 前自动 resume，
//   追问能引用之前的内容；session.resumed 记下 dsh 版本；重启前后的历史与快照来自事件库，resume 不补引擎事件。
// - 两次启动之间清掉 DSH_HOME 里的会话日志：会话只读、原因明确，历史仍在。
// Provider 经 provider.upsert（带 Key）登记，Host 照常交给适配器（T3.4）：mock Provider 来自
// @wevir/adapter-dsh/testing，不需要 Key；设了 WEVIR_TEST_API_KEY 时用真实模型再跑第一个用例（默认 DeepSeek 官方，
// WEVIR_TEST_BASE_URL / WEVIR_TEST_MODEL 改走 OpenAI 兼容服务）。@wevir/adapter-dsh 只是本包的 devDependency。

import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DshAdapter } from '@wevir/adapter-dsh';
import { MOCK_MODEL, type MockRequest, startMockModel, textOf } from '@wevir/adapter-dsh/testing';
import type { SessionId, SessionSnapshot, WevirEvent } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningHost, startHost } from './host-process.js';
import { createLogger } from './logger.js';
import type { HostRuntimeInfo } from './runtime-file.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const REAL_KEY = process.env.WEVIR_TEST_API_KEY || undefined;
const TURN_TIMEOUT_MS = 120_000;

interface Connected {
  host: RunningHost;
  client: TestRpcClient;
}

/** 在数据目录上起 Host（引擎是真实 dsh）并完成 hello。 */
async function start(home: string): Promise<Connected> {
  const host = await startHost({
    home,
    // 旁路插件与恢复无关，关掉省去安装；Provider 由 provider.upsert 经 configureProviders 交给 dsh。
    adapter: new DshAdapter({ home, streamTap: false, logger: { warn: () => {} } }),
    engine: 'dsh',
    logger: createLogger({ level: 'error', mirror: () => {} }),
  });
  cleanups.push(() => host.shutdown());
  const info = JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as HostRuntimeInfo;
  const client = await TestRpcClient.connect(host.url);
  cleanups.push(() => client.ws.close());
  expect((await client.hello(info.token as string)).error).toBeUndefined();
  return { host, client };
}

/** 从头订阅一个会话，返回订阅 ID（之后用 `client.events(id)` 取事件）。 */
async function subscribe(client: TestRpcClient, sessionId: SessionId): Promise<string> {
  const { subscriptionId } = await client.request('events.subscribe', { sessionId, sinceSeq: 0 });
  return subscriptionId;
}

/** 发一条消息，等这个回合的 `turn.finished`，返回本回合的事件。 */
async function ask(
  { client }: Connected,
  sessionId: SessionId,
  subscriptionId: string,
  text: string,
): Promise<WevirEvent[]> {
  const { turnId, seq } = await client.request('session.send', {
    sessionId,
    content: [{ type: 'text', text }],
  });
  await client.until(
    () =>
      client
        .events(subscriptionId)
        .find((e) => e.type === 'turn.finished' && e.payload.turnId === turnId),
    'turn.finished',
    TURN_TIMEOUT_MS,
  );
  return client.events(subscriptionId).filter((e) => e.seq >= seq);
}

const replyOf = (events: WevirEvent[]) =>
  events.flatMap((e) => (e.type === 'assistant.message' ? [e.payload.text] : [])).join('');

const CODE = '青石桥-4721';
const TELL = `[wevir:RECALL] 我的暗号是 ${CODE}。记住它，只回复“好的”。`;
const ASK = '[wevir:RECALL] 我的暗号是什么？只回复暗号本身。';

/** mock 模型只看请求作答：告知暗号就回“好的”，追问时从请求里的历史消息找暗号。 */
async function mockProvider(): Promise<Record<string, unknown>> {
  const model = await startMockModel((request: MockRequest) => {
    const users = request.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
    const last = users.findLast((text) => text.includes('[wevir:RECALL]')) ?? '';
    if (last.includes('记住它')) return { text: ['好的'] };
    const told = users.map((text) => /我的暗号是 (\S+?)。/.exec(text)?.[1]).find(Boolean);
    return { text: [told ?? '不知道'] };
  });
  cleanups.push(() => model.close());
  return {
    id: 'wevir-test',
    kind: 'openai-compatible',
    displayName: 'Wevir Test',
    api: 'openai-completions',
    baseURL: model.baseURL,
    models: [{ id: MOCK_MODEL }],
    defaultModelId: MOCK_MODEL,
    apiKey: 'wevir-mock-key-not-a-secret',
  };
}

/** 真实模型的 provider.upsert 参数（Key 只进 SecretStore 与 dsh 的子进程环境）。 */
function realProvider(key: string): Record<string, unknown> {
  const baseURL = process.env.WEVIR_TEST_BASE_URL;
  const model = process.env.WEVIR_TEST_MODEL;
  if (baseURL === undefined) {
    return {
      id: 'deepseek-official',
      kind: 'deepseek-official',
      displayName: 'DeepSeek',
      models: [],
      defaultModelId: model ?? 'deepseek-v4-flash',
      apiKey: key,
    };
  }
  if (model === undefined) throw new Error('设了 WEVIR_TEST_BASE_URL 时要同时设 WEVIR_TEST_MODEL');
  return {
    id: 'wevir-real',
    kind: 'openai-compatible',
    displayName: 'Wevir Real',
    api: 'openai-completions',
    baseURL,
    models: [{ id: model }],
    defaultModelId: model,
    apiKey: key,
  };
}

/** 第一个 Host：登记工作区与 Provider，建会话，告知暗号，退出。 */
async function firstRun(provider: Record<string, unknown>) {
  const home = join(tempDir(), 'home');
  const workspace = join(tempDir(), 'workspace');
  mkdirSync(workspace);
  const first = await start(home);
  const { workspace: ws } = await first.client.request('workspace.add', { rootPath: workspace });
  await first.client.request('provider.upsert', provider);
  const { session } = await first.client.request('session.create', {
    workspaceId: ws.id,
    providerId: provider.id,
  });
  const id = session.id as SessionId;
  const subscription = await subscribe(first.client, id);
  const told = await ask(first, id, subscription, TELL);
  expect(told.find((e) => e.type === 'turn.finished')?.payload).toMatchObject({
    outcome: 'completed',
  });
  // turn.finished 之后还有一条 session.state_changed（running → idle）：按快照的 lastSeq 等它到了再取历史，
  // 否则机器忙时历史会少最后一条，重启后的回放与它对不上。
  const snapshot: SessionSnapshot = await first.client.request('session.get', { sessionId: id });
  await first.client.until(
    () =>
      first.client.events(subscription).at(-1)?.seq === snapshot.session.lastSeq ? true : undefined,
    'lastSeq',
  );
  const history = first.client.events(subscription);
  await first.host.shutdown();
  return { home, id, history, snapshot };
}

async function restartAndAsk(provider: Record<string, unknown>): Promise<string> {
  const { home, id, history, snapshot } = await firstRun(provider);
  const second = await start(home);
  // 恢复之前：快照与回放都来自事件库。
  const before: SessionSnapshot = await second.client.request('session.get', { sessionId: id });
  expect(before).toEqual(snapshot);
  expect(before.session).toMatchObject({ state: 'idle', title: TELL });
  const subscription = await subscribe(second.client, id);
  await second.client.until(
    () => (second.client.events(subscription).length >= history.length ? true : undefined),
    'replay',
  );
  expect(second.client.events(subscription)).toEqual(history);

  await ask(second, id, subscription, ASK);
  const asked = second.client.events(subscription).slice(history.length);
  // 自动 resume 只写 session.resumed（在 user.message 之前），引擎不回放任何历史事件。
  expect(asked.map((e) => e.type).slice(0, 3)).toEqual([
    'session.resumed',
    'user.message',
    'turn.started',
  ]);
  const version = asked[0]?.type === 'session.resumed' ? asked[0].payload.engineVersion : '';
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
  expect(history[0]?.type === 'session.created' && history[0].payload.engineVersion).toBe(version);
  const after: SessionSnapshot = await second.client.request('session.get', { sessionId: id });
  expect(after.session).toMatchObject({ state: 'idle', title: TELL });
  return replyOf(asked);
}

describe('Host 重启后恢复会话（startHost + 真实 dsh + mock Provider）', () => {
  it('建会话 → 对话 → 重启 Host → 追问：自动 resume，追问引用之前的内容', async () => {
    expect(await restartAndAsk(await mockProvider())).toBe(CODE);
  }, 60_000);

  it('两次启动之间 DSH_HOME 的会话日志被清掉：会话只读、原因明确，历史仍在', async () => {
    const { home, id, history } = await firstRun(await mockProvider());
    const sessions = join(realpathSync(home), 'engines', 'dsh', 'sessions');
    rmSync(sessions, { recursive: true, force: true });
    mkdirSync(sessions);

    const { client } = await start(home);
    const failed = await client.call('session.send', {
      sessionId: id,
      content: [{ type: 'text', text: ASK }],
    });
    expect(failed.error).toMatchObject({
      message: expect.stringContaining('session is not resumable'),
      data: { category: 'session_unavailable' },
    });
    const { session }: SessionSnapshot = await client.request('session.get', { sessionId: id });
    expect(session).toMatchObject({
      state: 'error',
      readOnly: {
        reason: 'engine_session_not_found',
        message: expect.stringContaining('session is not resumable'),
      },
    });
    const subscription = await subscribe(client, id);
    await client.until(
      () =>
        client.events(subscription).some((e) => e.type === 'session.read_only') ? true : undefined,
      'session.read_only',
    );
    expect(client.events(subscription).slice(0, history.length)).toEqual(history);
    expect(replyOf(history)).toBe('好的');
    const again = await client.call('session.send', {
      sessionId: id,
      content: [{ type: 'text', text: ASK }],
    });
    expect(again.error).toMatchObject({ data: { state: 'error', readOnly: session.readOnly } });
  }, 60_000);
});

describe.skipIf(REAL_KEY === undefined)('Host 重启后恢复会话（真实模型）', () => {
  it('建会话 → 对话 → 重启 Host → 追问能引用之前告知的暗号', async () => {
    expect(await restartAndAsk(realProvider(REAL_KEY as string))).toContain(CODE);
  }, 300_000);
});
