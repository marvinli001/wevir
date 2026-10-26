// 共享任务清单（domain-model §3.15 的“任务清单”一条）：一个会话和它开出来的所有会话（再加引擎派出的子 agent）共用一张清单，
// 用 `wevir_tasks` / `wevir_task_create` / `wevir_task_update` 分工：谁在做哪一项、哪一项等哪一项、做到哪儿了。形态照 Claude Code
// 的任务清单（主题、说明、状态、认领、依赖）。
//
// 一张清单属于这棵会话树的根（没有上级的那个会话），存成 `<数据目录>/tasks/<根会话 ID>.json`（0600，临时文件加 rename 原子写），
// 同一张清单的改动排队依次做；Host 启动时清掉根会话已经不在的清单。清单只是登记：给别人派了一项不会叫醒它，要它动手还得发消息。

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BoardTask as ProtocolBoardTask, SessionId } from '@wevir/protocol';
import type { EventStore } from './event-store.js';

export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 一张清单最多几项（含做完的）；满了要先删掉做完的。 */
export const TASKS_MAX = 200;
export const TASK_SUBJECT_MAX = 200;
export const TASK_DESCRIPTION_MAX = 2000;
/** 一项最多留几条备注、每条多少字符；旧的先丢。 */
export const TASK_NOTES_MAX = 20;
export const TASK_NOTE_MAX = 500;
/** `tasks.board_updated` 事件里每项带最近几条备注（0.52.0）。 */
export const TASK_EVENT_NOTES = 5;

export interface TaskNote {
  sessionId: SessionId;
  text: string;
  at: string;
}

export interface BoardTask {
  /** 清单里的编号，`t1`、`t2`……不重用。 */
  id: string;
  subject: string;
  description?: string;
  status: TaskStatus;
  /** 认领的会话；没人认领时省略。 */
  owner?: SessionId;
  /** 要先做完（完成或取消）的几项。 */
  blockedBy: string[];
  notes: TaskNote[];
  createdBy: SessionId;
  createdAt: string;
  updatedAt: string;
}

interface Board {
  version: 1;
  nextId: number;
  tasks: BoardTask[];
}

export type TaskBoardErrorCode = 'invalid' | 'not_found' | 'limit' | 'owned' | 'blocked' | 'cycle';

