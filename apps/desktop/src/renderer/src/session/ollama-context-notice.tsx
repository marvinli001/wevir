import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import { useEffect, useState } from 'react';
import { useWorkbenchProviders } from '@/data/workbench-data';
import { t } from '@/i18n';
import { formatTokens } from '@/layout/rail-model';
import { everyWhileVisible } from '@/lib/visible-interval';
import { lowOllamaContext, ollamaEndpoint } from '@/settings/ollama-model';

export function OllamaContextNotice({
  client,
  providerId,
  modelId,
  running,
}: {
  client: WevirClient | undefined;
  providerId: string;
  modelId: string;
  running: boolean;
}) {
  const provider = useWorkbenchProviders()?.find((item) => item.id === providerId);
  const baseURL = provider?.baseURL ?? '';
  const endpoint = provider?.kind === 'openai-compatible' ? ollamaEndpoint(baseURL) : undefined;
  const localOllama =
    endpoint === 'local' &&
    (new URL(baseURL).port === '11434' || /^local-ollama(?:-\d+)?$/.test(providerId));
  const enabled =
    localOllama && !!client && hostSupports(client.hello.features, 'provider_model_discovery');
  const [context, setContext] = useState<number>();
  useEffect(() => {
    setContext(undefined);
    if (!enabled || !client) return;
    let disposed = false;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await client.request('provider.discoverModels', { providerId, modelId });
        if (!disposed)
          setContext(
            result.ok && result.models[0] ? lowOllamaContext(result.models[0]) : undefined,
          );
      } catch {
        if (!disposed) setContext(undefined);
      } finally {
        busy = false;
      }
    };
    void refresh();
    const stopTimer = running ? everyWhileVisible(() => void refresh(), 10_000) : undefined;
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      stopTimer?.();
      window.removeEventListener('focus', refresh);
    };
  }, [client, enabled, providerId, modelId, running]);
  return context === undefined ? null : (
    <p
      role="status"
      className="mb-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground"
      data-ollama-context
    >
      {t('provider.ollama.lowContext', { size: formatTokens(context) })}
    </p>
  );
}
