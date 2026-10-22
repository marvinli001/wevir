import type { WevirClient } from '@wevir/client-sdk';
import type { AccountState, AccountUpstream } from '@wevir/protocol';
import { Check, Copy, ExternalLink, LoaderCircle, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { StatusDot } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { accountRef } from '@/data/sources';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import {
  connectMode,
  connectParams,
  loginPrompt,
  SEARCH_THRESHOLD,
  upstreamsStamp,
  visibleUpstreams,
} from './subscription-upstreams-model';

type RunAccount = (
  label: string,
  op: () => Promise<{ account: AccountState }>,
) => Promise<AccountState | undefined>;

/**
 * 订阅来源后面接着的上游（0.56.0，OpenCode）：常用的几家一行一个，带“连接 / 断开”；其余收在“更多”里，多了可以搜索。填 Key 的
 * 上游展开一个输入框，OAuth 的开浏览器授权或显示设备码，进行中的登录在列表上方，可以取消。Key 只在输入框里，交给 Host 后就清空。
 */
export function UpstreamList({
  client,
  account,
  busy,
  onRun,
}: {
  client: WevirClient;
  account: AccountState;
  busy: string | undefined;
  onRun: RunAccount;
}) {
  const [upstreams, setUpstreams] = useState<AccountUpstream[]>();
  const [loadError, setLoadError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [secret, setSecret] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const stamp = upstreamsStamp(account);
  // 0.104.0：上游的接上与否按账号（添加的账号带 ID）。
  const ref = accountRef(account);

  // 接上、断开、登录开始与结束都会改账号状态：状态变了就重新读。
  // biome-ignore lint/correctness/useExhaustiveDependencies: stamp 就是依赖的账号字段。
  useEffect(() => {
    let alive = true;
    client
      .request('account.upstreams', ref)
      .then((result) => {
        if (!alive) return;
        setUpstreams(result.upstreams);
        setLoadError(undefined);
      })
      .catch((reason) => alive && setLoadError(describe(reason)));
    return () => {
      alive = false;
    };
  }, [client, ref.kind, ref.id, stamp]);

  const prompt = loginPrompt(account.login);
  const login = async (upstream: AccountUpstream, option: string, apiKey?: string) => {
    const method = upstream.methods.find((candidate) => candidate.option === option);
    if (method === undefined) return;
    const next = await onRun(`connect:${upstream.id}`, () =>
      client.request('account.login', connectParams(ref, upstream, method, apiKey)),
    );
    if (next === undefined) return;
    setSecret('');
    setOpen(undefined);
    const started = loginPrompt(next.login);
    if (started !== undefined && started.kind !== 'waiting') {
      void window.wevir.openExternal(started.url);
    }
  };
  const disconnect = (upstream: AccountUpstream) =>
    onRun(`disconnect:${upstream.id}`, () =>
      client.request('account.logout', { ...ref, upstream: upstream.id }),
    );

  if (upstreams === undefined) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        {loadError === undefined ? (
          <>
            <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
            {t('common.loading')}
          </>
        ) : (
          loadError
        )}
      </p>
    );
  }

  const { rows, hidden } = visibleUpstreams(upstreams, { query, expanded });
  return (
    <div className="space-y-3" data-upstreams>
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm font-medium">{t('source.upstream.title')}</p>
        {upstreams.length > SEARCH_THRESHOLD && (
          <div className="relative w-44 shrink-0">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('source.upstream.search')}
              aria-label={t('source.upstream.search')}
              className="h-7 pl-7 text-xs"
              data-upstream-search
            />
          </div>
        )}
      </div>
      {prompt !== undefined && (
        <LoginPanel
          prompt={prompt}
          busy={busy !== undefined}
          onCancel={() =>
            void onRun('cancel', () =>
              client.request('account.cancelLogin', {
                ...ref,
                ...(account.login !== undefined && { loginId: account.login.loginId }),
              }),
            )
          }
        />
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('source.upstream.empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-background/50">
          {rows.map((upstream) => (
            <UpstreamRow
              key={upstream.id}
              upstream={upstream}
              open={open === upstream.id}
              busy={busy}
              secret={secret}
              onSecret={setSecret}
              onConnect={() => {
                const mode = connectMode(upstream);
                const [only] = upstream.methods;
                if (mode === 'oauth' && only !== undefined) {
                  void login(upstream, only.option);
                  return;
                }
                setSecret('');
                setOpen((current) => (current === upstream.id ? undefined : upstream.id));
              }}
              onLogin={(option, apiKey) => void login(upstream, option, apiKey)}
              onDisconnect={() => void disconnect(upstream)}
            />
          ))}
        </ul>
      )}
      {query.trim() === '' && (hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:underline"
          data-action="toggle-more-upstreams"
        >
          {expanded ? t('source.upstream.less') : t('source.upstream.more', { count: hidden })}
        </button>
      )}
    </div>
  );
}