/** 参数不合规、找不到、被别人认领、被依赖挡住：消息给模型看，写得能让它改正。 */
export class TaskBoardError extends Error {
  readonly code: TaskBoardErrorCode;
  constructor(code: TaskBoardErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface TaskCreateInput {
  subject: string;
  description?: string;
  blockedBy?: string[];
  owner?: SessionId;
}

export interface TaskPatch {
  subject?: string;
  description?: string;
  status?: TaskStatus;
  /** `null` 放掉认领。 */
  owner?: SessionId | null;
  addBlockedBy?: string[];
  removeBlockedBy?: string[];
  note?: string;
}

const isResolved = (task: BoardTask): boolean =>
  task.status === 'completed' || task.status === 'cancelled';

/** 还没做完的依赖项（找不到的算已解除：被删掉了）。 */
export function unmetBlockers(board: readonly BoardTask[], task: BoardTask): BoardTask[] {
  return task.blockedBy.flatMap((id) => {
    const blocker = board.find((candidate) => candidate.id === id);
    return blocker !== undefined && !isResolved(blocker) ? [blocker] : [];
  });
}

function clipText(text: string, max: number, field: string): string {
  const trimmed = text.trim();
  if (Array.from(trimmed).length > max) {
    throw new TaskBoardError('invalid', `${field} is longer than ${max} characters.`);
  }
  return trimmed;
}

function subjectOf(text: string): string {
  const subject = clipText(text.replace(/\s+/g, ' '), TASK_SUBJECT_MAX, 'subject');
  if (subject === '') throw new TaskBoardError('invalid', 'subject must not be empty.');
  return subject;
}

/** 清单里的 ID 是 `t<序号>`；模型常写成 `1`、`#1` 或 `T1`，这些都当作 `t1`，别的原样（照常报找不到）。 */
export function normalizeTaskId(raw: string): string {
  const id = raw.trim().replace(/^#/, '');
  return /^t?\d+$/i.test(id) ? `t${id.replace(/^t/i, '')}` : id;
}

function find(tasks: readonly BoardTask[], id: string): BoardTask {
  const task = tasks.find((candidate) => candidate.id === id);
  if (task === undefined) {
    throw new TaskBoardError(
      'not_found',
      `No task ${id} on this board${tasks.length === 0 ? ' (it is empty)' : `; tasks: ${tasks.map((t) => t.id).join(', ')}`}.`,
    );
  }
  return task;
}

/** 加上依赖后会不会绕回自己。 */
function reaches(tasks: readonly BoardTask[], from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) stack.push(...task.blockedBy);
  }
  return false;
}

function checkBlockers(tasks: readonly BoardTask[], taskId: string, ids: readonly string[]): void {
  for (const id of ids) {
    if (id === taskId) throw new TaskBoardError('cycle', `Task ${taskId} cannot wait for itself.`);
    find(tasks, id);
    if (reaches(tasks, id, taskId)) {
      throw new TaskBoardError(
        'cycle',
        `Task ${id} already waits for ${taskId}; that would be a loop.`,
      );
    }
  }
}

/** 新建一项（改 `board`，返回新的那项）。 */
export function applyCreate(
  board: Board,
  input: TaskCreateInput,
  by: SessionId,
  now: string,
): BoardTask {
  if (board.tasks.length >= TASKS_MAX) {
    throw new TaskBoardError(
      'limit',
      `The board already has ${TASKS_MAX} tasks; delete finished ones (wevir_task_update delete=true) first.`,
    );
  }
  const id = `t${board.nextId}`;
  const blockedBy = [...new Set(input.blockedBy ?? [])];
  checkBlockers(board.tasks, id, blockedBy);
  const description =
    input.description === undefined
      ? undefined
      : clipText(input.description, TASK_DESCRIPTION_MAX, 'description');
  const task: BoardTask = {
    id,
    subject: subjectOf(input.subject),
    ...(description !== undefined && description !== '' && { description }),
    status: 'pending',
    ...(input.owner !== undefined && { owner: input.owner }),
    blockedBy,
    notes: [],
    createdBy: by,
    createdAt: now,
    updatedAt: now,
  };
  board.nextId += 1;
  board.tasks.push(task);
  return task;
}

/**
 * 改一项。认领的规则：没人认领、自己认领、自己建的，才能改它的内容、状态和认领；别人认领的只能加备注。开始（`in_progress`）
 * 或完成要等依赖项做完；开始时没人认领就由改的人认领。
 */
export function applyUpdate(
  board: Board,
  id: string,
  patch: TaskPatch,
  by: SessionId,
  now: string,
): BoardTask {
  const task = find(board.tasks, id);
  const changesTask =
    patch.subject !== undefined ||
    patch.description !== undefined ||
    patch.status !== undefined ||
    patch.owner !== undefined ||
    (patch.addBlockedBy?.length ?? 0) > 0 ||
    (patch.removeBlockedBy?.length ?? 0) > 0;
  if (changesTask && task.owner !== undefined && task.owner !== by && task.createdBy !== by) {
    throw new TaskBoardError(
      'owned',
      `Task ${id} is owned by ${task.owner}; you can only add a note. Ask its owner, or pick another task.`,
    );
  }
  const next: BoardTask = { ...task, blockedBy: [...task.blockedBy], notes: [...task.notes] };
  if (patch.subject !== undefined) next.subject = subjectOf(patch.subject);
  if (patch.description !== undefined) {
    const description = clipText(patch.description, TASK_DESCRIPTION_MAX, 'description');
    if (description === '') delete next.description;
    else next.description = description;
  }
  const remove = new Set(patch.removeBlockedBy ?? []);
  next.blockedBy = next.blockedBy.filter((blocker) => !remove.has(blocker));
  const add = [...new Set(patch.addBlockedBy ?? [])].filter(
    (blocker) => !next.blockedBy.includes(blocker),
  );
  checkBlockers(board.tasks, id, add);
  next.blockedBy.push(...add);
  if (patch.owner !== undefined) {
    if (patch.owner === null) delete next.owner;
    else next.owner = patch.owner;
  }
  if (patch.status !== undefined) {
    next.status = patch.status;
    if (patch.status === 'in_progress' && next.owner === undefined) next.owner = by;
  }
  if (
    patch.status !== undefined &&
    patch.status !== task.status &&
    (patch.status === 'in_progress' || patch.status === 'completed')
  ) {
    const unmet = unmetBlockers(board.tasks, next);
    if (unmet.length > 0) {
      throw new TaskBoardError(
        'blocked',
        `Task ${id} waits for ${unmet.map((blocker) => `${blocker.id} (${blocker.status})`).join(', ')}; finish those first.`,
      );
    }
  }
  if (patch.note !== undefined) {
    const text = clipText(patch.note, TASK_NOTE_MAX, 'note');
    if (text !== '') {
      next.notes.push({ sessionId: by, text, at: now });
      if (next.notes.length > TASK_NOTES_MAX)
        next.notes.splice(0, next.notes.length - TASK_NOTES_MAX);
    }
  }
  next.updatedAt = now;
  Object.assign(task, next);
  // 去掉被放掉的字段（Object.assign 不会删）。
  if (next.owner === undefined) delete task.owner;
  if (next.description === undefined) delete task.description;
  return task;
}

/** 删一项（同时从别的项的依赖里去掉）。同样要求没人认领、自己认领或自己建的。 */
export function applyRemove(board: Board, id: string, by: SessionId): BoardTask {
  const task = find(board.tasks, id);
  if (task.owner !== undefined && task.owner !== by && task.createdBy !== by) {
    throw new TaskBoardError(
      'owned',
      `Task ${id} is owned by ${task.owner}; only its owner or creator can delete it.`,
    );
  }
  board.tasks = board.tasks.filter((candidate) => candidate.id !== id);
  for (const other of board.tasks)
    other.blockedBy = other.blockedBy.filter((blocker) => blocker !== id);
  return task;
}

/** 清单在事件与快照里的样子（0.52.0 的 `tasks.board_updated`）：每项的备注只留最近 `TASK_EVENT_NOTES` 条。 */
export function boardEventTasks(tasks: readonly BoardTask[]): ProtocolBoardTask[] {
  return tasks.map((task) => ({
    ...task,
    blockedBy: [...task.blockedBy],
    notes: task.notes.slice(-TASK_EVENT_NOTES).map((note) => ({ ...note })),
  }));
}

/**
 * `TaskBoardStoreOptions.onChange` 的实现：把改完的清单作为 `tasks.board_updated` 写进根会话的事件流。根会话已经不在、事件被
 * 拒绝时只记一条警告，不让工具调用失败。
 */
export function boardEventRecorder(
  events: Pick<EventStore, 'append'>,
  onWarning?: (message: string, fields?: Record<string, unknown>) => void,
): NonNullable<TaskBoardStoreOptions['onChange']> {
  return (root, tasks) => {
    try {
      events.append(root, {
        type: 'tasks.board_updated',
        source: 'host',
        payload: { tasks: boardEventTasks(tasks) },
      });
    } catch (error) {
      onWarning?.('failed to record task board update', { sessionId: root, error });
    }
  };
}

export interface TaskBoardStoreOptions {
  /** `<数据目录>/tasks`。 */
  dir: string;
  now?: () => string;
  /**
   * 一次改动写盘之后调用（建、改、删各一次），带着改完的整张清单；Host 用它往根会话的事件流里写 `tasks.board_updated`。
   * 回调抛错不影响改动本身。
   */
  onChange?: (root: SessionId, tasks: readonly BoardTask[]) => void;
}

export class TaskBoardStore {
  readonly #dir: string;
  readonly #now: () => string;
  readonly #onChange: TaskBoardStoreOptions['onChange'];
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: TaskBoardStoreOptions) {
    this.#dir = options.dir;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#onChange = options.onChange;
  }

