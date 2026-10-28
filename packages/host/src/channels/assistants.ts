// 助理的隐藏工作区（0.120.0，ADR-0020 §1）：`<数据目录>/assistants/<频道 ID>/`，`Workspace.kind: 'assistant'`，不进 `workspace.list`。
// 记忆、规则文件、审批规则、护栏、任务清单都按工作区生效，助理有了自己的工作区，这些全部直接可用。按 rootPath 认出它，不另存种类
// （同“对话”工作区，chats.ts）。
// 每个助理还有一个跟着它的环境（domain-model §3.10）：只有这个工作区一个文件夹、不开 worktree，协调者与线程都用它建会话；不进
// `environment.list`，也不能改、删，助理删除时随工作区一起删。按主文件夹是助理的工作区认出它。

import { mkdir, realpath, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { EnvironmentRecord, Storage, WorkspaceRecord } from '@wevir/storage';
import { newId } from '../ids.js';

/** 环境名字的上限（同 `environment.create`）。 */
const ENVIRONMENT_NAME_MAX = 60;

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

  /** 是不是助理的环境：主文件夹是助理的工作区。 */
  isAssistantEnvironment(storage: Storage, environment: EnvironmentRecord): boolean {
    const workspaceId = environment.folders[0]?.workspaceId;
    const workspace = workspaceId === undefined ? undefined : storage.workspaces.get(workspaceId);
    return workspace !== undefined && this.isAssistant(workspace);
  }

  /** 给新助理建目录、工作区行与环境；`undo` 在频道没建成时收回。 */
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
    this.environment(storage, workspace.id, displayName, now);
    return {
      workspace,
      undo: async () => {
        await this.remove(storage, workspace.id, now);
      },
    };
  }

  /** 助理的环境 ID；没有（这项功能之前建的助理）就建一个。 */
  environment(storage: Storage, workspaceId: string, name: string, now: string): string {
    const existing = this.#environments(storage, workspaceId)[0];
    if (existing !== undefined) return existing.id;
    const record: EnvironmentRecord = {
      id: newId('env'),
      name: environmentName(name),
      location: { kind: 'local' },
      folders: [{ workspaceId, worktree: 'none' }],
      createdAt: now,
      updatedAt: now,
    };
    storage.environments.insert(record);
    return record.id;
  }

  /** 助理改名时环境跟着改。 */
  rename(storage: Storage, workspaceId: string, name: string, now: string): void {
    for (const environment of this.#environments(storage, workspaceId)) {
      storage.environments.update({ ...environment, name: environmentName(name), updatedAt: now });
    }
  }

  /** 删助理：环境、工作区行与目录都删掉，返回删掉的环境 ID（调用方再删它们的变量）。 */
  async remove(storage: Storage, workspaceId: string, now: string): Promise<string[]> {
    const environments = this.#environments(storage, workspaceId).map(({ id }) => id);
    for (const id of environments) storage.environments.remove(id);
    const workspace = storage.workspaces.get(workspaceId);
    if (workspace === undefined) return environments;
    if (workspace.removedAt === undefined) storage.workspaces.markRemoved(workspaceId, now);
    // 只删助理目录里的。
    if (this.isAssistant(workspace)) {
      await rm(workspace.rootPath, { recursive: true, force: true });
    }
    return environments;
  }

  #environments(storage: Storage, workspaceId: string): EnvironmentRecord[] {
    return storage.environments
      .list()
      .filter((environment) => environment.folders[0]?.workspaceId === workspaceId);
  }
}

function environmentName(name: string): string {
  return name.trim().slice(0, ENVIRONMENT_NAME_MAX) || 'Assistant';
}
