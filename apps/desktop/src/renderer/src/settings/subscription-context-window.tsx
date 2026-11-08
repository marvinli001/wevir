import type { WevirClient } from '@wevir/client-sdk';
import type { ProviderModel, ProviderProfile } from '@wevir/protocol';
import { LoaderCircle } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useWorkbenchStore } from '@/data/workbench-data';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { NoticeBanner } from './settings-ui';

export function SubscriptionContextWindow({
  client,
  provider,
}: {
  client: WevirClient;
  provider: ProviderProfile;
}) {
  const [selected, setSelected] = useState(provider.defaultModelId);
  const models = provider.models.filter((model) => model.contextWindowSettings !== undefined);
  const model = models.find((entry) => entry.id === selected) ?? models[0];
  if (!client.supports('subscription_context_window') || model === undefined) return null;
  return (
    <div className="mt-4 space-y-2 border-t border-border pt-3" data-subscription-context>
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-sm text-muted-foreground">{t('source.context.title')}</span>
        <Select
          value={model.id}
          onValueChange={setSelected}
          aria-label={t('source.context.model')}
          className="max-w-72"
          options={models.map((entry) => ({
            value: entry.id,
            label:
              entry.contextWindowSettings?.override === undefined
                ? (entry.displayName ?? entry.id)
                : `${entry.displayName ?? entry.id} · ${entry.contextWindowSettings.override.toLocaleString()}`,
          }))}
        />
      </div>
      <ModelWindowEditor
        key={`${provider.id}:${model.id}:${model.contextWindowSettings?.override ?? 'default'}`}
        client={client}
        providerId={provider.id}
        model={model}
      />
    </div>
  );
}

function ModelWindowEditor({
  client,
  providerId,
  model,
}: {
  client: WevirClient;
  providerId: string;
  model: ProviderModel;
}) {
  const settings = model.contextWindowSettings;
  const initial = settings?.override ?? settings?.default;
  const [draft, setDraft] = useState(String(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const store = useWorkbenchStore();
  const id = useId();
  if (settings === undefined) return null;
  const value = Number(draft);
  const valid =
    draft.trim() !== '' && Number.isSafeInteger(value) && value > 0 && value <= settings.max;
  const save = async (contextWindow: number | null) => {
    setSaving(true);
    setError(undefined);
    try {
      await client.request('account.setModelContextWindow', {
        id: providerId,
        modelId: model.id,
        contextWindow,
      });
      await store?.refresh();
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setSaving(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && value !== initial) void save(value);
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={settings.max}
          step={1}
          value={draft}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={t('source.context.title')}
          aria-describedby={id}
          aria-invalid={!valid}
          className="h-8 w-36 tabular-nums"
          data-context-window
        />
        <span className="text-xs text-muted-foreground">tokens</span>
        <Button type="submit" size="sm" disabled={saving || !valid || value === initial}>
          {saving && <LoaderCircle className="animate-spin" />}
          {t('source.account.labelSave')}
        </Button>
        {settings.override !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => void save(null)}
          >
            {t('source.context.reset')}
          </Button>
        )}
      </div>
      <p id={id} className="text-xs text-muted-foreground" data-context-limit>
        {t('source.context.limit', { max: settings.max.toLocaleString() })}
        {valid &&
          ` · ${t('source.context.usable', { value: Math.floor(value * 0.95).toLocaleString() })}`}
      </p>
      {!valid && (
        <p role="alert" className="text-xs text-destructive">
          {t('source.context.invalid', { max: settings.max.toLocaleString() })}
        </p>
      )}
      {error !== undefined && <NoticeBanner notice={{ tone: 'error', text: error }} />}
    </form>
  );
}
