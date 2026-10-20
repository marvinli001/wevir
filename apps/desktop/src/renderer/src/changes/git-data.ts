// 暂存与提交的数据（0.67.0，`git.*`，ADR-0009）：会话目录的暂存状态，窗格显示、窗口获得焦点、回合开始或结束时重读。
// 写操作带上读到的 HEAD 与索引；Host 回 GIT_STATE_CHANGED（仓库在别处变了）时重读，不重试。

import { hostSupports, isRpcError } from '@wevir/client-sdk';
import type {
  GitCommitOutcome,
  GitExpectedState,
  GitStatusResult,
  SessionId,
  WorkspaceId,
} from '@wevir/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useHostConnection } from '@/host/host-connection';

/** Host 声明了 `git_commit`（0.67.0）。 */
export function useGitSupported(): boolean {
  const { view } = useHostConnection();
  return view.status === 'connected' && hostSupports(view.hello.features, 'git_commit');
}

export interface GitState {
  status: GitStatusResult | undefined;
  /** 读状态或写操作失败的说明；`stale` 是仓库在读状态之后变了（已重读）。 */
  error: { kind: 'failed'; message: string } | { kind: 'stale' } | undefined;
  busy: boolean;
  refresh(): void;
  stage(paths: readonly string[]): Promise<void>;
  unstage(paths: readonly string[]): Promise<void>;
  commit(message: string, includeExternal: boolean): Promise<GitCommitOutcome | undefined>;
}

export function expectedOf(status: GitStatusResult | undefined): GitExpectedState | undefined {
  if (status?.repo !== true || status.index === undefined || status.head === undefined) {
    return undefined;
  }
  return { head: status.head, index: status.index };
}

export function useGitStatus(
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  refreshKey: unknown,
): GitState {
  const { client } = useHostConnection();
  const supported = useGitSupported();
  const key = `${workspaceId}:${sessionId}`;
  const [state, setState] = useState<{ key: string; status: GitStatusResult }>();
  const [error, setError] = useState<GitState['error']>();
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(0);
  const latest = useRef<GitStatusResult>(undefined);
  latest.current = state?.key === key ? state.status : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey 与 manual 只用来触发重读。
  useEffect(() => {
    if (!client || !supported) return;
    let stopped = false;
    const read = () => {
      client
        .request('git.status', { workspaceId, sessionId })
        .then((status) => {
          if (stopped) return;
          setState({ key, status });
          setError((current) => (current?.kind === 'stale' ? current : undefined));
        })
        .catch((cause: unknown) => {
          if (!stopped) setError({ kind: 'failed', message: messageOf(cause) });
        });
    };
    read();
    window.addEventListener('focus', read);
    return () => {
      stopped = true;
      window.removeEventListener('focus', read);
    };
  }, [client, supported, workspaceId, sessionId, key, refreshKey, manual]);

  const refresh = useCallback(() => setManual((value) => value + 1), []);

  /** 跑一次写操作：成功时换上返回的状态；仓库变了时标出来并重读。 */
  const write = useCallback(
    async <T>(
      run: (expected: GitExpectedState) => Promise<T>,
      take: (result: T) => GitStatusResult,
    ) => {
      const expected = expectedOf(latest.current);
      if (!client || !expected) return undefined;
      setBusy(true);
      setError(undefined);
      try {
        const result = await run(expected);
        setState({ key, status: take(result) });
        return result;
      } catch (cause) {
        if (isRpcError(cause, 'GIT_STATE_CHANGED')) {
          setError({ kind: 'stale' });
          setManual((value) => value + 1);
        } else {
          setError({ kind: 'failed', message: messageOf(cause) });
        }
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [client, key],
  );

  const stage = useCallback(
    async (paths: readonly string[]) => {
      if (!client || paths.length === 0) return;
      await write(
        (expected) =>
          client.request('git.stage', { workspaceId, sessionId, paths: [...paths], expected }),
        (result) => result.status,
      );
    },
    [client, workspaceId, sessionId, write],
  );

  const unstage = useCallback(
    async (paths: readonly string[]) => {
      if (!client || paths.length === 0) return;
      await write(
        (expected) =>
          client.request('git.unstage', { workspaceId, sessionId, paths: [...paths], expected }),
        (result) => result.status,
      );
    },
    [client, workspaceId, sessionId, write],
  );

  const commit = useCallback(
    async (message: string, includeExternal: boolean) => {
      if (!client) return undefined;
      const result = await write(
        (expected) =>
          client.request('git.commit', {
            workspaceId,
            sessionId,
            message,
            expected,
            ...(includeExternal && { includeExternal: true }),
          }),
        (result) => result.status,
      );
      return result?.outcome;
    },
    [client, workspaceId, sessionId, write],
  );

  return {
    status: state?.key === key ? state.status : undefined,
    error,
    busy,
    refresh,
    stage,
    unstage,
    commit,
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
