import type { WevirClient } from '@wevir/client-sdk';
import type { ZuvApiError, ZuvApiState } from '@wevir/protocol';
import { ExternalLink, KeyRound, LoaderCircle, LogIn, RotateCw, Unplug } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { StatusDot } from '@/components/status-dot';
import { Button, buttonVariants } from '@/components/ui/button';
import { useWorkbenchStore } from '@/data/workbench-data';
import { describe } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { capabilities, platformApi } from '@/platform/platform';
import { NoticeBanner } from './settings-ui';

const ERRORS: Partial<Record<ZuvApiError, PlainMessageKey>> = {
  network: 'provider.test.reason.network',
  timeout: 'provider.test.reason.timeout',
  service: 'provider.test.reason.server',
  server: 'provider.test.reason.server',
  auth: 'provider.test.reason.auth',
  invalid_api_key: 'provider.test.reason.auth',
  protocol: 'provider.test.reason.protocol',
  rate_limited: 'provider.zuvApi.rateLimited',
  slow_down: 'provider.zuvApi.rateLimited',
  authorization_expired: 'provider.zuvApi.expired',
  authorization_cancelled: 'provider.zuvApi.cancelled',
  authorization_denied: 'provider.zuvApi.denied',
  authorization_completed: 'provider.zuvApi.completed',
  authorization_not_found: 'provider.zuvApi.notFound',
  invalid_host_proof: 'provider.zuvApi.invalidResponse',
  invalid_response: 'provider.zuvApi.invalidResponse',
  key_disabled: 'provider.zuvApi.keyDisabled',
  key_revoked: 'provider.zuvApi.keyRevoked',
  key_expired: 'provider.zuvApi.keyExpired',
  key_limit_reached: 'provider.zuvApi.keyLimit',
  key_window_limit: 'provider.zuvApi.windowLimit',
  key_replaced: 'provider.zuvApi.keyReplaced',
  key_limit: 'provider.zuvApi.keyCount',
  account_suspended: 'provider.zuvApi.suspended',
  no_models: 'provider.zuvApi.noModels',
  not_revealable: 'provider.zuvApi.notRevealable',
  ip_not_allowed: 'provider.zuvApi.ipDenied',
};

export function zuvApiError(error: ZuvApiError): string {
  return t(ERRORS[error] ?? 'provider.test.reason.server');
}

type Action = 'zuvApi.login' | 'zuvApi.cancel' | 'zuvApi.disconnect' | 'zuvApi.refreshModels';

/**
 * ZUV API 的登录连接（设置 → 模型服务）：照订阅来源的详情，在列表里就地展开，不另开页面。已连接时列出账号与 API Key 前缀（模型太多，不逐个列出），
 * 下面一排“重新登录”“刷新模型”“断开连接”；未连接时“登录连接”（新增时还有“手动填写”，转到填 Key 的表单）；授权中显示进度与
 * “打开授权页”“取消”。每 2 s 读一次状态，变了刷新工作台。
 */
