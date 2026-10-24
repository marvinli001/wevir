import type { Session } from '@wevir/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { DONE_MARK_MS, resetSessionMotion, STATUS_JUMP_MS, sessionMotion } from './session-motion';

const NOW = '2026-10-24T00:00:00.000Z';
const LATER = Date.parse(NOW) + 60_000;

function session(extra: Partial<Session> = {}): Session {
  return {
    id: 'ses_a',
    workspaceId: 'ws_a',
    cwd: '/tmp/ws_a',
    engine: { kind: 'codex', sessionId: 'a' },
    providerId: 'mock',
    modelId: 'mock-model',
    title: '',
    titleSource: 'first_prompt',
    state: 'idle',
    createdAt: NOW,
    updatedAt: NOW,
    lastSeq: 1,
    ...extra,
  };
}

describe('sessionMotion', () => {
  beforeEach(() => resetSessionMotion());

  it('plays nothing for the state a session is first seen in', () => {
    expect(sessionMotion(session({ state: 'awaiting_approval', title: 'x' }), LATER)).toEqual({});
  });

  it('plays a session created moments ago from blank', () => {
    const at = Date.parse(NOW) + 300;
    expect(sessionMotion(session({ state: 'awaiting_approval', title: 'approve' }), at)).toEqual({
      markerAt: at,
      markerFrom: undefined,
      titleAt: at,
    });
  });

  it('marks a new status and stops after the jump', () => {
    sessionMotion(session(), LATER + 0);
    expect(sessionMotion(session({ state: 'running' }), LATER + 10)).toEqual({
      markerAt: LATER + 10,
      markerFrom: undefined,
    });
    // 同一份会话再看一次（StrictMode、顶栏）结果不变。
    expect(sessionMotion(session({ state: 'running' }), LATER + 20).markerAt).toBe(LATER + 10);
    expect(sessionMotion(session({ state: 'awaiting_approval' }), LATER + 30)).toMatchObject({
      markerAt: LATER + 30,
      markerFrom: 'running',
    });
    expect(
      sessionMotion(session({ state: 'awaiting_approval' }), LATER + 30 + STATUS_JUMP_MS).markerAt,
    ).toBeUndefined();
  });

  it('draws the done check only for a turn that finished on its own', () => {
    sessionMotion(session({ state: 'running' }), LATER + 0);
    expect(sessionMotion(session(), LATER + 100).doneAt).toBe(LATER + 100);
    expect(sessionMotion(session(), LATER + 100 + DONE_MARK_MS).doneAt).toBeUndefined();

    sessionMotion(session({ state: 'running' }), LATER + 5000);
    sessionMotion(session({ state: 'cancelling' }), LATER + 5100);
    expect(sessionMotion(session(), LATER + 5200).doneAt).toBeUndefined();

    sessionMotion(session({ state: 'running' }), LATER + 6000);
    const failed = { message: 'boom', code: 'engine_error' } as unknown as Session['lastError'];
    expect(sessionMotion(session({ lastError: failed }), LATER + 6100).doneAt).toBeUndefined();
  });

  it('reveals a title that replaces a blank or first-prompt title with a generated one', () => {
    sessionMotion(session(), LATER + 0);
    expect(sessionMotion(session({ title: 'Hello' }), LATER + 10).titleAt).toBe(LATER + 10);
    expect(
      sessionMotion(session({ title: 'Greeting', titleSource: 'generated' }), LATER + 20).titleAt,
    ).toBe(LATER + 20);
    expect(
      sessionMotion(session({ title: 'Renamed', titleSource: 'user' }), LATER + 30).titleAt,
    ).toBeUndefined();
  });
});
