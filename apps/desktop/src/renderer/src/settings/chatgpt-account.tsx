import type { WevirClient } from '@wevir/client-sdk';
import type { AccountRateLimitWindow, AccountState, ProviderProfile } from '@wevir/protocol';
import { cn } from 'cn';
import { Copy, ExternalLink, LoaderCircle, LogIn, LogOut } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { StatusDot } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import { useWorkbenchStore } from '@/data/workbench-data';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import {
  type AccountPhase,
  accountPhase,
  planLabel,
  resetLabel,
  usageTone,
  windowName,
} from './chatgpt-account-model';
import { NoticeBanner, SELECT } from './settings-ui';

/**
 * 设置 → 模型 Provider 顶部的“ChatGPT 账号”（R6，ADR-0005 决策 4 第 ① 行）：未登录时登录按钮与条款说明，登录中显示进度
 * 与取消（浏览器方式把登录页交给系统浏览器，设备码方式显示网址与一次性码），已登录显示账号、套餐、用量、默认模型与登出。
 * 只在 Host 声明了 `chatgpt_account` 时出现。账号与凭据都在 Host 的 Codex 引擎里，这里只经 `account.*` 读状态。
 */
export function ChatgptAccountSection({
  client,
  provider,
}: {
  client: WevirClient;
  /** 登录成功后 Host 建的 `chatgpt` Provider（还没建时省略）。 */
  provider: ProviderProfile | undefined;
}) {
  const store = useWorkbenchStore();
  const [account, setAccount] = useState<AccountState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmLogout, setConfirmLogout] = useState(false);
  /** 本窗口发起的浏览器登录：登录页已经交给系统浏览器打开过。 */
  const opened = useRef(new Set<string>());

  useEffect(
    () =>
      client.watchAccount(
        'chatgpt',
        (next) => {
          setAccount(next);
          // 登录成功后 Host 在后台建（或刷新）chatgpt Provider，列表跟着重读。
          if (next.status === 'signed_in') void store?.refresh();
        },
        (reason) => setError(describe(reason)),
      ),
    [client, store],
  );

  const run = async (op: () => Promise<{ account: AccountState }>) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await op();
      setAccount(result.account);
      return result.account;
    } catch (reason) {
      setError(describe(reason));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const login = async (method: 'browser' | 'device_code') => {
    const next = await run(() => client.request('account.login', { kind: 'chatgpt', method }));
    const authUrl = next?.login?.authUrl;
    if (method === 'browser' && next?.login !== undefined && authUrl !== undefined) {
      opened.current.add(next.login.loginId);
      void window.wevir.openExternal(authUrl);
    }
  };
  const cancel = (loginId: string) =>
    void run(() => client.request('account.cancelLogin', { kind: 'chatgpt', loginId }));

  const phase = accountPhase(account);
  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-card p-4"
      data-section="chatgpt-account"
      data-phase={phase.kind}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="font-medium">{t('account.chatgpt.title')}</h3>
            <PhaseBadge phase={phase} />
          </div>
          {phase.kind === 'signed_out' || phase.kind === 'loading' ? (
            <p className="text-sm text-muted-foreground">{t('account.chatgpt.intro')}</p>
          ) : null}
        </div>
        {phase.kind === 'signed_out' && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void login('device_code')}
              data-action="login-device-code"
            >
              {t('account.chatgpt.loginDeviceCode')}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void login('browser')}
              data-action="login-browser"
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <LogIn />}
              {t('account.chatgpt.login')}
            </Button>
          </div>
        )}
      </div>

      {phase.kind === 'signed_out' && (
        <p className="text-xs text-muted-foreground" data-terms>
          {t('account.chatgpt.terms')}
        </p>
      )}
      {phase.kind === 'signed_out' && phase.error !== undefined && (
        <NoticeBanner
          notice={{ tone: 'error', text: t('account.chatgpt.loginFailed', { error: phase.error }) }}
        />
      )}
      {phase.kind === 'browser' && (
        <BrowserProgress
          phase={phase}
          openedHere={opened.current.has(phase.loginId)}
          busy={busy}
          onCancel={() => cancel(phase.loginId)}
        />
      )}
      {phase.kind === 'device_code' && (
        <DeviceCodeProgress phase={phase} busy={busy} onCancel={() => cancel(phase.loginId)} />
      )}
      {phase.kind === 'signed_in' && (
        <SignedIn
          client={client}
          account={account}
          phase={phase}
          provider={provider}
          busy={busy}
          onLogout={() => setConfirmLogout(true)}
          onSaved={() => void store?.refresh()}
          onError={setError}
        />
      )}
      {error !== undefined && <NoticeBanner notice={{ tone: 'error', text: error }} />}
      {confirmLogout && (
        <ConfirmDialog
          open
          onOpenChange={(next) => !next && setConfirmLogout(false)}
          title={t('account.chatgpt.logout.title')}
          confirmLabel={t('account.chatgpt.logout')}
          onConfirm={async () => {
            const { account: next } = await client.request('account.logout', { kind: 'chatgpt' });
            setAccount(next);
          }}
          failure={(reason) => t('account.chatgpt.logout.failed', { error: reason })}
        >
          <p>{t('account.chatgpt.logout.body')}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function PhaseBadge({ phase }: { phase: AccountPhase }) {
  if (phase.kind === 'loading') return null;
  const signedIn = phase.kind === 'signed_in';
  const signingIn = phase.kind === 'browser' || phase.kind === 'device_code';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <StatusDot tone={signedIn ? 'success' : signingIn ? 'accent' : 'neutral'} pulse={signingIn} />
      {signedIn
        ? t('account.chatgpt.status.signedIn')
        : signingIn
          ? t('account.chatgpt.status.signingIn')
          : t('account.chatgpt.status.signedOut')}
    </span>
  );
}

function BrowserProgress({
  phase,
  openedHere,
  busy,
  onCancel,
}: {
  phase: Extract<AccountPhase, { kind: 'browser' }>;
  openedHere: boolean;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md bg-muted px-3 py-2.5 text-sm" role="status">
      <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      <p className="min-w-0 flex-1">
        {openedHere ? t('account.chatgpt.browser.waiting') : t('account.chatgpt.browser.elsewhere')}
      </p>
      {phase.authUrl !== undefined && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void window.wevir.openExternal(phase.authUrl ?? '')}
          data-action="open-login-page"
        >
          <ExternalLink />
          {openedHere ? t('account.chatgpt.browser.reopen') : t('account.chatgpt.browser.open')}
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={onCancel}
        data-action="cancel-login"
      >
        {t('account.chatgpt.cancel')}
      </Button>
    </div>
  );
}

function DeviceCodeProgress({
  phase,
  busy,
  onCancel,
}: {
  phase: Extract<AccountPhase, { kind: 'device_code' }>;
  busy: boolean;
  onCancel: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3 rounded-md bg-muted px-3 py-3 text-sm" role="status">
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          {t('account.chatgpt.device.step1')}{' '}
          {phase.verificationUrl !== undefined && (
            <button
              type="button"
              className="font-mono text-primary underline-offset-4 hover:underline"
              onClick={() => void window.wevir.openExternal(phase.verificationUrl ?? '')}
              data-action="open-verification"
            >
              {phase.verificationUrl}
            </button>
          )}
        </li>
        <li>
          {t('account.chatgpt.device.step2')}
          <div className="mt-1.5 flex items-center gap-2">
            <code
              className="rounded-md border border-border bg-background px-3 py-1 font-mono text-lg tracking-widest"
              data-user-code
            >
              {phase.userCode}
            </code>
            {phase.userCode !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void window.wevir.copyText(phase.userCode ?? '').then(() => setCopied(true))
                }
              >
                <Copy />
                {copied ? t('account.chatgpt.device.copied') : t('account.chatgpt.device.copy')}
              </Button>
            )}
          </div>
        </li>
      </ol>
      <p className="text-xs text-muted-foreground">{t('account.chatgpt.device.warning')}</p>
      <div className="flex items-center gap-2">
        <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden />
        <span className="flex-1 text-muted-foreground">{t('account.chatgpt.device.waiting')}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onCancel}
          data-action="cancel-login"
        >
          {t('account.chatgpt.cancel')}
        </Button>
      </div>
    </div>
  );
}

