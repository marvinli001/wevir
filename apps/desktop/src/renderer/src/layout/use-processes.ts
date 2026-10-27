// “进程输出”窗格的数据（0.69.0）：列表读 `process.list`，`process.changed` 来了就合进来（带状态的整条替换、`removed` 删掉）；
// 重连后（listener 收到 undefined）重新列一次，Host 重启过时列表变空、旧的进程就不在了。选中的进程的输出先读最后一页，之后跟着
// `bytes` 往后读；“加载更早的输出”往前补一页。断线期间记着偏移量，重连后从那里接着读，不丢不重。

import type { WevirClient } from '@wevir/client-sdk';
import type { HostProcess, SessionId, WorkspaceId } from '@wevir/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useHostConnection } from '@/host/host-connection';
import {
  appendPage,
  bufferFromPage,
  type OutputBuffer,
  prependPage,
  processKey,
} from './process-model';

export interface ProcessFilter {
  workspaceId: WorkspaceId;
  /** 只列这个会话的；省略时列整个项目的。 */
  sessionId?: SessionId;
}

const matches = (process: HostProcess, filter: ProcessFilter) =>
  process.workspaceId === filter.workspaceId &&
  (filter.sessionId === undefined || process.source.sessionId === filter.sessionId);

/** `client` 为 undefined（没连上、Host 没有 `process_output`、调用方现在不读）时列表是 undefined。 */
export function useProcessList(
  client: WevirClient | undefined,
  filter: ProcessFilter,
): { processes: HostProcess[] | undefined; error: unknown } {
  const [processes, setProcesses] = useState<HostProcess[]>();
  const [error, setError] = useState<unknown>();
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const { workspaceId, sessionId } = filter;

  // 换项目或会话时重新列。
  useEffect(() => {
    setProcesses(undefined);
    if (!client) return;
    let seq = 0;
    let alive = true;
    const reload = () => {
      const id = ++seq;
      client.request('process.list', { workspaceId, ...(sessionId && { sessionId }) }).then(
        (result) => {
          if (!alive || id !== seq) return;
          setProcesses(result.processes);
          setError(undefined);
        },
        (reason: unknown) => {
          if (alive && id === seq) setError(reason);
        },
      );
    };
    reload();
    const off = client.onProcessesChanged((change) => {
      if (change === undefined) {
        reload();
        return;
      }
      if ('removed' in change) {
        const key = processKey(change.removed);
        setProcesses((list) => list?.filter((item) => processKey(item) !== key));
        return;
      }
      const next = change.process;
      if (!matches(next, filterRef.current)) return;
      setProcesses((list) => {
        if (list === undefined) return list;
        const key = processKey(next);
        const at = list.findIndex((item) => processKey(item) === key);
        if (at < 0) return [...list.filter((item) => item.id !== next.id), next];
        const copy = [...list];
        copy[at] = next;
        return copy;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, [client, workspaceId, sessionId]);

  return { processes, error };
}

const NO_PROCESSES: readonly HostProcess[] = [];

/**
 * 会话的后台进程（“后台任务”窗格与会话侧栏卡片，desktop-layout.md §15）；Host 没有 `process_output` 或 `active` 为 false 时是空的，
 * 不去 Host 读。
 */
export function useSessionProcesses(
  workspaceId: string,
  sessionId: string,
  active = true,
): readonly HostProcess[] {
  const { client } = useHostConnection();
  const usable = active && client?.supports('process_output') ? client : undefined;
  return (
    useProcessList(usable, {
      workspaceId: workspaceId as WorkspaceId,
      sessionId: sessionId as SessionId,
    }).processes ?? NO_PROCESSES
  );
}

export interface ProcessOutput {
  buffer: OutputBuffer | undefined;
  error: unknown;
  loadingEarlier: boolean;
  loadEarlier: () => void;
  /** 丢掉缓冲，重读最后一页并接着跟。 */
  jumpToLatest: () => void;
}

/** 选中的进程的输出；`process` 的 `bytes` 变多时往后读。 */
export function useProcessOutput(
  client: WevirClient,
  process: HostProcess | undefined,
): ProcessOutput {
  const key = process === undefined ? undefined : processKey(process);
  const [state, setState] = useState<{ key: string; buffer: OutputBuffer } | undefined>();
  const [error, setError] = useState<unknown>();
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 同一时刻只有一个往后读的请求；读的时候又变多了，读完再来一次。 */
  const reading = useRef<{ key: string; again: boolean } | undefined>(undefined);
  const [reset, setReset] = useState(0);

  const readForward = useCallback(
    async (target: HostProcess) => {
      const targetKey = processKey(target);
      if (reading.current?.key === targetKey) {
        reading.current.again = true;
        return;
      }
      reading.current = { key: targetKey, again: false };
      try {
        for (;;) {
          const current = stateRef.current?.key === targetKey ? stateRef.current.buffer : undefined;
          if (current?.detached) break;
          const page = await client.request(
            'process.output',
            current === undefined
              ? { processId: target.id }
              : { processId: target.id, offset: current.next },
          );
          if (reading.current?.key !== targetKey) return;
          const merged = current === undefined ? bufferFromPage(page) : appendPage(current, page);
          stateRef.current = { key: targetKey, buffer: merged };
          setState(stateRef.current);
          setError(undefined);
          if (page.more) continue;
          if (reading.current.again) {
            reading.current.again = false;
            continue;
          }
          break;
        }
      } catch (reason) {
        if (reading.current?.key === targetKey) setError(reason);
      } finally {
        if (reading.current?.key === targetKey) reading.current = undefined;
      }
    },
    [client],
  );

  // 换了进程（或跳到最新）：从最后一页读起。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只看进程本身与 reset。
  useEffect(() => {
    reading.current = undefined;
    stateRef.current = undefined;
    setState(undefined);
    setError(undefined);
    if (process !== undefined) void readForward(process);
  }, [key, reset]);

  // 输出变多（通知、重连后重新列出）：从记下的偏移量往后读。
  const bytes = process?.bytes;
  useEffect(() => {
    if (process === undefined || bytes === undefined) return;
    const current = stateRef.current;
    if (current?.key !== processKey(process) || current.buffer.next >= bytes) return;
    void readForward(process);
  }, [bytes, process, readForward]);

  const loadEarlier = useCallback(() => {
    const current = stateRef.current;
    if (process === undefined || current === undefined || current.key !== processKey(process))
      return;
    const { buffer } = current;
    if (buffer.from <= buffer.start) return;
    setLoadingEarlier(true);
    client
      .request('process.output', {
        processId: process.id,
        offset: Math.max(buffer.start, buffer.from - 256 * 1024),
        until: buffer.from,
      })
      .then(
        (page) => {
          const latest = stateRef.current;
          if (latest?.key !== current.key) return;
          stateRef.current = { key: latest.key, buffer: prependPage(latest.buffer, page) };
          setState(stateRef.current);
        },
        (reason: unknown) => setError(reason),
      )
      .finally(() => setLoadingEarlier(false));
  }, [client, process]);

  return {
    buffer: state?.key === key ? state?.buffer : undefined,
    error,
    loadingEarlier,
    loadEarlier,
    jumpToLatest: () => setReset((value) => value + 1),
  };
}
