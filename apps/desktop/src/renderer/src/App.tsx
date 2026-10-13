import { type HostConnectionView, useHostConnection } from './use-host-connection.js';

/** T5.1 只显示与 Host 的连接状态和版本；布局与设计 Token 在 T5.2。 */
export function App() {
  const view = useHostConnection();
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-6 text-sm text-neutral-900">
      <section className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
        <h1 className="text-base font-semibold">Wevir</h1>
        <Status view={view} />
        {view.status === 'connected' && (
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-neutral-600">
            <dt>协议版本</dt>
            <dd className="font-mono text-neutral-900" data-testid="protocol-version">
              {view.hello.protocolVersion}
            </dd>
            <dt>Host 版本</dt>
            <dd className="font-mono text-neutral-900" data-testid="host-version">
              {view.hello.hostVersion}
            </dd>
            <dt>Host ID</dt>
            <dd className="truncate font-mono text-neutral-900">{view.hello.hostId}</dd>
          </dl>
        )}
      </section>
    </main>
  );
}

const LABELS: Record<HostConnectionView['status'], { text: string; dot: string }> = {
  connecting: { text: '正在连接 Host…', dot: 'bg-amber-400' },
  connected: { text: '已连接', dot: 'bg-emerald-500' },
  reconnecting: { text: '连接已断开，正在重连', dot: 'bg-amber-400' },
  closed: { text: '已断开', dot: 'bg-neutral-400' },
  failed: { text: '无法连接 Host', dot: 'bg-red-500' },
};

function Status({ view }: { view: HostConnectionView }) {
  const label = LABELS[view.status];
  const error = view.status === 'failed' || view.status === 'closed' ? view.error : undefined;
  return (
    <div className="mt-3">
      <p className="flex items-center gap-2" data-testid="connection-status">
        <span className={`size-2 rounded-full ${label.dot}`} aria-hidden="true" />
        {label.text}
        {view.status === 'reconnecting' && `（第 ${view.attempt} 次）`}
      </p>
      {error && <p className="mt-2 break-words text-red-600">{error}</p>}
    </div>
  );
}
