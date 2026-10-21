// 删除已归档的会话与按会话的占用（0.43.0，domain-model §3.20）：一个会话的“一家”（它自己、子会话、支线）在库里、数据目录里与
// 引擎那边留下的东西。SessionManager.delete 关闭会话、排进它的命令队列之后调 `deleteSessionData`；`measureUsage` 只读。

import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type {
  ImageId,
  MethodResult,
  SessionId,
  SessionUsage,
  SessionWorktreeUsage,
  WevirEvent,
} from '@wevir/protocol';
import type { AgentRuntimeAdapter } from '@wevir/runtime-adapter';
import { historyFilePath } from '@wevir/runtime-adapter/history-tool';
import type { SessionRecord, Storage } from '@wevir/storage';
import type { ChatFolders } from './chats.js';
import { type FsLimit, fsLimit, sizeOf } from './dir-size.js';
import { HostError } from './errors.js';
import type { EventStore } from './event-store.js';
import { deleteWorktree, worktreeState } from './git-worktree.js';
import type { ImageStore } from './images.js';
import { dropMoveRefs } from './session-move.js';
import {
  type ArchivedWorktree,
  dropArchived,
  dropArchiveRefs,
  readArchived,
} from './worktree-archive.js';

/** 删完之后库文件里空闲页至少这么多时 `VACUUM`，文件才变小。 */
export const VACUUM_MIN_FREE_BYTES = 1024 * 1024;

export interface SessionDataOptions {
  storage: Storage;
  images?: ImageStore | undefined;
  chats?: ChatFolders | undefined;
  /** `<数据目录>/history`。 */
  historyDir?: string | undefined;
  /** `<数据目录>/worktrees`。 */
  worktreesDir?: string | undefined;
  /** `<数据目录>/tool-output`：每个会话一个 `<会话 ID>/`（大输出与后台进程的日志）。 */
  toolOutputDir?: string | undefined;
}

export interface DeleteSessionDeps extends SessionDataOptions {
  adapter: AgentRuntimeAdapter;
  events: EventStore;
  onWarning: (message: string, fields?: Record<string, unknown>) => void;
  /** 断开这些会话的引擎会话、忘掉它们的运行时（SessionManager 的内存状态）。 */
  detach: (sessionIds: readonly SessionId[]) => void;
}

/** Host 为会话开的一个 worktree：根目录在 `<worktreesDir>/<会话 ID>/` 下。 */
interface SessionWorktreeRoot {
  sessionId: string;
  workspaceId: string;
  branch: string;
  root: string;
}

/**
 * 一家会话的 worktree 根目录。`SessionWorktree.path` 是 worktree 里对应工作区的目录（可能是子目录），根是它在
 * `<worktreesDir>/<会话 ID>/` 下的第一级；不在那下面的（不是 Host 开的）不算，绝不去删。
 */
export function worktreeRoots(
  family: readonly SessionRecord[],
  worktreesDir: string | undefined,
): SessionWorktreeRoot[] {
  if (worktreesDir === undefined) return [];
  const roots = new Map<string, SessionWorktreeRoot>();
  for (const record of family) {
    const base = join(worktreesDir, record.id);
    for (const worktree of record.worktrees ?? []) {
      const rel = relative(base, worktree.path);
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      const root = join(base, rel.split(sep)[0] as string);
      if (!roots.has(root)) {
        roots.set(root, {
          sessionId: record.id,
          workspaceId: worktree.workspaceId,
          branch: worktree.branch,
          root,
        });
      }
    }
  }
  return [...roots.values()];
}

