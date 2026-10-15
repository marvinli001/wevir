// 会话目标（0.35.0，domain-model §3.16）：session.setGoal / updateGoal / clearGoal 与引擎自己开的目标回合，经方法表对着
// EchoAdapter 的会话（它在第一个回合之后续跑一个回合，续跑的回合结束即达成）。

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

describe('会话目标', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  function setup(adapter: EchoAdapter = new EchoAdapter({ stepDelayMs: 0 })) {
    const root = realpathSync(tempDir());
    const storage = storages.open(join(root, 'data'));
    const workspaceDir = join(root, 'ws');
    mkdirSync(workspaceDir);
    const T0 = '2026-10-15T00:00:00.000Z';
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
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const manager = new SessionManager({ storage, events, adapter });
    managers.push(manager);
    const methods = createHostMethods({
      storage,
      events,
      sessions: manager,
      secrets: new FileSecretStore(join(root, 'data')),
    });
    return { adapter, storage, events, manager, methods };
  }
  const context = { client: identity, capabilities: {} };
  type Env = ReturnType<typeof setup>;

  async function newSession({ manager }: Env): Promise<SessionId> {
    const session = await manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    return session.id as SessionId;
  }

  function all({ events }: Env, sessionId: SessionId): WevirEvent[] {
    return events.readSince(sessionId, 0);
  }

  function goalStatus({ events }: Env, sessionId: SessionId): string | undefined {
    return events.snapshot(sessionId)?.session.goal?.status;
  }

  it('设目标：目标是用户消息，第一个回合带 trigger；之后引擎自己续跑一个回合，结束后目标达成', async () => {
    const env = setup();
    const sessionId = await newSession(env);
    const { turnId, seq } = await env.methods['session.setGoal'](
      { sessionId, objective: '  补齐登录页的测试  ', tokenBudget: 5000 },
      context,
    );
    await vi.waitFor(() => expect(goalStatus(env, sessionId)).toBe('complete'));
    await vi.waitFor(() => expect(env.events.snapshot(sessionId)?.session.state).toBe('idle'));

    const events = all(env, sessionId);
    const started = events.filter((event) => event.type === 'turn.started');
    expect(started).toHaveLength(2);
    expect(started[0]?.payload).toEqual({ turnId, trigger: 'goal' });
    expect(started[1]?.payload).toMatchObject({ trigger: 'goal' });
    // 第一个回合的用户消息是去掉首尾空白的目标；续跑的回合没有用户消息。
    const messages = events.filter((event) => event.type === 'user.message');
    expect(messages[0]?.seq).toBe(seq);
    expect(messages.map((event) => event.payload)).toEqual([
      expect.objectContaining({ turnId, content: [{ type: 'text', text: '补齐登录页的测试' }] }),
    ]);
    const continuation = started[1]?.payload.turnId;
    const answers = events.flatMap((event) =>
      event.type === 'assistant.message' && event.payload.turnId === continuation
        ? [event.payload.text]
        : [],
    );
    expect(answers).toEqual(['Echo: Continue: 补齐登录页的测试']);
    // 目标的每次变化写成 session.goal_changed，Session.goal 是最后一次。
    const changes = events.flatMap((event) =>
      event.type === 'session.goal_changed' ? [event.payload.goal?.status] : [],
    );
    expect(changes[0]).toBe('active');
    expect(changes.at(-1)).toBe('complete');
    const { goal } = env.events.snapshot(sessionId)?.session ?? {};
    expect(goal).toMatchObject({
      objective: '补齐登录页的测试',
      status: 'complete',
      tokenBudget: 5000,
      tokensUsed: 2400,
      timeUsedSeconds: 2,
    });
    // 标题照普通消息起。
    expect(env.events.snapshot(sessionId)?.session.title).toBe('补齐登录页的测试');
    const listed = await env.methods['session.list']({}, context);
    expect(listed.sessions[0]?.goal?.status).toBe('complete');
  });

  it('停止目标回合时先暂停目标，之后不再续跑；继续时引擎随即开回合', async () => {
    const env = setup(new EchoAdapter({ stepDelayMs: 2 }));
    const sessionId = await newSession(env);
    await env.methods['session.setGoal']({ sessionId, objective: 'slow 迁移构建脚本' }, context);
    // 等到引擎自己开的续跑回合。
    await vi.waitFor(() =>
      expect(all(env, sessionId).filter((event) => event.type === 'turn.started')).toHaveLength(2),
    );
    await env.methods['session.cancel']({ sessionId }, context);
    expect(goalStatus(env, sessionId)).toBe('paused');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(env.events.snapshot(sessionId)?.session.state).toBe('idle');
    expect(all(env, sessionId).filter((event) => event.type === 'turn.started')).toHaveLength(2);

    const { goal } = await env.methods['session.updateGoal'](
      { sessionId, status: 'active' },
      context,
    );
    expect(goal.status).toBe('active');
    await vi.waitFor(() => expect(goalStatus(env, sessionId)).toBe('complete'));
    const started = all(env, sessionId).filter((event) => event.type === 'turn.started');
    expect(started).toHaveLength(3);
    expect(started[2]?.payload).toMatchObject({ trigger: 'goal' });
  });

  it('暂停与清除：没有目标时 updateGoal 是 INVALID_STATE，clearGoal 返回 false', async () => {
    const env = setup();
    const sessionId = await newSession(env);
    await expect(
      env.methods['session.updateGoal']({ sessionId, status: 'paused' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await env.methods['session.clearGoal']({ sessionId }, context)).toEqual({
      cleared: false,
    });

    await env.methods['session.setGoal']({ sessionId, objective: '整理依赖' }, context);
    const { goal } = await env.methods['session.updateGoal'](
      { sessionId, status: 'paused' },
      context,
    );
    expect(goal).toMatchObject({ objective: '整理依赖', status: 'paused' });
    await vi.waitFor(() => expect(env.events.snapshot(sessionId)?.session.state).toBe('idle'));
    // 暂停的目标不续跑。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(all(env, sessionId).filter((event) => event.type === 'turn.started')).toHaveLength(1);

    expect(await env.methods['session.clearGoal']({ sessionId }, context)).toEqual({
      cleared: true,
    });
    expect(env.events.snapshot(sessionId)?.session.goal).toBeUndefined();
    const last = all(env, sessionId)
      .filter((event) => event.type === 'session.goal_changed')
      .at(-1);
    expect(last?.payload).toEqual({ goal: null });
  });

  it('会话忙时设目标是 SESSION_BUSY', async () => {
    const env = setup(new EchoAdapter({ stepDelayMs: 2 }));
    const sessionId = await newSession(env);
    await env.methods['session.send'](
      { sessionId, content: [{ type: 'text', text: 'slow 先跑一个回合' }] },
      context,
    );
    await expect(
      env.methods['session.setGoal']({ sessionId, objective: '补测试' }, context),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    await vi.waitFor(() => expect(env.events.snapshot(sessionId)?.session.state).toBe('idle'));
  });

  it('会话所在的引擎没有目标时 INVALID_STATE，不写事件', async () => {
    const plain = setup();
    Object.assign(plain.adapter, { supports: () => false });
    const other = await newSession(plain);
    const before = all(plain, other).length;
    await expect(
      plain.methods['session.setGoal']({ sessionId: other, objective: '补测试' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      plain.methods['session.clearGoal']({ sessionId: other }, context),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(all(plain, other)).toHaveLength(before);
  });

  it('Host 重启后目标还在：从事件重放出 Session.goal', async () => {
    const env = setup();
    const sessionId = await newSession(env);
    await env.methods['session.setGoal']({ sessionId, objective: '整理依赖' }, context);
    await env.methods['session.updateGoal']({ sessionId, status: 'paused' }, context);
    await vi.waitFor(() => expect(env.events.snapshot(sessionId)?.session.state).toBe('idle'));
    const reopened = new EventStore({ storage: env.storage });
    expect(reopened.snapshot(sessionId)?.session.goal).toMatchObject({
      objective: '整理依赖',
      status: 'paused',
    });
  });
});
