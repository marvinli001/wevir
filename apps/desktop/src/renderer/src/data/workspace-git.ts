// 工作区的 git 状态（U18，host-api.md §3.1 的 `workspace.git`），给会话侧栏的“环境”与“变更”卡片。Host 每次现读，
// 这里在侧栏显示时读一次，之后每 10 s（窗口看得见时）、窗口获得焦点、`refreshKey` 变了（会话的回合结束）时重读。

import { hostSupports } from '@wevir/client-sdk';
import type { SessionId, WorkspaceGitResult, WorkspaceId } from '@wevir/protocol';
import { useEffect, useState } from 'react';
import { folderCacheKey, folderParams } from '@/changes/change-folders';
import { useHostConnection } from '@/host/host-connection';
import { LruMap } from '@/lib/lru';
import { everyWhileVisible } from '@/lib/visible-interval';

const REFRESH_MS = 10_000;

/** 最近一次读到的，换会话回来时先显示它（最近用过的一批）。 */
const lastKnown = new LruMap<string, WorkspaceGitResult>(100);

export interface WorkspaceGitState {
  /** Host 声明了 `workspace_git`（0.13.0）；没有时 `status` 总是 undefined。 */
  supported: boolean;
  /** 还没读到、读失败时是 undefined。 */
  status: WorkspaceGitResult | undefined;
}

interface GitOptions {
  active: boolean;
  refreshKey?: unknown;
  sessionId?: SessionId;
}

export function useWorkspaceGit(
  workspaceId: WorkspaceId | undefined,
  options: GitOptions & { folder?: string },
): WorkspaceGitState {
  const { supported, statuses } = useGitFolders(workspaceId, [options.folder], options);
  return { supported, status: statuses[0] };
}

export interface WorkspaceGitFolder {
  folder: string;
  status: WorkspaceGitResult | undefined;
}

export function useWorkspaceGitFolders(
  workspaceId: WorkspaceId,
  folders: readonly string[],
  options: GitOptions,
): { supported: boolean; folders: readonly WorkspaceGitFolder[] } {
  const { view } = useHostConnection();
  const multiple =
    view.status === 'connected' && hostSupports(view.hello.features, 'multi_folder_changes');
  const sources = multiple ? folders : folders.slice(0, 1);
  const { supported, statuses } = useGitFolders(workspaceId, sources, options);
  return {
    supported,
    folders: sources.map((folder, index) => ({ folder, status: statuses[index] })),
  };
}

function useGitFolders(
  workspaceId: WorkspaceId | undefined,
  folders: readonly (string | undefined)[],
  { active, refreshKey, sessionId }: GitOptions,
): { supported: boolean; statuses: readonly (WorkspaceGitResult | undefined)[] } {
  const { client, view } = useHostConnection();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'workspace_git');
  const features = view.status === 'connected' ? view.hello.features : undefined;
  const requested = JSON.stringify(folders.map((folder) => folderParams(features, folder).folder));
  const owner = sessionId ?? workspaceId;
  const [statuses, setStatuses] = useState<ReadonlyMap<string, WorkspaceGitResult>>(new Map());

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey 只用来触发重读。
  useEffect(() => {
    setStatuses(new Map());
    if (!client || !supported || !active || workspaceId === undefined || owner === undefined)
      return;
    const sources = JSON.parse(requested) as (string | null)[];
    let stopped = false;
    const read = () => {
      for (const folder of sources) {
        const key = folderCacheKey(owner, folder ?? undefined);
        client
          .request('workspace.git', {
            workspaceId,
            ...(sessionId !== undefined && { sessionId }),
            ...(folder !== null && { folder }),
          })
          .then((result) => {
            if (stopped) return;
            lastKnown.set(key, result);
            setStatuses((current) => new Map(current).set(key, result));
          })
          .catch(() => {
            if (stopped) return;
            lastKnown.delete(key);
            setStatuses((current) => {
              const next = new Map(current);
              next.delete(key);
              return next;
            });
          });
      }
    };
    read();
    const stopTimer = everyWhileVisible(read, REFRESH_MS);
    window.addEventListener('focus', read);
    return () => {
      stopped = true;
      stopTimer();
      window.removeEventListener('focus', read);
    };
  }, [client, supported, active, workspaceId, sessionId, owner, requested, refreshKey]);

  return {
    supported,
    statuses: folders.map((folder) => {
      if (!supported || owner === undefined) return undefined;
      const key = folderCacheKey(owner, folderParams(features, folder).folder);
      return statuses.get(key) ?? lastKnown.get(key);
    }),
  };
}
