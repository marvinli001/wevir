import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { idleCompactionWindow } from './idle-compaction.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const managers: SessionManager[] = [];
const adapters: EchoAdapter[] = [];
const T0 = '2026-11-03T00:00:00.000Z';

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const adapter of adapters.splice(0)) await adapter.dispose();
  vi.useRealTimers();
});

class WarmEchoAdapter extends EchoAdapter {
  expiresAt: string | undefined;
  contextUsed = 220_000;
  alreadyCompacted = false;

  override async *subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    for await (const event of super.subscribe(engineSessionId)) {
      if (event.type === 'turn.settled') {
        if (this.alreadyCompacted) {
          yield {
            type: 'context.compacted',
            engineSessionId,
            compactionId: 'already-compacted',
            trigger: 'auto',
          };
        }
        yield {
          type: 'usage.updated',
          engineSessionId,
          contextUsed: this.contextUsed,
          contextSize: 1_000_000,
          ...(this.expiresAt !== undefined && { promptCacheExpiresAt: this.expiresAt }),
        };
      }
      yield event;
    }
  }
}

async function setup(ttlMinutes = 5) {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const storage = storages.open(join(tempDir(), 'data'));
  const cwd = join(tempDir(), 'workspace');
  mkdirSync(cwd);
  storage.workspaces.insert({
    id: 'ws_1',
    rootPath: cwd,
    displayName: 'ws',
    createdAt: T0,
    updatedAt: T0,
  });
  storage.providers.insert({
    id: 'claude',
    kind: 'claude',
    displayName: 'Claude',
    models: [{ id: 'm' }],
    defaultModelId: 'm',
    createdAt: T0,
    updatedAt: T0,
  });
  const adapter = new WarmEchoAdapter({ stepDelayMs: 0 });
  adapters.push(adapter);
  adapter.expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  const compact = vi.spyOn(adapter, 'compact');
  const events = new EventStore({ storage });
  const controls = { enabled: true, background: false };
  const errors: unknown[] = [];
  const manager = new SessionManager({
    storage,
    events,
    adapter,
    idleCompaction: {
      enabled: () => controls.enabled,
      hasBackgroundWork: () => controls.background,
    },
    onError: (error) => errors.push(error),
  });
  managers.push(manager);
  const created = await manager.create({ workspaceId: 'ws_1', providerId: 'claude' });
  const id = created.id as SessionId;
  const send = async () => {
    await manager.send({ sessionId: id, content: [{ type: 'text', text: 'hello' }] }, identity);
    await vi.advanceTimersByTimeAsync(10);
    expect(events.snapshot(id)?.session.state).toBe('idle');
  };
  return { storage, adapter, compact, events, controls, manager, errors, id, send };
}

describe('Claude 闲置压缩', () => {
  it.each([5, 60])('%i 分钟缓存：提前两分钟压缩，一次闲置只做一次', async (ttl) => {
    const h = await setup(ttl);
    await h.send();
    await vi.advanceTimersByTimeAsync((ttl - 2) * 60_000 - 11);
    expect(h.compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(h.compact).toHaveBeenCalledTimes(1);
    const started = h.events.readSince(h.id, 0).filter((event) => event.type === 'turn.started');
    expect(started.at(-1)?.payload).toMatchObject({ command: { kind: 'compact' } });
    await vi.advanceTimersByTimeAsync(ttl * 60_000);
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.errors).toEqual([]);
  });

  it.each(['off', 'small', 'unknown', 'expired', 'compacted', 'background'] as const)(
    '%s：不排压缩',
    async (condition) => {
      const h = await setup();
      if (condition === 'off') h.controls.enabled = false;
      if (condition === 'small') h.adapter.contextUsed = 199_999;
      if (condition === 'unknown') h.adapter.expiresAt = undefined;
      if (condition === 'expired') h.adapter.expiresAt = T0;
      if (condition === 'compacted') h.adapter.alreadyCompacted = true;
      if (condition === 'background') h.controls.background = true;
      await h.send();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(h.compact).not.toHaveBeenCalled();
    },
  );

  it.each(['off', 'background', 'close', 'archive', 'dispose', 'cold'] as const)(
    '%s：到点重新检查，不发出压缩',
    async (condition) => {
      const h = await setup();
      await h.send();
      if (condition === 'off') h.controls.enabled = false;
      if (condition === 'background') h.controls.background = true;
      if (condition === 'close') await h.manager.close(h.id);
      if (condition === 'archive') await h.manager.archive(h.id, true);
      if (condition === 'dispose') await h.manager.dispose();
      if (condition === 'cold') vi.setSystemTime(Date.now() + 6 * 60_000);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(h.compact).not.toHaveBeenCalled();
      expect(h.errors).toEqual([]);
    },
  );

  it('新回合替换旧计时器，未知的新缓存期限清掉旧值', async () => {
    const h = await setup();
    await h.send();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    h.adapter.expiresAt = undefined;
    await h.send();
    expect(h.events.snapshot(h.id)?.usage?.promptCacheExpiresAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it('窗口开始前不做，回合结束时已在窗口内则立即做', async () => {
    const h = await setup(1);
    await h.send();
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it('有待发消息、未决问题或活动子会话时没有压缩窗口', async () => {
    const h = await setup();
    await h.send();
    const snapshot = h.events.snapshot(h.id);
    if (snapshot === undefined) throw new Error('missing session');
    expect(idleCompactionWindow(snapshot, Date.now())).toBeDefined();
    expect(
      idleCompactionWindow({ ...snapshot, pendingMessages: [{}] } as typeof snapshot, Date.now()),
    ).toBeUndefined();
    expect(
      idleCompactionWindow({ ...snapshot, pendingQuestions: [{}] } as typeof snapshot, Date.now()),
    ).toBeUndefined();
    expect(
      idleCompactionWindow({ ...snapshot, pendingApprovals: [{}] } as typeof snapshot, Date.now()),
    ).toBeUndefined();
    expect(
      idleCompactionWindow(
        { ...snapshot, subagents: [{ status: 'running' }] } as typeof snapshot,
        Date.now(),
      ),
    ).toBeUndefined();
  });
});
