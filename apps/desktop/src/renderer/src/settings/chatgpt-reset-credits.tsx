import { accountId, type WevirClient } from '@wevir/client-sdk';
import type { AccountResetCreditOutcome, AccountState, MethodParams } from '@wevir/protocol';
import { useState } from 'react';
import { Collapse } from '@/components/collapse';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { currentLocale, t } from '@/i18n';
import { nextResetCredit } from './chatgpt-account-model';

type ResetCreditRequest = MethodParams<'account.consumeResetCredit'>;

export function ChatgptResetCredits({
  client,
  account,
}: {
  client: WevirClient;
  account: AccountState;
}) {
  const [confirmation, setConfirmation] = useState<ResetCreditRequest>();
  const [legacyAttempt, setLegacyAttempt] = useState<ResetCreditRequest>();
  const [outcome, setOutcome] = useState<AccountResetCreditOutcome>();
  const pending = account.pendingResetCredit;
  const retry = pending ?? legacyAttempt;
  const summary = account.resetCredits;
  const [lastSummary, setLastSummary] = useState(summary);
  if (summary && summary !== lastSummary) setLastSummary(summary);
  const visible =
    client.supports('account_reset_credits') &&
    (summary !== undefined ||
      retry !== undefined ||
      confirmation !== undefined ||
      outcome !== undefined);
  const shown = visible ? summary : lastSummary;
  const credit =
    retry === undefined
      ? nextResetCredit(shown)
      : shown?.credits?.find((item) => item.id === retry.creditId);
  const canUse =
    retry !== undefined ||
    ((summary?.availableCount ?? 0) > 0 &&
      (summary?.credits === undefined || credit !== undefined));

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
    <Collapse open={visible} motion="height">
      <div
        className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5"
        data-reset-credits
      >
        <div className="flex items-center gap-3 text-sm">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span>{t('account.chatgpt.reset.title')}</span>
              {shown !== undefined && (
                <span className="tabular-nums text-muted-foreground" data-reset-count>
                  {t('account.chatgpt.reset.available', { count: shown.availableCount })}
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
              const creditId = pending === undefined ? credit?.id : pending.creditId;
              setOutcome(undefined);
              setConfirmation(
                legacyAttempt ?? {
                  kind: 'chatgpt',
                  id: accountId(account),
                  ...(account.resetCreditIdentity !== undefined && {
                    expectedAccountIdentity: account.resetCreditIdentity,
                  }),
                  ...(creditId !== undefined && { creditId }),
                  ...(pending !== undefined
                    ? { pendingAttemptId: pending.attemptId }
                    : creditId === undefined && {
                        expectedAvailableCount: summary?.availableCount,
                        expectedCreditRevision: summary?.revision,
                      }),
                },
              );
            }}
          >
            {retry === undefined ? t('account.chatgpt.reset.use') : t('usage.retry')}
          </Button>
        </div>
        <Collapse open={status !== undefined} motion="height">
          <p role="status" className="text-xs text-muted-foreground">
            {status}
          </p>
        </Collapse>
        {confirmation !== undefined && (
          <ConfirmDialog
            open
            onOpenChange={(open) => {
              if (!open) setConfirmation(undefined);
            }}
            title={t('account.chatgpt.reset.confirmTitle')}
            confirmLabel={
              confirmation.pendingAttemptId === undefined &&
              confirmation.idempotencyKey === undefined
                ? t('account.chatgpt.reset.use')
                : t('usage.retry')
            }
            failure={(error) => t('account.chatgpt.reset.failed', { error })}
            onConfirm={async () => {
              let request = confirmation;
              if (
                confirmation.expectedAccountIdentity === undefined &&
                confirmation.pendingAttemptId === undefined
              ) {
                request = legacyAttempt ?? {
                  kind: 'chatgpt',
                  id: confirmation.id,
                  creditId: confirmation.creditId,
                  idempotencyKey: crypto.randomUUID(),
                };
                setLegacyAttempt(request);
              }
              const result = await client.request('account.consumeResetCredit', request);
              setLegacyAttempt(undefined);
              setOutcome(result.outcome);
            }}
          >
            {t('account.chatgpt.reset.confirmation', {
              account: account.email ?? accountId(account),
            })}
          </ConfirmDialog>
        )}
      </div>
    </Collapse>
  );
}
