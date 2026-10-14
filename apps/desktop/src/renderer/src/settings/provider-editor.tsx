import { isRpcError, type WevirClient } from '@wevir/client-sdk';
import { cn } from 'cn';
import { ArrowLeft, ExternalLink, Plus, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import {
  connectionChanged,
  deepseekModelChoices,
  type FormErrors,
  modelRow,
  type ProviderForm,
  toUpsertParams,
  validateForm,
} from './provider-form';
import { FORM_APIS } from './provider-presets';
import { SELECT } from './settings-ui';

export interface SaveOutcome {
  id: string;
  displayName: string;
  hasSecret: boolean;
  /** 改了影响连接的字段（或是新建的）：列表要丢掉旧的测试结果，有 Key 时重测。 */
  connectionChanged: boolean;
  /** Profile 已保存，但引擎没能用上新配置（ENGINE_ERROR，host-api.md §3.1）。 */
  engineError?: string;
}

/** 新增或编辑一个 Provider 的表单（字段与检查在 provider-form.ts）。 */
export function ProviderEditor({
  client,
  initial,
  takenIds,
  onSaved,
  onCancel,
}: {
  client: WevirClient;
  initial: ProviderForm;
  takenIds: string[];
  onSaved: (outcome: SaveOutcome) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  /** 保存失败，或 Host 退回了没有对应输入框的问题（compat 等）。 */
  const [failure, setFailure] = useState<{ title: string; items: string[] }>();
  const [saving, setSaving] = useState(false);
  const ids = useId();

  const update = (patch: Partial<ProviderForm>) => setForm((current) => ({ ...current, ...patch }));
  const openAI = form.kind === 'openai-compatible';
  const name = form.editing
    ? initial.displayName
    : form.preset
      ? t(form.preset.name)
      : openAI
        ? t('provider.form.customName')
        : t('provider.pick.deepseek');

  // 按模板新建（含 DeepSeek 官方）时其余字段都已填好，Key 放在最前并聚焦：用户只需填 Key。
  const keyFirst = !form.editing && (form.preset !== undefined || !openAI);
  const keyField = (
    <FormField
      id={`${ids}-key`}
      label={t('provider.form.apiKey')}
      hint={t('provider.form.apiKeyHint')}
    >
      <Input
        id={`${ids}-key`}
        type="password"
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
        autoFocus={keyFirst}
        value={form.apiKey}
        placeholder={
          form.hasSecret
            ? t('provider.form.apiKeyPlaceholderSet')
            : t('provider.form.apiKeyPlaceholder')
        }
        onChange={(event) => update({ apiKey: event.target.value })}
      />
    </FormField>
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const local = validateForm(form, form.editing ? [] : takenIds);
    setErrors(local);
    setFailure(undefined);
    if (Object.keys(local).length > 0) return;
    const params = toUpsertParams(form);
    const outcome: SaveOutcome = {
      id: params.id,
      displayName: params.displayName,
      hasSecret: params.apiKey !== undefined || form.hasSecret,
      connectionChanged: connectionChanged(initial, form),
    };
    setSaving(true);
    try {
      await client.request('provider.upsert', params);
    } catch (error) {
      if (isRpcError(error, 'ENGINE_ERROR')) {
        await onSaved({ ...outcome, engineError: describe(error) });
        return;
      }
      setSaving(false);
      if (isRpcError(error, 'INVALID_PARAMS') && error.data?.issues.length) {
        // 适配器的检查（validateProvider）比本地的多，比如 compat 开关与协议不匹配。
        const fields: FormErrors = {};
        const rest: string[] = [];
        for (const issue of error.data.issues) {
          const key = issue.path.join('.');
          if (FIELD_KEYS.some((field) => key === field || key.startsWith(`${field}.`))) {
            fields[key] = issue.message;
          } else rest.push(issue.message);
        }
        setErrors(fields);
        if (rest.length > 0) setFailure({ title: t('provider.form.rejected'), items: rest });
        return;
      }
      setFailure({ title: t('provider.form.saveFailed', { error: describe(error) }), items: [] });
      return;
    }
    await onSaved(outcome);
  };

  return (
    <form className="space-y-5" onSubmit={submit} noValidate data-provider-form={form.kind}>
      <div className="flex items-center gap-1.5">
        <IconButton label={t('provider.form.back')} onClick={onCancel} disabled={saving}>
          <ArrowLeft />
        </IconButton>
        <h2 className="text-base font-semibold">
          {form.editing
            ? t('provider.form.titleEdit', { name })
            : t('provider.form.titleNew', { name })}
        </h2>
      </div>

      {form.preset && (
        <div className="space-y-1.5 rounded-lg bg-muted px-3.5 py-2.5 text-sm text-muted-foreground">
          <p>{t(form.preset.note)}</p>
          {form.preset.docsURL && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
              onClick={() => void window.wevir.openExternal(form.preset?.docsURL ?? '')}
            >
              {t('provider.form.docs')}
              <ExternalLink className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      )}

      {keyFirst && keyField}

      <FormField
        id={`${ids}-name`}
        label={t('provider.form.displayName')}
        error={errors.displayName}
      >
        <Input
          id={`${ids}-name`}
          value={form.displayName}
          onChange={(event) => update({ displayName: event.target.value })}
          aria-invalid={!!errors.displayName}
        />
      </FormField>

      <FormField
        id={`${ids}-id`}
        label={t('provider.form.id')}
        error={errors.id}
        hint={openAI && !form.editing ? t('provider.form.idHint') : t('provider.form.idLocked')}
      >
        <Input
          id={`${ids}-id`}
          className="font-mono"
          value={form.id}
          readOnly={form.editing || !openAI}
          disabled={form.editing || !openAI}
          spellCheck={false}
          onChange={(event) => update({ id: event.target.value })}
          aria-invalid={!!errors.id}
        />
      </FormField>

      {openAI ? (
        <>
          <FormField id={`${ids}-api`} label={t('provider.form.api')}>
            <select
              id={`${ids}-api`}
              className={SELECT}
              value={form.api}
              onChange={(event) => update({ api: event.target.value as ProviderForm['api'] })}
            >
              {FORM_APIS.map((api) => (
                <option key={api} value={api}>
                  {t(`provider.form.api.${api}`)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField
            id={`${ids}-url`}
            label={t('provider.form.baseURL')}
            hint={t('provider.form.baseURLHint')}
            error={errors.baseURL}
          >
            <Input
              id={`${ids}-url`}
              className="font-mono"
              value={form.baseURL}
              spellCheck={false}
              placeholder="https://"
              onChange={(event) => update({ baseURL: event.target.value })}
              aria-invalid={!!errors.baseURL}
            />
          </FormField>
          <ModelsField form={form} errors={errors} onChange={update} />
        </>
      ) : (
        <>
          <FormField
            id={`${ids}-model`}
            label={t('provider.form.defaultModel')}
            hint={t('provider.form.defaultModelHint')}
            error={errors.defaultModelId}
          >
            <select
              id={`${ids}-model`}
              className={cn(SELECT, 'font-mono')}
              value={form.defaultModelId}
              onChange={(event) => update({ defaultModelId: event.target.value })}
            >
              {deepseekModelChoices(form).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </FormField>
          <FormField
            id={`${ids}-url`}
            label={t('provider.form.baseURLOptional')}
            hint={t('provider.form.baseURLOptionalHint')}
            error={errors.baseURL}
          >
            <Input
              id={`${ids}-url`}
              className="font-mono"
              value={form.baseURL}
              spellCheck={false}
              placeholder="https://api.deepseek.com/anthropic"
              onChange={(event) => update({ baseURL: event.target.value })}
              aria-invalid={!!errors.baseURL}
            />
          </FormField>
        </>
      )}

      {!keyFirst && keyField}

      {failure && (
        <div
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <p>{failure.title}</p>
          {failure.items.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {failure.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {t('provider.form.cancel')}
        </Button>
        <Button type="submit" disabled={saving} data-action="save-provider">
          {saving ? t('provider.form.saving') : t('provider.form.save')}
        </Button>
      </div>
    </form>
  );
}

/** 有输入框的字段：Host 退回的 `issues[].path` 落在这些字段（或其下）时显示在输入框旁。 */
const FIELD_KEYS = ['displayName', 'id', 'baseURL', 'models', 'defaultModelId'];

function FormField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        hint && <p className="text-sm text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/** OpenAI 兼容 Provider 的模型列表：每行模型 ID 与上下文长度，单选默认模型。 */
function ModelsField({
  form,
  errors,
  onChange,
}: {
  form: ProviderForm;
  errors: FormErrors;
  onChange: (patch: Partial<ProviderForm>) => void;
}) {
  const ids = useId();
  const general = errors.models ?? errors.defaultModelId;
  const setRow = (index: number, patch: Partial<ProviderForm['models'][number]>) =>
    onChange({
      models: form.models.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  const removeRow = (index: number) =>
    onChange({
      models: form.models.filter((_, i) => i !== index),
      defaultIndex:
        form.defaultIndex > index
          ? form.defaultIndex - 1
          : form.defaultIndex === index
            ? 0
            : form.defaultIndex,
    });

  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1.5 text-sm font-medium">{t('provider.form.models')}</legend>
      <div className="grid grid-cols-[auto_1fr_10rem_auto] items-center gap-x-2 gap-y-1.5">
        <span className="text-xs text-muted-foreground">{t('provider.form.default')}</span>
        <span className="text-xs text-muted-foreground">{t('provider.form.modelId')}</span>
        <span className="text-xs text-muted-foreground">{t('provider.form.contextWindow')}</span>
        <span />
        {form.models.map((row, index) => {
          const idError = errors[`models.${index}.id`];
          const contextError = errors[`models.${index}.contextWindow`];
          return (
            <div key={row.key} className="contents" data-model-row={index}>
              <input
                type="radio"
                name={`${ids}-default`}
                className="mx-auto size-4 accent-primary"
                checked={form.defaultIndex === index}
                onChange={() => onChange({ defaultIndex: index })}
                aria-label={t('provider.form.defaultModel')}
              />
              <div>
                <Input
                  className="font-mono"
                  value={row.id}
                  spellCheck={false}
                  aria-label={t('provider.form.modelId')}
                  aria-invalid={!!idError}
                  onChange={(event) => setRow(index, { id: event.target.value })}
                />
                {idError && <p className="mt-1 text-sm text-destructive">{idError}</p>}
              </div>
              <div>
                <Input
                  className="font-mono"
                  inputMode="numeric"
                  value={row.contextWindow}
                  placeholder={t('provider.form.contextWindowPlaceholder')}
                  aria-label={t('provider.form.contextWindow')}
                  aria-invalid={!!contextError}
                  onChange={(event) => setRow(index, { contextWindow: event.target.value })}
                />
                {contextError && <p className="mt-1 text-sm text-destructive">{contextError}</p>}
              </div>
              <IconButton
                label={t('provider.form.removeModel', { id: row.id })}
                disabled={form.models.length <= 1}
                onClick={() => removeRow(index)}
              >
                <X />
              </IconButton>
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onChange({ models: [...form.models, modelRow()] })}
      >
        <Plus />
        {t('provider.form.addModel')}
      </Button>
      {general ? (
        <p className="text-sm text-destructive">{general}</p>
      ) : (
        <p className="text-sm text-muted-foreground">{t('provider.form.modelsHint')}</p>
      )}
    </fieldset>
  );
}
