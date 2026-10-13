import {
  type ConnectionState,
  type HostHello,
  WevirClient,
  webSocketTransport,
} from '@wevir/client-sdk';
import type { ClientIdentity } from '@wevir/protocol';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

export type HostConnectionView =
  | { status: 'connecting' }
  | { status: 'connected'; hello: HostHello }
  | { status: 'reconnecting'; attempt: number }
  | { status: 'closed'; error?: string }
  /** 第一次就连不上（Host 没能启动、找不到 Node 等），client-sdk 不重试。 */
  | { status: 'failed'; error: string };

export interface HostConnection {
  view: HostConnectionView;
  /** 第一次连上之后才有；断线重连期间仍是同一个客户端（请求会排队）。 */
  client: WevirClient | undefined;
  /** 本连接在 `host.hello` 里的身份，用来认出“本端做的决定”“本端发的消息”。 */
  identity: ClientIdentity | undefined;
}

const HostConnectionContext = createContext<HostConnection | null>(null);

/**
 * 连接 Host 并跟踪连接状态（T5.1），T5.2 起经 context 交给整个界面。端点每次连接尝试前向主进程要
 * （`window.wevir.getHostConnection()`），令牌只在这次调用的返回值与 client-sdk 的内存里。
 */
export function HostConnectionProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<HostConnection>({
    view: { status: 'connecting' },
    client: undefined,
    identity: undefined,
  });

  useEffect(() => {
    let disposed = false;
    let client: WevirClient | undefined;
    const update = (view: HostConnectionView) => {
      if (!disposed) setConnection((current) => ({ ...current, view }));
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
        setConnection({
          view: { status: 'connected', hello: connected.hello },
          client: connected,
          identity,
        });
      } catch (error) {
        update({ status: 'failed', error: describe(error) });
      }
    })();
    return () => {
      disposed = true;
      client?.close();
    };
  }, []);

  return <HostConnectionContext value={connection}>{children}</HostConnectionContext>;
}

export function useHostConnection(): HostConnection {
  const connection = useContext(HostConnectionContext);
  if (!connection) throw new Error('useHostConnection 必须在 HostConnectionProvider 之内使用');
  return connection;
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
export function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '');
}
