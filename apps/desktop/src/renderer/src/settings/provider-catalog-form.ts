import type { WevirClient } from '@wevir/client-sdk';
import { t } from '@/i18n';
import { modelRow, type ProviderForm } from './provider-form';

/** Both onboarding and settings load dynamic catalogs through Host. */
export async function loadProviderCatalog(
  client: Pick<WevirClient, 'request'>,
  form: ProviderForm,
): Promise<ProviderForm> {
  if (form.preset?.modelCatalog !== 'zuv') return form;
  const result = await client.request(
    'provider.discoverModels',
    form.editing && !form.apiKey.trim()
      ? { providerId: form.id }
      : { baseURL: form.baseURL, ...(form.apiKey.trim() && { apiKey: form.apiKey.trim() }) },
  );
  if (!result.ok || result.models.length === 0 || result.truncated)
    throw new Error(t('provider.models.loadFailed'));
  const previous = form.models[form.defaultIndex]?.id;
  return {
    ...form,
    models: result.models.map(({ model }) => modelRow(model)),
    defaultIndex: Math.max(
      0,
      result.models.findIndex(({ model }) => model.id === previous),
    ),
  };
}
