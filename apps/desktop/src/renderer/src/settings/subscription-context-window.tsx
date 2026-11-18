import type { WevirClient } from '@wevir/client-sdk';
import type { ProviderModel, ProviderProfile } from '@wevir/protocol';
import { cn } from 'cn';
import { LoaderCircle } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Collapse } from '@/components/collapse';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useWorkbenchStore } from '@/data/workbench-data';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { NoticeBanner } from './settings-ui';

export const SUBSCRIPTION_SETTING_ROW =
  'grid grid-cols-[minmax(0,7rem)_minmax(0,18rem)] items-center gap-x-3 text-sm';

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
      <div className={SUBSCRIPTION_SETTING_ROW}>
        <span className="text-muted-foreground">{t('source.context.title')}</span>
        <Select
          value={model.id}
          onValueChange={setSelected}
          aria-label={t('source.context.model')}
          className="min-w-0 w-full"
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
    <form onSubmit={submit} className={cn(SUBSCRIPTION_SETTING_ROW, 'gap-y-2')}>
      <div className="col-span-2 flex flex-wrap items-center gap-2 @min-[24rem]:col-span-1 @min-[24rem]:col-start-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
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
            className="h-8 min-w-12 max-w-36 flex-1 tabular-nums"
            data-context-window
          />
          <span className="text-xs text-muted-foreground">tokens</span>
          <Button type="submit" size="sm" disabled={saving || !valid || value === initial}>
            {saving && <LoaderCircle className="animate-spin" />}
            {t('source.account.labelSave')}
          </Button>
        </div>
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
      <p id={id} className="col-span-2 text-xs text-muted-foreground" data-context-limit>
        {t('source.context.limit', { max: settings.max.toLocaleString() })}
        {valid &&
          ` · ${t('source.context.usable', { value: Math.floor(value * 0.95).toLocaleString() })}`}
      </p>
      <Collapse open={!valid} motion="height" className="col-span-2 -mt-2">
        <p role="alert" className="text-xs text-destructive">
          {t('source.context.invalid', { max: settings.max.toLocaleString() })}
        </p>
      </Collapse>
      <div className="col-span-2 empty:hidden">
        <NoticeBanner notice={error === undefined ? undefined : { tone: 'error', text: error }} />
      </div>
    </form>
  );
}
