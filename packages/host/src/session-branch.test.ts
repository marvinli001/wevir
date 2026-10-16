// 分支到新会话与撤回最后一个回合（0.38.0，domain-model §3.18）：session.fork 不带 side 分出带历史的顶层会话，session.rewind 撤回
// 最后一个回合。echo 引擎的 `recall` 关键词写出它记得的之前每个回合的输入。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, TurnId, WevirEvent } from '@wevir/protocol';
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

/** 会话里每个完成的回合的 ID，按先后。 */
function turnIds(events: readonly WevirEvent[]): TurnId[] {
  return events.flatMap((e) => (e.type === 'turn.finished' ? [e.payload.turnId] : []));
}

/** 消息记录里的用户输入与回答（按事件顺序）。 */
function transcript(events: readonly WevirEvent[]): string[] {
  return events.flatMap((e) => {
    if (e.type === 'user.message') {
      return e.payload.content.flatMap((part) => (part.type === 'text' ? [`> ${part.text}`] : []));
    }
    return e.type === 'assistant.message' ? [e.payload.text] : [];
  });
}

describe('session.fork 分支（0.38.0）', () => {
  it('从中间的回合分：顶层会话，标题与设置沿用，带到那个回合为止的消息记录，引擎只记得那些回合；原会话不受影响', async () => {
    const h = setup();
    const main = await h.create();
    for (const text of ['one', 'two', 'three']) {
      await h.send(main, text);
      await h.settle(main);
    }
    const [, second] = turnIds(h.all(main));
    const title = h.events.snapshot(main)?.session.title;
    expect(title).toBe('one');

    const { session: branch } = await h.methods['session.fork'](
      { sessionId: main, turnId: second },
      context,
    );
    expect(branch).toMatchObject({
      workspaceId: 'ws_1',
      providerId: 'mock',
      modelId: 'm',
      reasoningEffort: 'high',
      permissionMode: 'full_access',
      state: 'idle',
      title,
      forkedFrom: { sessionId: main, turnId: second },
    });
    expect(branch.side).toBeUndefined();
    const events = h.all(branch.id);
    expect(events[0]).toMatchObject({
      type: 'session.created',
      payload: { forkedFrom: { sessionId: main, turnId: second } },
    });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(transcript(events)).toEqual(['> one', 'Echo: one', '> two', 'Echo: two']);
    // 原会话的事件时间照旧，审批、状态转换之类的会话事实不抄。
    const copied = events.find((e) => e.type === 'user.message');
    const original = h.all(main).find((e) => e.type === 'user.message');
    expect(copied?.ts).toBe(original?.ts);
    expect(events.some((e) => e.type === 'session.state_changed')).toBe(false);

    const listed = await h.methods['session.list']({}, context);
    expect(listed.sessions.map((s) => s.id).sort()).toEqual([main, branch.id].sort());

    await h.send(branch.id, 'recall');
    await h.settle(branch.id);
    expect(h.answer(branch.id)).toBe('Echo: recall\n\nHistory: one | two');
    // 分支的第一条消息不再起标题。
    expect(h.events.snapshot(branch.id)?.session.title).toBe(title);

    await h.send(main, 'recall');
    await h.settle(main);
    expect(h.answer(main)).toBe('Echo: recall\n\nHistory: one | two | three');
    expect(h.errors).toEqual([]);
  });

  it('不带 turnId 分到最近一个完成的回合；回合进行中也行', async () => {
    const h = setup(new EchoAdapter({ stepDelayMs: 5 }));
    const main = await h.create();
    await h.send(main, 'one');
    await h.settle(main);
    await h.send(main, 'slow two');
    const branch = await h.manager.fork({ sessionId: main });
    expect(branch.forkedFrom?.turnId).toBe(turnIds(h.all(main))[0]);
    expect(transcript(h.all(branch.id))).toEqual(['> one', 'Echo: one']);
    await h.settle(main);
    await h.send(branch.id, 'recall');
    await h.settle(branch.id);
    expect(h.answer(branch.id)).toBe('Echo: recall\n\nHistory: one');
  });

  it('拒绝：支线带 turnId、不是完成的回合、从支线分、还没有回合', async () => {
    const h = setup();
    const main = await h.create();
    await expect(h.manager.fork({ sessionId: main })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await h.send(main, 'one');
    await h.settle(main);
    const [first] = turnIds(h.all(main));
    await expect(
      h.manager.fork({ sessionId: main, side: true, turnId: first }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      h.manager.fork({ sessionId: main, turnId: 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR' as TurnId }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const side = await h.manager.fork({ sessionId: main, side: true });
    await expect(h.manager.fork({ sessionId: side.id })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('分支之后 Host 重启：快照从抄来的事件重放出同样的结果', async () => {
    const h = setup();
    const main = await h.create();
    await h.send(main, 'one');
    await h.settle(main);
    const branch = await h.manager.fork({ sessionId: main });
    const before = h.events.snapshot(branch.id)?.session;
    const replayed = new EventStore({ storage: h.storage }).snapshot(branch.id)?.session;
    expect(replayed).toEqual(before);
  });
});

describe('session.rewind（0.38.0）', () => {
  it('撤回最后一个回合：写 turn.rewound，引擎不再记得它；只能撤回最后一个', async () => {
    const h = setup();
    const main = await h.create();
    for (const text of ['one', 'two']) {
      await h.send(main, text);
      await h.settle(main);
    }
    const [first, second] = turnIds(h.all(main));
    await expect(
      h.methods['session.rewind']({ sessionId: main, turnId: first as TurnId }, context),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const { seq } = await h.methods['session.rewind'](
      { sessionId: main, turnId: second as TurnId },
      context,
    );
    expect(h.all(main).at(-1)).toMatchObject({
      seq,
      type: 'turn.rewound',
      payload: { turnId: second },
    });
    // 撤回过的不能再撤回；之前那个现在是最后一个。
    await expect(
      h.manager.rewind({ sessionId: main, turnId: second as TurnId }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });

    await h.send(main, 'two again, recall');
    await h.settle(main);
    expect(h.answer(main)).toBe('Echo: two again, recall\n\nHistory: one');

    // 分支按没撤回的回合数：从第一个回合分，引擎只带 one。
    const branch = await h.manager.fork({ sessionId: main, turnId: first as TurnId });
    expect(transcript(h.all(branch.id))).toEqual(['> one', 'Echo: one']);
    await h.send(branch.id, 'recall');
    await h.settle(branch.id);
    expect(h.answer(branch.id)).toBe('Echo: recall\n\nHistory: one');
    expect(h.errors).toEqual([]);
  });

  it('回合进行中 SESSION_BUSY；支线不能撤回', async () => {
    const h = setup(new EchoAdapter({ stepDelayMs: 5 }));
    const main = await h.create();
    await h.send(main, 'one');
    await h.settle(main);
    const [first] = turnIds(h.all(main));
    await h.send(main, 'slow two');
    await expect(
      h.manager.rewind({ sessionId: main, turnId: first as TurnId }),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    await h.settle(main);
    const side = await h.manager.fork({ sessionId: main, side: true });
    await h.send(side.id, 'q');
    await h.settle(side.id);
    const [sideTurn] = turnIds(h.all(side.id));
    await expect(
      h.manager.rewind({ sessionId: side.id, turnId: sideTurn as TurnId }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('撤回之后从分支抄历史：被撤回的回合连同 turn.rewound 一起抄', async () => {
    const h = setup();
    const main = await h.create();
    await h.send(main, 'one');
    await h.settle(main);
    const [first] = turnIds(h.all(main));
    await h.manager.rewind({ sessionId: main, turnId: first as TurnId });
    await h.send(main, 'uno');
    await h.settle(main);
    const branch = await h.manager.fork({ sessionId: main });
    const types = h.all(branch.id).map((e) => e.type);
    expect(types).toContain('turn.rewound');
    await h.send(branch.id, 'recall');
    await h.settle(branch.id);
    expect(h.answer(branch.id)).toBe('Echo: recall\n\nHistory: uno');
  });
});
