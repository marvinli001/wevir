// 变更页与单个文件页共用：按“电脑/会话”取那台电脑的连接读变更；连接换了（重连、回到前台）时重读。单个文件页先用列表页读到的。

import type { SessionId } from '@wevir/protocol';
import { useCallback, useEffect, useState } from 'react';
import {
  type Changes,
  type ChangesClient,
  type ChangesProblem,
  cachedChanges,
  loadChanges,
  problemOf,
} from '../lib/changes';
import { useComputer, useRegistry } from './registry';

export interface ChangesState {
  computer: string;
  sessionId: SessionId;
  client: ChangesClient | undefined;
  changes: Changes | undefined;
  problem: ChangesProblem | undefined;
  loading: boolean;
  /** 电脑不在线：没有连接可用。 */
  offline: boolean;
  refresh(): void;
}

/** `key` 是“电脑名/会话 ID”。`reuse` 时有读过的就不再读（单个文件页）。 */
export function useChanges(key: string, options: { reuse?: boolean } = {}): ChangesState {
  const slash = key.indexOf('/');
  const computer = key.slice(0, slash);
  const sessionId = key.slice(slash + 1) as SessionId;
  const registry = useRegistry();
  const snapshot = useComputer(computer);
  const client = snapshot !== undefined ? registry.link(computer)?.changes : undefined;
  const [state, setState] = useState<{ changes?: Changes; problem?: ChangesProblem }>(() => ({
    changes: cachedChanges(key),
  }));
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(0);
  const reuse = options.reuse === true;

  useEffect(() => {
    if (client === undefined) return;
    if (reuse && manual === 0 && cachedChanges(key) !== undefined) return;
    let stopped = false;
    setLoading(true);
    loadChanges(client, key, sessionId)
      .then((changes) => {
        if (!stopped) setState({ changes });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        // 读失败（网络）时留着上次的结果；没权限、不是仓库就不再显示旧的。
        const problem = problemOf(error);
        setState((current) => (problem === 'failed' ? { ...current, problem } : { problem }));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [client, key, sessionId, reuse, manual]);

  const refresh = useCallback(() => setManual((value) => value + 1), []);
  return {
    computer,
    sessionId,
    client,
    changes: state.changes,
    problem: state.changes === undefined ? state.problem : undefined,
    loading,
    offline: client === undefined,
    refresh,
  };
}
