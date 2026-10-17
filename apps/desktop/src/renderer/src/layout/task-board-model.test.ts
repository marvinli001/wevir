import type { BoardTask, SessionId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  BOARD_STATUS_ORDER,
  boardGroups,
  boardProgress,
  resolveSession,
  type SessionDirectory,
} from './task-board-model';

const ROOT = 'ses_root' as SessionId;
const WORKER = 'ses_worker' as SessionId;
const CHILD = 'ses_child' as SessionId;
const GONE = 'ses_gone' as SessionId;

const directory: SessionDirectory = {
  rootId: ROOT,
  workspaceId: 'ws_1',
  subagents: [
    { sessionId: CHILD, title: '', nickname: 'Scout' },
    { sessionId: 'ses_named' as SessionId, title: '查日志', nickname: undefined },
  ],
  sessions: [
    { id: ROOT, workspaceId: 'ws_1', title: '主会话' },
    { id: WORKER, workspaceId: 'ws_2', title: '  ' },
  ],
  untitled: '未命名',
};

let counter = 0;
function task(id: string, extra: Partial<BoardTask> = {}): BoardTask {
  counter += 1;
  return {
    id,
    subject: `任务 ${id}`,
    status: 'pending',
    blockedBy: [],
    notes: [],
    createdBy: ROOT,
    createdAt: `2026-10-17T08:00:0${counter % 10}.000Z`,
    updatedAt: '2026-10-17T08:00:00.000Z',
    ...extra,
  };
}

describe('resolveSession', () => {
  it('清单所在的会话是“本会话”；子智能体先认（标题，没有就昵称），再认列表里的会话，都不是就不认识', () => {
    expect(resolveSession(ROOT, directory)).toEqual({ kind: 'self' });
    expect(resolveSession(CHILD, directory)).toEqual({
      kind: 'subagent',
      title: 'Scout',
      to: '/workspace/ws_1/session/ses_root/agent/ses_child',
    });
    expect(resolveSession('ses_named', directory)).toMatchObject({
      kind: 'subagent',
      title: '查日志',
    });
    // 别的项目里的会话按它自己的项目去；没有标题写“未命名”。
    expect(resolveSession(WORKER, directory)).toEqual({
      kind: 'session',
      title: '未命名',
      to: '/workspace/ws_2/session/ses_worker',
    });
    expect(resolveSession(GONE, directory)).toEqual({ kind: 'unknown' });
  });
});

describe('boardGroups', () => {
  it('按状态分组，空组不出现，组内保持清单里的先后', () => {
    const groups = boardGroups(
      [
        task('t1', { status: 'completed' }),
        task('t2'),
        task('t3', { status: 'in_progress', owner: WORKER }),
        task('t4', { status: 'cancelled' }),
        task('t5', { status: 'in_progress', owner: CHILD }),
        task('t6'),
      ],
      directory,
    );
    expect(groups.map((group) => [group.status, group.rows.map((row) => row.task.id)])).toEqual([
      ['in_progress', ['t3', 't5']],
      ['pending', ['t2', 't6']],
      ['completed', ['t1']],
      ['cancelled', ['t4']],
    ]);
    expect(BOARD_STATUS_ORDER).toEqual(groups.map((group) => group.status));
    expect(
      boardGroups([task('t1', { status: 'completed' })], directory).map((g) => g.status),
    ).toEqual(['completed']);
    expect(boardGroups([], directory)).toEqual([]);
  });

  it('等着谁：只算还没做完的依赖；做完或取消的依赖、已经被删掉的依赖都不挡；能开始的才标 ready', () => {
    const rows = boardGroups(
      [
        task('t1', { status: 'completed' }),
        task('t2', { status: 'in_progress', owner: WORKER }),
        task('t3', { blockedBy: ['t1', 't2'] }),
        task('t4', { blockedBy: ['t1', 't9'] }),
        task('t5', { status: 'cancelled' }),
        task('t6', { blockedBy: ['t5'] }),
        task('t7', { status: 'in_progress', blockedBy: ['t2'] }),
      ],
      directory,
    ).flatMap((group) => group.rows);
    const row = (id: string) => rows.find((item) => item.task.id === id);
    expect(row('t3')).toMatchObject({ waitingFor: ['t2'], ready: false });
    expect(row('t4')).toMatchObject({ waitingFor: [], ready: true });
    expect(row('t6')).toMatchObject({ waitingFor: [], ready: true });
    // 在做的不标可开始；做完的不再等任何人。
    expect(row('t2')).toMatchObject({ waitingFor: [], ready: false });
    expect(row('t7')).toMatchObject({ waitingFor: ['t2'], ready: false });
    expect(row('t1')).toMatchObject({ waitingFor: [], ready: false });
  });

  it('认领的会话、备注的作者认出来；有说明或备注的才能展开', () => {
    const [group] = boardGroups(
      [
        task('t1', {
          status: 'in_progress',
          owner: CHILD,
          description: '看一下日志',
          notes: [
            { sessionId: CHILD, text: '找到了', at: '2026-10-17T08:01:00.000Z' },
            { sessionId: GONE, text: '路过', at: '2026-10-17T08:02:00.000Z' },
          ],
        }),
        task('t2', { status: 'in_progress' }),
        task('t3', { status: 'in_progress', description: '只有说明' }),
      ],
      directory,
    );
    const [first, second, third] = group?.rows ?? [];
    expect(first?.owner).toMatchObject({ kind: 'subagent', title: 'Scout' });
    expect(first?.notes.map((note) => [note.author.kind, note.text])).toEqual([
      ['subagent', '找到了'],
      ['unknown', '路过'],
    ]);
    expect(first?.expandable).toBe(true);
    expect(second).not.toHaveProperty('owner');
    expect(second?.expandable).toBe(false);
    expect(third?.expandable).toBe(true);
  });
});

describe('boardProgress', () => {
  it('完成数 / 总数，取消的不算', () => {
    expect(
      boardProgress([
        task('t1', { status: 'completed' }),
        task('t2'),
        task('t3', { status: 'in_progress' }),
        task('t4', { status: 'cancelled' }),
      ]),
    ).toEqual({ done: 1, total: 3 });
    expect(boardProgress([task('t1', { status: 'cancelled' })])).toEqual({ done: 0, total: 0 });
    expect(boardProgress([])).toEqual({ done: 0, total: 0 });
  });
});
