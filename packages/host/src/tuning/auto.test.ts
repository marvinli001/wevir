import { join } from 'node:path';
import type { HostSettings, SessionId } from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import { useStorages, useTempDir } from '../test-utils.js';
import { AUTO_TUNING_IDLE_MS, AutoTuner } from './auto.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-10-22T00:00:00.000Z';
const NOW = '2026-10-22T12:00:00.000Z';

function setup() {
  const storage: Storage = storages.open(join(tempDir(), 'data'));
  for (const [id, rootPath] of [
    ['ws_1', '/p'],
    ['ws_chats', '/chats'],
  ] as const) {
    storage.workspaces.insert({ id, rootPath, displayName: id, createdAt: T0, updatedAt: T0 });
  }
  let seq = 0;
  const session = (id: string, extra: { workspaceId?: string; parentSessionId?: string } = {}) => {
    storage.sessions.insert({
      id,
      workspaceId: extra.workspaceId ?? 'ws_1',
      cwd: '/p',
      engine: 'echo',
      engineSessionId: id,
      providerId: 'p',
      modelId: 'm',
      title: '',
      titleSource: 'first_prompt',
      state: 'idle',
      lastSeq: 0,
      createdAt: T0,
      updatedAt: T0,
      ...(extra.parentSessionId !== undefined && { parentSessionId: extra.parentSessionId }),
    });
    return id as SessionId;
  };
  const turns = (sessionId: string, count: number, ts = '2026-10-22T11:00:00.000Z') => {
    for (let i = 0; i < count; i++) {
      seq += 1;
      storage.events.insert({
        sessionId,
        seq,
        ts,
        type: 'turn.finished',
        source: 'host',
        payload: { turnId: `trn_${seq}`, outcome: 'completed', durationMs: 1 },
      });
    }
  };
  const settings: HostSettings = { sendWhileBusy: 'steer', autoTuning: true };
  const state = { trial: false, exhausted: false, now: NOW };
  const generated: string[] = [];
  const evaluated: string[] = [];
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let timerId = 0;
  let release: (() => void) | undefined;
  const tuner = new AutoTuner({
    storage,
    settings: () => settings,
    trials: {
      hasTrial: () => state.trial,
      budget: () => ({
        month: '2026-10',
        limitTokens: 1,
        usedTokens: 0,
        autoTokens: 0,
        exhausted: state.exhausted,
      }),
      evaluate: async (workspaceId) => {
        evaluated.push(workspaceId);
      },
    },
    generate: async (sessionId) => {
      generated.push(sessionId);
      if (release !== undefined) await new Promise<void>((resolve) => (release = resolve));
    },
    isChats: (workspace) => workspace.rootPath === '/chats',
    now: () => new Date(state.now),
    setTimer: (callback, ms) => {
      timerId += 1;
      timers.set(timerId, { callback, ms });
      return timerId;
    },
    clearTimer: (id) => timers.delete(id as number),
  });
  const fire = async () => {
    const all = [...timers.entries()];
    timers.clear();
    for (const [, timer] of all) timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const autoRun = (sessionId: string, createdAt: string, workspaceId = 'ws_1') =>
    storage.tuningRuns.insert({
      id: `trr_${createdAt}`,
      workspaceId,
      sessionId,
      origin: 'auto',
      proposals: 0,
      createdAt,
    });
  return {
    storage,
    tuner,
    session,
    turns,
    settings,
    state,
    generated,
    evaluated,
    timers,
    fire,
    autoRun,
    hold: () => {
      release = () => {};
      return () => release?.();
    },
  };
}

describe('AutoTuner', () => {
  it('回合结束后空闲 10 分钟生成；新回合重新计时；关着时不生成', async () => {
    const h = setup();
    const id = h.session('ses_1');
    h.turns(id, 2);
    h.tuner.onTurnFinished(id);
    h.tuner.onTurnFinished(id);
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([AUTO_TUNING_IDLE_MS]);
    expect(h.evaluated).toEqual(['ws_1', 'ws_1']);
    h.settings.autoTuning = false;
    await h.fire();
    expect(h.generated).toEqual([]);
    h.settings.autoTuning = true;
    h.tuner.onTurnFinished(id);
    await h.fire();
    expect(h.generated).toEqual(['ses_1']);
  });

  it('子会话、“对话”里的会话不计时', () => {
    const h = setup();
    h.session('ses_parent');
    const child = h.session('ses_child', { parentSessionId: 'ses_parent' });
    const chat = h.session('ses_chat', { workspaceId: 'ws_chats' });
    h.tuner.onTurnFinished(child);
    h.tuner.onTurnFinished(chat);
    expect(h.timers.size).toBe(0);
    expect(h.evaluated).toEqual([]);
  });

  it('条件：至少 2 个新回合、项目间隔 30 分钟、没有试用、没到上限', async () => {
    const h = setup();
    const id = h.session('ses_1');
    h.turns(id, 1, '2026-10-22T10:00:00.000Z');
    expect(await h.tuner.run(id)).toBe(false);
    h.turns(id, 1, '2026-10-22T10:30:00.000Z');
    expect(await h.tuner.run(id)).toBe(true);
    // 这个会话上次自动生成之后只有 1 个回合。
    h.autoRun(id, '2026-10-22T10:45:00.000Z');
    h.turns(id, 1, '2026-10-22T11:00:00.000Z');
    expect(await h.tuner.run(id)).toBe(false);
    // 换个会话：项目 30 分钟内生成过。
    const other = h.session('ses_2');
    h.turns(other, 3);
    h.state.now = '2026-10-22T11:10:00.000Z';
    expect(await h.tuner.run(other)).toBe(false);
    h.state.now = NOW;
    expect(await h.tuner.run(other)).toBe(true);
    h.state.trial = true;
    expect(await h.tuner.run(other)).toBe(false);
    h.state.trial = false;
    h.state.exhausted = true;
    expect(await h.tuner.run(other)).toBe(false);
    expect(h.generated).toEqual(['ses_1', 'ses_2']);
  });

  it('关闭、归档前：有没到点的计时就现在生成；同一项目同时只跑一个', async () => {
    const h = setup();
    const id = h.session('ses_1');
    h.turns(id, 2);
    await h.tuner.beforeClose(id);
    expect(h.generated).toEqual([]);
    h.tuner.onTurnFinished(id);
    await h.tuner.beforeClose(id);
    expect(h.generated).toEqual(['ses_1']);
    expect(h.timers.size).toBe(0);

    const other = h.session('ses_2');
    h.turns(other, 2);
    const done = h.hold();
    const first = h.tuner.run(other);
    expect(await h.tuner.run(other)).toBe(false);
    done();
    expect(await first).toBe(true);
  });
});
