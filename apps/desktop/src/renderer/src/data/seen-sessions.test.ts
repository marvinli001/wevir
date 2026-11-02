import type { Session } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { isUnread } from './seen-sessions';

const NOW = '2026-10-31T10:48:21.839Z';

function session(extra: Partial<Session> = {}): Session {
  return {
    id: 'ses_a',
    workspaceId: 'ws_a',
    cwd: '/tmp/ws_a',
    engine: { kind: 'codex', sessionId: 'e1' },
    providerId: 'mock',
    modelId: 'mock-model',
    title: '',
    titleSource: 'first_prompt',
    state: 'idle',
    createdAt: NOW,
    updatedAt: NOW,
    lastSeq: 41,
    ...extra,
  } as Session;
}

describe('isUnread', () => {
  it('看过之后只有引擎重启、关闭、恢复这类事件（只推进 lastSeq）时仍是已读（0.147.0）', () => {
    const seen = { ses_a: 41 };
    expect(isUnread(seen, session({ lastSeq: 55, activitySeq: 40 }))).toBe(false);
    expect(isUnread(seen, session({ lastSeq: 60, activitySeq: 58 }))).toBe(true);
  });

  it('旧 Host 没有最近活动时按 lastSeq；没记过起点的会话不算未读', () => {
    expect(isUnread({ ses_a: 41 }, session({ lastSeq: 42 }))).toBe(true);
    expect(isUnread({ ses_a: 41 }, session({ lastSeq: 41 }))).toBe(false);
    expect(isUnread({}, session({ lastSeq: 55, activitySeq: 50 }))).toBe(false);
  });
});
