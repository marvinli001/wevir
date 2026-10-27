// 保存的环境（U22.1，0.15.0，domain-model §3.10）：列表来自 Host 的 `environment.list`，增删改后就地更新；新会话页选中的环境
// 记在本机（`wevir.environment-choice.v1`），只在它的主文件夹就是当前项目时生效。不用环境时，新会话也可以单独新开一个 git
// worktree（0.18.0，`session.create` 的 `worktree`），选没选同样记在本机（`wevir.new-worktree.v1`）。

import { hostSupports } from '@wevir/client-sdk';
import type {
  Environment,
  EnvironmentFolder,
  EnvironmentId,
  EnvironmentVariableInput,
  WorkspaceId,
} from '@wevir/protocol';
import { useCallback, useEffect } from 'react';
import { useWorkspaceGit } from '@/data/workspace-git';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { createPersistedStore, createStore } from '@/lib/store';

const listStore = createStore<readonly Environment[] | undefined>(undefined);

const choiceStore = createPersistedStore<EnvironmentId | null>(
  'wevir.environment-choice.v1',
  null,
  (raw) =>
    raw === null || (typeof raw === 'string' && raw.startsWith('env_'))
      ? (raw as EnvironmentId | null)
      : undefined,
);

export interface EnvironmentsState {
  /** Host 声明了 `environments`；没有时界面上不出现“选择环境”。 */
  supported: boolean;
  /** Host 声明了 `environment_variables`（0.130.0）；没有时对话框里不出现“环境变量”。 */
  variablesSupported: boolean;
  /** 还没读到时是空的。 */
  environments: readonly Environment[];
  /** `variables` 省略：不改（新建时就是没有）。 */
  create(
    name: string,
    folders: EnvironmentFolder[],
    variables?: EnvironmentVariableInput[],
  ): Promise<Environment>;
  update(
    id: EnvironmentId,
    name: string,
    folders: EnvironmentFolder[],
    variables?: EnvironmentVariableInput[],
  ): Promise<Environment>;
  remove(id: EnvironmentId): Promise<void>;
}

export function useEnvironments(): EnvironmentsState {
  const { client, view } = useHostConnection();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'environments');
  const variablesSupported =
    supported && hostSupports(view.hello.features, 'environment_variables');
  const environments = listStore.use() ?? [];

  useEffect(() => {
    if (!client || !supported) return;
    let stopped = false;
    client
      .request('environment.list', {})
      .then((result) => {
        if (!stopped) listStore.set(result.environments);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [client, supported]);

  const create = useCallback(
    async (name: string, folders: EnvironmentFolder[], variables?: EnvironmentVariableInput[]) => {
      if (!client) throw new Error('not connected');
      const { environment } = await client.request('environment.create', {
        name,
        folders,
        ...(variables !== undefined && { variables }),
      });
      listStore.set((current) => [...(current ?? []), environment]);
      return environment;
    },
    [client],
  );
  const update = useCallback(
    async (
      environmentId: EnvironmentId,
      name: string,
      folders: EnvironmentFolder[],
      variables?: EnvironmentVariableInput[],
    ) => {
      if (!client) throw new Error('not connected');
      const { environment } = await client.request('environment.update', {
        environmentId,
        name,
        folders,
        ...(variables !== undefined && { variables }),
      });
      listStore.set((current) =>
        (current ?? []).map((item) => (item.id === environment.id ? environment : item)),
      );
      return environment;
    },
    [client],
  );
  const remove = useCallback(
    async (environmentId: EnvironmentId) => {
      if (!client) throw new Error('not connected');
      await client.request('environment.remove', { environmentId });
      listStore.set((current) => (current ?? []).filter((item) => item.id !== environmentId));
      if (choiceStore.get() === environmentId) choiceStore.set(null);
    },
    [client],
  );
  return { supported, variablesSupported, environments, create, update, remove };
}

/** 选中一个环境（null：不用环境）。 */
export function chooseEnvironment(id: EnvironmentId | null): void {
  choiceStore.set(id);
}

/** 新会话页当前生效的环境：选中的、Host 支持、而且它的主文件夹就是当前项目。 */
export function useActiveEnvironment(
  workspaceId: WorkspaceId | undefined,
): Environment | undefined {
  const { supported, environments } = useEnvironments();
  const choice = choiceStore.use();
  if (!supported || choice === null || workspaceId === undefined) return undefined;
  const environment = environments.find((item) => item.id === choice);
  return environment?.folders[0]?.workspaceId === workspaceId ? environment : undefined;
}

const worktreeStore = createPersistedStore<boolean>('wevir.new-worktree.v1', false, (raw) =>
  typeof raw === 'boolean' ? raw : undefined,
);

export interface WorktreeChoice {
  /** Host 声明了 `session_worktree`；没有时“此计算机”只是一个标签。 */
  supported: boolean;
  /** 选了“新工作树”。 */
  chosen: boolean;
  /** 新会话真的要新开 worktree：选了、而且用得上。 */
  active: boolean;
  /** 用不上“新工作树”的原因（选了环境、还没有项目、项目不是 git 仓库）；用得上时 undefined。 */
  unavailable: string | undefined;
  choose(next: boolean): void;
}

/**
 * 新会话页的“此计算机 / 新工作树”（0.18.0）。选了环境时由环境按文件夹定，这里不另开；项目不是 git 仓库时也不开（还没读到
 * git 状态时照选的来，Host 会再查一次）。
 */
export function useWorktreeChoice(workspaceId: WorkspaceId | undefined): WorktreeChoice {
  const { view } = useHostConnection();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'session_worktree');
  const environment = useActiveEnvironment(workspaceId);
  const git = useWorkspaceGit(workspaceId, { active: supported });
  const chosen = worktreeStore.use();
  const unavailable = !supported
    ? undefined
    : environment
      ? t('worktree.byEnvironment')
      : workspaceId === undefined
        ? t('worktree.noProject')
        : git.status?.repo === false
          ? t('worktree.notRepo')
          : undefined;
  return {
    supported,
    chosen,
    active: supported && chosen && unavailable === undefined,
    unavailable,
    choose: (next) => worktreeStore.set(next),
  };
}

/** 环境的一句说明：“2 个文件夹 · worktree”。 */
export function environmentSummary(environment: Environment): string {
  const parts = [t('env.folders', { count: environment.folders.length })];
  if (environment.folders.some((folder) => folder.worktree === 'new'))
    parts.push(t('env.worktree'));
  return parts.join(' · ');
}
