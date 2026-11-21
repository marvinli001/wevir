// 分支到新会话与撤回最后一个回合（0.38.0，domain-model §3.18）：session.fork 不带 side 分出带历史的顶层会话，session.rewind 撤回
// 最后一个回合。echo 引擎的 `recall` 关键词写出它记得的之前每个回合的输入。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, TurnId, WevirEvent } from '@wevir/protocol';
import type { AgentEvent, AgentRuntimeAdapter } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore, type ProviderProfileRecord } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fakeKiroAdapter,
  fakeKiroEnv,
  readLog,
} from '../../adapter-kiro/src/test-fixtures/harness.js';
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
  return setupHost(adapter, {
    id: 'mock',
    kind: 'openai-compatible',
    displayName: 'Mock',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'm' }],
    defaultModelId: 'm',
  });
}

function setupHost<A extends AgentRuntimeAdapter>(
  adapter: A,
  provider: Omit<ProviderProfileRecord, 'createdAt' | 'updatedAt'>,
) {
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
  storage.providers.insert({ ...provider, createdAt: T0, updatedAt: T0 });
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
        providerId: provider.id,
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
  it('forks Kiro v3 history at the persisted native message and sends to the child', async () => {
    const root = join(tempDir(), 'kiro-fork');
    mkdirSync(root, { recursive: true });
    const log = join(root, 'rpc.ndjson');
    const adapter = fakeKiroAdapter(
      root,
      fakeKiroEnv({
        FAKE_KIRO_VERSION: '3.2.0',
        FAKE_KIRO_SIGNED_IN: '1',
        FAKE_KIRO_STORE: join(root, 'sessions'),
        FAKE_KIRO_LOG: log,
      }),
    );
    const h = setupHost(adapter, {
      id: 'kiro',
      kind: 'kiro',
      displayName: 'Kiro',
      models: [{ id: 'auto' }],
      defaultModelId: 'auto',
    });
    try {
      const { session: source } = await h.methods['session.create'](
        { workspaceId: 'ws_1', providerId: 'kiro' },
        context,
      );
      for (const text of ['first', 'second']) {
        await h.send(source.id, text);
        await h.settle(source.id);
      }
      const first = h.all(source.id).find((event) => event.type === 'turn.finished');
      const nativePrompt = readLog(log).find((entry) => entry.method === 'session/prompt');
      expect(first?.payload.engineRef).toMatchObject({
        engineSessionId: expect.stringMatching(/^kiro-v3:/),
        messageId: `native-user-message-${nativePrompt?.id}`,
      });
      const { session: branch } = await h.methods['session.fork'](
        { sessionId: source.id, turnId: first?.payload.turnId },
        context,
      );
      const branchId = h.storage.sessions.get(branch.id)?.engineSessionId;
      expect(branchId).toMatch(/^kiro-v3:/);
      expect(readLog(log).find((entry) => entry.method === 'session/fork')).toMatchObject({
        params: {
          sessionId: nativePrompt?.params.sessionId,
          _meta: { kiro: { messageId: first?.payload.engineRef?.messageId } },
        },
      });
      expect(transcript(h.all(branch.id))).toEqual(['> first', 'echo: first']);

      await h.send(branch.id, 'follow-up');
      await h.settle(branch.id);
      expect(h.answer(branch.id)).toBe('echo: follow-up');
      expect(readLog(log).findLast((entry) => entry.method === 'session/prompt')).toMatchObject({
        params: { sessionId: branchId?.slice('kiro-v3:'.length) },
      });
      expect(h.errors).toEqual([]);
    } finally {
      await h.manager.dispose();
      await adapter.dispose();
    }
  });

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

  it('uses the original native fork point after restart and leaves copied points unbound', async () => {
    class MessageBoundEcho extends EchoAdapter {
      #next = 0;

      override async *subscribe(engineSessionId: string): AsyncGenerator<AgentEvent> {
        for await (const event of super.subscribe(engineSessionId)) {
          if (event.type === 'turn.settled' && event.stopReason !== 'compacted') {
            yield {
              type: 'turn.bound',
              engineSessionId,
              engineTurnId: `message-${++this.#next}`,
              forkPoint: true,
            };
          }
          yield event;
        }
      }
    }
    const h = setup(new MessageBoundEcho({ stepDelayMs: 0 }));
    const main = await h.create();
    await h.send(main, 'one');
    await h.settle(main);
    const [first] = turnIds(h.all(main)) as [TurnId];
    vi.spyOn(h.adapter, 'send').mockRejectedValueOnce(new Error('engine refused the prompt'));
    await h.send(main, 'interrupted');
    await h.manager.resume(main);
    await h.manager.compact(main);
    await h.settle(main);
    await h.send(main, 'two');
    await h.settle(main);
    await h.manager.dispose();

    const events = new EventStore({ storage: h.storage });
    const manager = new SessionManager({ storage: h.storage, events, adapter: h.adapter });
    managers.push(manager);
    const nativeFork = h.adapter.fork.bind(h.adapter);
    const fork = vi
      .spyOn(h.adapter, 'fork')
      .mockImplementationOnce((id, config) =>
        nativeFork(id, config, { kind: 'branch', dropTurns: 2 }),
      );
    const branch = await manager.fork({ sessionId: main, turnId: first });
    expect(fork).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), {
      kind: 'branch',
      dropTurns: 3,
      nativeTurnId: 'message-1',
      atHead: false,
    });
    expect(transcript(events.readSince(branch.id, 0))).toEqual(['> one', 'Echo: one']);

    await manager.fork({ sessionId: branch.id });
    expect(fork).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), {
      kind: 'branch',
      dropTurns: 0,
      atHead: true,
    });

    await manager.send(
      { sessionId: branch.id, content: [{ type: 'text', text: 'three' }] },
      identity,
    );
    await h.settle(branch.id);
    await manager.fork({ sessionId: branch.id, turnId: first });
    expect(fork).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), {
      kind: 'branch',
      dropTurns: 1,
      atHead: false,
    });
  });
});

