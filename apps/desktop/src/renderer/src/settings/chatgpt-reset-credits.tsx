import { accountId, type WevirClient } from '@wevir/client-sdk';
import type { AccountResetCreditOutcome, AccountState } from '@wevir/protocol';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { currentLocale, t } from '@/i18n';
import { nextResetCredit } from './chatgpt-account-model';

export function ChatgptResetCredits({
  client,
  account,
  onChanged,
}: {
  client: WevirClient;
  account: AccountState;
  onChanged: (account: AccountState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<{ idempotencyKey: string; creditId?: string }>();
  const [outcome, setOutcome] = useState<AccountResetCreditOutcome>();
  const summary = account.resetCredits;
  const credit = nextResetCredit(summary);
  const canUse =
    pending !== undefined ||
    ((summary?.availableCount ?? 0) > 0 &&
      (summary?.credits === undefined || credit !== undefined));
  if (
    !client.supports('account_reset_credits') ||
    (summary === undefined && pending === undefined && outcome === undefined)
  )
    return null;

  const status =
    outcome === 'nothingToReset'
      ? t('account.chatgpt.reset.nothingToReset')
      : outcome === 'noCredit'
        ? t('account.chatgpt.reset.noCredit')
        : outcome !== undefined
          ? t('account.chatgpt.reset.used')
          : undefined;
  const expires =
    credit?.expiresAt === undefined
      ? undefined
      : new Date(credit.expiresAt).toLocaleString(currentLocale(), {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });

  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2.5" data-reset-credits>
      <div className="flex items-center gap-3 text-sm">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span>{t('account.chatgpt.reset.title')}</span>
            {summary !== undefined && (
              <span className="tabular-nums text-muted-foreground" data-reset-count>
                {t('account.chatgpt.reset.available', { count: summary.availableCount })}
              </span>
            )}
          </div>
          {expires !== undefined && (
            <p className="text-xs text-muted-foreground" data-reset-expiry>
              {t('account.chatgpt.reset.expires', { time: expires })}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!canUse}
          data-action="use-reset-credit"
          onClick={() => {
            if (pending === undefined)
              setPending({
                idempotencyKey: crypto.randomUUID(),
                ...(credit !== undefined && { creditId: credit.id }),
              });
            setOpen(true);
          }}
        >
          {t('account.chatgpt.reset.use')}
        </Button>
      </div>
      {status !== undefined && (
        <p role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
      )}
      {open && pending !== undefined && (
        <ConfirmDialog
          open
          onOpenChange={setOpen}
          title={t('account.chatgpt.reset.confirmTitle')}
          confirmLabel={t('account.chatgpt.reset.use')}
          failure={(error) => t('account.chatgpt.reset.failed', { error })}
          onConfirm={async () => {
            const result = await client.request('account.consumeResetCredit', {
              kind: 'chatgpt',
              id: accountId(account),
              ...pending,
            });
            onChanged(result.account);
            setOutcome(result.outcome);
            setPending(undefined);
          }}
        >
          {t('account.chatgpt.reset.confirmation', {
            account: account.email ?? accountId(account),
          })}
        </ConfirmDialog>
      )}
    </div>
  );
}