/** 一家会话自己的文件（不含 worktree）：历史文件、大输出与进程日志、对话文件夹，以及只有它们引用的图片。 */
function ownedFiles(
  options: SessionDataOptions,
  family: readonly SessionRecord[],
  imageRefs: ReadonlyMap<string, ReadonlySet<string>>,
): { paths: string[]; images: ImageId[] } {
  const ids = new Set(family.map((record) => record.id));
  const paths: string[] = [];
  for (const record of family) {
    if (options.historyDir !== undefined)
      paths.push(historyFilePath(options.historyDir, record.id));
    if (options.toolOutputDir !== undefined) paths.push(join(options.toolOutputDir, record.id));
    const chatDir = options.chats?.sessionDir(record.id);
    const workspace = options.storage.workspaces.get(record.workspaceId);
    // 只有“对话”里的会话、cwd 正是它自己的文件夹时：项目里的会话的 cwd 是用户的目录。
    if (
      chatDir !== undefined &&
      workspace !== undefined &&
      options.chats?.isChats(workspace) === true &&
      record.cwd === chatDir
    ) {
      paths.push(chatDir);
    }
  }
  const images: ImageId[] = [];
  for (const [imageId, sessions] of imageRefs) {
    if ([...sessions].every((sessionId) => ids.has(sessionId))) images.push(imageId as ImageId);
  }
  return { paths, images };
}

/** 会话挂过的引擎会话：建会话时的与每次接力（`session.handoff`）两端的，最后是当前的。 */
export function engineSessionsOf(
  record: SessionRecord,
  events: readonly WevirEvent[],
): { providerId: string; engineSessionId: string }[] {
  const found = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'session.handoff') continue;
    for (const end of [event.payload.from, event.payload.to]) {
      if (!found.has(end.engineSessionId)) found.set(end.engineSessionId, end.providerId);
    }
  }
  found.set(record.engineSessionId, record.providerId);
  return [...found].map(([engineSessionId, providerId]) => ({ providerId, engineSessionId }));
}

/** `session.usage`：每个会话（含它的一家）的事件字节数、文件与 worktree。 */
export async function measureUsage(
  options: SessionDataOptions,
  records: readonly SessionRecord[],
): Promise<SessionUsage[]> {
  const eventBytes = options.storage.events.payloadBytes();
  const imageRefs = options.storage.events.imageRefs();
  const limit = fsLimit();
  return Promise.all(
    records.map(async (record): Promise<SessionUsage> => {
      const family = options.storage.sessions.family(record.id);
      const { paths, images } = ownedFiles(options, family, imageRefs);
      const imagePaths = (
        await Promise.all(images.map((imageId) => options.images?.files(imageId) ?? []))
      ).flat();
      const fileSizes = await Promise.all(
        [...paths, ...imagePaths].map((path) => sizeOf(path, limit)),
      );
      return {
        sessionId: record.id as SessionId,
        eventBytes: family.reduce((sum, member) => sum + (eventBytes.get(member.id) ?? 0), 0),
        fileBytes: fileSizes.reduce((sum, size) => sum + size, 0),
        worktrees: await Promise.all(
          worktreeRoots(family, options.worktreesDir).map(async (worktree) =>
            measureWorktree(
              worktree,
              limit,
              options.worktreesDir === undefined
                ? undefined
                : (await readArchived(options.worktreesDir, worktree.sessionId)).find(
                    (entry) => entry.root === worktree.root,
                  ),
            ),
          ),
        ),
      };
    }),
  );
}

async function measureWorktree(
  worktree: SessionWorktreeRoot,
  limit: FsLimit,
  archived: ArchivedWorktree | undefined,
): Promise<SessionWorktreeUsage> {
  const state = await worktreeState(worktree.root);
  // 0.81.0：归档时删掉了目录、有快照的，`dirty` 是快照里有没有没提交的改动。
  if (state === 'missing' && archived !== undefined) {
    return {
      workspaceId: worktree.workspaceId as SessionWorktreeUsage['workspaceId'],
      branch: worktree.branch,
      path: worktree.root,
      bytes: 0,
      dirty: archived.dirty,
      missing: true,
      archived: true,
    };
  }
  return {
    workspaceId: worktree.workspaceId as SessionWorktreeUsage['workspaceId'],
    branch: worktree.branch,
    path: worktree.root,
    bytes: state === 'missing' ? 0 : await sizeOf(worktree.root, limit),
    dirty: state === 'dirty',
    ...(state === 'missing' && { missing: true as const }),
  };
}

/**
 * 删掉一个已归档、已关闭的顶层会话的一家（调用方已检查过，并且排在它的命令队列里）。顺序：有没提交的改动的 worktree 先拒绝（什么都
 * 不删）；引擎的数据；worktree；库里的行（一个事务）；内存；文件；空闲页多时 `VACUUM`。库删了之后的失败只记告警。
 */
