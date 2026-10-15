import type { WevirClient } from '@wevir/client-sdk';
import type { AccountKind, AccountState, ProviderProfile } from '@wevir/protocol';
import { cn } from 'cn';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FolderSearch,
  LoaderCircle,
  LogIn,
  LogOut,
  RotateCw,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Collapse } from '@/components/collapse';
import { ProviderLogo } from '@/components/provider-logo';
import { StatusDot } from '@/components/status-dot';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SOURCE_KINDS,
  SOURCES,
  type SourceInfo,
  type SourcePhase,
  sourcePhase,
} from '@/data/sources';
import { useAccounts, useAccountsStore, useWorkbenchStore } from '@/data/workbench-data';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { ChatgptAccountSection, UsageBar } from './chatgpt-account';
import { planLabel } from './chatgpt-account-model';
import { NoticeBanner } from './settings-ui';

/**
 * 设置 → 模型服务的“订阅”（0.19.0，照 T3 Code 的 Bring your own sub，desktop-tokens.md §32）：六种订阅排成一张三列的格子卡，
 * 每格是软件标志（放在内凹的“器皿”里）、名称与一行状态；点一格，卡片下半部展开它的详情——登录（应用内，或给出终端命令再
 * 重新检测）、安装（命令、下载、指定路径）、账号与套餐、用量、模型、在模型选择里显示的开关。这个 Host 还没有引擎的种类写
 * “即将支持”，不能点。
 */
export function SubscriptionSources({
  client,
  providers,
}: {
  client: WevirClient | undefined;
  providers: readonly ProviderProfile[];
}) {
  const accounts = useAccounts();
  const [selected, setSelected] = useState<AccountKind>();
  // 详情收起的过程里继续画刚才那一格的内容，动画才不会先清空。
  const [shown, setShown] = useState<AccountKind>();
  useEffect(() => {
    if (selected !== undefined) setShown(selected);
  }, [selected]);

  const accountOf = (kind: AccountKind) => accounts?.find((account) => account.kind === kind);
  const providerOf = (kind: AccountKind) => providers.find((provider) => provider.id === kind);

  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card"
      data-section="subscriptions"
    >
      {/* 格子之间的细线：网格底是分隔线色，格子之间留 1px 缝。 */}
      <ul className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3">
        {SOURCE_KINDS.map((kind) => (
          <SourceTile
            key={kind}
            source={SOURCES[kind]}
            phase={accounts === undefined ? undefined : sourcePhase(accountOf(kind))}
            provider={providerOf(kind)}
            selected={selected === kind}
            onSelect={() => setSelected((current) => (current === kind ? undefined : kind))}
          />
        ))}
      </ul>
      <Collapse open={selected !== undefined}>
        {shown !== undefined && client !== undefined && (
          <SourceDetail
            key={shown}
            client={client}
            source={SOURCES[shown]}
            account={accountOf(shown)}
            provider={providerOf(shown)}
          />
        )}
      </Collapse>
    </div>
  );
}

/** 软件标志放在内凹的小器皿里：次表面色、细边、内阴影（“静器”）。 */
export function LogoWell({
  logo,
  fallback,
  size = 'md',
  className,
}: {
  logo: SourceInfo['logo'];
  fallback: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-[10px] border border-border bg-background shadow-[inset_0_1px_2px_rgb(0_0_0/0.06)]',
        size === 'md' ? 'size-9' : 'size-7 rounded-lg',
        className,
      )}
    >
      <ProviderLogo
        logo={logo}
        fallback={fallback}
        className={size === 'md' ? 'size-5' : 'size-4'}
      />
    </span>
  );
}

