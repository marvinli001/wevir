// 保存的环境（U22.1，0.15.0，domain-model §3.10）：列表来自 Host 的 `environment.list`，增删改后就地更新；新会话页选中的环境
// 记在本机（`wevir.environment-choice.v1`），只在它的主文件夹就是当前项目时生效。

import { hostSupports } from '@wevir/client-sdk';
import type { Environment, EnvironmentFolder, EnvironmentId, WorkspaceId } from '@wevir/protocol';
import { useCallback, useEffect } from 'react';
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
  /** 还没读到时是空的。 */
  environments: readonly Environment[];
  create(name: string, folders: EnvironmentFolder[]): Promise<Environment>;
  update(id: EnvironmentId, name: string, folders: EnvironmentFolder[]): Promise<Environment>;
  remove(id: EnvironmentId): Promise<void>;
}

export function useEnvironments(): EnvironmentsState {
  const { client, view } = useHostConnection();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'environments');
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
    async (name: string, folders: EnvironmentFolder[]) => {
      if (!client) throw new Error('not connected');
      const { environment } = await client.request('environment.create', { name, folders });
      listStore.set((current) => [...(current ?? []), environment]);
      return environment;
    },
    [client],
  );
  const update = useCallback(
    async (environmentId: EnvironmentId, name: string, folders: EnvironmentFolder[]) => {
      if (!client) throw new Error('not connected');
      const { environment } = await client.request('environment.update', {
        environmentId,
        name,
        folders,
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
  return { supported, environments, create, update, remove };
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

/** 环境的一句说明：“2 个文件夹 · worktree”。 */
export function environmentSummary(environment: Environment): string {
  const parts = [t('env.folders', { count: environment.folders.length })];
  if (environment.folders.some((folder) => folder.worktree === 'new'))
    parts.push(t('env.worktree'));
  return parts.join(' · ');
}
