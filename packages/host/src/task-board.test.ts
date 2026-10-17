import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  boardEventRecorder,
  boardEventTasks,
  TASK_EVENT_NOTES,
  TASK_NOTE_MAX,
  TASK_NOTES_MAX,
  TASK_SUBJECT_MAX,
  TASKS_MAX,
  TaskBoardError,
  TaskBoardStore,
  unmetBlockers,
} from './task-board.js';
import { useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const ROOT = 'ses_root' as SessionId;
const A = 'ses_a' as SessionId;
const B = 'ses_b' as SessionId;

function store() {
  let tick = 0;
  return new TaskBoardStore({
    dir: join(tempDir(), 'tasks'),
    now: () => new Date(Date.UTC(2026, 9, 17, 0, 0, tick++)).toISOString(),
  });
}

const code = async (run: Promise<unknown>) =>
  run.then(
    () => 'ok',
    (error: unknown) => (error instanceof TaskBoardError ? error.code : 'other'),
  );

describe('TaskBoardStore', () => {
  it('建、改、认领、备注；编号递增不重用；写入的时刻按顺序', async () => {
    const tasks = store();
    const first = await tasks.create(ROOT, { subject: '  Do   it  ', description: ' details ' }, A);
    expect(first).toMatchObject({
      id: 't1',
      subject: 'Do it',
      description: 'details',
      status: 'pending',
      blockedBy: [],
      notes: [],
      createdBy: A,
    });
    await tasks.create(ROOT, { subject: 'second' }, A);
    await tasks.remove(ROOT, 't2', A);
    expect((await tasks.create(ROOT, { subject: 'third' }, A)).id).toBe('t3');

    // 开始时没人认领就认领；清空说明；备注带谁写的。
    const started = await tasks.update(
      ROOT,
      't1',
      { status: 'in_progress', description: '', note: ' halfway ' },
      B,
    );
    expect(started).toMatchObject({ status: 'in_progress', owner: B });
    expect(started).not.toHaveProperty('description');
    expect(started.notes).toEqual([{ sessionId: B, text: 'halfway', at: expect.any(String) }]);
    expect(started.updatedAt > first.updatedAt).toBe(true);
  });

  it('认领：别人认领的只能加备注，创建者可以收回或删；放掉后别人能认领', async () => {
    const tasks = store();
    await tasks.create(ROOT, { subject: 'x', owner: B }, A);
    expect(await code(tasks.update(ROOT, 't1', { status: 'in_progress' }, ROOT))).toBe('owned');
    expect(await code(tasks.remove(ROOT, 't1', ROOT))).toBe('owned');
    expect(await code(tasks.update(ROOT, 't1', { note: 'fyi' }, ROOT))).toBe('ok');
    // A 建的，可以收回。
    expect((await tasks.update(ROOT, 't1', { owner: null }, A)).owner).toBeUndefined();
    expect((await tasks.update(ROOT, 't1', { owner: ROOT }, ROOT)).owner).toBe(ROOT);
  });

  it('依赖：开始与完成要等依赖做完（取消也算），不能成环，删掉依赖项后解除', async () => {
    const tasks = store();
    await tasks.create(ROOT, { subject: 'a' }, A);
    await tasks.create(ROOT, { subject: 'b', blockedBy: ['t1'] }, A);
    await tasks.create(ROOT, { subject: 'c', blockedBy: ['t2', 't2'] }, A);
    expect((await tasks.list(ROOT))[2]?.blockedBy).toEqual(['t2']);
    expect(await code(tasks.update(ROOT, 't2', { status: 'in_progress' }, A))).toBe('blocked');
    expect(await code(tasks.update(ROOT, 't2', { status: 'completed' }, A))).toBe('blocked');
    expect(await code(tasks.update(ROOT, 't1', { addBlockedBy: ['t3'] }, A))).toBe('cycle');
    expect(await code(tasks.update(ROOT, 't1', { addBlockedBy: ['t1'] }, A))).toBe('cycle');
    expect(await code(tasks.update(ROOT, 't1', { addBlockedBy: ['t8'] }, A))).toBe('not_found');
    // 取消也解除依赖。
    await tasks.update(ROOT, 't1', { status: 'cancelled' }, A);
    expect(await code(tasks.update(ROOT, 't2', { status: 'in_progress' }, A))).toBe('ok');
    expect(
      unmetBlockers(await tasks.list(ROOT), (await tasks.list(ROOT))[2] as never),
    ).toHaveLength(1);
    // 删掉被依赖的，依赖也去掉。
    await tasks.remove(ROOT, 't2', A);
    expect((await tasks.list(ROOT)).find((task) => task.id === 't3')?.blockedBy).toEqual([]);
    // 加一个已经取消的依赖不挡路；再去掉。
    await tasks.update(ROOT, 't3', { addBlockedBy: ['t1'] }, A);
    const t3 = (await tasks.list(ROOT)).find((task) => task.id === 't3');
    expect(t3?.blockedBy).toEqual(['t1']);
    expect(unmetBlockers(await tasks.list(ROOT), t3 as never)).toEqual([]);
    await tasks.update(ROOT, 't3', { removeBlockedBy: ['t1'] }, A);
    expect((await tasks.list(ROOT)).find((task) => task.id === 't3')?.blockedBy).toEqual([]);
  });

  it('长度与数量上限：主题、备注（旧的先丢）、清单满了', async () => {
    const tasks = store();
    expect(await code(tasks.create(ROOT, { subject: 'x'.repeat(TASK_SUBJECT_MAX + 1) }, A))).toBe(
      'invalid',
    );
    expect(await code(tasks.create(ROOT, { subject: '' }, A))).toBe('invalid');
    await tasks.create(ROOT, { subject: 'noted' }, A);
    expect(await code(tasks.update(ROOT, 't1', { note: 'x'.repeat(TASK_NOTE_MAX + 1) }, A))).toBe(
      'invalid',
    );
    for (let index = 0; index < TASK_NOTES_MAX + 3; index += 1) {
      await tasks.update(ROOT, 't1', { note: `note ${index}` }, A);
    }
    const notes = (await tasks.list(ROOT))[0]?.notes ?? [];
    expect(notes).toHaveLength(TASK_NOTES_MAX);
    expect(notes[0]?.text).toBe('note 3');
    for (let index = 1; index < TASKS_MAX; index += 1) {
      await tasks.create(ROOT, { subject: `t ${index}` }, A);
    }
    expect(await code(tasks.create(ROOT, { subject: 'one too many' }, A))).toBe('limit');
  });

  it('同一张清单的并发改动排队，不丢写；失败的改动不留痕迹；坏文件当空清单', async () => {
    const tasks = store();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => tasks.create(ROOT, { subject: `p${index}` }, A)),
    );
    const all = await tasks.list(ROOT);
    expect(all.map((task) => task.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `t${index + 1}`),
    );
    expect(
      await code(tasks.update(ROOT, 't1', { status: 'in_progress', addBlockedBy: ['nope'] }, A)),
    ).toBe('not_found');
    expect((await tasks.list(ROOT))[0]?.status).toBe('pending');
  });

  it('onChange：建、改、删各通知一次，带改完的整张清单；失败的改动不通知；回调抛错不影响改动', async () => {
    const seen: string[][] = [];
    const tasks = new TaskBoardStore({
      dir: join(tempDir(), 'tasks'),
      onChange: (root, list) => {
        expect(root).toBe(ROOT);
        seen.push(list.map((task) => `${task.id}:${task.status}`));
        if (seen.length === 2) throw new Error('listener broke');
      },
    });
    await tasks.create(ROOT, { subject: 'a' }, A);
    await tasks.update(ROOT, 't1', { status: 'in_progress' }, A);
    expect(await code(tasks.update(ROOT, 't9', { note: 'x' }, A))).toBe('not_found');
    expect((await tasks.list(ROOT))[0]?.status).toBe('in_progress');
    await tasks.remove(ROOT, 't1', A);
    expect(seen).toEqual([['t1:pending'], ['t1:in_progress'], []]);
  });

  it('事件里的清单：每项只带最近几条备注，不改存储里的', async () => {
    const tasks = store();
    await tasks.create(ROOT, { subject: 'a' }, A);
    for (let index = 1; index <= TASK_EVENT_NOTES + 2; index += 1) {
      await tasks.update(ROOT, 't1', { note: `n${index}` }, B);
    }
    const stored = await tasks.list(ROOT);
    const event = boardEventTasks(stored);
    expect(event[0]?.notes.map((note) => note.text)).toEqual(['n3', 'n4', 'n5', 'n6', 'n7']);
    expect(stored[0]?.notes).toHaveLength(TASK_EVENT_NOTES + 2);
    // 是副本：改事件里的不影响存储里的。
    event[0]?.blockedBy.push('t9');
    expect(stored[0]?.blockedBy).toEqual([]);
  });

  it('boardEventRecorder：写 tasks.board_updated，写不进去（会话不在了）只记警告', () => {
    const appended: unknown[] = [];
    const warnings: string[] = [];
    const record = boardEventRecorder(
      {
        append: ((sessionId: SessionId, input: unknown) => {
          if (sessionId === A) throw new Error('no such session');
          appended.push({ sessionId, input });
        }) as never,
      },
      (message) => warnings.push(message),
    );
    record(ROOT, []);
    record(A, []);
    expect(appended).toEqual([
      {
        sessionId: ROOT,
        input: { type: 'tasks.board_updated', source: 'host', payload: { tasks: [] } },
      },
    ]);
    expect(warnings).toEqual(['failed to record task board update']);
  });
});
