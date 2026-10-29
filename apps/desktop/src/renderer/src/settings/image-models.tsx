import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import type { MethodParams } from '@wevir/protocol';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';
import { type ProviderForm, transcriptionIds } from './provider-form';

/** 读图片模型用哪份凭据：编辑中且地址与 Key 都没改时用已存的，否则用表单里的。 */
export function imageDiscoveryParams(
  form: Pick<ProviderForm, 'id' | 'editing' | 'baseURL' | 'savedBaseURL' | 'apiKey'>,
): MethodParams<'provider.discoverImageModels'> {
  return form.editing && form.savedBaseURL === form.baseURL.trim() && form.apiKey.trim() === ''
    ? { providerId: form.id }
    : { baseURL: form.baseURL.trim(), ...(form.apiKey.trim() && { apiKey: form.apiKey.trim() }) };
}

/** 并上读到的图片模型：已填的在前、顺序不变，新的按 Host 给的顺序（新版本在前）接在后面。 */
export function mergeImageModels(current: string, found: readonly string[]): string {
  return [...new Set([...transcriptionIds(current), ...found])].join(', ');
}

/** `openai-compatible` 的图片模型（0.139.0）：手填，或从服务的 `/models` 读出来。 */
export function ImageModelsField({
  id,
  client,
  form,
  error,
  onChange,
}: {
  id: string;
  client: WevirClient | undefined;
  form: ProviderForm;
  error: string | undefined;
  onChange: (patch: Partial<ProviderForm>) => void;
}) {
  const canDetect =
    !!client &&
    hostSupports(client.hello.features, 'image_generation') &&
    form.baseURL.trim() !== '';
  const [status, setStatus] = useState<'loading' | 'none' | 'failed'>();
  const detect = async () => {
    if (!client) return;
    setStatus('loading');
    try {
      const result = await client.request(
        'provider.discoverImageModels',
        imageDiscoveryParams(form),
      );
      if (!result.ok) {
        setStatus('failed');
        return;
      }
      setStatus(result.models.length === 0 ? 'none' : undefined);
      if (result.models.length > 0) {
        onChange({
          imageModels: mergeImageModels(
            form.imageModels,
            result.models.map((model) => model.id),
          ),
        });
      }
    } catch {
      setStatus('failed');
    }
  };
  return (
    <div className="space-y-1.5" data-image-models>
      <label htmlFor={id} className="block text-sm font-medium">
        {t('provider.form.imageModels')}
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          className="font-mono"
          value={form.imageModels}
          spellCheck={false}
          placeholder="gpt-image-2"
          onChange={(event) => onChange({ imageModels: event.target.value })}
          aria-invalid={!!error}
        />
        {canDetect && (
          <Button
            type="button"
            variant="outline"
            disabled={status === 'loading'}
            onClick={() => void detect()}
            data-action="detect-image-models"
          >
            {status === 'loading'
              ? t('provider.form.imageModelsDetecting')
              : t('provider.form.imageModelsDetect')}
          </Button>
        )}
      </div>
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : status === 'none' || status === 'failed' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {status === 'none'
            ? t('provider.form.imageModelsNone')
            : t('provider.form.imageModelsFailed')}
        </p>
      ) : null}
    </div>
  );
}
