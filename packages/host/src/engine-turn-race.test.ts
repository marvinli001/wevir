// 用户的消息交给引擎之前（打快照、跑钩子的那段时间）引擎自己开了回合（目标续跑、子 agent 跑完叫醒父会话）并且已经结束：
// 那个回合的事件并进用户的回合，它的结束不结束用户的回合，用户的消息照样交给引擎、回答照样写进这个回合。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import { type AgentEvent, EventHub } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnCheckpoints } from './checkpoints.js';
import { EventStore } from './event-store.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();

/** EchoAdapter 的事件流里另外并进测试自己发的事件（假装引擎自己开了回合）。 */
class InjectingAdapter extends EchoAdapter {
  readonly injected = new Map<string, EventHub<AgentEvent>>();

  override subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    const echo = super.subscribe(engineSessionId);
    const hub = new EventHub<AgentEvent>();
    this.injected.set(engineSessionId, hub);
    return merge(echo, hub.subscribe());
  }
}

async function* merge(...sources: AsyncIterable<AgentEvent>[]): AsyncIterable<AgentEvent> {
  const iterators = sources.map((source) => source[Symbol.asyncIterator]());
  const next = (index: number) =>
    (iterators[index] as AsyncIterator<AgentEvent>).next().then((result) => ({ index, result }));
  const pending = new Map(iterators.map((_, index) => [index, next(index)]));
  while (pending.size > 0) {
    const { index, result } = await Promise.race(pending.values());
    if (result.done) {
      pending.delete(index);
      continue;
    }
    pending.set(index, next(index));
    yield result.value;
  }
}

describe('交给引擎之前引擎自己开的回合', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  it('那个回合在消息交出之前就结束：不结束用户的回合，消息照样交出，回答写进同一个回合', async () => {
    const root = realpathSync(tempDir());
    const storage = storages.open(join(root, 'data'));
    const workspaceDir = join(root, 'ws');
    mkdirSync(workspaceDir);
    const T0 = '2026-11-05T00:00:00.000Z';
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
    const adapter = new InjectingAdapter({ stepDelayMs: 0 });
    const send = vi.spyOn(adapter, 'send');
    let engineSessionId = '';
    // 打“前”快照的时候引擎开了一个回合、说了一句并结束（叫醒父会话的回合就是这么短）。
    const checkpoints = new Proxy(
      {
        async beforeTurn() {
          const hub = adapter.injected.get(engineSessionId);
          hub?.emit({ type: 'turn.started', engineSessionId });
          hub?.emit({
            type: 'assistant.message',
            engineSessionId,
            messageId: 'wake-1',
            text: 'Subagent finished.',
            replaces: [],
          });
          hub?.emit({
            type: 'turn.settled',
            engineSessionId,
            outcome: 'completed',
            stopReason: 'end_turn',
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      },
      { get: (target, name) => Reflect.get(target, name) ?? (async () => undefined) },
    ) as unknown as TurnCheckpoints;
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const errors: unknown[] = [];
    const manager = new SessionManager({
      storage,
      events,
      adapter,
      checkpoints,
      onError: (error) => errors.push(error),
    });
    managers.push(manager);
    const session = await manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = session.id as SessionId;
    engineSessionId = storage.sessions.get(sessionId)?.engineSessionId ?? '';
    expect(engineSessionId).not.toBe('');

    const { turnId } = await manager.send(
      { sessionId, content: [{ type: 'text', text: 'hello' }] },
      identity,
    );
    await vi.waitFor(() => expect(events.snapshot(sessionId)?.session.state).toBe('idle'));
    expect(send).toHaveBeenCalledTimes(1);
    const all = events.readSince(sessionId, 0);
    // 只有用户的一个回合：引擎回合的话并在里面，之后是给用户消息的回答，回合只结束一次。
    expect(all.filter((event) => event.type === 'turn.started')).toHaveLength(1);
    expect(all.filter((event) => event.type === 'turn.finished')).toMatchObject([
      { payload: { turnId, outcome: 'completed' } },
    ]);
    const said = all.flatMap((event) =>
      event.type === 'assistant.message' && event.payload.turnId === turnId
        ? [event.payload.text]
        : [],
    );
    expect(said[0]).toBe('Subagent finished.');
    expect(said.at(-1)).toContain('hello');
    expect(errors.map(String).join('\n')).not.toContain('没有进行中的回合');
  });
});
