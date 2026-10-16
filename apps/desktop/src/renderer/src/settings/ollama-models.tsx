import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import type { MethodResult } from '@wevir/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { formatTokens } from '@/layout/rail-model';
import {
  discoveryParams,
  lowOllamaContext,
  ollamaEndpoint,
  toggleDiscoveredModel,
} from './ollama-model';
import type { ProviderForm } from './provider-form';

/** Shared by onboarding and settings. No renderer network permissions are needed. */
export function OllamaModels({
  client,
  form,
  onChange,
}: {
  client: WevirClient | undefined;
  form: ProviderForm;
  onChange: (patch: Partial<ProviderForm>) => void;
}) {
  const endpoint = form.kind === 'openai-compatible' ? ollamaEndpoint(form.baseURL) : undefined;
  const enabled =
    !!endpoint && !!client && hostSupports(client.hello.features, 'provider_model_discovery');
  const [result, setResult] = useState<MethodResult<'provider.discoverModels'>>();
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const { id, baseURL, savedBaseURL, apiKey, editing } = form;
  const refresh = useCallback(async () => {
    if (!client || !enabled) return;
    const current = ++generation.current;
    setLoading(true);
    try {
      const found = await client.request(
        'provider.discoverModels',
        discoveryParams({ id, baseURL, savedBaseURL, apiKey, editing }),
      );
      if (current === generation.current) setResult(found);
    } catch {
      if (current === generation.current) setResult({ ok: false, models: [], reason: 'unknown' });
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [client, enabled, id, baseURL, savedBaseURL, apiKey, editing]);
  useEffect(() => {
    setResult(undefined);
    setLoading(false);
    if (enabled && endpoint === 'local') void refresh();
    return () => {
      generation.current++;
    };
  }, [enabled, endpoint, refresh]);
  if (!endpoint) return null;
  return (
    <fieldset
      className="space-y-2 rounded-lg border border-border px-3.5 py-3"
      data-ollama-discovery
    >
      <legend className="px-1 text-sm font-medium">{t('provider.ollama.models')}</legend>
      {!enabled ? (
        <p className="text-sm text-muted-foreground">{t('provider.ollama.upgradeHost')}</p>
      ) : (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? t('provider.ollama.loading') : t('provider.ollama.refresh')}
          </Button>
          {result && !result.ok && (
            <p role="status" className="text-sm text-muted-foreground">
              {result.reason === 'missing_key' || result.reason === 'auth'
                ? t('provider.ollama.keyRequired')
                : t('provider.ollama.failed')}
            </p>
          )}
          {result?.ok && result.models.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('provider.ollama.empty')}</p>
          )}
          {result?.ok && (
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {result.models.map((entry) => {
                const low = lowOllamaContext(entry);
                const incapable =
                  entry.capabilities !== undefined && !entry.capabilities.includes('tools');
                return (
                  <div key={entry.model.id} className="text-sm">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1 accent-primary"
                        disabled={incapable}
                        checked={form.models.some((row) => row.id === entry.model.id)}
                        onChange={() => onChange(toggleDiscoveredModel(form, entry))}
                      />
                      <span className="min-w-0 break-words">
                        <span className="font-mono">{entry.model.id}</span>
                        {(entry.parameterSize || entry.quantization) && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {[entry.parameterSize, entry.quantization].filter(Boolean).join(' · ')}
                          </span>
                        )}
                        {entry.sizeBytes !== undefined && entry.sizeBytes > 0 && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {(entry.sizeBytes / 1024 ** 3).toFixed(1)} GiB
                          </span>
                        )}
                        {entry.remoteHost && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {entry.remoteHost}
                          </span>
                        )}
                        {entry.model.contextWindow !== undefined && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {t('provider.ollama.context', {
                              size: formatTokens(entry.model.contextWindow),
                            })}
                          </span>
                        )}
                        {incapable && (
                          <span className="ml-2 text-muted-foreground">
                            {t('provider.ollama.noTools')}
                          </span>
                        )}
                      </span>
                    </label>
                    {low !== undefined && (
                      <p className="mt-1 text-xs text-muted-foreground" role="status">
                        {t('provider.ollama.lowContext', { size: formatTokens(low) })}
                      </p>
                    )}
                    {entry.model.contextWindow === undefined && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('provider.ollama.unknownContext')}
                      </p>
                    )}
                    {!entry.detailsAvailable && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('provider.ollama.partial')}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {result?.truncated && (
            <p className="text-xs text-muted-foreground">{t('provider.ollama.truncated')}</p>
          )}
        </>
      )}
    </fieldset>
  );
}