export function ZuvApiConnectionPanel({
  client,
  onManual,
}: {
  client: WevirClient;
  onManual?: () => void;
}) {
  const store = useWorkbenchStore();
  const [connection, setConnection] = useState<ZuvApiState>();
  const [busy, setBusy] = useState<Action>();
  const [failure, setFailure] = useState<string>();
  const version = useRef('');

  useEffect(() => {
    let live = true;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const { connection: next } = await client.request('zuvApi.get');
        if (!live) return;
        setConnection(next);
        setFailure(undefined);
        const signature = `${next.status}:${next.keyPrefix}:${next.modelCount}:${next.modelsError}`;
        if (version.current !== signature) {
          version.current = signature;
          await store?.refresh();
        }
      } catch (error) {
        if (live) setFailure(describe(error));
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => {
      void read();
    }, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, store]);

  const run = async (action: Action) => {
    if (busy) return;
    const popup =
      action === 'zuvApi.login' && !capabilities().localHost
        ? window.open('about:blank', '_blank')
        : null;
    if (popup) popup.opener = null;
    setBusy(action);
    setFailure(undefined);
    try {
      const params = action === 'zuvApi.cancel' ? { requestId: connection?.login?.requestId } : {};
      const { connection: next } = await client.request(action, params, { timeoutMs: 60_000 });
      setConnection(next);
      if (action === 'zuvApi.login' && next.login) {
        if (popup) popup.location.replace(next.login.authorizationUrl);
        else if (capabilities().localHost)
          await platformApi().openExternal(next.login.authorizationUrl);
      } else popup?.close();
      await store?.refresh();
    } catch (error) {
      popup?.close();
      setFailure(describe(error));
    } finally {
      setBusy(undefined);
    }
  };

  const manual = async () => {
    if (!onManual || busy) return;
    if (connection?.status === 'authorizing') await run('zuvApi.cancel');
    onManual();
  };

  const pending = connection?.status === 'authorizing';
  const connected = connection?.status === 'connected';
  const errors = [
    connection?.error && zuvApiError(connection.error),
    connection?.modelsError &&
      t('provider.zuvApi.modelsFailed', { reason: zuvApiError(connection.modelsError) }),
    failure,
  ].filter((text): text is string => typeof text === 'string' && text !== '');
  const facts: [string, ReactNode][] = [];
  if (connection?.account) {
    facts.push([t('source.fact.account'), connection.account.email]);
    if (connection.keyPrefix)
      facts.push([
        t('provider.form.apiKey'),
        <span key="key" className="font-mono text-xs">
          {connection.keyPrefix}…
        </span>,
      ]);
  }
  const spinner = (action: Action) =>
    busy === action ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : null;

  return (
    <section className="space-y-4" data-zuv-api-connection={connection?.status ?? 'loading'}>
      {connected && facts.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 truncate">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {/* 未连接与授权中：状态在左、按钮在右，一行。 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {!connected && (
          <p className="mr-auto flex min-h-8 items-center gap-2 pr-3 text-sm" role="status">
            {!connection || pending ? (
              <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
            ) : (
              <StatusDot tone={connection.status === 'error' ? 'danger' : 'neutral'} />
            )}
            {t(pending ? 'provider.zuvApi.waiting' : 'provider.zuvApi.disconnected')}
          </p>
        )}
        {pending && connection?.login ? (
          <>
            <a
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              href={connection.login.authorizationUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink data-icon="inline-start" />
              {t('provider.zuvApi.open')}
            </a>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy !== undefined}
              onClick={() => void run('zuvApi.cancel')}
            >
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant={connected ? 'outline' : 'default'}
            size="sm"
            disabled={busy !== undefined || !connection}
            onClick={() => void run('zuvApi.login')}
            data-action="zuv-login"
          >
            {spinner('zuvApi.login') ?? <LogIn data-icon="inline-start" />}
            {t(
              connected || connection?.status === 'error'
                ? 'provider.zuvApi.reconnect'
                : 'provider.zuvApi.login',
            )}
          </Button>
        )}
        {connected && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== undefined}
              onClick={() => void run('zuvApi.refreshModels')}
              data-action="zuv-refresh-models"
            >
              {spinner('zuvApi.refreshModels') ?? <RotateCw data-icon="inline-start" />}
              {t('provider.zuvApi.models')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy !== undefined}
              onClick={() => void run('zuvApi.disconnect')}
              data-action="zuv-disconnect"
            >
              {spinner('zuvApi.disconnect') ?? <Unplug data-icon="inline-start" />}
              {t('provider.zuvApi.disconnect')}
            </Button>
          </>
        )}
        {onManual && !connected && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy !== undefined}
            onClick={() => void manual()}
            data-action="zuv-manual"
          >
            <KeyRound data-icon="inline-start" />
            {t('provider.zuvApi.manual')}
          </Button>
        )}
      </div>
      {errors.map((text) => (
        <NoticeBanner key={text} notice={{ tone: 'error', text }} />
      ))}
    </section>
  );
}
