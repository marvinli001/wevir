// 自动化的数据（0.66.0）：列表页读 `automation.list`，详情页读 `automation.get`（带运行记录）。`automation.changed` 来了就重读，
// 同一刻来的几条合成一次；重连后（listener 收到 undefined）也重读。重读时先留着上次的结果，不闪“正在加载”。

import type { WevirClient } from '@wevir/client-sdk';
import type { Automation, AutomationId, AutomationRun } from '@wevir/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface Loaded<T> {
  data?: T;
  error?: unknown;
}

/** 合并同一刻的几次重读。 */
const COALESCE_MS = 150;

function useReloading<T>(
  client: WevirClient,
  load: () => Promise<T>,
  relevant: (automationId: AutomationId | undefined) => boolean,
): Loaded<T> & { reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({});
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => {
    const id = ++seq.current;
    loadRef.current().then(
      (data) => {
        if (id === seq.current) setState({ data });
      },
      (error: unknown) => {
        if (id === seq.current) setState((current) => ({ ...current, error }));
      },
    );
  }, []);
  const relevantRef = useRef(relevant);
  relevantRef.current = relevant;
  useEffect(() => {
    reload();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = client.onAutomationsChanged((change) => {
      if (change !== undefined && !relevantRef.current(change.automationId)) return;
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
  }, [client, reload]);
  return { ...state, reload };
}

export function useAutomations(client: WevirClient) {
  return useReloading(
    client,
    () => client.request('automation.list', {}).then((result) => result.automations),
    () => true,
  );
}

export function useAutomation(client: WevirClient, automationId: AutomationId) {
  return useReloading<{ automation: Automation; runs: AutomationRun[] }>(
    client,
    () => client.request('automation.get', { automationId }),
    (id) => id === automationId,
  );
}
