// 共享任务清单的应用级工具（domain-model §3.15 的“任务清单”一条）：`wevir_tasks`、`wevir_task_create`、`wevir_task_update`
// 交给 task-board.ts 的 TaskBoardStore。清单属于会话树的根（`rootOf`），树里的会话共用。像记忆工具一样不走批准——只写 Host
// 数据目录里 Wevir 自己的文件，不碰用户的项目——所以都标 `readOnlyHint`（同 `wevir_memory_*`，runtime-adapter 的
// `APP_TOOLS_NO_APPROVAL` 也列了）。

import type { SessionId } from '@wevir/protocol';
import { type AppTool, AppToolError, jsonResult } from './app-mcp.js';
import { objectSchema, optionalString, requiredString } from './app-tools.js';
import {
  type BoardTask,
  TASK_DESCRIPTION_MAX,
  TASK_NOTE_MAX,
  TASK_STATUSES,
  TASK_SUBJECT_MAX,
  TaskBoardError,
  type TaskBoardStore,
  type TaskPatch,
  type TaskStatus,
  unmetBlockers,
} from './task-board.js';

/** 任务清单工具的名字（都不用批准）。 */
export const TASK_TOOLS = ['wevir_tasks', 'wevir_task_create', 'wevir_task_update'] as const;

const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE_ANNOTATIONS = { ...ANNOTATIONS, idempotentHint: false };

export interface TaskToolsOptions {
  tasks: TaskBoardStore;
  /** 调工具的会话所在的会话树的根；会话不在了时抛 AppToolError。 */
  rootOf: (sessionId: SessionId) => SessionId;
  /** 认领的会话是不是同一棵树里的；不在时说明原因（给模型看）。 */
  ownerCheck: (root: SessionId, owner: string) => SessionId;
  /** 认领的会话现在的标题与状态，给清单加上下文；会话不在了时 `undefined`。 */
  describeOwner?: (sessionId: SessionId) => { title: string; state: string } | undefined;
  /** 只有用户能标完成的清单（助理的，0.120.0）：Agent 标 `completed` 时拒绝。 */
  userCompletes?: (root: SessionId) => boolean;
}

