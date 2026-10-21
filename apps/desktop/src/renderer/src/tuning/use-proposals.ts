// 调优的建议（0.87.0）：按范围与“待审 / 已处理”列出，`tuning.proposal.changed` 来了（或重连后收到 undefined）就重读，同一刻的几条
// 合成一次；侧栏的待审数用同一个通知。重读时留着上次的结果，不闪“正在加载”。

import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import type { TuningProposal, WorkspaceId } from '@wevir/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

const COALESCE_MS = 150;

/** `tuning.proposal.changed` 合成一次调用 `reload`；返回取消函数。 */
function watchProposals(
  client: WevirClient,
  workspaceId: string | undefined,
  reload: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = client.onTuningProposalsChanged((change) => {
    if (
      workspaceId !== undefined &&
      change?.workspaceId !== undefined &&
      change.workspaceId !== workspaceId
    ) {
      return;
    }
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      reload();
    }, COALESCE_MS);
  });
  return () => {
    off();
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** 一个范围（省略是全部项目）里的待审或已处理的建议，与待审数。 */
export function useProposals(
  client: WevirClient,
  workspaceId: string | undefined,
  status: 'open' | 'decided',
) {
  const [state, setState] = useState<{
    key?: string;
    proposals?: TuningProposal[];
    open?: number;
    error?: unknown;
  }>({});
  const seq = useRef(0);
  const key = `${workspaceId ?? '*'}:${status}`;
  const reload = useCallback(() => {
    const id = ++seq.current;
    const scope = workspaceId === undefined ? {} : { workspaceId: workspaceId as WorkspaceId };
    Promise.all([
      client.request('tuning.proposal.list', { ...scope, status }),
      status === 'open'
        ? undefined
        : client.request('tuning.proposal.list', { ...scope, status: 'open' }),
    ]).then(
      ([listed, open]) => {
        if (id !== seq.current) return;
        setState({
          key,
          proposals: listed.proposals,
          open: (open ?? listed).proposals.length,
        });
      },
      (error: unknown) => {
        if (id === seq.current) setState((previous) => ({ ...previous, key, error }));
      },
    );
  }, [client, workspaceId, status, key]);

  useEffect(() => {
    reload();
    return watchProposals(client, workspaceId, reload);
  }, [client, workspaceId, reload]);

  const fresh = state.key === key;
  return {
    ...(fresh && state.proposals !== undefined && { proposals: state.proposals }),
    ...(fresh && state.open !== undefined && { open: state.open }),
    ...(fresh && state.error !== undefined && { error: state.error }),
    reload,
  };
}

/** 侧栏“调优”右边的数字：全部项目的待审数；Host 没有 `tuning_proposals` 或读不到时 0。 */
export function useOpenProposalCount(client: WevirClient | undefined): number {
  const [count, setCount] = useState(0);
  const supported = client !== undefined && hostSupports(client.hello.features, 'tuning_proposals');
  useEffect(() => {
    if (client === undefined || !supported) {
      setCount(0);
      return;
    }
    let alive = true;
    const reload = () => {
      client.request('tuning.proposal.list', { status: 'open' }).then(
        (result) => alive && setCount(result.proposals.length),
        () => undefined,
      );
    };
    reload();
    const off = watchProposals(client, undefined, reload);
    return () => {
      alive = false;
      off();
    };
  }, [client, supported]);
  return count;
}
