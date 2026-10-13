// T3.5 验收：Host（SessionManager + 事件库）+ 真实 dsh 的会话恢复。
// - 建会话 → 对话 → 重启 Host（释放 SessionManager 与适配器、关库；dsh 随之退出）→ 新 Host 启动对账 → 追问：
//   send 前自动 resume，追问能引用之前的内容；session.resumed 记下 dsh 版本；界面历史与标题来自事件库，
//   resume 不补任何引擎事件。mock Provider 不需要 Key；设了 WEVIR_TEST_API_KEY 时用真实模型再跑一遍。
// - 引擎会话丢失：两次启动之间清掉 DSH_HOME 里的会话日志，会话只读、原因明确，历史仍在。
// Host 只在测试里依赖本包（devDependencies）：@wevir/host 自己不依赖 adapter-dsh。

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, SessionManager } from '@wevir/host';
import type { ClientIdentity, SessionId, WevirEvent } from '@wevir/protocol';
import { openStorage, type Storage } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DshAdapter } from './dsh-adapter.js';
import { DSH_VERSION } from './paths.js';
import {
  MOCK_KEY,
  MOCK_KEY_ENV,
  MOCK_MODEL,
  type MockRequest,
  startMockModel,
  textOf,
  writeMockOverlay,
} from './test-fixtures/mock-model.js';
import { type ModelSetup, REAL_KEY, realModelSetup } from './test-fixtures/real-model.js';