export function taskTools({
  tasks,
  rootOf,
  ownerCheck,
  describeOwner,
  userCompletes,
}: TaskToolsOptions): AppTool[] {
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof TaskBoardError) throw new AppToolError(error.message);
      throw error;
    }
  };
  const idList = (args: Record<string, unknown>, key: string): string[] | undefined => {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw new AppToolError(`${key} must be a list of task ids.`);
    }
    return value as string[];
  };
  /** `me` 是自己，`none` 放掉，其余是会话 ID（要在同一棵树里）。 */
  const ownerOf = (
    args: Record<string, unknown>,
    caller: SessionId,
    root: SessionId,
    allowNone: boolean,
  ): SessionId | null | undefined => {
    const owner = optionalString(args, 'owner');
    if (owner === undefined) return undefined;
    if (owner === 'me') return caller;
    if (owner === 'none') {
      if (!allowNone) throw new AppToolError('owner "none" only makes sense when updating a task.');
      return null;
    }
    return ownerCheck(root, owner);
  };
  const view = (task: BoardTask, all: readonly BoardTask[], caller: SessionId, full: boolean) => {
    const owner = task.owner === undefined ? undefined : describeOwner?.(task.owner);
    const unmet = unmetBlockers(all, task);
    return {
      id: task.id,
      subject: task.subject,
      status: task.status,
      ...(task.owner !== undefined && {
        owner: task.owner,
        ...(task.owner === caller && { ownedByYou: true }),
        ...(owner !== undefined && { ownerTitle: owner.title, ownerState: owner.state }),
      }),
      ...(task.blockedBy.length > 0 && { blockedBy: task.blockedBy }),
      // 能开始做：还没开始、没人认领（或是自己的）、依赖都做完了。
      ...(task.status === 'pending' &&
        unmet.length === 0 &&
        (task.owner === undefined || task.owner === caller) && { ready: true }),
      ...(unmet.length > 0 && { waitingFor: unmet.map((blocker) => blocker.id) }),
      ...(full && {
        ...(task.description !== undefined && { description: task.description }),
        notes: task.notes,
        createdBy: task.createdBy,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      }),
    };
  };

  return [
    {
      name: 'wevir_tasks',
      title: 'List shared tasks',
      description:
        'The task list shared by this session, the sessions it opened and their subagents: who is doing what, ' +
        'what waits for what, what is ready to start. status "open" (default: pending and in progress), ' +
        '"all" or one status; owner "me", "none" (unclaimed) or a session id. id returns one task in full ' +
        '(description and notes). Check it before you start work so you do not repeat what another session ' +
        'is doing, and claim a task before you begin it.',
      inputSchema: objectSchema({
        status: { type: 'string', enum: ['open', 'all', ...TASK_STATUSES] },
        owner: { type: 'string' },
        id: { type: 'string' },
      }),
      annotations: ANNOTATIONS,
      call: async (args, { sessionId }) => {
        const root = rootOf(sessionId);
        const all = await guard(() => tasks.list(root));
        const id = optionalString(args, 'id');
        if (id !== undefined) {
          const task = all.find((candidate) => candidate.id === id);
          if (task === undefined) throw new AppToolError(`No task ${id} on this board.`);
          return jsonResult({ board: root, task: view(task, all, sessionId, true) });
        }
        const status = optionalString(args, 'status') ?? 'open';
        if (
          status !== 'open' &&
          status !== 'all' &&
          !(TASK_STATUSES as readonly string[]).includes(status)
        ) {
          throw new AppToolError(`status must be open, all or one of ${TASK_STATUSES.join(', ')}.`);
        }
        const owner = optionalString(args, 'owner');
        const shown = all.filter((task) => {
          if (status === 'open' && task.status !== 'pending' && task.status !== 'in_progress') {
            return false;
          }
          if (status !== 'open' && status !== 'all' && task.status !== status) return false;
          if (owner === 'me') return task.owner === sessionId;
          if (owner === 'none') return task.owner === undefined;
          return owner === undefined || task.owner === owner;
        });
        const counts = Object.fromEntries(
          TASK_STATUSES.map((s) => [s, all.filter((task) => task.status === s).length]),
        );
        return jsonResult({
          board: root,
          counts,
          tasks: shown.map((task) => view(task, all, sessionId, false)),
        });
      },
    },
    {
      name: 'wevir_task_create',
      title: 'Add a shared task',
      description:
        'Add a task to the shared list. subject is a short imperative; description says what done looks like. ' +
        'blockedBy lists ids of tasks that must finish first. owner "me" claims it for yourself, or give the id ' +
        'of a session in this tree; assigning only records it, it does not wake the session (message it with ' +
        'wevir_session_send to make it start). Returns the new id.',
      inputSchema: objectSchema(
        {
          subject: { type: 'string', maxLength: TASK_SUBJECT_MAX },
          description: { type: 'string', maxLength: TASK_DESCRIPTION_MAX },
          blockedBy: { type: 'array', items: { type: 'string' } },
          owner: { type: 'string' },
        },
        ['subject'],
      ),
      annotations: WRITE_ANNOTATIONS,
      call: async (args, { sessionId }) => {
        const root = rootOf(sessionId);
        const owner = ownerOf(args, sessionId, root, false);
        const description = optionalString(args, 'description');
        const blockedBy = idList(args, 'blockedBy');
        const created = await guard(() =>
          tasks.create(
            root,
            {
              subject: requiredString(args, 'subject'),
              ...(description !== undefined && { description }),
              ...(blockedBy !== undefined && { blockedBy }),
              ...(owner !== undefined && owner !== null && { owner }),
            },
            sessionId,
          ),
        );
        const all = await guard(() => tasks.list(root));
        return jsonResult({ board: root, task: view(created, all, sessionId, true) });
      },
    },
    {
      name: 'wevir_task_update',
      title: 'Update a shared task',
      description:
        'Change a task: status (pending, in_progress, completed, cancelled), owner ("me" to claim it, "none" to ' +
        'release it, or a session id in this tree), subject, description, addBlockedBy / removeBlockedBy, or add a ' +
        'short note about progress or findings. Starting a task (in_progress) claims it for you unless it has an ' +
        'owner; a task owned by another session only takes notes from you, and a task cannot start or finish while ' +
        'what it waits for is open. Mark your task completed as soon as it is done. delete=true removes it.',
      inputSchema: objectSchema(
        {
          id: { type: 'string' },
          status: { type: 'string', enum: [...TASK_STATUSES] },
          owner: { type: 'string' },
          subject: { type: 'string', maxLength: TASK_SUBJECT_MAX },
          description: { type: 'string', maxLength: TASK_DESCRIPTION_MAX },
          addBlockedBy: { type: 'array', items: { type: 'string' } },
          removeBlockedBy: { type: 'array', items: { type: 'string' } },
          note: { type: 'string', maxLength: TASK_NOTE_MAX },
          delete: { type: 'boolean' },
        },
        ['id'],
      ),
      annotations: WRITE_ANNOTATIONS,
      call: async (args, { sessionId }) => {
        const root = rootOf(sessionId);
        const id = requiredString(args, 'id');
        if (args.delete === true) {
          const removed = await guard(() => tasks.remove(root, id, sessionId));
          return jsonResult({ board: root, deleted: removed.id });
        }
        const status = optionalString(args, 'status');
        if (status !== undefined && !(TASK_STATUSES as readonly string[]).includes(status)) {
          throw new AppToolError(`status must be one of ${TASK_STATUSES.join(', ')}.`);
        }
        if (status === 'completed' && userCompletes?.(root) === true) {
          throw new AppToolError(
            'Only the user marks tasks on this list completed. Add a note saying it is done and tell the user.',
          );
        }
        const owner = ownerOf(args, sessionId, root, true);
        const patch: TaskPatch = {};
        const subject = optionalString(args, 'subject');
        if (subject !== undefined) patch.subject = subject;
        // 空字符串清掉说明：optionalString 把 '' 当没给，这里要区分。
        if (typeof args.description === 'string') patch.description = args.description;
        if (status !== undefined) patch.status = status as TaskStatus;
        if (owner !== undefined) patch.owner = owner;
        const add = idList(args, 'addBlockedBy');
        if (add !== undefined) patch.addBlockedBy = add;
        const remove = idList(args, 'removeBlockedBy');
        if (remove !== undefined) patch.removeBlockedBy = remove;
        const note = optionalString(args, 'note');
        if (note !== undefined) patch.note = note;
        if (Object.keys(patch).length === 0) {
          throw new AppToolError('Nothing to change: give status, owner, a note or another field.');
        }
        const updated = await guard(() => tasks.update(root, id, patch, sessionId));
        const all = await guard(() => tasks.list(root));
        return jsonResult({ board: root, task: view(updated, all, sessionId, true) });
      },
    },
  ];
}
