// 自动调优的数据（0.108.0）：`tuning.overview` 与这个范围的全部改动（`tuning.proposal.list`，时间线用）。`tuning.changed`、
// `tuning.proposal.changed` 与设置变了（开关、上限）时重读，同一刻的几条合成一次；重读时留着上次的结果，不闪“正在加载”。

import type { WevirClient } from '@wevir/client-sdk';
import type { TuningOverview, TuningProposal, WorkspaceId } from '@wevir/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

const COALESCE_MS = 150;

export interface OverviewData {
  overview: TuningOverview;
  proposals: TuningProposal[];
}

export function useOverview(client: WevirClient, workspaceId: string | undefined) {
  const [state, setState] = useState<{ key?: string; data?: OverviewData; error?: unknown }>({});
  const seq = useRef(0);
  const key = workspaceId ?? 'global';
  const reload = useCallback(() => {
    const id = ++seq.current;
    const scope = workspaceId === undefined ? {} : { workspaceId: workspaceId as WorkspaceId };
    Promise.all([
      client.request('tuning.overview', scope),
      workspaceId === undefined
        ? Promise.resolve({ proposals: [] })
        : client.request('tuning.proposal.list', scope),
    ]).then(
      ([overview, listed]) => {
        if (id === seq.current) setState({ key, data: { overview, proposals: listed.proposals } });
      },
      (error: unknown) => {
        if (id === seq.current) setState((previous) => ({ ...previous, key, error }));
      },
    );
  }, [client, workspaceId, key]);

  useEffect(() => {
    reload();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        reload();
      }, COALESCE_MS);
    };
    const matches = (change: { workspaceId?: string } | undefined) =>
      change?.workspaceId === undefined || change.workspaceId === workspaceId;
    const offTuning = client.onTuningChanged((change) => matches(change) && schedule());
    const offProposals = client.onTuningProposalsChanged((change) => matches(change) && schedule());
    let first = true;
    const offSettings = client.watchSettings(() => {
      // 订阅时立即回一次当前设置，不必为它重读。
      if (first) {
        first = false;
        return;
      }
      schedule();
    });
    return () => {
      offTuning();
      offProposals();
      offSettings();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, reload, workspaceId]);

  const fresh = state.key === key;
  return {
    ...(fresh && state.data !== undefined && { data: state.data }),
    ...(fresh && state.error !== undefined && { error: state.error }),
    reload,
  };
}
