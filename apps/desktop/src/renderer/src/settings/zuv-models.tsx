import type { WevirClient } from '@wevir/client-sdk';
import { useId, useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { t } from '@/i18n';
import { loadProviderCatalog } from './provider-catalog-form';
import type { ProviderForm } from './provider-form';

export function ZuvModels({
  client,
  form,
  onChange,
}: {
  client: WevirClient;
  form: ProviderForm;
  onChange: (patch: Partial<ProviderForm>) => void;
}) {
  const id = useId();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = async () => {
    setLoading(true);
    setFailed(false);
    try {
      onChange(await loadProviderCatalog(client, form));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="space-y-2" data-zuv-models>
      <label htmlFor={id} className="text-sm font-medium">
        {t('provider.form.defaultModel')}
      </label>
      <Select
        id={id}
        value={form.models[form.defaultIndex]?.id ?? ''}
        onValueChange={(value) =>
          onChange({ defaultIndex: form.models.findIndex((model) => model.id === value) })
        }
        options={form.models.map((model) => ({
          value: model.id,
          label: model.base?.displayName ?? model.id,
        }))}
      />
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? t('provider.models.loading') : t('provider.models.refresh')}
        </Button>
        <span role="status" className="text-sm text-muted-foreground">
          {t('provider.models.count', { count: form.models.length })}
        </span>
      </div>
      {failed && <ErrorNote className="text-sm">{t('provider.models.loadFailed')}</ErrorNote>}
    </div>
  );
}
