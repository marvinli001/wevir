// 不在项目里的会话（0.39.0，domain-model §3.1）：Host 自己的“对话”工作区在 `<数据目录>/chats`，每个会话在它下面有一个新建的
// 文件夹 `<会话 ID>`。工作区第一次有对话时才建（之前 `workspace.list` 里没有它）；按 rootPath 认出它，不另存种类。

import { mkdir, realpath, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Storage, WorkspaceRecord } from '@wevir/storage';
import { newId } from './ids.js';

/** 老客户端不认 `kind`，在它那里这是一个叫这个名字的项目。 */
export const CHATS_DISPLAY_NAME = 'Chats';

export class ChatFolders {
  readonly #dir: string;
  /** `#dir` 的 realpath（工作区按 realpath 去重）；`#root()` 第一次调用时建目录、解析。 */
  #rootPath: string | undefined;

  constructor(options: { dir: string }) {
    this.#dir = options.dir;
  }

  /** 已知的“对话”工作区目录；还没建过时是 undefined。 */
  get rootPath(): string | undefined {
    return this.#rootPath;
  }

  /** 是不是“对话”工作区。 */
  isChats(workspace: Pick<WorkspaceRecord, 'rootPath'>): boolean {
    return this.#rootPath !== undefined && workspace.rootPath === this.#rootPath;
  }

  /** 路径在“对话”工作区里（含它本身）：不能作为项目添加。`path` 要是 realpath。 */
  owns(path: string): boolean {
    const root = this.#rootPath;
    return root !== undefined && (path === root || path.startsWith(`${root}${sep}`));
  }

  /** 启动时调用：目录已经在的话记下 realpath，`workspace.list` 才认得出已有的“对话”工作区。 */
  async load(): Promise<void> {
    try {
      this.#rootPath = await realpath(this.#dir);
    } catch {
      // 还没有对话。
    }
  }

  /** “对话”工作区：没有就建（目录与工作区行），移除过的恢复。 */
  async workspace(storage: Storage, now: string): Promise<WorkspaceRecord> {
    const rootPath = await this.#root();
    const existing = storage.workspaces.getByRootPath(rootPath);
    if (existing) {
      if (existing.removedAt !== undefined) storage.workspaces.restore(existing.id, now);
      return storage.workspaces.get(existing.id) ?? existing;
    }
    const record: WorkspaceRecord = {
      id: newId('ws'),
      rootPath,
      displayName: CHATS_DISPLAY_NAME,
      createdAt: now,
      updatedAt: now,
    };
    storage.workspaces.insert(record);
    return record;
  }

  /** 给会话新建的空文件夹；`undo` 在会话没建成时删掉它。 */
  async createSessionDir(sessionId: string): Promise<{ path: string; undo: () => Promise<void> }> {
    const path = join(await this.#root(), sessionId);
    await mkdir(path, { mode: 0o700 });
    return { path, undo: () => rm(path, { recursive: true, force: true }) };
  }

  async #root(): Promise<string> {
    if (this.#rootPath === undefined) {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 });
      this.#rootPath = await realpath(this.#dir);
    }
    return this.#rootPath;
  }
}
