// 建议的后续任务（0.16.0，U23，domain-model §3.11）：echo 的 `suggest` 关键词提出建议，session.create 带 origin 开成会话，
// 那个会话第一个回合结束时回报到提出建议的会话（事件 + injectNote）。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, SessionState, WevirEvent } from '@wevir/protocol';
import { ECHO_SUGGESTIONS, EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-10-15T00:00:00.000Z';
const managers: SessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

function setup(adapter = new EchoAdapter({ stepDelayMs: 0 })) {
  const root = realpathSync(tempDir());
  const storage = storages.open(join(root, 'data'));
  for (const id of ['ws_1', 'ws_2']) {
    const dir = join(root, id);
    mkdirSync(dir);
    storage.workspaces.insert({ id, rootPath: dir, displayName: id, createdAt: T0, updatedAt: T0 });
  }
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
  const manager = new SessionManager({
    storage,
    events,
    adapter,
    onError: (e) => errors.push(e),
  });
  managers.push(manager);
  const create = async (extra: Partial<Parameters<SessionManager['create']>[0]> = {}) =>
    (await manager.create({ workspaceId: 'ws_1', providerId: 'mock', ...extra })).id;
  const send = (sessionId: SessionId, text: string) =>
    manager.send({ sessionId, content: [{ type: 'text', text }] }, identity);
  const state = (sessionId: SessionId): SessionState | undefined =>
    events.snapshot(sessionId)?.session.state;
  const settle = async (sessionId: SessionId) => {
    await vi.waitFor(() => expect(state(sessionId)).toBe('idle'), { timeout: 5000 });
  };
  const all = (sessionId: SessionId): WevirEvent[] => events.readSince(sessionId, 0);
  return { storage, events, manager, adapter, errors, create, send, settle, all };
}

/** 发一个 `suggest` 回合，返回建议。 */
async function suggest(h: ReturnType<typeof setup>, sessionId: SessionId) {
  await h.send(sessionId, 'suggest follow-ups');
  await vi.waitFor(() =>
    expect(h.events.snapshot(sessionId)?.suggestedTasks).toHaveLength(ECHO_SUGGESTIONS.length),
  );
  await h.settle(sessionId);
  return h.events.snapshot(sessionId)?.suggestedTasks ?? [];
}

describe('建议的后续任务', () => {
  it('引擎报的建议写成 tasks.suggested：Host 分配 ID，带工具调用与回合，状态 suggested', async () => {
    const h = setup();
    const parent = await h.create();
    const tasks = await suggest(h, parent);
    const event = h.all(parent).find((e) => e.type === 'tasks.suggested');
    expect(event).toMatchObject({ source: 'host' });
    const tool = h.all(parent).find((e) => e.type === 'tool.started');
    expect(tasks).toEqual(
      ECHO_SUGGESTIONS.map((task) => ({
        ...task,
        id: expect.stringMatching(/^tsk_/),
        toolCallId: tool?.type === 'tool.started' && tool.payload.toolCallId,
        turnId: event?.type === 'tasks.suggested' && event.payload.turnId,
        status: 'suggested',
      })),
    );
    expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
    expect(h.errors).toEqual([]);
  });

  it('开成会话：origin 记在新会话上，提出建议的会话写 task.started；第一个回合结束时写 task.reported，之后不再写（回报笔记由应用级工具交）', async () => {
    const h = setup();
    const inject = vi.spyOn(h.adapter, 'injectNote');
    const parent = await h.create();
    const [task] = await suggest(h, parent);
    if (!task) throw new Error('no task');

    const child = await h.create({
      origin: { kind: 'suggested_task', sessionId: parent, taskId: task.id },
    });
    expect(h.events.snapshot(child)?.session.origin).toEqual({
      kind: 'suggested_task',
      sessionId: parent,
      taskId: task.id,
    });
    expect(h.all(parent).at(-1)).toMatchObject({
      type: 'task.started',
      payload: { taskId: task.id, sessionId: child },
    });
    expect(h.events.snapshot(parent)?.suggestedTasks?.[0]).toMatchObject({
      status: 'started',
      sessionId: child,
    });

    await h.send(child, task.prompt);
    await vi.waitFor(() =>
      expect(h.events.snapshot(parent)?.suggestedTasks?.[0]?.status).toBe('reported'),
    );
    const reported = h.all(parent).find((e) => e.type === 'task.reported');
    expect(reported?.payload).toEqual({
      taskId: task.id,
      sessionId: child,
      outcome: 'completed',
      summary: `Echo: ${task.prompt}`,
    });
    // 交给提出建议的会话的笔记与续上它在 AppTools（app-tools.test.ts），SessionManager 自己不补说明。
    expect(inject).not.toHaveBeenCalled();

    // 第二个回合不再回报。
    await h.settle(child);
    await h.send(child, 'again');
    await h.settle(child);
    expect(h.all(parent).filter((e) => e.type === 'task.reported')).toHaveLength(1);
    expect(inject).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
  });

  it('回合失败也写 task.reported；提出建议的会话关着时也写', async () => {
    const h = setup();
    const inject = vi.spyOn(h.adapter, 'injectNote');
    const parent = await h.create();
    const [, task] = await suggest(h, parent);
    if (!task) throw new Error('no task');
    const child = await h.create({
      origin: { kind: 'suggested_task', sessionId: parent, taskId: task.id },
    });
    await h.manager.close(parent);
    await h.send(child, 'please fail');
    await vi.waitFor(() =>
      expect(h.all(parent).find((e) => e.type === 'task.reported')?.payload).toEqual({
        taskId: task.id,
        sessionId: child,
        outcome: 'failed',
      }),
    );
    expect(inject).not.toHaveBeenCalled();
  });

  it('origin 不对时不建会话：工作区不同、建议不在、已经开始过', async () => {
    const h = setup();
    const parent = await h.create();
    const [task] = await suggest(h, parent);
    if (!task) throw new Error('no task');
    const origin = { kind: 'suggested_task' as const, sessionId: parent, taskId: task.id };
    await expect(h.create({ workspaceId: 'ws_2', origin })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(
      h.create({ origin: { ...origin, taskId: 'tsk_01JA2B3C4D5E6F7G8H9JKMNPZZ' } }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    // 同时开两次：只有一次成功。
    const results = await Promise.allSettled([h.create({ origin }), h.create({ origin })]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    await expect(h.create({ origin })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(h.storage.sessions.list().filter((s) => s.origin !== undefined)).toHaveLength(1);
    expect(h.all(parent).filter((e) => e.type === 'task.started')).toHaveLength(1);
  });

  it('引擎不会建议任务时不接受 origin', async () => {
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    const h = setup(adapter);
    const parent = await h.create();
    const [task] = await suggest(h, parent);
    if (!task) throw new Error('no task');
    Object.defineProperty(adapter, 'suggestedTasks', { value: undefined });
    await expect(
      h.create({ origin: { kind: 'suggested_task', sessionId: parent, taskId: task.id } }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
});
