import {
  type ConnectionState,
  type HostHello,
  WevirClient,
  webSocketTransport,
} from '@wevir/client-sdk';
import type { ClientIdentity } from '@wevir/protocol';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { HostProcessStatus } from '../../../shared/desktop-api.js';
import { describeError } from './error-text';

export type HostConnectionView =
  | { status: 'connecting' }
  | { status: 'connected'; hello: HostHello }
  | { status: 'reconnecting'; attempt: number }
  | { status: 'closed'; error?: string }
  /** 第一次就连不上（Host 没能启动、找不到 Node 等），client-sdk 不重试；Host 回到运行时再连。 */
  | { status: 'failed'; error: string };

export interface HostConnection {
  view: HostConnectionView;
  /** 第一次连上之后才有；断线重连期间仍是同一个客户端（请求会排队，订阅按 seq 续订）。 */
  client: WevirClient | undefined;
  /** 本连接在 `host.hello` 里的身份，用来认出“本端做的决定”“本端发的消息”。 */
  identity: ClientIdentity | undefined;
  /** 主进程看到的 Host 进程状态（T5.5）：连接断了时据此说明原因。还没读到时为 undefined。 */
  hostStatus: HostProcessStatus | undefined;
  /**
   * 手动重试：Host 起不来时让主进程重新附着或拉起；断线重连中时立即重连，不等退避；首次连接失败或连接已关闭时
   * 重新连接。
   */
  retry(): void;
}

const HostConnectionContext = createContext<HostConnection | null>(null);

interface ConnectionFields {
  view: HostConnectionView;
  client: WevirClient | undefined;
  identity: ClientIdentity | undefined;
  hostStatus: HostProcessStatus | undefined;
}

/**
 * 连接 Host 并跟踪连接状态（T5.1），T5.2 起经 context 交给整个界面。端点每次连接尝试前向主进程要
 * （`window.wevir.getHostConnection()`），令牌只在这次调用的返回值与 client-sdk 的内存里。
 *
 * T5.5：断线后 client-sdk 按退避自动重连、按 seq 续订；主进程推来的 Host 进程状态回到 `running`（拥有的 Host 被
 * 重新拉起、附着的 Host 回来了）时立即重连，第一次就没连上或连接已关闭的，这时重新连接。
 */
export function HostConnectionProvider({ children }: { children: ReactNode }) {
  const [fields, setFields] = useState<ConnectionFields>({
    view: { status: 'connecting' },
    client: undefined,
    identity: undefined,
    hostStatus: undefined,
  });
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let client: WevirClient | undefined;
    let connecting = false;
    let hostStatus: HostProcessStatus | undefined;
    const update = (patch: Partial<ConnectionFields>) => {
      if (!disposed) setFields((current) => ({ ...current, ...patch }));
    };

    const connect = async () => {
      if (disposed || connecting) return;
      connecting = true;
      update({ view: { status: 'connecting' } });
      try {
        const { identity } = await window.wevir.getHostConnection();
        const connected = await WevirClient.connect({
          endpoint: async () => {
            const { url, token } = await window.wevir.getHostConnection();
            return { url, token };
          },
          transport: webSocketTransport(WebSocket),
          identity,
          onStateChange: (state) => {
            // 被替换掉的旧客户端（关闭后重新连接）不再更新界面。
            if (client === undefined || client === connected) update({ view: toView(state) });
          },
        });
        if (disposed) {
          connected.close();
          return;
        }
        client = connected;
        update({
          view: { status: 'connected', hello: connected.hello },
          client: connected,
          identity,
        });
      } catch (error) {
        update({ view: { status: 'failed', error: describe(error) } });
      } finally {
        connecting = false;
      }
    };

    /** 连上过、而且没有关闭：client-sdk 自己在重连。否则要新建连接。 */
    const reconnect = () => {
      if (client && client.state.status !== 'closed') client.reconnectNow();
      else void connect();
    };

    const onHostStatus = (status: HostProcessStatus) => {
      hostStatus = status;
      update({ hostStatus: status });
      if (status.phase === 'running') reconnect();
    };
    const unsubscribe = window.wevir.onHostStatus(onHostStatus);
    void window.wevir
      .getHostStatus()
      .then((status) => {
        // 推送可能先到：只在还没收到推送时采用。
        if (!disposed && hostStatus === undefined) {
          hostStatus = status;
          update({ hostStatus: status });
        }
      })
      .catch(() => {});

    retryRef.current = () => {
      if (hostStatus?.phase === 'failed') void window.wevir.retryHost();
      else reconnect();
    };

    void connect();
    return () => {
      disposed = true;
      unsubscribe();
      client?.close();
    };
  }, []);

  const connection = useMemo<HostConnection>(
    () => ({ ...fields, retry: () => retryRef.current() }),
    [fields],
  );
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

/** 错误的说法，按界面语言（host/error-text.ts）。 */
export const describe = describeError;