function SignedIn({
  client,
  account,
  phase,
  provider,
  busy,
  onLogout,
  onSaved,
  onError,
}: {
  client: WevirClient;
  account: AccountState | undefined;
  phase: Extract<AccountPhase, { kind: 'signed_in' }>;
  provider: ProviderProfile | undefined;
  busy: boolean;
  onLogout: () => void;
  onSaved: () => void;
  onError: (error: string | undefined) => void;
}) {
  const modelSelect = useId();
  const [saving, setSaving] = useState(false);
  const plan = planLabel(phase.plan);
  const { primary, secondary } = account?.rateLimits ?? {};

  const setDefaultModel = async (defaultModelId: string) => {
    if (provider === undefined) return;
    setSaving(true);
    onError(undefined);
    try {
      await client.request('provider.upsert', {
        id: 'chatgpt',
        kind: 'chatgpt',
        displayName: provider.displayName,
        defaultModelId,
      });
      onSaved();
    } catch (reason) {
      onError(describe(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm" data-account-email>
            {phase.email ?? t('account.chatgpt.emailUnknown')}
          </p>
        </div>
        {plan !== undefined && (
          <span
            className="shrink-0 rounded-sm bg-muted px-1.5 text-xs leading-5 text-muted-foreground"
            data-account-plan
          >
            {plan}
          </span>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={onLogout} data-action="logout">
          <LogOut />
          {t('account.chatgpt.logout')}
        </Button>
      </div>
      {(primary !== undefined || secondary !== undefined) && (
        <div className="grid gap-2 sm:grid-cols-2" data-usage>
          {primary !== undefined && <UsageBar window={primary} />}
          {secondary !== undefined && <UsageBar window={secondary} />}
        </div>
      )}
      <div className="flex items-center gap-3 text-sm">
        <label htmlFor={modelSelect} className="shrink-0 text-muted-foreground">
          {t('provider.defaultModel')}
        </label>
        {provider === undefined || provider.models.length === 0 ? (
          <span className="text-muted-foreground">{t('account.chatgpt.modelsLoading')}</span>
        ) : (
          <select
            id={modelSelect}
            className={cn(SELECT, 'max-w-72')}
            value={provider.defaultModelId}
            disabled={saving}
            onChange={(event) => void setDefaultModel(event.target.value)}
            data-default-model
          >
            {provider.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName ?? model.id}
              </option>
            ))}
          </select>
        )}
        {saving && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
      </div>
    </div>
  );
}

function UsageBar({ window: usage }: { window: AccountRateLimitWindow }) {
  const tone = usageTone(usage);
  const percent = Math.min(100, Math.max(0, usage.usedPercent));
  const resets = resetLabel(usage.resetsAt);
  return (
    <div className="space-y-1 rounded-md border border-border px-3 py-2">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{windowName(usage)}</span>
        <span className="font-medium tabular-nums">
          {t('account.chatgpt.usage.used', { percent: Math.round(percent) })}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full',
            tone === 'danger' ? 'bg-destructive' : tone === 'warning' ? 'bg-warning' : 'bg-primary',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      {resets !== undefined && <p className="text-xs text-muted-foreground">{resets}</p>}
    </div>
  );
}
