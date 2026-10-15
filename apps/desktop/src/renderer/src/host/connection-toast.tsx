import { Copy, RefreshCw } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Toast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { useHostConnection } from './host-connection';
import { type ConnectionNotice, connectionNotice } from './host-status';

/** 断线恢复之后“已重新连接”的显示时长。 */
const RECONNECTED_MS = 2500;

/** 卡片里显示的内容：断线的说明，或恢复后的“已重新连接”。 */
type Shown = { kind: 'notice'; notice: ConnectionNotice } | { kind: 'reconnected' };

/**
 * 窗口右下角的连接通知（T5.5，U25 起是通知卡片，之前是窗口顶部的横条）：与 Host 断线、Host 正在重新启动、在等外部的
 * Host 回来、Host 起不来（带原因与日志路径）。连接正常时没有；断线恢复后同一张卡片换成“已重新连接”，随后自动关闭。
 * 用户关掉的那种情况不再弹出，换了情况或连上之后才会。
 */
export function ConnectionToast() {
  const { view, hostStatus, retry, client } = useHostConnection();
  const notice = connectionNotice(view, hostStatus);
  const disconnected = notice !== undefined;
  const [reconnected, clearReconnected] = useReconnectedFlash(
    view.status === 'connected',
    disconnected,
  );
  const [dismissed, setDismissed] = useState<ConnectionNotice['kind']>();
  useEffect(() => {
    if (!disconnected) setDismissed(undefined);
  }, [disconnected]);

  const current: Shown | undefined =
    notice && notice.kind !== dismissed
      ? { kind: 'notice', notice }
      : reconnected
        ? { kind: 'reconnected' }
        : undefined;
  // 离场动画里仍显示最后的内容。
  const last = useRef<Shown | undefined>(current);
  if (current) last.current = current;
  const shown = current ?? last.current;
  if (!shown) return null;

  const open = current !== undefined;
  if (shown.kind === 'reconnected') {
    return (
      <Toast
        open={open}
        tone="success"
        title={t('connection.reconnected')}
        duration={RECONNECTED_MS}
        onClose={clearReconnected}
        testId="connection-toast"
      />
    );
  }

  const shownNotice = shown.notice;
  const onAction = shownNotice.action === 'reconnect' ? () => client?.reconnectNow() : retry;
  return (
    <Toast
      open={open}
      tone={shownNotice.tone === 'danger' ? 'danger' : 'progress'}
      title={shownNotice.message}
      onClose={() => setDismissed(shownNotice.kind)}
      testId="connection-toast"
    >
      {shownNotice.detail && (
        <p className="text-xs break-words text-muted-foreground">{shownNotice.detail}</p>
      )}
      {shownNotice.logPath && (
        <p className="font-mono text-xs break-all text-muted-foreground select-text">
          {t('connection.logPath', { path: shownNotice.logPath })}
        </p>
      )}
      {(shownNotice.action || shownNotice.logPath) && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
          {shownNotice.action && (
            <Button size="sm" variant="outline" onClick={onAction}>
              <RefreshCw />
              {t(
                shownNotice.action === 'reconnect' ? 'connection.reconnectNow' : 'connection.retry',
              )}
            </Button>
          )}
          {shownNotice.logPath && <CopyLogPath path={shownNotice.logPath} />}
        </div>
      )}
    </Toast>
  );
}

function CopyLogPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="text-muted-foreground"
      onClick={() => {
        void window.wevir.copyText(path).then(() => setCopied(true));
      }}
    >
      <Copy />
      {t(copied ? 'connection.logPathCopied' : 'connection.copyLogPath')}
    </Button>
  );
}

/**
 * 显示过断线通知（关掉的也算）、随后连上了：返回 true，直到通知自动关闭或被关掉。在绘制前切换，断线的卡片直接换成
 * “已重新连接”，中间不会先开始离场。
 */
function useReconnectedFlash(connected: boolean, disconnected: boolean): [boolean, () => void] {
  const hadNotice = useRef(false);
  const [flash, setFlash] = useState(false);
  useLayoutEffect(() => {
    if (disconnected) {
      hadNotice.current = true;
      setFlash(false);
      return;
    }
    if (!connected || !hadNotice.current) return;
    hadNotice.current = false;
    setFlash(true);
  }, [connected, disconnected]);
  return [flash, () => setFlash(false)];
}
