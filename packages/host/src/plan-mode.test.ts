// 计划模式（0.36.0，domain-model §3.17）：`session.send` 的 `collaborationMode`，经方法表对着 EchoAdapter 的会话。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineFeatures, SessionId, WevirEvent } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();

describe('计划模式', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  function setup(engineFeatures?: Record<string, EngineFeatures>) {
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
    const adapter = new EchoAdapter({ stepDelayMs: 1 });
    const send = vi.spyOn(adapter, 'send');
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const manager = new SessionManager({
      storage,
      events,
      adapter,
      ...(engineFeatures !== undefined && { engineFeatures }),
    });
    managers.push(manager);
    const methods = createHostMethods({
      storage,
      events,
      sessions: manager,
      secrets: new FileSecretStore(join(root, 'data')),
    });
    return { events, manager, methods, send };
  }
  type Env = ReturnType<typeof setup>;
  const context = { client: identity, capabilities: {} };
  const text = (value: string) => [{ type: 'text' as const, text: value }];

  async function newSession({ manager }: Env): Promise<SessionId> {
    const session = await manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    return session.id as SessionId;
  }

  async function idle({ events }: Env, sessionId: SessionId): Promise<void> {
    await vi.waitFor(() => expect(events.snapshot(sessionId)?.session.state).toBe('idle'));
  }

  function turnEvents({ events }: Env, sessionId: SessionId, turnId: string): WevirEvent[] {
    return events
      .readSince(sessionId, 0)
      .filter(
        (event) =>
          'turnId' in event.payload && (event.payload as { turnId?: string }).turnId === turnId,
      );
  }

  it('计划回合：user.message 带 collaborationMode，引擎收到 plan，计划写成 plan.proposed；下一条默认消息回到默认', async () => {
    const env = setup();
    const sessionId = await newSession(env);
    const { turnId } = await env.methods['session.send'](
      { sessionId, content: text('add export'), collaborationMode: 'plan' },
      context,
    );
    await idle(env, sessionId);
    const events = turnEvents(env, sessionId, turnId as string);
    expect(events[0]).toMatchObject({
      type: 'user.message',
      payload: { collaborationMode: 'plan' },
    });
    expect(env.send.mock.calls.at(-1)?.[1]).toMatchObject({ collaborationMode: 'plan' });
    const plan = events.find((event) => event.type === 'plan.proposed');
    expect(plan).toMatchObject({ source: 'engine', payload: { turnId } });
    expect(plan?.type === 'plan.proposed' && plan.payload.text).toContain('## 输入\n\nadd export');
    expect(env.events.snapshot(sessionId)?.session.collaborationMode).toBe('plan');

    const next = await env.methods['session.send'](
      { sessionId, content: text('go'), collaborationMode: 'default' },
      context,
    );
    await idle(env, sessionId);
    const after = turnEvents(env, sessionId, next.turnId as string);
    expect(after[0]?.payload).not.toHaveProperty('collaborationMode');
    expect(after.some((event) => event.type === 'plan.proposed')).toBe(false);
    expect(env.send.mock.calls.at(-1)?.[1]).not.toHaveProperty('collaborationMode');
    expect(env.events.snapshot(sessionId)?.session).not.toHaveProperty('collaborationMode');
  });

  it('引擎没有计划模式：INVALID_PARAMS（collaborationMode），不写事件；default 照常', async () => {
    const env = setup({ 'openai-compatible': { engine: 'echo', commands: [] } });
    const sessionId = await newSession(env);
    const before = env.events.snapshot(sessionId)?.session.lastSeq;
    await expect(
      env.methods['session.send'](
        { sessionId, content: text('x'), collaborationMode: 'plan' },
        context,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { issues: [{ path: ['collaborationMode'] }] },
    });
    expect(env.events.snapshot(sessionId)?.session.lastSeq).toBe(before);
    await env.methods['session.send'](
      { sessionId, content: text('x'), collaborationMode: 'default' },
      context,
    );
    await idle(env, sessionId);
  });

  it('排队的计划消息带着模式，回合结束后作为计划回合发出；插话不带模式', async () => {
    const env = setup();
    const sessionId = await newSession(env);
    await env.methods['session.send']({ sessionId, content: text('slow work') }, context);
    const queued = await env.methods['session.send'](
      {
        sessionId,
        content: text('then plan'),
        delivery: 'queue',
        collaborationMode: 'plan',
      },
      context,
    );
    expect(env.events.pending(sessionId, queued.pendingId as never)).toMatchObject({
      collaborationMode: 'plan',
    });
    await vi.waitFor(() => {
      const messages = env.events
        .readSince(sessionId, 0)
        .filter((event) => event.type === 'user.message');
      expect(messages).toHaveLength(2);
      expect(messages[1]?.payload).toMatchObject({
        pendingId: queued.pendingId,
        collaborationMode: 'plan',
      });
    });
    await idle(env, sessionId);
    expect(env.send.mock.calls.at(-1)?.[1]).toMatchObject({ collaborationMode: 'plan' });
  });

  it('幂等：同一 clientMessageId 换了模式是 CLIENT_MESSAGE_CONFLICT；默认模式的指纹不变', async () => {
    const env = setup();
    const sessionId = await newSession(env);
    const first = await env.methods['session.send'](
      { sessionId, content: text('x'), clientMessageId: 'm-1' },
      context,
    );
    await idle(env, sessionId);
    await expect(
      env.methods['session.send'](
        { sessionId, content: text('x'), clientMessageId: 'm-1', collaborationMode: 'default' },
        context,
      ),
    ).resolves.toEqual(first);
    await expect(
      env.methods['session.send'](
        { sessionId, content: text('x'), clientMessageId: 'm-1', collaborationMode: 'plan' },
        context,
      ),
    ).rejects.toMatchObject({ code: 'CLIENT_MESSAGE_CONFLICT' });
  });
});
