import { type AccountState, type ProviderProfile, rateLimitWindows } from '@wevir/protocol';
import { cn } from 'cn';
import type { ReactNode } from 'react';
import { accountOfProvider, sourceOf, sourceTitle } from '@/data/sources';
import { t } from '@/i18n';
import { ContextBar } from '@/layout/context-bar';
import { resetText, usageBar, usagePace } from '@/layout/usage-model';
import { windowName } from '@/settings/chatgpt-account-model';
import { providerLogo } from '@/settings/provider-catalog';
import { routingReason } from '@/settings/routing-model';
import { ProviderLogo } from './provider-logo';

export function QuotaNode({
  provider,
  providerId,
  modelId,
  accounts,
  now,
  reason,
  heading,
  controls,
}: {
  provider: ProviderProfile | undefined;
  providerId: string;
  modelId: string;
  accounts: readonly AccountState[] | undefined;
  now: number;
  reason?: string;
  heading?: ReactNode;
  controls?: ReactNode;
}) {
  const source = provider && sourceOf(provider);
  const account = provider && accountOfProvider(provider, accounts);
  const name = provider
    ? source
      ? sourceTitle(provider, accounts, t(source.name))
      : provider.displayName
    : providerId;
  const windows = rateLimitWindows(account);
  return (
    <div
      className="flex h-full flex-col rounded-xl border border-border bg-card p-3"
      data-testid="quota-node"
      data-reason={reason}
    >
      {heading && (
        <div className="mb-3 flex min-h-6 items-center justify-between gap-2 text-xs text-muted-foreground">
          {heading}
        </div>
      )}
      <div className={cn('flex-1', reason && 'text-muted-foreground')}>
        <div className="flex items-center gap-2">
          {provider && (
            <ProviderLogo
              logo={source?.logo ?? providerLogo(provider)}
              fallback={name}
              className={cn('size-5 shrink-0', reason && 'grayscale opacity-50')}
            />
          )}
          <span className="min-w-0 truncate text-sm font-medium" title={name}>
            {name}
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground" title={modelId}>
          {provider?.models.find((model) => model.id === modelId)?.displayName ??
            (modelId || t('routing.reason.model_missing'))}
        </p>
        {reason && (
          <p className="mt-2 text-xs" data-node-reason>
            {routingReason(reason)}
          </p>
        )}
        <ul className={cn('mt-4 space-y-3', reason && 'grayscale opacity-60')}>
          {windows.map((window, index) => {
            const bar = usageBar(window);
            const reset = resetText(window.resetsAt, new Date(now));
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: 额度窗口没有稳定 ID。
              <li key={index}>
                <div className="mb-1.5 flex justify-between gap-2 text-xs">
                  <span className="truncate text-muted-foreground">{windowName(window)}</span>
                  <span className="shrink-0 tabular-nums">
                    {t('account.chatgpt.usage.used', { percent: bar.percent })}
                  </span>
                </div>
                <ContextBar usage={bar} pacePercent={usagePace(window, now)} />
                {reset && <p className="mt-1.5 text-xs text-muted-foreground">{reset}</p>}
              </li>
            );
          })}
        </ul>
        {windows.length === 0 && (
          <p className="mt-4 text-xs text-muted-foreground">
            {t(!provider || source ? 'routing.quota.empty' : 'routing.quota.metered')}
          </p>
        )}
      </div>
      {controls && (
        <div className="mt-3 flex items-center justify-end gap-1 border-t border-border pt-2">
          {controls}
        </div>
      )}
    </div>
  );
}
