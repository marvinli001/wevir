// 助理的隐藏工作区（0.120.0，ADR-0020 §1）：`<数据目录>/assistants/<频道 ID>/`，`Workspace.kind: 'assistant'`，不进 `workspace.list`。
// 记忆、规则文件、审批规则、护栏、任务清单都按工作区生效，助理有了自己的工作区，这些全部直接可用。按 rootPath 认出它，不另存种类
// （同“对话”工作区，chats.ts）。

import { mkdir, realpath, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Storage, WorkspaceRecord } from '@wevir/storage';
import { newId } from '../ids.js';

export class AssistantFolders {
  readonly #dir: string;
  /** `#dir` 的 realpath；第一次建助理或启动时目录已在才有。 */
  #rootPath: string | undefined;

  constructor(options: { dir: string }) {
    this.#dir = options.dir;
  }

  /** 启动时调用：目录已经在的话记下 realpath。 */
  async load(): Promise<void> {
    try {
      this.#rootPath = await realpath(this.#dir);
    } catch {
      // 还没有助理。
    }
  }

  /** 是不是助理的隐藏工作区。 */
  isAssistant(workspace: Pick<WorkspaceRecord, 'rootPath'>): boolean {
    const root = this.#rootPath;
    return root !== undefined && workspace.rootPath.startsWith(`${root}${sep}`);
  }

  /** 路径在助理的目录里（含它本身）：不能作为项目添加。`path` 要是 realpath。 */
  owns(path: string): boolean {
    const root = this.#rootPath;
    return root !== undefined && (path === root || path.startsWith(`${root}${sep}`));
  }

  /** 给新助理建目录与工作区行；`undo` 在频道没建成时收回。 */
  async create(
    storage: Storage,
    channelId: string,
    displayName: string,
    extraFolders: readonly string[],
    now: string,
  ): Promise<{ workspace: WorkspaceRecord; undo: () => Promise<void> }> {
    if (this.#rootPath === undefined) {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 });
      this.#rootPath = await realpath(this.#dir);
    }
    const rootPath = join(this.#rootPath, channelId);
    await mkdir(rootPath, { mode: 0o700 });
    const workspace: WorkspaceRecord = {
      id: newId('ws'),
      rootPath,
      displayName,
      ...(extraFolders.length > 0 && { extraFolders: [...extraFolders] }),
      createdAt: now,
      updatedAt: now,
    };
    storage.workspaces.insert(workspace);
    return {
      workspace,
      undo: async () => {
        storage.workspaces.markRemoved(workspace.id, now);
        await rm(rootPath, { recursive: true, force: true });
      },
    };
  }
}