function UpstreamRow({
  upstream,
  open,
  busy,
  secret,
  onSecret,
  onConnect,
  onLogin,
  onDisconnect,
}: {
  upstream: AccountUpstream;
  open: boolean;
  busy: string | undefined;
  secret: string;
  onSecret: (value: string) => void;
  onConnect: () => void;
  onLogin: (option: string, apiKey?: string) => void;
  onDisconnect: () => void;
}) {
  const working = busy === `connect:${upstream.id}` || busy === `disconnect:${upstream.id}`;
  return (
    <li className="px-3 py-2" data-upstream={upstream.id} data-connected={upstream.connected}>
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {upstream.connected && (
            <StatusDot tone="success" label={t('source.upstream.connected')} />
          )}
          <span className="truncate text-sm">{upstream.name}</span>
        </span>
        {upstream.connected ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== undefined}
            onClick={onDisconnect}
            data-action="disconnect-upstream"
          >
            {working && <LoaderCircle className="animate-spin" />}
            {t('source.upstream.disconnect')}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== undefined}
            onClick={onConnect}
            aria-expanded={open}
            data-action="connect-upstream"
          >
            {working && <LoaderCircle className="animate-spin" />}
            {t('source.upstream.connect')}
          </Button>
        )}
      </div>
      {open && !upstream.connected && (
        <div className="mt-2 space-y-2">
          {upstream.methods.map((method) =>
            method.type === 'oauth' ? (
              <Button
                key={method.option}
                variant="outline"
                size="sm"
                disabled={busy !== undefined}
                onClick={() => onLogin(method.option)}
                data-action="oauth-upstream"
              >
                <ExternalLink />
                {method.label}
              </Button>
            ) : (
              <form
                key={method.option}
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (secret.trim() !== '') onLogin(method.option, secret);
                }}
              >
                <Input
                  autoFocus
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={secret}
                  onChange={(event) => onSecret(event.target.value)}
                  placeholder={t('source.upstream.apiKey')}
                  aria-label={`${upstream.name} ${t('source.upstream.apiKey')}`}
                  className="h-8 font-mono text-xs"
                  data-upstream-key
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy !== undefined || secret.trim() === ''}
                >
                  {t('source.upstream.save')}
                </Button>
              </form>
            ),
          )}
        </div>
      )}
    </li>
  );
}

/** 进行中的登录：浏览器授权（重新打开）或设备码（码、打开页面），都可以取消。 */
function LoginPanel({
  prompt,
  busy,
  onCancel,
}: {
  prompt: NonNullable<ReturnType<typeof loginPrompt>>;
  busy: boolean;
  onCancel: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2"
      data-upstream-login={prompt.kind}
    >
      <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      <span className="min-w-0 flex-1 basis-40 text-sm">
        {prompt.kind === 'device_code'
          ? t('source.upstream.deviceCode')
          : t('source.signingIn.title')}
        {prompt.kind === 'device_code' && (
          <code className="ml-3 font-mono text-sm font-medium tracking-wider" data-device-code>
            {prompt.code}
          </code>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {prompt.kind === 'device_code' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void window.wevir.copyText(prompt.code).then(() => setCopied(true))}
          >
            {copied ? <Check className="confirm-pop" /> : <Copy />}
            {t(copied ? 'source.copied' : 'source.copy')}
          </Button>
        )}
        {prompt.kind !== 'waiting' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void window.wevir.openExternal(prompt.url)}
          >
            <ExternalLink />
            {prompt.kind === 'device_code'
              ? t('source.upstream.openPage')
              : t('source.signingIn.reopen')}
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>
          {t('source.cancel')}
        </Button>
      </span>
    </div>
  );
}
