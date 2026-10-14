import type { Session, WevirEventOf } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { adaptEventForClient, adaptResultForClient } from './rpc-connection.js';
import { SES, T0 } from './test-utils.js';

// 按连接的能力位降级（host-api.md §10）。0.5.0：`TitleSource` 的 `generated` 只发给声明了 `title_source_generated`
// 的连接，其余连接看到 `first_prompt`；事件不扣下，seq 不变。

const titleEvent: WevirEventOf<'session.title_changed'> = {
  seq: 7,
  sessionId: SES,
  ts: T0,
  type: 'session.title_changed',
  source: 'host',
  payload: { title: '修复登录', source: 'generated', description: '登录 500' },
};

const session = (titleSource: Session['titleSource']): Session => ({
  id: SES,
  workspaceId: 'ws_1',
  cwd: '/w',
  engine: { kind: 'codex', sessionId: 'thread-1' },
  providerId: 'p',
  modelId: 'm',
  title: '修复登录',
  titleSource,
  state: 'idle',
  createdAt: T0,
  updatedAt: T0,
  lastSeq: 7,
});

describe('adaptEventForClient', () => {
  it('不认识 generated 的连接：降级成 first_prompt，其余不变', () => {
    expect(adaptEventForClient(titleEvent, {})).toEqual({
      ...titleEvent,
      payload: { ...titleEvent.payload, source: 'first_prompt' },
    });
    expect(adaptEventForClient(titleEvent, { title_source_generated: true })).toBe(titleEvent);
    const user = { ...titleEvent, payload: { title: 't', source: 'user' as const } };
    expect(adaptEventForClient(user, {})).toBe(user);
  });
});

describe('adaptResultForClient', () => {
  it('会话的结果（create / get / resume / list）里的 titleSource 一样降级', () => {
    expect(adaptResultForClient('session.create', { session: session('generated') }, {})).toEqual({
      session: session('first_prompt'),
    });
    expect(
      adaptResultForClient(
        'session.get',
        { session: session('generated'), pendingApprovals: [] },
        {},
      ),
    ).toEqual({ session: session('first_prompt'), pendingApprovals: [] });
    expect(
      adaptResultForClient(
        'session.list',
        { sessions: [session('generated'), session('user')] },
        {},
      ),
    ).toEqual({ sessions: [session('first_prompt'), session('user')] });
    const result = { session: session('generated') };
    expect(adaptResultForClient('session.resume', result, { title_source_generated: true })).toBe(
      result,
    );
    expect(adaptResultForClient('workspace.list', { workspaces: [] }, {})).toEqual({
      workspaces: [],
    });
  });
});
