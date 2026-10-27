// 新会话到第一段回答的本地耗时（startup-timing.ts）：阶段的记法、p50 / p90，以及 SessionManager 在建会话与第一个回合里记下的阶段。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { describe, expect, it } from 'vitest';
import { EventStore } from './event-store.js';
import { newId } from './ids.js';
import { SessionManager } from './session-manager.js';
import {
  percentile,
  STARTUP_STAGES,
  type StartupSummary,
  type StartupTiming,
  StartupTimings,
} from './startup-timing.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();

describe('StartupTimings', () => {
  it('记下各阶段距开始的毫秒数，同一阶段只记第一次，第一段回答时交出', () => {
    let clock = 0;
    const done: Array<[StartupTiming, StartupSummary]> = [];
    const timings = new StartupTimings({
      now: () => clock,
      onDone: (timing, summary) => done.push([timing, summary]),
    });
    timings.begin('ses_a', 10);
    clock = 12.34;
    timings.mark('ses_a', 'prepared');
    clock = 40;
    timings.mark('ses_a', 'created');
    timings.mark('ses_unknown', 'created');
    clock = 50;
    timings.mark('ses_a', 'send');
    clock = 60;
    timings.mark('ses_a', 'send');
    expect(done).toEqual([]);
    clock = 110;
    timings.mark('ses_a', 'firstDelta');
    expect(done).toEqual([
      [
        { sessionId: 'ses_a', stages: { prepared: 2.3, created: 30, send: 40, firstDelta: 100 } },
        {
          count: 1,
          p50: { prepared: 2.3, created: 30, send: 40, firstDelta: 100 },
          p90: { prepared: 2.3, created: 30, send: 40, firstDelta: 100 },
        },
      ],
    ]);
    // 交出之后不再记这个会话。
    timings.mark('ses_a', 'firstDelta');
    expect(done).toHaveLength(1);
  });

  it('p50 / p90 只算最近的若干个会话', () => {
    let clock = 0;
    let last: StartupSummary | undefined;
    const timings = new StartupTimings({
      now: () => clock,
      window: 10,
      onDone: (_, summary) => {
        last = summary;
      },
    });
    for (let i = 1; i <= 15; i++) {
      timings.begin(`ses_${i}`, 0);
      clock = i;
      timings.mark(`ses_${i}`, 'firstDelta');
    }
    expect(last).toEqual({ count: 10, p50: { firstDelta: 10 }, p90: { firstDelta: 14 } });
  });

  it('丢掉的会话与超出上限的最早会话不计', () => {
    const done: string[] = [];
    const timings = new StartupTimings({
      now: () => 1,
      maxOpen: 2,
      onDone: ({ sessionId }) => done.push(sessionId),
    });
    timings.begin('ses_a', 0);
    timings.begin('ses_b', 0);
    timings.begin('ses_c', 0);
    timings.drop('ses_b');
    for (const id of ['ses_a', 'ses_b', 'ses_c']) timings.mark(id, 'firstDelta');
    expect(done).toEqual(['ses_c']);
  });

  it('percentile 用最近秩法', () => {
    expect(percentile([1], 0.9)).toBe(1);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});

describe('SessionManager 的启动耗时', () => {
  it('新会话的第一个回合按顺序记下全部阶段', async () => {
    const dir = realpathSync(tempDir());
    const workspace = join(dir, 'ws');
    mkdirSync(workspace);
    const storage = storages.open(join(dir, 'data'));
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const timings: StartupTiming[] = [];
    const sessions = new SessionManager({
      storage,
      events,
      adapter: new EchoAdapter({ stepDelayMs: 0 }),
      onStartupTiming: (timing) => timings.push(timing),
    });
    const now = '2026-10-27T00:00:00.000Z';
    const workspaceId = newId('ws') as WorkspaceId;
    storage.workspaces.insert({
      id: workspaceId,
      displayName: 'ws',
      rootPath: workspace,
      createdAt: now,
      updatedAt: now,
    });
    storage.providers.insert({
      id: 'mock',
      kind: 'openai-compatible',
      displayName: 'Mock',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'm' }],
      defaultModelId: 'm',
      createdAt: now,
      updatedAt: now,
    });
    const session = await sessions.create({
      workspaceId,
      providerId: 'mock',
    });
    expect(timings).toEqual([]);
    await sessions.send(
      { sessionId: session.id, content: [{ type: 'text', text: 'hello' }] },
      identity,
    );
    await expect.poll(() => timings.length).toBe(1);
    const [timing] = timings;
    expect(timing?.sessionId).toBe(session.id);
    const values = STARTUP_STAGES.map((stage) => timing?.stages[stage]);
    expect(values.every((value) => typeof value === 'number')).toBe(true);
    // `handed` 与 `firstDelta` 谁先到要看引擎；之前的阶段有先后。
    const ordered = values.slice(0, 5) as number[];
    expect([...ordered].sort((a, b) => a - b)).toEqual(ordered);
    await sessions.dispose();
  });
});
