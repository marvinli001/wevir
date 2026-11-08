import { ArrowRight } from 'lucide-react';
import { type ReactNode, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { useAccounts, useWorkbenchData } from '@/data/workbench-data';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { ModelPicker } from '@/session/model-picker';
import { lastChoice, resolveChoice } from '@/session/start-session';
import { SubscriptionSources } from '@/settings/subscription-sources';
import { welcomeProviders } from './welcome-model';

/** 第一步的内容：订阅网格或 API 表单（`children`），由页头的分段切换；两边的底部操作在同一位置。 */
export function WelcomeSources({
  api,
  children,
  onSkip,
  onNext,
}: {
  api: boolean;
  children: ReactNode;
  onSkip: () => void;
  onNext: () => void;
}) {
  const data = useWorkbenchData();
  const accounts = useAccounts();
  const { client } = useHostConnection();
  const stored = lastChoice.use();
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
        <SubscriptionSources
          client={client}
          providers={data.status === 'ready' ? data.providers : []}
          setupOnly
          onChoose={chooseProvider}
          activeProviderId={choice?.providerId}
        />
      </div>
      <div hidden={!api} className="min-h-0 flex-1">
        {children}
      </div>
      {!api && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 pt-2">
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
            className="min-w-24"
            onClick={() => {
              if (choice) lastChoice.set(choice);
              onNext();
            }}
            data-action="welcome-next"
          >
            {t('welcome.next')}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      )}
    </section>
  );
}
