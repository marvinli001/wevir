import type { ProviderProfile } from '@wevir/protocol';
import { CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { accountOfProvider, sourceOf, sourceTitle } from '@/data/sources';
import { useAccounts } from '@/data/workbench-data';
import { t } from '@/i18n';
import { resetLabel } from '@/settings/chatgpt-account-model';
import type { ModelChoice } from './model-picker';
import { exhaustionReset, isExhausted, quotaAlternative } from './usage-limit-model';
import { useNow } from './use-now';

export function NewSessionQuota({
  providers,
  choice,
  choose,
}: {
  providers: readonly ProviderProfile[] | undefined;
  choice: ModelChoice | undefined;
  choose: (choice: ModelChoice) => void;
}) {
  const accounts = useAccounts();
  const now = useNow(15_000);
  const provider = providers?.find((provider) => provider.id === choice?.providerId);
  const account = provider && accountOfProvider(provider, accounts);
  if (!provider || !isExhausted(account, now)) return null;
  const alternative = quotaAlternative(providers ?? [], accounts, provider.id, now);
  const title = (provider: ProviderProfile) => {
    const source = sourceOf(provider);
    return source ? sourceTitle(provider, accounts, t(source.name)) : provider.displayName;
  };
  const resets = resetLabel(exhaustionReset(account, now), new Date(now));
  return (
    <div
      role="status"
      data-testid="new-session-quota"
      className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning"
    >
      <CircleAlert aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {t('session.quota.exhausted', { name: title(provider) })}
        {resets && ` · ${resets}`}
      </span>
      {alternative && (
        <Button
          variant="ghost"
          size="sm"
          data-action="quota-switch"
          onClick={() =>
            choose({ providerId: alternative.id, modelId: alternative.defaultModelId })
          }
        >
          {t('session.quota.switch', { name: title(alternative) })}
        </Button>
      )}
    </div>
  );
}
