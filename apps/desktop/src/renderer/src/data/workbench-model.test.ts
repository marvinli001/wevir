import type { Session, Workspace } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  groupByStatus,
  groupSessions,
  mergeSessions,
  resolveRoute,
  sessionMarker,
  type WorkbenchData,
} from './workbench-model';

const NOW = '2026-10-13T00:00:00.000Z';

function workspace(id: `ws_${string}`): Workspace {
  return { id, rootPath: `/tmp/${id}`, displayName: id, createdAt: NOW, updatedAt: NOW };
}

function session(id: `ses_${string}`, workspaceId: `ws_${string}`, extra: Partial<Session> = {}) {
  return {
    id,
    workspaceId,
    cwd: `/tmp/${workspaceId}`,
    engine: { kind: 'dsh', sessionId: id },
    providerId: 'mock',
    modelId: 'mock-model',
    title: '',
    titleSource: 'first_prompt',
    state: 'idle',
    createdAt: NOW,
    updatedAt: NOW,
    lastSeq: 1,
    ...extra,
  } satisfies Session;
}

describe('groupSessions', () => {
  it('会话归到各自的工作区下，按最近活动从新到旧；未知工作区的会话不显示', () => {
    const later = '2026-10-13T00:00:05.000Z';
    const entries = groupSessions(
      [workspace('ws_a'), workspace('ws_b')],
      [
        session('ses_1', 'ws_a'),
        session('ses_3', 'ws_x'),
        session('ses_2', 'ws_a'),
        session('ses_0', 'ws_a', { updatedAt: later }),
      ],
    );
    expect(entries.map((entry) => [entry.workspace.id, entry.sessions.map((s) => s.id)])).toEqual([
      ['ws_a', ['ses_0', 'ses_2', 'ses_1']],
      ['ws_b', []],
    ]);
  });
});

describe('mergeSessions', () => {
  it('两边都有时取 lastSeq 大的；列表里没有的会话去掉', () => {
    const liveNewer = session('ses_1', 'ws_a', { lastSeq: 9, state: 'running' });
    const liveOlder = session('ses_2', 'ws_a', { lastSeq: 2 });
    const gone = session('ses_3', 'ws_a');
    const live = new Map([liveNewer, liveOlder, gone].map((s) => [s.id, s] as const));
    const fetchedNewer = session('ses_2', 'ws_a', { lastSeq: 5, title: '新' });
    const added = session('ses_4', 'ws_b');
    const merged = mergeSessions(live, [
      session('ses_1', 'ws_a', { lastSeq: 3 }),
      fetchedNewer,
      added,
    ]);
    expect([...merged.values()]).toEqual([liveNewer, fetchedNewer, added]);
  });
});

describe('sessionMarker', () => {
  it('运行中（含正在取消）、待审批、出错', () => {
    expect(sessionMarker(session('ses_1', 'ws_a', { state: 'running' }))).toBe('running');
    expect(sessionMarker(session('ses_1', 'ws_a', { state: 'cancelling' }))).toBe('running');
    expect(sessionMarker(session('ses_1', 'ws_a', { state: 'awaiting_approval' }))).toBe(
      'awaiting_approval',
    );
    expect(sessionMarker(session('ses_1', 'ws_a', { state: 'error' }))).toBe('error');
  });

  it('空闲时上一回合失败或只读也算出错；正常空闲与已关闭没有标记', () => {
    const lastError = { category: 'provider', message: '401' } as const;
    const readOnly = { reason: 'engine_session_not_found', message: 'gone', since: NOW } as const;
    expect(sessionMarker(session('ses_1', 'ws_a', { lastError }))).toBe('error');
    expect(sessionMarker(session('ses_1', 'ws_a', { readOnly }))).toBe('error');
    expect(sessionMarker(session('ses_1', 'ws_a'))).toBeUndefined();
    expect(sessionMarker(session('ses_1', 'ws_a', { state: 'closed' }))).toBeUndefined();
  });
});

