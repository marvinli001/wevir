// session.compact 与 session.review（0.24.0，domain-model §4.7）：由命令开始的回合，经方法表对着 EchoAdapter 的会话。

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
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

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'w',
      GIT_AUTHOR_EMAIL: 'w@example.com',
      GIT_COMMITTER_NAME: 'w',
      GIT_COMMITTER_EMAIL: 'w@example.com',
    },
  });
}

/** 一个有一次提交的仓库，在 `branch` 上（默认 main）。 */
function initRepo(dir: string, branch = 'main'): void {
  git(dir, 'init', '-q', '-b', branch);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

describe('session.compact / session.review', () => {
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
    return { events, manager, methods, workspaceDir };
  }
  const context = { client: identity, capabilities: {} };
  type Env = ReturnType<typeof setup>;

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

  it('压缩：没有 user.message 的回合，turn.started 带 command，回合里有 manual 的压缩事件', async () => {
    const env = setup();
    const sessionId = await newSession(env);
    const { turnId, seq } = await env.methods['session.compact']({ sessionId }, context);
    await idle(env, sessionId);
    const events = turnEvents(env, sessionId, turnId);
    expect(events.map((event) => event.type)).toEqual([
      'turn.started',
      'context.compacting',
      'context.compacted',
      'turn.finished',
    ]);
    expect(events[0]).toMatchObject({ seq, payload: { command: { kind: 'compact' } } });
    expect(events[1]?.payload).toMatchObject({ trigger: 'manual' });
    expect(events[2]?.payload).toEqual(events[1]?.payload);
    expect(events[3]?.payload).toMatchObject({ outcome: 'completed' });
    // 命令回合不起标题。
    expect(env.events.snapshot(sessionId)?.session.title).toBe('');
    expect(env.events.snapshot(sessionId)?.usage?.contextUsed).toBe(50);
  });

  it('引擎在普通回合中间自己压缩：trigger 是 auto', async () => {
    const env = setup();
    const sessionId = await newSession(env);
    const { turnId } = await env.manager.send(
      { sessionId, content: [{ type: 'text', text: 'please compact' }] },
      identity,
    );
    await idle(env, sessionId);
    const types = turnEvents(env, sessionId, turnId as string).map((event) => event.type);
    expect(types).toContain('context.compacted');
    const compacted = env.events
      .readSince(sessionId, 0)
      .find((event) => event.type === 'context.compacted');
    expect(compacted?.payload).toMatchObject({ trigger: 'auto' });
  });

  it('审查未提交的改动与本分支：command 带目标与基础分支，回答是审查结果', async () => {
    const env = setup();
    initRepo(env.workspaceDir);
    git(env.workspaceDir, 'checkout', '-q', '-b', 'feature');
    const sessionId = await newSession(env);

    const uncommitted = await env.methods['session.review'](
      { sessionId, target: 'uncommitted' },
      context,
    );
    await idle(env, sessionId);
    let events = turnEvents(env, sessionId, uncommitted.turnId);
    expect(events[0]?.payload).toMatchObject({
      command: { kind: 'review', target: 'uncommitted' },
    });
    expect(events.find((event) => event.type === 'assistant.message')?.payload).toMatchObject({
      text: 'Echo: Review the uncommitted changes',
    });

    const branch = await env.methods['session.review']({ sessionId, target: 'branch' }, context);
    await idle(env, sessionId);
    events = turnEvents(env, sessionId, branch.turnId);
    expect(events[0]?.payload).toEqual({
      turnId: branch.turnId,
      command: { kind: 'review', target: 'branch', baseBranch: 'main' },
    });
    expect(events.at(-1)?.payload).toMatchObject({ outcome: 'completed' });
  });

  it('审查：不是 git 仓库、找不到基础分支时 INVALID_PARAMS，不写事件', async () => {
    const env = setup();
    const sessionId = await newSession(env);
    const before = env.events.snapshot(sessionId)?.session.lastSeq;
    expect(before).toBeGreaterThan(0);
    await expect(
      env.methods['session.review']({ sessionId, target: 'uncommitted' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

    initRepo(env.workspaceDir, 'trunk');
    await expect(
      env.methods['session.review']({ sessionId, target: 'branch' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(env.events.snapshot(sessionId)?.session.lastSeq).toBe(before);
  });

  it('会话忙时 SESSION_BUSY；命令回合里的插话改为排队', async () => {
    const env = setup(new EchoAdapter({ stepDelayMs: 20 }));
    const sessionId = await newSession(env);
    await env.methods['session.compact']({ sessionId }, context);
    await expect(env.methods['session.compact']({ sessionId }, context)).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    });
    const { pendingId } = await env.manager.send(
      { sessionId, content: [{ type: 'text', text: 'next' }], delivery: 'steer' },
      identity,
    );
    expect(pendingId).toBeDefined();
    const pending = env.events.snapshot(sessionId)?.pendingMessages?.[0];
    expect(pending).toMatchObject({
      delivery: 'queue',
      fallback: { reason: 'rejected' },
    });
    // 改成插话同样不交给引擎。
    const updated = await env.manager.updatePending({
      sessionId,
      pendingId: pendingId as NonNullable<typeof pendingId>,
      delivery: 'steer',
    });
    expect(updated).toMatchObject({ delivery: 'queue', fallback: { reason: 'rejected' } });
    // 压缩结束后，排队的消息作为下一个回合发出。
    await vi.waitFor(() =>
      expect(
        env.events
          .readSince(sessionId, 0)
          .some((event) => event.type === 'user.message' && event.payload.pendingId === pendingId),
      ).toBe(true),
    );
    await idle(env, sessionId);
  });

  it('会话所在的引擎不能压缩、审查时 INVALID_STATE，不写事件', async () => {
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    Object.assign(adapter, { compact: undefined, review: undefined });
    const env = setup(adapter);
    initRepo(env.workspaceDir);
    const sessionId = await newSession(env);
    const before = env.events.snapshot(sessionId)?.session.lastSeq;
    expect(before).toBeGreaterThan(0);
    await expect(env.methods['session.compact']({ sessionId }, context)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await expect(
      env.methods['session.review']({ sessionId, target: 'uncommitted' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(env.events.snapshot(sessionId)?.session.lastSeq).toBe(before);
  });

  it('已关闭的会话 INVALID_STATE（同 send：客户端先 resume）', async () => {
    const env = setup();
    const sessionId = await newSession(env);
    await env.manager.close(sessionId);
    await expect(env.methods['session.compact']({ sessionId }, context)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await env.manager.resume(sessionId);
    const { turnId } = await env.methods['session.compact']({ sessionId }, context);
    await idle(env, sessionId);
    expect(turnEvents(env, sessionId, turnId).at(-1)?.payload).toMatchObject({
      outcome: 'completed',
    });
  });
});