function SourceTile({
  source,
  phase,
  provider,
  selected,
  onSelect,
}: {
  source: SourceInfo;
  /** 还没读到账号时 undefined。 */
  phase: SourcePhase | undefined;
  provider: ProviderProfile | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const soon = phase?.kind === 'soon';
  const name = t(source.name);
  return (
    <li className="relative bg-card">
      <button
        type="button"
        disabled={soon}
        aria-expanded={selected}
        onClick={onSelect}
        data-source={source.kind}
        data-phase={phase?.kind ?? 'loading'}
        className={cn(
          'group/tile flex h-full w-full flex-col gap-3 px-4 pt-4 pb-3.5 text-left outline-none transition-colors duration-150',
          'focus-visible:bg-accent/60 enabled:hover:bg-accent/40',
          selected && 'bg-accent/70 enabled:hover:bg-accent/70',
          soon && 'cursor-default',
        )}
      >
        <span className="flex items-start justify-between gap-2">
          <LogoWell
            logo={source.logo}
            fallback={name}
            className={cn(
              'transition-transform duration-200 ease-smooth group-enabled/tile:group-hover/tile:-translate-y-px',
              soon && 'opacity-45 grayscale',
            )}
          />
          <TileMark phase={phase} disabled={provider?.enabled === false} />
        </span>
        <span className="min-w-0">
          <span
            className={cn('block truncate text-sm font-medium', soon && 'text-muted-foreground')}
          >
            {name}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground" data-status>
            {phase === undefined ? t('common.loading') : phaseText(phase, source)}
            {provider?.enabled === false &&
              phase?.kind === 'signed_in' &&
              ` · ${t('source.disabled')}`}
          </span>
        </span>
      </button>
      {/* 选中的一格下沿有一道墨线，接着下面展开的详情。 */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-x-4 bottom-0 h-0.5 origin-center rounded-full bg-foreground transition-transform duration-200 ease-smooth',
          selected ? 'scale-x-100' : 'scale-x-0',
        )}
      />
    </li>
  );
}

/** 格子右上角：已登录是一个点（停用时空心），登录中、下载中转圈，其余不画。 */
function TileMark({ phase, disabled }: { phase: SourcePhase | undefined; disabled: boolean }) {
  if (phase?.kind === 'signing_in' || phase?.kind === 'installing') {
    return <LoaderCircle aria-hidden className="size-3.5 animate-spin text-muted-foreground" />;
  }
  if (phase?.kind !== 'signed_in') return null;
  return disabled ? (
    <span
      aria-hidden
      className="mt-1 size-2 rounded-full ring-1 ring-muted-foreground ring-inset"
    />
  ) : (
    <StatusDot tone="success" label={t('source.status.signedIn')} className="mt-1 size-2" />
  );
}

function phaseText(phase: SourcePhase, source: SourceInfo): string {
  switch (phase.kind) {
    case 'soon':
      return t('source.status.soon');
    case 'missing':
      return t(phase.canInstall ? 'source.status.downloadable' : 'source.status.missing');
    case 'installing':
      return phase.percent === undefined
        ? t('source.status.installing')
        : t('source.status.installingPercent', { percent: phase.percent });
    case 'signing_in':
      return t('source.status.signingIn');
    case 'signed_out':
      return t('source.status.signedOut');
    case 'signed_in': {
      const plan = source.kind === 'chatgpt' ? planLabel(phase.plan) : phase.plan;
      return plan === undefined ? t('source.status.signedIn') : plan;
    }
  }
}

/** 展开的详情：头部（标志、名称、账号、在模型选择里显示），下面按状态给登录、安装或账号的内容。 */
function SourceDetail({
  client,
  source,
  account,
  provider,
}: {
  client: WevirClient;
  source: SourceInfo;
  account: AccountState | undefined;
  provider: ProviderProfile | undefined;
}) {
  const store = useWorkbenchStore();
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string>();
  const phase = sourcePhase(account);
  const name = t(source.name);

  const setEnabled = async (enabled: boolean) => {
    if (provider === undefined) return;
    setToggling(true);
    setError(undefined);
    try {
      await client.request('provider.setEnabled', { providerId: provider.id, enabled });
      await store?.refresh();
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setToggling(false);
    }
  };

  return (
    <div
      className="border-t border-border bg-background/40 px-5 pt-4 pb-5 animate-in fade-in duration-200"
      data-source-detail={source.kind}
    >
      <div className="flex items-center gap-3">
        <LogoWell logo={source.logo} fallback={name} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          {account?.status === 'signed_in' && account.email !== undefined && (
            <p className="truncate text-xs text-muted-foreground" data-account-email>
              {account.email}
            </p>
          )}
        </div>
        {provider !== undefined && client.supports('provider_enabled') && (
          <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <span aria-hidden>{t('source.showInPicker')}</span>
            <Switch
              checked={provider.enabled !== false}
              label={t('source.showInPicker')}
              disabled={toggling}
              onChange={(next) => void setEnabled(next)}
              data-action="toggle-source"
            />
          </div>
        )}
      </div>
      <div className="mt-4">
        {source.kind === 'chatgpt' ? (
          client.supports('chatgpt_account') ? (
            <ChatgptAccountSection client={client} provider={provider} embedded />
          ) : (
            <p className="text-sm text-muted-foreground">{t('source.soon.body')}</p>
          )
        ) : (
          <SubscriptionBody
            client={client}
            kind={source.kind}
            name={name}
            account={account}
            phase={phase}
            provider={provider}
          />
        )}
      </div>
      {error !== undefined && (
        <div className="mt-3">
          <NoticeBanner notice={{ tone: 'error', text: error }} />
        </div>
      )}
    </div>
  );
}

