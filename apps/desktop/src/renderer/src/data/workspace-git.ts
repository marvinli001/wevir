// 工作区的 git 状态（U18，host-api.md §3.1 的 `workspace.git`），给会话侧栏的“环境”与“变更”卡片。Host 每次现读，
// 这里在侧栏显示时读一次，之后每 10 s、窗口获得焦点、`refreshKey` 变了（会话的回合结束）时重读。

import { hostSupports } from '@wevir/client-sdk';
import type { SessionId, WorkspaceGitResult, WorkspaceId } from '@wevir/protocol';
import { useEffect, useState } from 'react';
import { useHostConnection } from '@/host/host-connection';

const REFRESH_MS = 10_000;

/** 最近一次读到的，换会话回来时先显示它。 */
const lastKnown = new Map<string, WorkspaceGitResult>();

export interface WorkspaceGitState {
  /** Host 声明了 `workspace_git`（0.13.0）；没有时 `status` 总是 undefined。 */
  supported: boolean;
  /** 还没读到、读失败时是 undefined。 */
  status: WorkspaceGitResult | undefined;
}

export function useWorkspaceGit(
  workspaceId: WorkspaceId | undefined,
  options: { active: boolean; refreshKey?: unknown; sessionId?: SessionId },
): WorkspaceGitState {
  const { client, view } = useHostConnection();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'workspace_git');
  const [status, setStatus] = useState<WorkspaceGitResult | undefined>(() => {
    const initial = options.sessionId ?? workspaceId;
    return initial === undefined ? undefined : lastKnown.get(initial);
  });
  const { active, refreshKey, sessionId } = options;
  const key = sessionId ?? workspaceId;

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey 只用来触发重读。
  useEffect(() => {
    setStatus(key === undefined ? undefined : lastKnown.get(key));
    if (!client || !supported || !active || workspaceId === undefined || key === undefined) return;
    let stopped = false;
    const read = () => {
      client
        .request('workspace.git', { workspaceId, ...(sessionId && { sessionId }) })
        .then((result) => {
          lastKnown.set(key, result);
          if (!stopped) setStatus(result);
        })
        .catch(() => {
          lastKnown.delete(key);
          if (!stopped) setStatus(undefined);
        });
    };
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    window.addEventListener('focus', read);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', read);
    };
  }, [client, supported, active, workspaceId, sessionId, key, refreshKey]);

  return { supported, status: supported ? status : undefined };
}