export async function deleteSessionData(
  deps: DeleteSessionDeps,
  record: SessionRecord,
  force: boolean,
): Promise<MethodResult<'session.delete'>> {
  const { storage } = deps;
  const family = storage.sessions.family(record.id);
  const ids = family.map((member) => member.id as SessionId);
  const worktrees = worktreeRoots(family, deps.worktreesDir);
  const states = await Promise.all(worktrees.map((worktree) => worktreeState(worktree.root)));
  // 归档时删掉了目录的（0.81.0）：快照里有没提交的改动的同样算，删会话会连快照一起删掉。
  const archived = new Map<string, ArchivedWorktree>();
  if (deps.worktreesDir !== undefined) {
    for (const member of family) {
      for (const entry of await readArchived(deps.worktreesDir, member.id))
        archived.set(entry.root, entry);
    }
  }
  const dirty = worktrees.filter(
    (worktree, index) =>
      states[index] === 'dirty' ||
      (states[index] === 'missing' && archived.get(worktree.root)?.dirty === true),
  );
  if (dirty.length > 0 && !force) {
    throw new HostError(
      'RESOURCE_IN_USE',
      `session ${record.id} has worktrees with uncommitted changes`,
      {
        sessionIds: [record.id as SessionId],
        worktrees: dirty.map((worktree) => ({ path: worktree.root, branch: worktree.branch })),
      },
    );
  }

  deps.detach(ids);

  // 引擎的数据：顶层会话挂过的每个引擎会话（子会话由引擎随它删，支线引擎不持久化）。
  let engineDataKept = false;
  const engineSessions = engineSessionsOf(record, deps.events.readSince(record.id as SessionId, 0));
  for (const { providerId, engineSessionId } of engineSessions) {
    if (deps.adapter.deleteSession === undefined) {
      engineDataKept = true;
      continue;
    }
    try {
      await deps.adapter.deleteSession(engineSessionId, { providerId });
    } catch (error) {
      engineDataKept = true;
      deps.onWarning('删除会话时引擎的数据没删掉', {
        sessionId: record.id,
        engineSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const keptBranches: string[] = [];
  if (deps.worktreesDir !== undefined) {
    keptBranches.push(...(await dropArchived(deps.worktreesDir, ids)).keptBranches);
  }
  for (const worktree of worktrees) {
    await dropArchiveRefs(worktree.root, worktree.sessionId);
    const { branchKept } = await deleteWorktree(worktree.root, worktree.branch);
    if (branchKept) keptBranches.push(worktree.branch);
  }
  // 移动会话时原处的快照（0.81.0）在项目的仓库里。
  const projectDir = storage.workspaces.get(record.workspaceId)?.rootPath;
  if (projectDir !== undefined) await dropMoveRefs(projectDir, ids);
  if (deps.worktreesDir !== undefined) {
    const dir = deps.worktreesDir;
    await Promise.all(
      ids.map((id) => rm(join(dir, id), { recursive: true, force: true }).catch(() => {})),
    );
  }

  // 图片的归属在删行之前算（删了就看不出别的会话引用没引用）。
  const { paths, images } = ownedFiles(deps, family, storage.events.imageRefs());
  storage.transaction(() => storage.sessions.remove(ids));
  deps.events.forget(ids);

  for (const path of paths) {
    await rm(path, { recursive: true, force: true }).catch((error: unknown) =>
      deps.onWarning('删除会话的文件失败', { path, error: String(error) }),
    );
  }
  for (const imageId of images) {
    await deps.images
      ?.remove(imageId)
      .catch((error: unknown) =>
        deps.onWarning('删除会话的图片失败', { imageId, error: String(error) }),
      );
  }

  try {
    if (storage.freeBytes() >= VACUUM_MIN_FREE_BYTES) storage.vacuum();
  } catch (error) {
    deps.onWarning('删除会话后整理数据库失败', { error: String(error) });
  }

  return {
    sessionIds: ids,
    ...(keptBranches.length > 0 && { keptBranches }),
    ...(engineDataKept && { engineDataKept: true as const }),
  };
}