function SubscriptionBody({
  client,
  kind,
  name,
  account,
  phase,
  provider,
}: {
  client: WevirClient;
  kind: AccountKind;
  name: string;
  account: AccountState | undefined;
  phase: SourcePhase;
  provider: ProviderProfile | undefined;
}) {
  const accounts = useAccountsStore();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const run = async (label: string, op: () => Promise<{ account: AccountState }>) => {
    setBusy(label);
    setError(undefined);
    try {
      const result = await op();
      accounts?.merge(result.account);
      return result.account;
    } catch (reason) {
      setError(describe(reason));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };
  const refresh = () =>
    run('refresh', () => client.request('account.get', { kind, refresh: true }));
  const login = async () => {
    const next = await run('login', () =>
      client.request('account.login', { kind, method: 'browser' }),
    );
    const url = next?.login?.authUrl;
    if (url !== undefined) void window.wevir.openExternal(url);
  };

  if (account === undefined || phase.kind === 'soon') {
    return <p className="text-sm text-muted-foreground">{t('source.soon.body')}</p>;
  }

  return (
    <div className="space-y-4" data-phase={phase.kind}>
      {phase.kind === 'missing' || phase.kind === 'installing' ? (
        <InstallStep
          client={client}
          kind={kind}
          name={name}
          account={account}
          phase={phase}
          busy={busy}
          onRun={run}
        />
      ) : phase.kind === 'signed_out' && phase.signIn === 'command' ? (
        <Step
          title={t('source.command.title')}
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== undefined}
              onClick={() => void refresh()}
              data-action="recheck"
            >
              {busy === 'refresh' ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
              {t('source.recheck')}
            </Button>
          }
        >
          {account.loginCommand !== undefined && <CommandLine command={account.loginCommand} />}
        </Step>
      ) : phase.kind === 'signed_out' ? (
        <Step
          title={t('source.login.title', { name })}
          actions={
            <Button
              size="sm"
              disabled={busy !== undefined}
              onClick={() => void login()}
              data-action="login"
            >
              {busy === 'login' ? <LoaderCircle className="animate-spin" /> : <LogIn />}
              {t('source.login')}
            </Button>
          }
        />
      ) : phase.kind === 'signing_in' ? (
        <Step
          title={t('source.signingIn.title')}
          actions={
            <>
              {account.login?.authUrl !== undefined && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void window.wevir.openExternal(account.login?.authUrl ?? '')}
                >
                  <ExternalLink />
                  {t('source.signingIn.reopen')}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== undefined}
                onClick={() =>
                  void run('cancel', () =>
                    client.request('account.cancelLogin', {
                      kind,
                      ...(account.login !== undefined && { loginId: account.login.loginId }),
                    }),
                  )
                }
              >
                {t('source.cancel')}
              </Button>
            </>
          }
        />
      ) : (
        <SignedIn
          client={client}
          kind={kind}
          account={account}
          provider={provider}
          busy={busy}
          onRun={run}
          onRefresh={() => void refresh()}
        />
      )}
      {(error ?? account.lastError) !== undefined && (
        <NoticeBanner notice={{ tone: 'error', text: error ?? account.lastError ?? '' }} />
      )}
      {account.signIn === 'command' && (
        <p className="text-xs text-muted-foreground" data-terms>
          {t('source.terms.command', { name })}
        </p>
      )}
    </div>
  );
}

/** 一步：标题、右侧的操作，下面可以有命令行等内容。 */
function Step({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-56 text-sm font-medium">{title}</p>
        {actions !== undefined && (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        )}
      </div>
      {children}
    </div>
  );
}

/** 一行要在终端里运行的命令：等宽字、内凹的底，右边复制。 */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 py-1 pr-1 pl-3 shadow-[inset_0_1px_2px_rgb(0_0_0/0.04)]">
      <span aria-hidden className="font-mono text-xs text-muted-foreground select-none">
        $
      </span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs" data-command>
        {command}
      </code>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void window.wevir.copyText(command).then(() => setCopied(true))}
        data-action="copy-command"
      >
        {copied ? <Check /> : <Copy />}
        {t(copied ? 'source.copied' : 'source.copy')}
      </Button>
    </div>
  );
}

