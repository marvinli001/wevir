// 空闲释放：挂着的会话空闲够久后 Host 关掉它的引擎会话（引擎回收进程与 MCP 服务），不写事件；下次发消息时自动恢复。
// 对着 EchoAdapter，释放时长调到几十毫秒。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { SessionManager, type SessionManagerOptions } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();

const RELEASE_MS = 30;

describe('空闲释放', () => {
  let count = 0;
  const live: Array<{ manager: SessionManager; adapter: EchoAdapter; events: EventStore }> = [];
  afterEach(async () => {
    for (const env of live.splice(0)) {
      await env.manager.dispose();
      await env.adapter.dispose();
      env.events.close();
    }
  });

  function setup(manager: Partial<SessionManagerOptions> = {}) {
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    count += 1;
    const root = join(realpathSync(tempDir()), `env-${count}`);
    const storage = storages.open(join(root, 'data'));
    const workspaceDir = join(root, 'ws');
    mkdirSync(workspaceDir, { recursive: true });
    const T0 = '2026-11-11T00:00:00.000Z';
    storage.workspaces.insert({
      id: 'ws_1',
      rootPath: workspaceDir,
      displayName: 'ws',
      createdAt: T0,
      updatedAt: T0,
    });
    storage.providers.insert({
      id: 'deepseek-official',
      kind: 'deepseek-official',
      displayName: 'DeepSeek',
      models: [],
      defaultModelId: 'deepseek-chat',
      createdAt: T0,
      updatedAt: T0,
    });
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const warnings: string[] = [];
    const sessions = new SessionManager({
      storage,
      events,
      adapter,
      idleReleaseMs: RELEASE_MS,
      onWarning: (message) => warnings.push(message),
      ...manager,
    });
    const env = { manager: sessions, adapter, events, warnings };
    live.push(env);
    return {
      ...env,
      close: vi.spyOn(adapter, 'close'),
      resume: vi.spyOn(adapter, 'resumeSession'),
    };
  }
  type Env = ReturnType<typeof setup>;

  async function newSession(env: Env): Promise<SessionId> {
    return (await env.manager.create({ workspaceId: 'ws_1', providerId: 'deepseek-official' }))
      .id as SessionId;
  }

  function state(env: Env, id: SessionId) {
    return env.events.snapshot(id)?.session.state;
  }

  function lastSeq(env: Env, id: SessionId): number {
    return env.events.snapshot(id)?.session.lastSeq ?? 0;
  }

  async function turn(env: Env, id: SessionId, text: string): Promise<void> {
    await env.manager.send({ sessionId: id, content: [{ type: 'text', text }] }, identity);
    await vi.waitFor(() => expect(state(env, id)).toBe('idle'));
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('空闲满时长后关掉引擎会话，不写事件、状态仍是 idle；下次发消息时自动恢复', async () => {
    const env = setup();
    const id = await newSession(env);
    await turn(env, id, 'hello');
    const before = lastSeq(env, id);

    await vi.waitFor(() => expect(env.close).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const engineSessionId = env.events.snapshot(id)?.session.engine.sessionId;
    expect(env.close).toHaveBeenCalledWith(engineSessionId);
    expect(lastSeq(env, id)).toBe(before);
    expect(state(env, id)).toBe('idle');

    await turn(env, id, 'again');
    expect(env.resume).toHaveBeenCalledTimes(1);
    const types = env.events.readSince(id, before).map((event) => event.type);
    expect(types.slice(0, 2)).toEqual(['session.resumed', 'user.message']);
    expect(types).toContain('turn.finished');
    expect(env.warnings).toEqual([]);
  });

  it('等审批时不释放；审批结掉、空闲满时长后才释放', async () => {
    const env = setup();
    const id = await newSession(env);
    await env.manager.send(
      { sessionId: id, content: [{ type: 'text', text: 'approve' }] },
      identity,
    );
    await vi.waitFor(() => expect(state(env, id)).toBe('awaiting_approval'));
    await delay(RELEASE_MS * 6);
    expect(env.close).not.toHaveBeenCalled();

    const [approval] = env.events.snapshot(id)?.pendingApprovals ?? [];
    if (approval === undefined) throw new Error('no approval');
    await env.manager.respondToApproval(
      { approvalId: approval.id, optionId: 'allow-once' },
      identity,
    );
    await vi.waitFor(() => expect(state(env, id)).toBe('idle'));
    await vi.waitFor(() => expect(env.close).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it('适配器说还有后台工作时不释放，之后再问', async () => {
    const env = setup();
    let busy = true;
    const holds = vi.fn(async () => busy);
    Object.assign(env.adapter, { holdsIdleWork: holds });
    const id = await newSession(env);
    await turn(env, id, 'hello');

    await vi.waitFor(() => expect(holds.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
    });
    expect(env.close).not.toHaveBeenCalled();
    busy = false;
    await vi.waitFor(() => expect(env.close).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it('适配器查询出错时照常释放，记告警', async () => {
    const env = setup();
    Object.assign(env.adapter, {
      holdsIdleWork: async () => {
        throw new Error('boom');
      },
    });
    const id = await newSession(env);
    await turn(env, id, 'hello');
    await vi.waitFor(() => expect(env.close).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(env.warnings).toEqual(['空闲释放前查询引擎失败，照常释放']);
  });

  it('引擎关闭失败只记告警，下次发消息照样恢复', async () => {
    const env = setup();
    env.close.mockRejectedValueOnce(new Error('gone'));
    const id = await newSession(env);
    await turn(env, id, 'hello');
    await vi.waitFor(() => expect(env.warnings).toEqual(['空闲释放时关闭引擎会话失败']), {
      timeout: 2000,
    });
    await turn(env, id, 'again');
    expect(env.resume).toHaveBeenCalledTimes(1);
  });

  it('关掉的会话、idleReleaseMs 为 0 时不释放', async () => {
    const off = setup({ idleReleaseMs: 0 });
    const id = await newSession(off);
    await turn(off, id, 'hello');
    await delay(RELEASE_MS * 4);
    expect(off.close).not.toHaveBeenCalled();

    const env = setup();
    const closed = await newSession(env);
    await env.manager.close(closed);
    await delay(RELEASE_MS * 4);
    expect(env.close).toHaveBeenCalledTimes(1);
  });
});