it('returns only the skill names and native commands available to the active composer', async () => {
  class CatalogAdapter extends EchoAdapter {
    override readonly skills = true;
    async listCommands() {
      return [{ name: 'usage', argumentHint: '[period]' }];
    }
  }
  const h = setup(new CatalogAdapter());
  const sessionId = await h.create();
  const skills = vi
    .fn()
    .mockResolvedValue([{ name: 'style', description: 'UI', path: '/private/SKILL.md' }]);
  await expect(h.manager.composerCatalog(sessionId, skills)).resolves.toEqual({
    skills: [{ name: 'style', description: 'UI' }],
    commands: [{ name: 'usage', argumentHint: '[period]' }],
  });
  expect(skills).toHaveBeenCalledOnce();
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

  it('editing an earlier turn checks the visible tip and removes the suffix from engine history', async () => {
    const h = setup();
    const sessionId = await h.create();
    for (const text of ['one', 'two', 'three']) {
      await h.send(sessionId, text);
      await h.settle(sessionId);
    }
    const [, middle, last] = turnIds(h.all(sessionId));
    const rewind = vi.spyOn(h.adapter, 'rewind');
    const edit = { sessionId, turnId: middle as TurnId, through: true as const };
    await expect(
      h.manager.rewind({ ...edit, expectedLatestTurnId: middle as TurnId }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await h.manager.rewind({ ...edit, expectedLatestTurnId: last as TurnId });
    expect(rewind).toHaveBeenCalledTimes(1);
    expect(rewind).toHaveBeenCalledWith(expect.any(String), 2, undefined);
    expect(
      h
        .all(sessionId)
        .filter((event) => event.type === 'turn.rewound')
        .map((event) => event.payload.turnId),
    ).toEqual([last, middle]);
    await h.send(sessionId, 'replacement, recall');
    await h.settle(sessionId);
    expect(h.answer(sessionId)).toBe('Echo: replacement, recall\n\nHistory: one');
  });

  it('refuses rewind and branch boundaries that include an interrupted turn never admitted by the engine', async () => {
    const h = setup();
    const sessionId = await h.create();
    await h.send(sessionId, 'A');
    await h.settle(sessionId);
    vi.spyOn(h.adapter, 'send').mockRejectedValueOnce(new Error('engine rejected turn/start'));
    await h.send(sessionId, 'B');
    expect(h.events.snapshot(sessionId)?.session.state).toBe('error');
    await h.manager.resume(sessionId);
    await h.send(sessionId, 'C');
    await h.settle(sessionId);
    const [first, missing, last] = turnIds(h.all(sessionId));
    const rewind = vi.spyOn(h.adapter, 'rewind');
    await expect(
      h.manager.rewind({
        sessionId,
        turnId: missing as TurnId,
        through: true,
        expectedLatestTurnId: last as TurnId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(rewind).not.toHaveBeenCalled();
    expect(h.all(sessionId).some((e) => e.type === 'turn.rewound')).toBe(false);
    const fork = vi.spyOn(h.adapter, 'fork');
    for (const turnId of [first, missing]) {
      await expect(h.manager.fork({ sessionId, turnId: turnId as TurnId })).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
    }
    expect(fork).not.toHaveBeenCalled();
    const branch = await h.manager.fork({ sessionId, turnId: last as TurnId });
    await h.send(branch.id, 'recall');
    await h.settle(branch.id);
    expect(h.answer(branch.id)).toBe('Echo: recall\n\nHistory: A | C');
    await h.send(sessionId, 'recall');
    await h.settle(sessionId);
    expect(h.answer(sessionId)).toBe('Echo: recall\n\nHistory: A | C');
  });

  it('keeps the whole visible suffix if the native rewind fails', async () => {
    const h = setup();
    const sessionId = await h.create();
    for (const text of ['A', 'B', 'C']) {
      await h.send(sessionId, text);
      await h.settle(sessionId);
    }
    const [, middle, last] = turnIds(h.all(sessionId));
    vi.spyOn(h.adapter, 'rewind').mockRejectedValueOnce(new Error('engine busy'));
    await expect(
      h.manager.rewind({
        sessionId,
        turnId: middle as TurnId,
        through: true,
        expectedLatestTurnId: last as TurnId,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_ERROR' });
    expect(h.all(sessionId).some((e) => e.type === 'turn.rewound')).toBe(false);
    await h.send(sessionId, 'recall');
    await h.settle(sessionId);
    expect(h.answer(sessionId)).toBe('Echo: recall\n\nHistory: A | B | C');
  });

  it('rewinds an interrupted turn confirmed in native history together with its successors', async () => {
    class BoundEcho extends EchoAdapter {
      override async *subscribe(engineSessionId: string): AsyncGenerator<AgentEvent> {
        for await (const event of super.subscribe(engineSessionId)) {
          if (event.type === 'engine.exited') {
            yield { type: 'turn.bound', engineSessionId, engineTurnId: 'B' };
          }
          yield event;
        }
      }
      override async rewind(id: string, count = 1, first?: string) {
        expect(first).toBe('B');
        await super.rewind(id, count);
      }
    }
    const h = setup(new BoundEcho({ stepDelayMs: 1 }));
    const sessionId = await h.create();
    await h.send(sessionId, 'A');
    await h.settle(sessionId);
    await h.send(sessionId, 'slow B');
    await h.adapter.simulateEngineExit();
    await vi.waitFor(() => expect(h.events.snapshot(sessionId)?.session.state).toBe('error'));
    await h.manager.resume(sessionId);
    await h.send(sessionId, 'C');
    await h.settle(sessionId);
    const [, middle, last] = turnIds(h.all(sessionId));
    await h.manager.rewind({
      sessionId,
      turnId: middle as TurnId,
      through: true,
      expectedLatestTurnId: last as TurnId,
    });
    await h.send(sessionId, 'recall');
    await h.settle(sessionId);
    expect(h.answer(sessionId)).toBe('Echo: recall\n\nHistory: A');
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