function InstallStep({
  client,
  kind,
  name,
  account,
  phase,
  busy,
  onRun,
}: {
  client: WevirClient;
  kind: AccountKind;
  name: string;
  account: AccountState;
  phase: Extract<SourcePhase, { kind: 'missing' | 'installing' }>;
  busy: string | undefined;
  onRun: (label: string, op: () => Promise<{ account: AccountState }>) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(account.customPath ?? '');
  const installing = phase.kind === 'installing';
  return (
    <div className="space-y-4">
      {account.canInstall === true || installing ? (
        <Step
          title={t('source.download.title', { name })}
          actions={
            <Button
              size="sm"
              disabled={installing || busy !== undefined}
              onClick={() =>
                void onRun('install', () => client.request('account.install', { kind }))
              }
              data-action="install"
            >
              {installing ? <LoaderCircle className="animate-spin" /> : <Download />}
              {installing ? t('source.status.installing') : t('source.download')}
            </Button>
          }
        >
          {installing && <Progress percent={phase.percent} />}
        </Step>
      ) : (
        <Step
          title={t('source.install.title', { name })}
          actions={
            <>
              {account.installUrl !== undefined && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void window.wevir.openExternal(account.installUrl ?? '')}
                >
                  <ExternalLink />
                  {t('source.install.docs')}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== undefined}
                onClick={() =>
                  void onRun('refresh', () =>
                    client.request('account.get', { kind, refresh: true }),
                  )
                }
                data-action="recheck"
              >
                {busy === 'refresh' ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
                {t('source.recheck')}
              </Button>
            </>
          }
        >
          {account.installCommand !== undefined && <CommandLine command={account.installCommand} />}
        </Step>
      )}
      {!installing && client.supports('subscription_sources') && (
        <div className="space-y-2">
          {editing ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const value = path.trim();
                void onRun('path', () =>
                  client.request('account.setPath', { kind, path: value === '' ? null : value }),
                ).then(() => setEditing(false));
              }}
            >
              <Input
                autoFocus
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder={t('source.path.placeholder')}
                className="h-8 font-mono text-xs"
                aria-label={t('source.path.label')}
              />
              <Button type="submit" size="sm" disabled={busy !== undefined}>
                {t('source.path.save')}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
                {t('source.cancel')}
              </Button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:underline"
              data-action="set-path"
            >
              <FolderSearch className="size-3.5" aria-hidden />
              {t('source.path.link')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Progress({ percent }: { percent: number | undefined }) {
  return (
    <div
      className="h-1 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuenow={percent}
    >
      <div
        className={cn(
          'h-full rounded-full bg-primary transition-[width] duration-300 ease-smooth',
          percent === undefined && 'w-1/3 animate-pulse',
        )}
        style={percent === undefined ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

function SignedIn({
  client,
  kind,
  account,
  provider,
  busy,
  onRun,
  onRefresh,
}: {
  client: WevirClient;
  kind: AccountKind;
  account: AccountState;
  provider: ProviderProfile | undefined;
  busy: string | undefined;
  onRun: (label: string, op: () => Promise<{ account: AccountState }>) => Promise<unknown>;
  onRefresh: () => void;
}) {
  const { primary, secondary } = account.rateLimits ?? {};
  const facts: [string, ReactNode][] = [];
  const plan = account.planLabel ?? account.plan;
  if (plan !== undefined) facts.push([t('source.fact.plan'), plan]);
  if (account.version !== undefined) facts.push([t('source.fact.version'), account.version]);
  if (account.executablePath !== undefined) {
    facts.push([
      t('source.fact.path'),
      <span key="path" className="font-mono text-xs" title={account.executablePath}>
        {account.executablePath}
      </span>,
    ]);
  }
  return (
    <div className="space-y-4">
      {facts.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 truncate">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {(primary !== undefined || secondary !== undefined) && (
        <div className="grid gap-2 sm:grid-cols-2" data-usage>
          {primary !== undefined && <UsageBar window={primary} />}
          {secondary !== undefined && <UsageBar window={secondary} />}
        </div>
      )}
      {provider !== undefined && provider.models.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">
            {t('source.models', { count: provider.models.length })}
          </p>
          <ul className="flex flex-wrap gap-1.5" data-source-models>
            {provider.models.map((model) => (
              <li
                key={model.id}
                className="rounded-md border border-border bg-background px-2 py-0.5 text-xs"
              >
                {model.displayName ?? model.id}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== undefined}
          onClick={onRefresh}
          data-action="recheck"
        >
          {busy === 'refresh' ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
          {t('source.recheck')}
        </Button>
        {account.signIn === 'in_app' ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== undefined}
            onClick={() => void onRun('logout', () => client.request('account.logout', { kind }))}
            data-action="logout"
          >
            <LogOut />
            {t('source.logout')}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">{t('source.logout.command')}</span>
        )}
      </div>
    </div>
  );
}
