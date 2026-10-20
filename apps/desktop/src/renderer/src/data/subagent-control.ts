// 后台任务（U21，desktop-layout.md §15）：单独停掉一个子会话（0.14.0 的 `subagent_cancel`），与读子会话的累计 token 数。

import { hostSupports } from '@wevir/client-sdk';
import type { SessionId } from '@wevir/protocol';
import { useCallback, useEffect, useState } from 'react';
import { describe, useHostConnection } from '@/host/host-connection';
import { everyWhileVisible } from '@/lib/visible-interval';

/** 进行中的子会话多久重读一次快照。 */
const USAGE_REFRESH_MS = 3_000;

export interface SubagentStop {
  /** Host 声明了 `subagent_cancel`；没有时不显示停止按钮。 */
  supported: boolean;
  /** 停掉这个子会话；失败时返回错误说明。 */
  stop: (childId: SessionId) => Promise<string | undefined>;
}

export function useSubagentStop(): SubagentStop {
  const { client, view } = useHostConnection();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'subagent_cancel');
  const stop = useCallback(
    async (childId: SessionId) => {
      if (!client) return undefined;
      try {
        await client.request('session.cancel', { sessionId: childId });
        return undefined;
      } catch (error) {
        return describe(error);
      }
    },
    [client],
  );
  return { supported, stop };
}

/** 子会话累计用掉的 token（0.14.0 的 `usage.totalTokens`）：显示时读一次快照，进行中的每 3 s（窗口看得见时）再读。 */
export function useChildTokens(childId: SessionId, running: boolean): number | undefined {
  const { client } = useHostConnection();
  const [tokens, setTokens] = useState<number>();
  useEffect(() => {
    if (!client) return;
    let stopped = false;
    const read = () => {
      client
        .request('session.get', { sessionId: childId })
        .then((snapshot) => {
          if (!stopped) setTokens(snapshot.usage?.totalTokens);
        })
        .catch(() => {});
    };
    read();
    if (!running)
      return () => {
        stopped = true;
      };
    const stopTimer = everyWhileVisible(read, USAGE_REFRESH_MS);
    return () => {
      stopped = true;
      stopTimer();
    };
  }, [client, childId, running]);
  return tokens;
}