describe('groupByStatus', () => {
  const day = 24 * 60 * 60 * 1000;
  const at = (daysAgo: number) => new Date(Date.parse(NOW) - daysAgo * day).toISOString();
  const ids = (rows: { session: Session }[]) => rows.map((row) => row.session.id);

  it('需要你、进行中、最近 7 天的已完成；关闭了的不出现；组内按最近活动，跨工作区', () => {
    const groups = groupByStatus(
      groupSessions(
        [workspace('ws_a'), workspace('ws_b')],
        [
          session('ses_approve', 'ws_a', { state: 'awaiting_approval', updatedAt: at(0.2) }),
          session('ses_ask', 'ws_b', { state: 'running', awaitingInput: true, updatedAt: at(0.1) }),
          session('ses_failed', 'ws_a', {
            lastError: { category: 'unknown', message: 'x' },
            updatedAt: at(3),
          }),
          session('ses_run', 'ws_b', { state: 'running', updatedAt: at(0.3) }),
          session('ses_stop', 'ws_a', { state: 'cancelling', updatedAt: at(0.4) }),
          session('ses_done', 'ws_b', { updatedAt: at(1) }),
          session('ses_done2', 'ws_a', { updatedAt: at(6.9) }),
          session('ses_old', 'ws_a', { updatedAt: at(8) }),
          session('ses_closed', 'ws_b', { state: 'closed', updatedAt: at(0) }),
          session('ses_closed_ro', 'ws_b', {
            state: 'closed',
            readOnly: { reason: 'engine_session_not_found', message: 'x', since: NOW },
            updatedAt: at(0),
          }),
        ],
      ),
      Date.parse(NOW),
    );
    expect(ids(groups.needsYou)).toEqual(['ses_ask', 'ses_approve', 'ses_failed']);
    expect(ids(groups.running)).toEqual(['ses_run', 'ses_stop']);
    expect(ids(groups.completed)).toEqual(['ses_done', 'ses_done2']);
    expect(groups.needsYou[0]?.workspace.id).toBe('ws_b');
  });
});

describe('resolveRoute', () => {
  const ready: WorkbenchData = {
    status: 'ready',
    workspaces: groupSessions(
      [workspace('ws_a'), workspace('ws_b')],
      [session('ses_1', 'ws_a'), session('ses_2', 'ws_b')],
    ),
    providers: [],
  };

  it('数据没到之前不判未找到', () => {
    expect(resolveRoute({ status: 'loading' }, 'ws_a', 'ses_1')).toEqual({ kind: 'loading' });
    expect(resolveRoute({ status: 'error', error: 'boom' }, 'ws_a')).toEqual({
      kind: 'unavailable',
      error: 'boom',
    });
  });

  it('按 URL 找到会话或草稿', () => {
    expect(resolveRoute(ready, 'ws_a', 'ses_1')).toMatchObject({
      kind: 'session',
      session: { id: 'ses_1' },
    });
    expect(resolveRoute(ready, 'ws_b')).toMatchObject({
      kind: 'draft',
      entry: { workspace: { id: 'ws_b' } },
    });
  });

  it('工作区不存在时是未找到，不回落到第一个工作区', () => {
    expect(resolveRoute(ready, 'ws_gone', 'ses_1')).toEqual({
      kind: 'workspace-not-found',
      workspaceId: 'ws_gone',
    });
    expect(resolveRoute(ready, 'ws_gone')).toEqual({
      kind: 'workspace-not-found',
      workspaceId: 'ws_gone',
    });
  });

  it('会话属于别的工作区也是未找到，不改写 URL 里的工作区', () => {
    expect(resolveRoute(ready, 'ws_a', 'ses_2')).toMatchObject({
      kind: 'session-not-found',
      sessionId: 'ses_2',
      entry: { workspace: { id: 'ws_a' } },
    });
  });
});
