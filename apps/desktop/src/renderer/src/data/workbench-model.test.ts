import type { Session, Workspace } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { groupSessions, resolveRoute, sessionMarker, type WorkbenchData } from './workbench-model';

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
  it('会话归到各自的工作区下并保持原顺序；未知工作区的会话不显示', () => {
    const entries = groupSessions(
      [workspace('ws_a'), workspace('ws_b')],
      [session('ses_2', 'ws_a'), session('ses_3', 'ws_x'), session('ses_1', 'ws_a')],
    );
    expect(entries.map((entry) => [entry.workspace.id, entry.sessions.map((s) => s.id)])).toEqual([
      ['ws_a', ['ses_2', 'ses_1']],
      ['ws_b', []],
    ]);
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

describe('resolveRoute', () => {
  const ready: WorkbenchData = {
    status: 'ready',
    workspaces: groupSessions(
      [workspace('ws_a'), workspace('ws_b')],
      [session('ses_1', 'ws_a'), session('ses_2', 'ws_b')],
    ),
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
