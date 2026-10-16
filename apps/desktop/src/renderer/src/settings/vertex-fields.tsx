import { ExternalLink } from 'lucide-react';
import { useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { t } from '@/i18n';
import { modelRow, type ProviderForm, serviceAccountEmail } from './provider-form';
import { VERTEX_PRESETS } from './provider-presets';

/** 设置与首次引导共用；JSON 输入始终掩码，只显示解析出的账号邮箱。 */
export function VertexFields({
  form,
  errors,
  onChange,
}: {
  form: ProviderForm;
  errors: Record<string, string>;
  onChange: (patch: Partial<ProviderForm>) => void;
}) {
  const id = useId();
  const [fileError, setFileError] = useState(false);
  const email = serviceAccountEmail(form.serviceAccountJson ?? '');
  const docsURL = VERTEX_PRESETS.find((preset) => preset.api === form.api)?.docsURL;
  return (
    <div className="space-y-4" data-vertex-fields>
      <div className="space-y-1.5 text-sm text-muted-foreground">
        {docsURL && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
            onClick={() => void window.wevir.openExternal(docsURL)}
          >
            {t('provider.form.docs')}
            <ExternalLink className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-project`} className="block text-sm font-medium">
            {t('provider.vertex.project')}
          </label>
          <Input
            id={`${id}-project`}
            className="font-mono"
            value={form.vertex?.project ?? ''}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              onChange({ vertex: { ...form.vertex, project: event.target.value } })
            }
            aria-invalid={!!errors['vertex.project']}
          />
          {errors['vertex.project'] && (
            <p className="text-sm text-destructive">{errors['vertex.project']}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-location`} className="block text-sm font-medium">
            {t('provider.vertex.location')}
          </label>
          <Input
            id={`${id}-location`}
            className="font-mono"
            value={form.vertex?.location ?? 'global'}
            placeholder="global"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              onChange({
                vertex: { project: form.vertex?.project ?? '', location: event.target.value },
              })
            }
            aria-invalid={!!errors['vertex.location']}
          />
          {errors['vertex.location'] && (
            <p className="text-sm text-destructive">{errors['vertex.location']}</p>
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-family`} className="block text-sm font-medium">
          {t('provider.vertex.family')}
        </label>
        <Select
          id={`${id}-family`}
          value={form.api}
          options={[
            { value: 'openai-completions', label: 'Gemini' },
            { value: 'anthropic-messages', label: 'Claude' },
          ]}
          onValueChange={(api) => {
            const preset = VERTEX_PRESETS.find((p) => p.api === api);
            if (preset)
              onChange({
                api: preset.api,
                models: preset.models.map(modelRow),
                defaultIndex: 0,
                compat: preset.compat,
                preset,
              });
          }}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-account`} className="block text-sm font-medium">
          {t('provider.vertex.account')}
        </label>
        <Input
          id={`${id}-account`}
          type="password"
          value={form.serviceAccountJson ?? ''}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            form.hasSecret
              ? t('provider.form.apiKeyPlaceholderSet')
              : t('provider.vertex.accountPlaceholder')
          }
          aria-invalid={!!errors.serviceAccountJson || fileError}
          onChange={(event) => {
            setFileError(false);
            onChange({ serviceAccountJson: event.target.value });
          }}
        />
        <input
          type="file"
          accept=".json,application/json"
          className="block max-w-full text-sm text-muted-foreground"
          aria-label={t('provider.vertex.file')}
          onChange={async (event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            input.value = '';
            if (!file) return;
            try {
              if (file.size > 64 * 1024) throw new Error();
              onChange({ serviceAccountJson: await file.text() });
              setFileError(false);
            } catch {
              setFileError(true);
            }
          }}
        />
        {email && <p className="break-all text-sm text-soft-foreground">{email}</p>}
        {(errors.serviceAccountJson || fileError) && (
          <p className="text-sm text-destructive">
            {errors.serviceAccountJson ?? t('provider.vertex.accountInvalid')}
          </p>
        )}
      </div>
    </div>
  );
}
