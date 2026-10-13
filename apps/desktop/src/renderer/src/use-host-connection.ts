import {
  type ConnectionState,
  type HostHello,
  WevirClient,
  webSocketTransport,
} from '@wevir/client-sdk';
import { useEffect, useState } from 'react';

export type HostConnectionView =
  | { status: 'connecting' }
  | { status: 'connected'; hello: HostHello }
  | { status: 'reconnecting'; attempt: number }
  | { status: 'closed'; error?: string }
  /** 第一次就连不上（Host 没能启动、找不到 Node 等），client-sdk 不重试。 */
  | { status: 'failed'; error: string };

/**
 * 连接 Host 并跟踪连接状态。端点每次连接尝试前向主进程要（`window.wevir.getHostConnection()`），令牌只在
 * 这次调用的返回值与 client-sdk 的内存里。
 */
export function useHostConnection(): HostConnectionView {
  const [view, setView] = useState<HostConnectionView>({ status: 'connecting' });

  useEffect(() => {
    let disposed = false;
    let client: WevirClient | undefined;
    const update = (next: HostConnectionView) => {
      if (!disposed) setView(next);
    };
    void (async () => {
      try {
        const { identity } = await window.wevir.getHostConnection();
        const connected = await WevirClient.connect({
          endpoint: async () => {
            const { url, token } = await window.wevir.getHostConnection();
            return { url, token };
          },
          transport: webSocketTransport(WebSocket),
          identity,
          onStateChange: (state) => update(toView(state)),
        });
        if (disposed) {
          connected.close();
          return;
        }
        client = connected;
        update({ status: 'connected', hello: connected.hello });
      } catch (error) {
        update({ status: 'failed', error: describe(error) });
      }
    })();
    return () => {
      disposed = true;
      client?.close();
    };
  }, []);

  return view;
}

function toView(state: ConnectionState): HostConnectionView {
  switch (state.status) {
    case 'connecting':
      return { status: 'connecting' };
    case 'connected':
      return { status: 'connected', hello: state.hello };
    case 'reconnecting':
      return { status: 'reconnecting', attempt: state.attempt };
    case 'closed':
      return state.error === undefined
        ? { status: 'closed' }
        : { status: 'closed', error: describe(state.error) };
  }
}

/** 去掉 Electron 给 IPC 错误加的前缀（“Error invoking remote method '…': HostStartError: ”）。 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '');
}