  async list(root: SessionId): Promise<BoardTask[]> {
    return (await this.#read(root)).tasks;
  }

  create(root: SessionId, input: TaskCreateInput, by: SessionId): Promise<BoardTask> {
    return this.#mutate(root, (board) => applyCreate(board, input, by, this.#now()));
  }

  update(root: SessionId, id: string, patch: TaskPatch, by: SessionId): Promise<BoardTask> {
    return this.#mutate(root, (board) => applyUpdate(board, id, patch, by, this.#now()));
  }

  remove(root: SessionId, id: string, by: SessionId): Promise<BoardTask> {
    return this.#mutate(root, (board) => applyRemove(board, id, by));
  }

  /** 清掉根会话已经不在的清单；返回清掉几张。 */
  async sweep(exists: (sessionId: string) => boolean): Promise<number> {
    const names = await readdir(this.#dir).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names) {
      const match = /^((?:ses|chn)_[A-Za-z0-9]+)\.json$/.exec(name);
      if (match === null || exists(match[1] as string)) continue;
      await rm(join(this.#dir, name), { force: true }).catch(() => undefined);
      removed += 1;
    }
    return removed;
  }

  #file(root: SessionId): string {
    // 根是会话，或频道（0.120.0：频道里的会话共用频道的清单）。
    if (!/^(?:ses|chn)_[A-Za-z0-9]+$/.test(root))
      throw new TaskBoardError('invalid', 'bad session id');
    return join(this.#dir, `${root}.json`);
  }

  async #read(root: SessionId): Promise<Board> {
    const text = await readFile(this.#file(root), 'utf8').catch(() => undefined);
    if (text === undefined) return { version: 1, nextId: 1, tasks: [] };
    try {
      const board = JSON.parse(text) as Board;
      if (board.version === 1 && Array.isArray(board.tasks) && Number.isInteger(board.nextId)) {
        return board;
      }
    } catch {
      // 手改坏了：当空清单，下一次写入时覆盖。
    }
    return { version: 1, nextId: 1, tasks: [] };
  }

  /** 同一张清单的改动排队：读、改、原子写；改动抛错时不写。 */
  #mutate<T>(root: SessionId, change: (board: Board) => T): Promise<T> {
    const key = String(root);
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const run = previous.then(async () => {
      const board = await this.#read(root);
      const result = change(board);
      await mkdir(this.#dir, { recursive: true, mode: 0o700 });
      const file = this.#file(root);
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, `${JSON.stringify(board, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
      try {
        this.#onChange?.(root, board.tasks);
      } catch {
        // 通知失败不算改动失败：清单已经写好了。
      }
      return result;
    });
    const tail = run.catch(() => undefined);
    this.#queues.set(key, tail);
    void tail.then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    });
    return run;
  }
}
