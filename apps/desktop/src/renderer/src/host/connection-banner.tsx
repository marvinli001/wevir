import { cn } from 'cn';
import { CircleCheck, Copy, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { useHostConnection } from './host-connection';
import { type ConnectionBanner as Banner, connectionBanner } from './host-status';

/** 断线恢复之后“已重新连接”的显示时长。 */
const RECONNECTED_MS = 2500;

/**
 * 窗口顶部的连接提示（T5.5）：与 Host 断线、Host 正在重新启动、在等外部的 Host 回来、Host 起不来（带原因与日志
 * 路径）。连接正常时不占位；断线恢复后短暂显示“已重新连接”。
 */
export function ConnectionBanner() {
  const { view, hostStatus, retry, client } = useHostConnection();
  const banner = connectionBanner(view, hostStatus);
  const reconnected = useReconnectedFlash(view.status === 'connected', banner !== undefined);

  if (banner) {
    const onAction = banner.action === 'reconnect' ? () => client?.reconnectNow() : retry;
    return <BannerView banner={banner} onAction={onAction} />;
  }
  if (!reconnected) return null;
  return (
    <div
      role="status"
      data-testid="connection-banner"
      data-tone="success"
      className="flex shrink-0 items-center gap-2.5 border-b border-success/20 bg-success/10 px-4 py-2 text-sm text-success"
    >
      <CircleCheck className="size-4 shrink-0" />
      <p className="font-medium">{t('connection.reconnected')}</p>
    </div>
  );
}

function BannerView({ banner, onAction }: { banner: Banner; onAction: () => void }) {
  const danger = banner.tone === 'danger';
  const Icon = danger ? TriangleAlert : LoaderCircle;
  return (
    <div
      role={danger ? 'alert' : 'status'}
      data-testid="connection-banner"
      data-tone={banner.tone}
      className={cn(
        'flex shrink-0 items-start gap-2.5 border-b px-4 py-2 text-sm',
        danger
          ? 'border-destructive/20 bg-destructive/10 text-destructive'
          : 'border-warning/20 bg-warning/10 text-warning',
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', !danger && 'animate-spin')} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium break-words">{banner.message}</p>
        {banner.detail && <p className="text-xs break-words opacity-80">{banner.detail}</p>}
        {banner.logPath && <LogPath path={banner.logPath} />}
      </div>
      {banner.action && (
        <Button size="sm" variant="outline" className="shrink-0 text-foreground" onClick={onAction}>
          <RefreshCw />
          {t(banner.action === 'reconnect' ? 'connection.reconnectNow' : 'connection.retry')}
        </Button>
      )}
    </div>
  );
}

function LogPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-xs">
      <span className="min-w-0 font-mono break-all select-text">
        {t('connection.logPath', { path })}
      </span>
      <Button
        size="xs"
        variant="ghost"
        className="shrink-0 text-current"
        onClick={() => {
          void window.wevir.copyText(path).then(() => setCopied(true));
        }}
      >
        <Copy />
        {t(copied ? 'connection.logPathCopied' : 'connection.copyLogPath')}
      </Button>
    </p>
  );
}

/** 显示过断线提示、随后连上了：短暂返回 true。 */
function useReconnectedFlash(connected: boolean, showingBanner: boolean): boolean {
  const hadBanner = useRef(false);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (showingBanner) {
      hadBanner.current = true;
      setFlash(false);
      return;
    }
    if (!connected || !hadBanner.current) return;
    hadBanner.current = false;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), RECONNECTED_MS);
    return () => window.clearTimeout(timer);
  }, [connected, showingBanner]);
  return flash;
}
