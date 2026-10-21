import type { Session, SessionId, SessionUsage, WorkspaceId } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import { archivedChatRows, deleteChats, usageBytes, worktreeRows } from './storage-model';

const WS = 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR' as WorkspaceId;

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id: id as SessionId,
    workspaceId: WS,
    cwd: '/w',
    engine: { kind: 'echo', sessionId: `e-${id}` },
    providerId: 'mock',
    modelId: 'm',
    title: `title ${id}`,
    titleSource: 'user',
    state: 'closed',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    lastSeq: 3,
    ...extra,
  } as Session;
}

function usage(id: string, extra: Partial<SessionUsage> = {}): SessionUsage {
  return { sessionId: id as SessionId, eventBytes: 10, fileBytes: 0, worktrees: [], ...extra };
}

const worktree = (path: string, bytes: number, dirty = false) => ({
  workspaceId: WS,
  branch: `wevir/${path}`,
  path,
  bytes,
  dirty,
});

describe('storage-model', () => {
  it('usageBytes 加上事件、文件与 worktree', () => {
    expect(
      usageBytes(usage('a', { eventBytes: 1, fileBytes: 2, worktrees: [worktree('/x', 4)] })),
    ).toBe(7);
  });

  it('已归档的会话按大小、再按归档时刻排；没量到的不列；数出有改动的 worktree', () => {
    const rows = archivedChatRows(
      [
        session('a', { archivedAt: '2026-10-03T00:00:00.000Z' }),
        session('b', { archivedAt: '2026-10-02T00:00:00.000Z' }),
        session('c', { archivedAt: '2026-10-01T00:00:00.000Z' }),
        session('d', { archivedAt: '2026-10-01T00:00:00.000Z' }),
      ],
      [
        usage('a'),
        usage('b'),
        usage('c', { worktrees: [worktree('/c1', 100, true), worktree('/c2', 5)] }),
      ],
    );
    expect(rows.map((row) => [row.session.id, row.bytes, row.dirtyWorktrees])).toEqual([
      ['c', 115, 1],
      ['b', 10, 0],
      ['a', 10, 0],
    ]);
  });

  it('worktreeRows 带上会话标题与是否归档，大的在前', () => {
    const rows = worktreeRows(
      [session('a', { archivedAt: '2026-10-03T00:00:00.000Z' }), session('b')],
      [
        usage('a', { worktrees: [worktree('/a', 1)] }),
        usage('b', { worktrees: [worktree('/b', 9, true)] }),
      ],
    );
    expect(rows.map((row) => [row.path, row.title, row.archived, row.dirty])).toEqual([
      ['/b', 'title b', false, true],
      ['/a', 'title a', true, false],
    ]);
  });

  it('worktreeRows 把归档时删掉、有快照的 worktree 记成 snapshot（0.81.0）', () => {
    const rows = worktreeRows(
      [session('a', { archivedAt: '2026-10-03T00:00:00.000Z' })],
      [
        usage('a', {
          worktrees: [
            { ...worktree('/a', 0, true), missing: true, archived: true },
            worktree('/b', 0),
          ],
        }),
      ],
    );
    expect(rows.map((row) => [row.path, row.archived, row.snapshot, row.dirty])).toEqual([
      ['/a', true, true, true],
      ['/b', true, false, false],
    ]);
  });

  it('deleteChats 依次删，有改动的带 force；失败的记下、不挡后面的', async () => {
    const rows = archivedChatRows(
      [session('a'), session('b'), session('c')],
      [
        usage('a', { eventBytes: 30 }),
        usage('b', { eventBytes: 20, worktrees: [worktree('/b', 1, true)] }),
        usage('c'),
      ],
    );
    const remove = vi.fn(async (sessionId: SessionId) => {
      if ((sessionId as string) === 'c') throw new Error('in use');
      return (sessionId as string) === 'b'
        ? { sessionIds: [sessionId], keptBranches: ['wevir/b'], engineDataKept: true as const }
        : { sessionIds: [sessionId] };
    });
    const outcome = await deleteChats(rows, remove, (reason) => (reason as Error).message);
    expect(remove.mock.calls).toEqual([
      ['a', false],
      ['b', true],
      ['c', false],
    ]);
    expect(outcome).toEqual({
      deleted: ['a', 'b'],
      failed: [{ sessionId: 'c', error: 'in use' }],
      keptBranches: ['wevir/b'],
      engineDataKept: true,
    });
  });
});
