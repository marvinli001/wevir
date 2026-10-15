// 支线会话（0.17.0，U23.1，domain-model §3.12）：session.fork 从顶层会话分出支线，echo 引擎的支线回复带 (side)。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-10-15T00:00:00.000Z';
const context = { client: identity, capabilities: {} };
const managers: SessionManager[] = [];
let harnesses = 0;
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

function setup(adapter = new EchoAdapter({ stepDelayMs: 0 })) {
  harnesses += 1;
  const root = join(realpathSync(tempDir()), `h${harnesses}`);
  mkdirSync(root);
  const dataDir = join(root, 'data');
  const storage = storages.open(dataDir);
  const workspaceDir = join(root, 'ws');
  mkdirSync(workspaceDir);
  storage.workspaces.insert({
    id: 'ws_1',
    rootPath: workspaceDir,
    displayName: 'ws',
    createdAt: T0,
    updatedAt: T0,
  });
  storage.providers.insert({
    id: 'mock',
    kind: 'openai-compatible',
    displayName: 'Mock',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'm' }],
    defaultModelId: 'm',
    createdAt: T0,
    updatedAt: T0,
  });
  const errors: unknown[] = [];
  const events = new EventStore({ storage, deltaWindowMs: 5, onError: (e) => errors.push(e) });
  const manager = new SessionManager({ storage, events, adapter, onError: (e) => errors.push(e) });
  managers.push(manager);
  const methods = createHostMethods({
    storage,
    events,
    sessions: manager,
    secrets: new FileSecretStore(dataDir),
  });
  const create = async () =>
    (
      await manager.create({
        workspaceId: 'ws_1',
        providerId: 'mock',
        permissionMode: 'full_access',
        reasoningEffort: 'high',
      })
    ).id;
  const send = (sessionId: SessionId, text: string) =>
    manager.send({ sessionId, content: [{ type: 'text', text }] }, identity);
  const state = (sessionId: SessionId) => events.snapshot(sessionId)?.session.state;
  const settle = (sessionId: SessionId) =>
    vi.waitFor(() => expect(state(sessionId)).toBe('idle'), { timeout: 5000 });
  const all = (sessionId: SessionId): WevirEvent[] => events.readSince(sessionId, 0);
  const answer = (sessionId: SessionId) => {
    const last = all(sessionId).findLast((e) => e.type === 'assistant.message');
    return last?.type === 'assistant.message' ? last.payload.text : undefined;
  };
  return { storage, events, manager, methods, adapter, errors, create, send, settle, all, answer };
}

describe('session.fork', () => {
  it('分出支线：沿用模型、档位与权限模式，带 forkedFrom 与 side；不进 session.list；回复在支线里，主会话不受影响', async () => {
    const h = setup();
    const main = await h.create();
    await h.send(main, 'hello');
    await h.settle(main);
    const finished = h.all(main).find((e) => e.type === 'turn.finished');
    const turnId = finished?.type === 'turn.finished' ? finished.payload.turnId : undefined;

    const { session: side } = await h.methods['session.fork'](
      { sessionId: main, side: true },
      context,
    );
    expect(side).toMatchObject({
      workspaceId: 'ws_1',
      providerId: 'mock',
      modelId: 'm',
      reasoningEffort: 'high',
      permissionMode: 'full_access',
      state: 'idle',
      forkedFrom: { sessionId: main, turnId },
      side: true,
      lastSeq: 1,
    });
    expect(h.all(side.id)[0]).toMatchObject({
      type: 'session.created',
      payload: { forkedFrom: { sessionId: main, turnId }, side: true },
    });
    const listed = await h.methods['session.list']({}, context);
    expect(listed.sessions.map((s) => s.id)).toEqual([main]);
    expect(h.events.snapshot(side.id)?.session.side).toBe(true);

    await h.send(side.id, 'btw what is this');
    await h.settle(side.id);
    expect(h.answer(side.id)).toBe('Echo (side): btw what is this');
    expect(h.all(main).filter((e) => e.type === 'turn.finished')).toHaveLength(1);

    // 支线不能再分；关掉照常。
    await expect(
      h.methods['session.fork']({ sessionId: side.id, side: true }, context),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await h.manager.close(side.id);
    expect(h.events.snapshot(side.id)?.session.state).toBe('closed');
    expect(h.errors).toEqual([]);
  });

  it('主会话回合进行中也能分：forkedFrom 是最近一个结束的回合', async () => {
    const h = setup(new EchoAdapter({ stepDelayMs: 5 }));
    const main = await h.create();
    await h.send(main, 'first');
    await h.settle(main);
    const first = h.all(main).find((e) => e.type === 'turn.finished');
    await h.send(main, 'slow second');
    expect(h.events.snapshot(main)?.session.state).toBe('running');
    const side = await h.manager.fork({ sessionId: main, side: true });
    expect(side.forkedFrom?.turnId).toBe(first?.type === 'turn.finished' && first.payload.turnId);
    await h.settle(main);
  });

  it('还没有结束的回合、会话已关闭、子会话或引擎不能分支时 INVALID_STATE；会话不在时 SESSION_NOT_FOUND', async () => {
    const h = setup();
    const main = await h.create();
    await expect(h.manager.fork({ sessionId: main, side: true })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await h.send(main, 'subagent hi');
    await h.settle(main);
    const child = h.events.snapshot(main)?.subagents?.[0]?.sessionId;
    expect(child).toBeDefined();
    await expect(
      h.manager.fork({ sessionId: child as SessionId, side: true }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      h.manager.fork({ sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPZZ', side: true }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await h.manager.close(main);
    await expect(h.manager.fork({ sessionId: main, side: true })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });

    const plain = new EchoAdapter({ stepDelayMs: 0 });
    Object.defineProperty(plain, 'fork', { value: undefined });
    const g = setup(plain);
    const other = await g.create();
    await g.send(other, 'hello');
    await g.settle(other);
    await expect(g.manager.fork({ sessionId: other, side: true })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
});
