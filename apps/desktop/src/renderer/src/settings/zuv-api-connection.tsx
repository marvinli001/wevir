import type { WevirClient } from '@wevir/client-sdk';
import type { ZuvApiError, ZuvApiState } from '@wevir/protocol';
import { ExternalLink, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { useWorkbenchStore } from '@/data/workbench-data';
import { describe } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { capabilities, platformApi } from '@/platform/platform';

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

export function ZuvApiConnectionPanel({ client }: { client: WevirClient }) {
  const store = useWorkbenchStore();
  const [connection, setConnection] = useState<ZuvApiState>();
  const [busy, setBusy] = useState(false);
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
    setBusy(true);
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
      setBusy(false);
    }
  };

  const pending = connection?.status === 'authorizing';
  const connected = connection?.status === 'connected';
  return (
    <section className="space-y-4" data-zuv-api-connection>
      <p className="flex items-center gap-2 text-sm" role="status">
        {(!connection || pending) && <LoaderCircle className="size-4 animate-spin" />}
        {t(
          pending
            ? 'provider.zuvApi.waiting'
            : connected
              ? 'provider.zuvApi.connected'
              : 'provider.zuvApi.disconnected',
        )}
      </p>
      {connection?.account && (
        <div className="space-y-1 text-sm">
          <p className="break-all">{connection.account.email}</p>
          <p className="font-mono text-xs text-muted-foreground">{connection.keyPrefix}…</p>
        </div>
      )}
      {connection?.error && (
        <p role="alert" className="text-sm text-destructive">
          {zuvApiError(connection.error)}
        </p>
      )}
      {connection?.modelsError && (
        <p role="alert" className="text-sm text-destructive">
          {t('provider.zuvApi.modelsFailed', { reason: zuvApiError(connection.modelsError) })}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {pending && connection?.login ? (
          <>
            <a
              className={buttonVariants({ variant: 'outline' })}
              href={connection.login.authorizationUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="size-4" />
              {t('provider.zuvApi.open')}
            </a>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void run('zuvApi.cancel')}
            >
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            disabled={busy || !connection}
            onClick={() => void run('zuvApi.login')}
          >
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
              disabled={busy}
              onClick={() => void run('zuvApi.refreshModels')}
            >
              {t('provider.zuvApi.models')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void run('zuvApi.disconnect')}
            >
              {t('provider.zuvApi.disconnect')}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