const T0 = '2026-10-13T00:00:00.000Z';
const cli: ClientIdentity = { deviceId: 'dev-it', clientId: 'cli-it', clientKind: 'cli' };

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `wevir-host-resume-it-${label}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Host {
  storage: Storage;
  events: EventStore;
  adapter: DshAdapter;
  manager: SessionManager;
  errors: unknown[];
  stop(): Promise<void>;
}

/** 在数据目录上起一个 Host（不含 RPC 服务）；首次启动时登记工作区与 Provider。 */
function startHost(home: string, workspace: string, setup: ModelSetup): Host {
  const storage = openStorage({ dataDir: home });
  if (!storage.workspaces.get('ws_1')) {
    storage.workspaces.insert({
      id: 'ws_1',
      rootPath: workspace,
      displayName: 'workspace',
      createdAt: T0,
      updatedAt: T0,
    });
    storage.providers.insert({
      id: setup.providerId,
      kind: setup.providerId === 'deepseek-official' ? 'deepseek-official' : 'openai-compatible',
      displayName: setup.providerId,
      models: [{ id: setup.modelId }],
      defaultModelId: setup.modelId,
      createdAt: T0,
      updatedAt: T0,
    });
  }
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  const events = new EventStore({ storage, onError });
  // Provider 由 setup 的 overlay 交给 dsh（T3.4 的 configureProviders 在这里用不上 Key 之外的东西）。
  const adapter = new DshAdapter({
    home,
    patches: setup.patches,
    env: setup.env,
    streamTap: false,
    logger: { warn: () => {} },
  });
  const manager = new SessionManager({ storage, events, adapter, onError });
  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= (async () => {
      await manager.shutdown();
      await adapter.dispose();
      events.close();
      storage.close();
    })();
    return stopped;
  };
  cleanups.push(stop);
  return { storage, events, adapter, manager, errors, stop };
}

const all = (host: Host, id: SessionId): WevirEvent[] => host.events.readSince(id, 0);

/** 发一条消息，等回合结束，返回本回合写下的事件。 */
async function ask(host: Host, id: SessionId, text: string): Promise<WevirEvent[]> {
  const { seq } = await host.manager.send(
    { sessionId: id, content: [{ type: 'text', text }] },
    cli,
  );
  await vi.waitFor(
    () => {
      const finished = host.events.readSince(id, seq).some((e) => e.type === 'turn.finished');
      expect(finished).toBe(true);
    },
    { timeout: 120_000, interval: 50 },
  );
  return host.events.readSince(id, seq - 1);
}

const replyOf = (events: WevirEvent[]) =>
  events.flatMap((e) => (e.type === 'assistant.message' ? [e.payload.text] : [])).join('');

const CODE = '青石桥-4721';
const TELL = `[wevir:RECALL] 我的暗号是 ${CODE}。记住它，只回复“好的”。`;
const ASK = '[wevir:RECALL] 我的暗号是什么？只回复暗号本身。';

async function mockSetup(): Promise<ModelSetup> {
  const model = await startMockModel((request: MockRequest) => {
    const users = request.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
    const last = users.findLast((text) => text.includes('[wevir:RECALL]')) ?? '';
    if (last.includes('记住它')) return { text: ['好的'] };
    const told = users.map((text) => /我的暗号是 (\S+?)。/.exec(text)?.[1]).find(Boolean);
    return { text: [told ?? '不知道'] };
  });
  cleanups.push(() => model.close());
  return {
    patches: [writeMockOverlay(tempDir('overlay'), model.baseURL)],
    env: { [MOCK_KEY_ENV]: MOCK_KEY },
    providerId: 'wevir-test',
    modelId: MOCK_MODEL,
  };
}

/** 第一个 Host：建会话、告知暗号、退出。 */
async function firstRun(setup: ModelSetup) {
  const home = tempDir('home');
  const workspace = tempDir('ws');
  const first = startHost(home, workspace, setup);
  const session = await first.manager.create({ workspaceId: 'ws_1', providerId: setup.providerId });
  const told = await ask(first, session.id, TELL);
  expect(told.find((e) => e.type === 'turn.finished')?.payload).toMatchObject({
    outcome: 'completed',
  });
  const history = all(first, session.id);
  await first.stop();
  expect(first.errors).toEqual([]);
  return { home, workspace, id: session.id, history };
}

async function restartAndAsk(setup: ModelSetup): Promise<string> {
  const { home, workspace, id, history } = await firstRun(setup);
  const second = startHost(home, workspace, setup);
  expect(second.manager.recover()).toEqual({
    expiredApprovals: 0,
    interruptedSessions: [],
    unknownSends: 0,
  });
  // 恢复之前：历史与标题都来自事件库。
  expect(all(second, id)).toEqual(history);
  const before = second.events.snapshot(id)?.session;
  expect(before).toMatchObject({ state: 'idle', title: TELL.slice(0, 50) });

  const asked = await ask(second, id, ASK);
  const types = all(second, id)
    .slice(history.length)
    .map((e) => e.type);
  // 自动 resume 只写 session.resumed，引擎不回放任何历史事件。
  expect(types.slice(0, 3)).toEqual(['session.resumed', 'user.message', 'turn.started']);
  expect(all(second, id).find((e) => e.type === 'session.resumed')?.payload).toEqual({
    engineVersion: DSH_VERSION,
  });
  expect(all(second, id).find((e) => e.type === 'session.created')?.payload).toMatchObject({
    engineVersion: DSH_VERSION,
  });
  expect(second.events.snapshot(id)?.session).toMatchObject({
    state: 'idle',
    title: before?.title,
  });
  expect(second.errors).toEqual([]);
  return replyOf(asked);
}

describe('Host 重启后恢复会话（真实 dsh + mock Provider）', () => {
  it('建会话 → 对话 → 重启 Host → 追问：自动 resume，追问引用之前的内容', async () => {
    expect(await restartAndAsk(await mockSetup())).toBe(CODE);
  }, 60_000);

  it('两次启动之间 DSH_HOME 的会话日志被清掉：会话只读、原因明确，历史仍在', async () => {
    const setup = await mockSetup();
    const { home, workspace, id, history } = await firstRun(setup);
    rmSync(join(home, 'engines', 'dsh', 'sessions'), { recursive: true, force: true });
    mkdirSync(join(home, 'engines', 'dsh', 'sessions'));

    const second = startHost(home, workspace, setup);
    second.manager.recover();
    await expect(
      second.manager.send({ sessionId: id, content: [{ type: 'text', text: ASK }] }, cli),
    ).rejects.toMatchObject({ code: 'ENGINE_ERROR', data: { category: 'session_unavailable' } });
    const session = second.events.snapshot(id)?.session;
    expect(session).toMatchObject({
      state: 'error',
      readOnly: {
        reason: 'engine_session_not_found',
        message: expect.stringContaining('session is not resumable'),
      },
    });
    expect(all(second, id).slice(0, history.length)).toEqual(history);
    expect(replyOf(history)).toBe('好的');
    await expect(
      second.manager.send({ sessionId: id, content: [{ type: 'text', text: ASK }] }, cli),
    ).rejects.toMatchObject({ code: 'INVALID_STATE', data: { readOnly: session?.readOnly } });
    expect(second.errors).toEqual([]);
  }, 60_000);
});

describe.skipIf(REAL_KEY === undefined)('Host 重启后恢复会话（真实模型）', () => {
  it('建会话 → 对话 → 重启 Host → 追问能引用之前告知的暗号', async () => {
    const answer = await restartAndAsk(realModelSetup(tempDir('overlay'), REAL_KEY as string));
    expect(answer).toContain(CODE);
  }, 300_000);
});
