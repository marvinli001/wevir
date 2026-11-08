import { type ReactNode, useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAccounts, useWorkbenchData } from '@/data/workbench-data';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { ModelPicker } from '@/session/model-picker';
import { lastChoice, resolveChoice } from '@/session/start-session';
import { SubscriptionSources } from '@/settings/subscription-sources';
import { welcomeProviders } from './welcome-model';

export function WelcomeSources({
  children,
  onSkip,
  onNext,
}: {
  children: ReactNode;
  onSkip: () => void;
  onNext: () => void;
}) {
  const data = useWorkbenchData();
  const accounts = useAccounts();
  const { client } = useHostConnection();
  const stored = lastChoice.use();
  const [api, setApi] = useState(false);
  const providers = welcomeProviders(data.status === 'ready' ? data.providers : [], accounts);
  const choice = resolveChoice(providers, stored);
  const chooseProvider = useCallback(
    (id: string) => {
      const previous = lastChoice.get();
      const next = resolveChoice(providers, previous, id);
      if (next && (previous?.providerId !== next.providerId || previous.modelId !== next.modelId))
        lastChoice.set(next);
    },
    [providers],
  );

  return (
    <section className="flex h-full min-h-0 flex-col gap-3">
      <div hidden={api} className="min-h-0 flex-1">
        {accounts !== undefined && accounts.length > 0 && (
          <SubscriptionSources
            client={client}
            providers={data.status === 'ready' ? data.providers : []}
            setupOnly
            onChoose={chooseProvider}
            activeProviderId={choice?.providerId}
          />
        )}
      </div>
      <div hidden={!api} className="min-h-0 flex-1">
        <div className="flex h-full min-h-0 flex-col gap-3">
          <div className="flex shrink-0 justify-end">
            <Button
              variant="outline"
              aria-expanded={api}
              onClick={() => setApi(!api)}
              data-action="welcome-api"
            >
              {t(api ? 'source.back' : 'welcome.addApi')}
            </Button>
          </div>
          <div className="min-h-0 flex-1">{children}</div>
        </div>
      </div>
      {!api && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            variant="outline"
            aria-expanded={api}
            onClick={() => setApi(!api)}
            data-action="welcome-api"
          >
            {t(api ? 'source.back' : 'welcome.addApi')}
          </Button>

          {choice && (
            <ModelPicker
              providers={providers}
              value={choice}
              onChange={(next) => lastChoice.set(next)}
            />
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onSkip}>
            {t('welcome.skip')}
          </Button>
          <Button
            disabled={!choice}
            onClick={() => {
              if (choice) lastChoice.set(choice);
              onNext();
            }}
            data-action="welcome-next"
          >
            {t('welcome.next')}
          </Button>
        </div>
      )}
    </section>
  );
}
