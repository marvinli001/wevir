import { accountId as idOf, type WevirClient } from '@wevir/client-sdk';
import type { AccountRateLimitWindow, AccountState, ProviderProfile } from '@wevir/protocol';
import { cn } from 'cn';
import { ExternalLink, LoaderCircle, LogIn, LogOut } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyGlyph, CopyLabel, useCopied } from '@/components/copy-glyph';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { accountRef } from '@/data/sources';
import { useAccountsError, useAccountsStore, useWorkbenchStore } from '@/data/workbench-data';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { platformApi } from '@/platform/platform';
import {
  type AccountPhase,
  accountPhase,
  planLabel,
  resetLabel,
  usageTone,
  usageWindows,
  windowName,
} from './chatgpt-account-model';
import { ChatgptResetCredits } from './chatgpt-reset-credits';
import { NoticeBanner } from './settings-ui';
import { SUBSCRIPTION_SETTING_ROW } from './subscription-context-window';

export function ChatgptAccountSection({
  client,
  account,
  provider,
  setupOnly = false,
}: {
  client: WevirClient;
  account: AccountState | undefined;
  provider: ProviderProfile | undefined;
  setupOnly?: boolean;
}) {
  const store = useWorkbenchStore();
  const accountsStore = useAccountsStore();
  const accountsError = useAccountsError();
  const setAccount = (next: AccountState) => accountsStore?.merge(next);
  const ref = accountRef(account ?? { kind: 'chatgpt' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmLogout, setConfirmLogout] = useState(false);
  /** 本窗口发起的浏览器登录：登录页已经交给系统浏览器打开过。 */
  const opened = useRef(new Set<string>());

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
    const next = await run(() => client.request('account.login', { ...ref, method }));
    const authUrl = next?.login?.authUrl;
    if (method === 'browser' && next?.login !== undefined && authUrl !== undefined) {
      opened.current.add(next.login.loginId);
      void platformApi().openExternal(authUrl);
    }
  };
  const cancel = (loginId: string) =>
    void run(() => client.request('account.cancelLogin', { ...ref, loginId }));

  const phase = accountPhase(account);
  const failure =
    error ??
    (account === undefined && accountsError !== undefined ? describe(accountsError) : undefined);
  return (
    <section className="flex flex-col gap-3" data-section="chatgpt-account" data-phase={phase.kind}>
      {phase.kind === 'signed_out' && (
        <div className="flex flex-wrap justify-end gap-1.5">
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
      <NoticeBanner
        notice={
          phase.kind === 'signed_out' && phase.error !== undefined
            ? { tone: 'error', text: t('account.chatgpt.loginFailed', { error: phase.error }) }
            : undefined
        }
      />
      {phase.kind === 'loading' && !setupOnly && (
        <>
          <div className="h-8" aria-hidden />
          <UsageCards windows={[]} />
          <div className={SUBSCRIPTION_SETTING_ROW} aria-hidden>
            <span className="text-muted-foreground">{t('provider.defaultModel')}</span>
            <div className="h-8 rounded-md bg-muted" />
          </div>
        </>
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
      {phase.kind === 'signed_in' && account !== undefined && !setupOnly && (
        <SignedIn
          client={client}
          account={account}
          phase={phase}
          provider={provider}
          busy={busy}
          onLogout={() => setConfirmLogout(true)}
          onSaved={() => void store?.refresh()}
          onError={setError}
          onAccountChanged={setAccount}
        />
      )}
      {setupOnly && phase.kind !== 'browser' && phase.kind !== 'device_code' && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void run(() => client.request('account.get', { ...ref, refresh: true }))}
        >
          {t('source.recheck')}
        </Button>
      )}
      <NoticeBanner notice={failure === undefined ? undefined : { tone: 'error', text: failure }} />
      {confirmLogout && (
        <ConfirmDialog
          open
          onOpenChange={(next) => !next && setConfirmLogout(false)}
          title={t('account.chatgpt.logout.title')}
          confirmLabel={t('account.chatgpt.logout')}
          onConfirm={async () => {
            const { account: next } = await client.request('account.logout', { ...ref });
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
          onClick={() => void platformApi().openExternal(phase.authUrl ?? '')}
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
  const [copied, markCopied] = useCopied();
  return (
    <div className="space-y-3 rounded-md bg-muted px-3 py-3 text-sm" role="status">
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          {t('account.chatgpt.device.step1')}{' '}
          {phase.verificationUrl !== undefined && (
            <button
              type="button"
              className="font-mono text-primary underline-offset-4 hover:underline"
              onClick={() => void platformApi().openExternal(phase.verificationUrl ?? '')}
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
                  void platformApi()
                    .copyText(phase.userCode ?? '')
                    .then(markCopied)
                }
              >
                <CopyGlyph copied={copied} />
                <CopyLabel
                  copied={copied}
                  idle={t('account.chatgpt.device.copy')}
                  done={t('account.chatgpt.device.copied')}
                />
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
  onAccountChanged,
}: {
  client: WevirClient;
  account: AccountState;
  phase: Extract<AccountPhase, { kind: 'signed_in' }>;
  provider: ProviderProfile | undefined;
  busy: boolean;
  onLogout: () => void;
  onSaved: () => void;
  onError: (error: string | undefined) => void;
  onAccountChanged: (account: AccountState) => void;
}) {
  const modelSelect = useId();
  const [saving, setSaving] = useState(false);
  const plan = planLabel(phase.plan);
  const windows = usageWindows(account.rateLimits);

  const setDefaultModel = async (defaultModelId: string) => {
    if (provider === undefined) return;
    setSaving(true);
    onError(undefined);
    try {
      await client.request('provider.upsert', {
        id: provider.id,
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
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-3">
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
      <UsageCards windows={windows} />
      <ChatgptResetCredits
        key={`${idOf(account)}:${account.email ?? ''}`}
        client={client}
        account={account}
        onChanged={onAccountChanged}
      />
      <div className={SUBSCRIPTION_SETTING_ROW}>
        <label htmlFor={modelSelect} className="shrink-0 text-muted-foreground">
          {t('provider.defaultModel')}
        </label>
        {provider === undefined || provider.models.length === 0 ? (
          <span className="flex min-h-8 items-center text-muted-foreground">
            {t('account.chatgpt.modelsLoading')}
          </span>
        ) : (
          <div className="relative min-w-0">
            <Select
              id={modelSelect}
              className="w-full min-w-0"
              value={provider.defaultModelId}
              disabled={saving}
              onValueChange={(id) => void setDefaultModel(id)}
              options={provider.models.map((model) => ({
                value: model.id,
                label: model.displayName ?? model.id,
              }))}
              data-default-model
            />
            {saving && (
              <LoaderCircle className="pointer-events-none absolute top-1/2 right-8 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function UsageCards({ windows }: { windows: readonly AccountRateLimitWindow[] }) {
  const placeholders = [
    t('account.chatgpt.usage.hours', { count: 5 }),
    t('account.chatgpt.usage.weekly'),
  ];
  return (
    <div
      className="grid gap-2 sm:grid-cols-2"
      data-usage
      aria-busy={windows.length === 0 || undefined}
    >
      {windows.length > 0
        ? windows.map((window, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 用量窗口没有 ID，顺序由引擎给出
            <UsageBar key={index} window={window} reserveReset />
          ))
        : placeholders.map((name, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 与同位置的用量卡片用同一个 key
            <UsageBar key={index} emptyName={name} reserveReset />
          ))}
    </div>
  );
}

/** 一个用量窗口：名称、已用百分比、进度条与重置时间。 */
export function UsageBar({
  window: usage,
  emptyName,
  reserveReset = false,
}: {
  window?: AccountRateLimitWindow;
  emptyName?: string;
  reserveReset?: boolean;
}) {
  const tone = usage && usageTone(usage);
  const percent = usage && Math.min(100, Math.max(0, usage.usedPercent));
  const resets = resetLabel(usage?.resetsAt);
  return (
    <div className="space-y-1 rounded-md border border-border px-3 py-2">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{usage ? windowName(usage) : emptyName}</span>
        {percent !== undefined && (
          <span className="font-medium tabular-nums">
            {t('account.chatgpt.usage.used', { percent: Math.round(percent) })}
          </span>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        {percent !== undefined && (
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-300 ease-smooth',
              tone === 'danger'
                ? 'bg-destructive'
                : tone === 'warning'
                  ? 'bg-warning'
                  : 'bg-primary',
            )}
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
      {(reserveReset || resets !== undefined) && (
        <p className="min-h-4 text-xs text-muted-foreground">{resets}</p>
      )}
    </div>
  );
}
