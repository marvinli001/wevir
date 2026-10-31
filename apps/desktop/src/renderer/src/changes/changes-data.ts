// “变更”窗格的数据（0.20.0，host-api.md §3.1）：`workspace.diff` 的一段改动与 `session.checkpoints` 的回合列表。Host 每次现读；
// 这里在窗格显示时读，之后窗口获得焦点、会话的回合开始或结束（`refreshKey` 变了）、点“刷新”时重读，回合进行中再每 5 s（窗口看得见时）读一次。
// 已经结束的回合的 diff 不会再变，读到一次就不再读。

import { hostSupports } from '@wevir/client-sdk';
import type {
  DiffSource,
  SessionId,
  TurnCheckpoint,
  WorkspaceDiffResult,
  WorkspaceId,
} from '@wevir/protocol';
import { useCallback, useEffect, useState } from 'react';
import { useHostConnection } from '@/host/host-connection';
import { LruMap } from '@/lib/lru';
import { everyWhileVisible } from '@/lib/visible-interval';

const LIVE_REFRESH_MS = 5_000;

/** Host 声明了 `workspace_diff`（0.20.0）。 */
export function useDiffSupported(): boolean {
  const { view } = useHostConnection();
  return view.status === 'connected' && hostSupports(view.hello.features, 'workspace_diff');
}

/** 最近一次读到的，换范围、换会话回来时先显示它（最近用过的一批；patch 合计最多这么多字符）。 */
const DIFF_MAX_CHARS = 32 * 1024 * 1024;
const lastDiff = new LruMap<string, WorkspaceDiffResult>(32, {
  maxWeight: DIFF_MAX_CHARS,
  weigh: (diff) => diff.patch?.length ?? 0,
});
const lastCheckpoints = new LruMap<SessionId, readonly TurnCheckpoint[]>(64);

export function sourceKey(sessionId: SessionId, source: DiffSource): string {
  return source.kind === 'turn'
    ? `${sessionId}:turn:${source.turnId}`
    : `${sessionId}:${source.kind}`;
}

export interface DiffState {
  result: WorkspaceDiffResult | undefined;
  error: string | undefined;
  loading: boolean;
  refresh(): void;
}

export function useWorkspaceDiff(
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  source: DiffSource | undefined,
  options: { refreshKey: unknown; live: boolean },
): DiffState {
  const { client } = useHostConnection();
  const supported = useDiffSupported();
  const key = source === undefined ? undefined : sourceKey(sessionId, source);
  const [state, setState] = useState<{
    key?: string;
    result?: WorkspaceDiffResult;
    error?: string;
  }>(() => (key === undefined ? {} : { key, result: lastDiff.get(key) }));
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(0);
  const { refreshKey, live } = options;

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey 与 manual 只用来触发重读。
  useEffect(() => {
    if (key === undefined || source === undefined) return;
    setState((current) => (current.key === key ? current : { key, result: lastDiff.get(key) }));
    if (!client || !supported) return;
    // 结束了的回合不会再变。
    const settled = source.kind === 'turn' && lastDiff.get(key)?.head !== undefined;
    if (settled && manual === 0) return;
    let stopped = false;
    const read = () => {
      setLoading(true);
      client
        .request('workspace.diff', { workspaceId, sessionId, source })
        .then((result) => {
          lastDiff.set(key, result);
          if (!stopped) setState({ key, result });
        })
        .catch((error: unknown) => {
          if (!stopped) {
            setState({ key, error: error instanceof Error ? error.message : String(error) });
          }
        })
        .finally(() => {
          if (!stopped) setLoading(false);
        });
    };
    read();
    const watch = !(source.kind === 'turn' && !live);
    const stopTimer = live ? everyWhileVisible(read, LIVE_REFRESH_MS) : undefined;
    if (watch) window.addEventListener('focus', read);
    return () => {
      stopped = true;
      stopTimer?.();
      window.removeEventListener('focus', read);
    };
  }, [client, supported, workspaceId, sessionId, key, live, refreshKey, manual]);

  const refresh = useCallback(() => setManual((value) => value + 1), []);
  const current = state.key === key ? state : {};
  return { result: current.result, error: current.error, loading, refresh };
}

/** 会话有快照的回合（从早到晚）；读不到时 undefined。 */
export function useCheckpoints(
  sessionId: SessionId,
  refreshKey: unknown,
  enabled = true,
): readonly TurnCheckpoint[] | undefined {
  const { client } = useHostConnection();
  const supported = useDiffSupported();
  const [state, setState] = useState(() => ({ sessionId, turns: lastCheckpoints.get(sessionId) }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey 只用来触发重读。
  useEffect(() => {
    setState({ sessionId, turns: lastCheckpoints.get(sessionId) });
    if (!client || !supported || !enabled) return;
    let stopped = false;
    client
      .request('session.checkpoints', { sessionId })
      .then((result) => {
        lastCheckpoints.set(sessionId, result.turns);
        if (!stopped) setState({ sessionId, turns: result.turns });
      })
      .catch(() => {
        if (!stopped) setState({ sessionId, turns: undefined });
      });
    return () => {
      stopped = true;
    };
  }, [client, supported, sessionId, refreshKey, enabled]);

  return supported && enabled
    ? state.sessionId === sessionId
      ? state.turns
      : lastCheckpoints.get(sessionId)
    : undefined;
}
