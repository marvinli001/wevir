// session.rename 与 session.archive（0.23.0）：经方法表对着 EchoAdapter 的会话。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { MethodSchemas, type SessionId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();

describe('session.rename / session.archive', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  function setup() {
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
    const manager = new SessionManager({
      storage,
      events,
      adapter: new EchoAdapter({ stepDelayMs: 0 }),
    });
    managers.push(manager);
    const methods = createHostMethods({
      storage,
      events,
      sessions: manager,
      secrets: new FileSecretStore(join(root, 'data')),
    });
    return { storage, events, manager, methods };
  }
  const context = { client: identity, capabilities: {} };

  async function sessionWithTurn(setupResult: ReturnType<typeof setup>): Promise<SessionId> {
    const { manager, events } = setupResult;
    const session = await manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = session.id as SessionId;
    await manager.send({ sessionId, content: [{ type: 'text', text: 'hello' }] }, identity);
    await vi.waitFor(() => expect(events.snapshot(sessionId)?.session.state).toBe('idle'));
    return sessionId;
  }

  it('改名写 user 来源的标题；空白标题与子会话被拒绝', async () => {
    const env = setup();
    const sessionId = await sessionWithTurn(env);
    const { session } = await env.methods['session.rename'](
      { sessionId, title: '  修复登录  ' },
      context,
    );
    expect(session).toMatchObject({ title: '修复登录', titleSource: 'user' });
    expect(MethodSchemas['session.rename'].result.safeParse({ session }).success).toBe(true);
    const last = env.events.snapshot(sessionId)?.session.lastSeq;
    // 没变时不写事件。
    await env.methods['session.rename']({ sessionId, title: '修复登录' }, context);
    expect(env.events.snapshot(sessionId)?.session.lastSeq).toBe(last);
    await expect(
      env.methods['session.rename']({ sessionId, title: '   ' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      env.methods['session.rename']({ sessionId: 'ses_missing' as SessionId, title: 'x' }, context),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('归档先关闭会话、列表默认不列；取消归档；恢复即取消归档', async () => {
    const env = setup();
    const sessionId = await sessionWithTurn(env);
    const other = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });

    const archived = await env.methods['session.archive']({ sessionId, archived: true }, context);
    expect(archived.session.state).toBe('closed');
    expect(archived.session.archivedAt).toEqual(expect.any(String));
    const at = archived.session.archivedAt;
    // 已归档时再归档不改时刻。
    const again = await env.methods['session.archive']({ sessionId, archived: true }, context);
    expect(again.session.archivedAt).toBe(at);

    const listed = await env.methods['session.list']({}, context);
    expect(listed.sessions.map((s) => s.id)).toEqual([other.id]);
    const archivedList = await env.methods['session.list']({ archived: true }, context);
    expect(archivedList.sessions.map((s) => s.id)).toEqual([sessionId]);
    expect(archivedList.sessions[0]?.archivedAt).toBe(at);
    expect((await env.methods['session.get']({ sessionId }, context)).session.archivedAt).toBe(at);

    const restored = await env.methods['session.archive']({ sessionId, archived: false }, context);
    expect(restored.session).not.toHaveProperty('archivedAt');
    expect(restored.session.state).toBe('closed');
    expect((await env.methods['session.list']({}, context)).sessions).toHaveLength(2);

    await env.methods['session.archive']({ sessionId, archived: true }, context);
    await env.methods['session.resume']({ sessionId }, context);
    expect(env.storage.sessions.get(sessionId)?.archivedAt).toBeUndefined();
  });

  it('支线会话不能归档', async () => {
    const env = setup();
    const sessionId = await sessionWithTurn(env);
    const side = await env.methods['session.fork']({ sessionId, side: true }, context);
    await expect(
      env.methods['session.archive'](
        { sessionId: side.session.id as SessionId, archived: true },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
});
