// 调优页的数据（0.85.0）：选中的范围（本机记住）、当前档案与版本列表。`tuning.changed` 来了且范围对得上（或重连后收到 undefined）
// 就重读，同一刻的几条合成一次；规则文件在编辑器里改了 Host 不通知，窗口回到前台时也重读一次。重读时留着上次的结果，不闪“正在加载”。

import type { WevirClient } from '@wevir/client-sdk';
import type { MethodResult, ProfileVersionSummary, WorkspaceId } from '@wevir/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPersistedStore } from '@/lib/store';
import type { TuningScope } from './tuning-model';

/** 上次选的范围。 */
export const tuningScope = createPersistedStore<TuningScope>('wevir.tuning.v1', 'global', (raw) =>
  typeof raw === 'string' && raw !== '' ? raw : undefined,
);

export interface TuningData {
  current: MethodResult<'tuning.get'>;
  versions: ProfileVersionSummary[];
  nextCursor?: string;
}

const COALESCE_MS = 150;

export function useTuning(client: WevirClient, workspaceId: string | undefined) {
  const [state, setState] = useState<{ data?: TuningData; error?: unknown; scope?: string }>({});
  const seq = useRef(0);
  const key = workspaceId ?? 'global';
  const reload = useCallback(() => {
    const id = ++seq.current;
    const params = workspaceId === undefined ? {} : { workspaceId: workspaceId as WorkspaceId };
    Promise.all([
      client.request('tuning.get', params),
      client.request('tuning.versions', params),
    ]).then(
      ([current, versions]) => {
        if (id !== seq.current) return;
        setState({
          scope: key,
          data: {
            current,
            versions: versions.versions,
            ...(versions.nextCursor !== undefined && { nextCursor: versions.nextCursor }),
          },
        });
      },
      (error: unknown) => {
        if (id === seq.current) setState((previous) => ({ ...previous, error, scope: key }));
      },
    );
  }, [client, workspaceId, key]);

  /** 再取一页更早的版本。 */
  const more = useCallback(() => {
    const cursor = state.data?.nextCursor;
    if (cursor === undefined) return;
    const id = seq.current;
    client
      .request('tuning.versions', {
        ...(workspaceId !== undefined && { workspaceId: workspaceId as WorkspaceId }),
        cursor,
      })
      .then(
        (page) => {
          if (id !== seq.current) return;
          setState((previous) =>
            previous.data === undefined
              ? previous
              : {
                  ...previous,
                  data: {
                    ...previous.data,
                    versions: [...previous.data.versions, ...page.versions],
                    ...(page.nextCursor === undefined
                      ? { nextCursor: undefined }
                      : { nextCursor: page.nextCursor }),
                  },
                },
          );
        },
        () => undefined,
      );
  }, [client, workspaceId, state.data?.nextCursor]);

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
    const off = client.onTuningChanged((change) => {
      if (change?.workspaceId !== undefined && change.workspaceId !== workspaceId) return;
      schedule();
    });
    window.addEventListener('focus', schedule);
    return () => {
      off();
      window.removeEventListener('focus', schedule);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, reload, workspaceId]);

  // 换了范围、新范围的结果还没到时不显示旧范围的数据。
  const fresh = state.scope === key;
  return {
    ...(fresh && state.data !== undefined && { data: state.data }),
    ...(fresh && state.error !== undefined && { error: state.error }),
    reload,
    more,
  };
}
