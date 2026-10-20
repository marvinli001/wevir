import { cn } from 'cn';
import { ArrowRight, Check, ChevronDown, ExternalLink, LoaderCircle } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { BrandMark } from '@/components/brand-mark';
import { ProviderLogo } from '@/components/provider-logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select } from '@/components/ui/select';
import { useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { PendingPage } from '@/routes/route-states';
import { OllamaModels } from '@/settings/ollama-models';
import { type CatalogEntry, catalogEntry, FEATURED_PROVIDERS } from '@/settings/provider-catalog';
import { ModelsField } from '@/settings/provider-editor';
import {
  hasProviderPlaceholder,
  newDeepSeekForm,
  newOpenAIForm,
  type ProviderForm,
  placeholderError,
  toUpsertParams,
  validateForm,
} from '@/settings/provider-form';
import { FORM_APIS } from '@/settings/provider-presets';
import {
  presentTestError,
  presentTestResult,
  type TestPresentation,
} from '@/settings/provider-test-result';
import { VertexFields } from '@/settings/vertex-fields';
import { onboardingDone } from './onboarding-state';
import { ProviderCatalogDialog } from './provider-catalog-dialog';

type Step = 'provider' | 'ready';

interface Connected {
  entry: CatalogEntry;
  name: string;
  model: string;
  verified: boolean;
}

/**
 * `/welcome`：首次使用的分步引导（U6，维护者 2026-10-14 定），整窗、不带侧栏。第一步选模型服务并填 Key（第一行是
 * OpenAI、Anthropic、Google AI Studio、Google Vertex AI，其余在“更多”里），保存后立即测试连接；第二步“开始对话”
 * 进入软件。跳过或走完都记在本机（onboarding-state.ts），之后不再出现；项目在侧栏里建。
 */
export function WelcomeRoute() {
  const data = useWorkbenchData();
  const navigate = useNavigate();
  const done = onboardingDone.use();
  const [step, setStep] = useState<Step>('provider');
  const [connected, setConnected] = useState<Connected>();

  if (data.status === 'loading') return <PendingPage />;
  // 走完或跳过过的不再引导（首页只在没有 Provider 时才把人带到这里）。
  if (done) return <Navigate to={paths.home()} replace />;

  const finish = () => {
    onboardingDone.set(true);
    navigate(paths.home(), { replace: true });
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="app-drag h-11 shrink-0" />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-176 flex-col px-6 pt-[clamp(1rem,9vh,5.5rem)] pb-12">
          <Stepper step={step} />
          {step === 'provider' ? (
            <ProviderStep
              key="provider"
              onSkip={finish}
              onConnected={(result) => {
                setConnected(result);
                setStep('ready');
              }}
            />
          ) : (
            connected && (
              <ReadyStep
                key="ready"
                connected={connected}
                onBack={() => setStep('provider')}
                onStart={finish}
              />
            )
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** 两步的进度：两段细条，当前与做完的一段是正文色。 */
function Stepper({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: 'provider', label: t('welcome.step.provider') },
    { id: 'ready', label: t('welcome.step.ready') },
  ];
  const current = steps.findIndex((item) => item.id === step);
  return (
    <ol className="mb-10 grid grid-cols-2 gap-2" aria-label={t('welcome.steps')}>
      {steps.map((item, index) => (
        <li
          key={item.id}
          aria-current={index === current ? 'step' : undefined}
          className="flex flex-col gap-2"
        >
          <span
            className={cn(
              'h-0.5 rounded-full transition-colors duration-500',
              index <= current ? 'bg-foreground' : 'bg-border',
            )}
          />
          <span
            className={cn(
              'text-xs tabular-nums transition-colors duration-300',
              index <= current ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {index + 1} · {item.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepHeader({ title, body }: { title: string; body?: string }) {
  return (
    <header className="mb-8 flex flex-col gap-3">
      <BrandMark className="size-6 text-brand" />
      <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight">{title}</h1>
      {body && <p className="text-muted-foreground">{body}</p>}
    </header>
  );
}

function ProviderStep({
  onSkip,
  onConnected,
}: {
  onSkip: () => void;
  onConnected: (connected: Connected) => void;
}) {
  const { client, view: connection } = useHostConnection();
  const vertexAvailable =
    connection.status === 'connected' && connection.hello.features.google_vertex === true;
  const data = useWorkbenchData();
  const store = useWorkbenchStore();
  const [entry, setEntry] = useState<CatalogEntry>();
  const [form, setForm] = useState<ProviderForm>();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<TestPresentation>();
  /** 这一步里已经存下的 Provider：改了 Key 再点“下一步”是更新它，不再新建。 */
  const [savedId, setSavedId] = useState<string>();

  const takenIds = data.status === 'ready' ? data.providers.map((p) => p.id) : [];
  const featured = FEATURED_PROVIDERS.map(catalogEntry).filter(
    (item): item is CatalogEntry => item !== undefined,
  );
  const extra = entry && !FEATURED_PROVIDERS.includes(entry.id) ? entry : undefined;

  const choose = (next: CatalogEntry) => {
    if (!next.source || (next.id === 'google-vertex' && !vertexAvailable)) return;
    setCatalogOpen(false);
    if (next.id === entry?.id) return;
    setEntry(next);
    setErrors({});
    setFailure(undefined);
    setSavedId(undefined);
    const source = next.source;
    setForm(
      source.kind === 'deepseek-official'
        ? newDeepSeekForm()
        : source.kind === 'preset'
          ? newOpenAIForm(source.preset, takenIds)
          : {
              ...newOpenAIForm(undefined, takenIds),
              id: uniqueCustomId(takenIds),
              displayName: t('provider.catalog.custom'),
            },
    );
  };

  const update = (patch: Partial<ProviderForm>) => {
    setForm((current) => current && { ...current, ...patch });
    setErrors({});
    setFailure(undefined);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!client || !form || !entry || busy) return;
    // 上次测试没通过、什么都没改：照样进下一步（例如要代理才能连上的服务）。
    if (failure && savedId) {
      onConnected(connectedFrom(entry, form, false));
      return;
    }
    const next: Record<string, string> = validateForm(
      savedId ? { ...form, editing: true } : form,
      savedId ? takenIds.filter((id) => id !== savedId) : takenIds,
    );
    if (!form.hasSecret) {
      if (form.kind === 'google-vertex' && !form.serviceAccountJson?.trim())
        next.serviceAccountJson = t('provider.form.error.required');
      else if (form.kind !== 'google-vertex' && !form.apiKey.trim())
        next.apiKey = t('provider.form.error.required');
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const { provider } = await client.request('provider.upsert', toUpsertParams(form));
      setSavedId(provider.id);
      setForm(
        (current) =>
          current && {
            ...current,
            editing: true,
            hasSecret: provider.hasSecret,
            apiKey: '',
            serviceAccountJson: '',
          },
      );
      await store?.refresh();
      let result: TestPresentation;
      try {
        result = presentTestResult(
          await client.request('provider.test', { providerId: provider.id }),
        );
      } catch (error) {
        result = presentTestError(error);
      }
      if (result.ok) onConnected(connectedFrom(entry, form, true));
      else setFailure(result);
    } catch (error) {
      setFailure({ ok: false, title: t('welcome.saveFailed', { error: describe(error) }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="animate-in duration-500 fade-in slide-in-from-bottom-2">
      <StepHeader title={t('welcome.provider.title')} />

      <fieldset className="grid grid-cols-3 gap-2.5 sm:grid-cols-5">
        <legend className="sr-only">{t('welcome.provider.title')}</legend>
        {featured.map((item) => (
          <ProviderTile
            vertexAvailable={vertexAvailable}
            key={item.id}
            entry={item}
            selected={entry?.id === item.id}
            onClick={() => choose(item)}
          />
        ))}
        <ProviderTile
          entry={extra}
          selected={extra !== undefined}
          more
          onClick={() => setCatalogOpen(true)}
        />
      </fieldset>

      {entry && form && (
        <form
          key={entry.id}
          onSubmit={submit}
          className="mt-8 flex flex-col gap-5 animate-in duration-300 fade-in slide-in-from-top-1"
        >
          <ProviderFields entry={entry} form={form} errors={errors} onChange={update} />
          <OllamaModels client={client} form={form} onChange={update} />
          {failure && (
            <div
              role="alert"
              className="rounded-lg bg-destructive/8 px-3.5 py-3 text-sm animate-in fade-in"
            >
              <p className="font-medium text-destructive">{failure.title}</p>
              {failure.hint && <p className="mt-1 text-soft-foreground">{failure.hint}</p>}
              {failure.detail && (
                <p className="mt-1.5 font-mono text-xs break-words text-muted-foreground">
                  {failure.detail}
                </p>
              )}
            </div>
          )}
          <Footer>
            <Button type="button" variant="ghost" onClick={onSkip}>
              {t('welcome.skip')}
            </Button>
            <Button
              type="submit"
              disabled={!client || busy}
              className="min-w-24"
              data-action="welcome-next"
            >
              {busy ? (
                <>
                  <LoaderCircle className="animate-spin" data-icon="inline-start" />
                  {t('welcome.verifying')}
                </>
              ) : (
                <>
                  {failure && savedId ? t('welcome.continueAnyway') : t('welcome.next')}
                  <ArrowRight data-icon="inline-end" />
                </>
              )}
            </Button>
          </Footer>
        </form>
      )}
      {!entry && (
        <Footer className="mt-10">
          <Button type="button" variant="ghost" onClick={onSkip}>
            {t('welcome.skip')}
          </Button>
          <Button type="button" disabled className="min-w-24">
            {t('welcome.next')}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </Footer>
      )}

      <ProviderCatalogDialog
        vertexAvailable={vertexAvailable}
        open={catalogOpen}
        selected={entry?.id}
        onOpenChange={setCatalogOpen}
        onSelect={choose}
      />
    </section>
  );
}

function Footer({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-end gap-2 pt-2', className)}>{children}</div>
  );
}

/** 第一行的一格：标志在上、名字在下；“更多”那一格选了列表里的服务后显示它。 */
function ProviderTile({
  entry,
  selected,
  more = false,
  vertexAvailable = false,
  onClick,
}: {
  entry: CatalogEntry | undefined;
  selected: boolean;
  more?: boolean;
  vertexAvailable?: boolean;
  onClick: () => void;
}) {
  const available =
    more || (entry?.source !== undefined && (entry.id !== 'google-vertex' || vertexAvailable));
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!available}
      aria-pressed={selected}
      data-provider-tile={more ? 'more' : entry?.id}
      className={cn(
        'group relative flex h-30 flex-col items-center justify-center gap-2.5 rounded-xl border bg-card px-2 text-sm outline-none',
        'transition-[border-color,box-shadow,transform,background-color] duration-200 ease-out',
        'hover:-translate-y-0.5 hover:shadow-md focus-visible:focus-field active:translate-y-0 active:scale-[0.98]',
        selected ? 'border-foreground/70 shadow-md ring-1 ring-foreground/70' : 'border-border',
        !available && 'pointer-events-none bg-transparent',
      )}
    >
      {more && !entry ? (
        <span className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors group-hover:text-foreground">
          <ChevronDown className="size-4" />
        </span>
      ) : (
        <ProviderLogo
          logo={entry?.logo}
          fallback={entry ? t(entry.name) : undefined}
          className={cn(
            'size-8 transition-transform duration-200 group-hover:scale-105',
            !available && 'opacity-40',
          )}
        />
      )}
      <span
        className={cn(
          'line-clamp-2 max-w-full text-center leading-tight',
          !available ? 'text-muted-foreground' : 'text-soft-foreground',
          selected && 'text-foreground',
        )}
      >
        {entry ? t(entry.name) : t('welcome.more')}
      </span>
      {!available && (
        <span className="-mt-1.5 text-[0.6875rem] leading-4 text-muted-foreground">
          {t(entry?.id === 'google-vertex' ? 'welcome.upgradeHost' : 'welcome.soon')}
        </span>
      )}
      {selected && (
        <span className="absolute top-2 right-2 flex size-4 items-center justify-center rounded-full bg-foreground text-background animate-in zoom-in-50 duration-200">
          <Check className="size-3" strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

/** 普通模板只填 Key；带占位的模板另填资源地址与部署名。设置页与引导使用相同的模型行和校验。 */
function ProviderFields({
  entry,
  form,
  errors,
  onChange,
}: {
  entry: CatalogEntry;
  form: ProviderForm;
  errors: Record<string, string>;
  onChange: (patch: Partial<ProviderForm>) => void;
}) {
  const custom = entry.source?.kind === 'custom';
  const resourceURL = hasProviderPlaceholder(form.preset?.baseURL ?? '');
  const deploymentModels = form.preset?.models.some((model) => hasProviderPlaceholder(model.id));
  const urlError = placeholderError(form.baseURL) ?? errors.baseURL;
  const keyless = form.kind === 'openai-compatible' && form.preset?.placeholderKey !== undefined;
  const firstModel = form.models[0];
  const setModel = (id: string) =>
    firstModel &&
    onChange({ models: [{ ...firstModel, id }, ...form.models.slice(1)], defaultIndex: 0 });

  return (
    <div className="flex flex-col gap-4">
      {form.kind !== 'google-vertex' && form.preset?.note && (
        <p className="text-sm text-muted-foreground">{t(form.preset.note)}</p>
      )}
      {(custom || resourceURL) && (
        <Field label={t('welcome.field.baseURL')} error={urlError}>
          {(id) => (
            <Input
              id={id}
              value={form.baseURL}
              onChange={(event) => onChange({ baseURL: event.target.value })}
              placeholder="https://example.com/v1"
              className="h-10 font-mono"
              aria-invalid={!!urlError}
              autoFocus
            />
          )}
        </Field>
      )}
      {(deploymentModels || entry.id === 'ollama' || entry.id === 'ollama-cloud') && (
        <ModelsField form={form} errors={errors} onChange={onChange} />
      )}
      {custom && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('welcome.field.api')}>
            {(id) => (
              <Select
                id={id}
                value={form.api}
                onValueChange={(api) => onChange({ api })}
                options={FORM_APIS.map((api) => ({
                  value: api,
                  label: t(`provider.form.api.${api}`),
                }))}
                className="h-10"
              />
            )}
          </Field>
          <Field label={t('welcome.field.model')} error={errors['models.0.id']}>
            {(id) => (
              <Input
                id={id}
                value={firstModel?.id ?? ''}
                onChange={(event) => setModel(event.target.value)}
                className="h-10 font-mono"
              />
            )}
          </Field>
        </div>
      )}
      {keyless && entry.id !== 'ollama' && (
        <Field label={t('welcome.field.model')} error={errors['models.0.id']}>
          {(id) => (
            <Input
              id={id}
              value={firstModel?.id ?? ''}
              onChange={(event) => setModel(event.target.value)}
              className="h-10 font-mono"
              autoFocus
            />
          )}
        </Field>
      )}
      {form.kind === 'google-vertex' && (
        <VertexFields form={form} errors={errors} onChange={onChange} />
      )}
      {!keyless && form.kind !== 'google-vertex' && (
        <Field
          label={t('welcome.field.apiKey')}
          error={errors.apiKey}
          aside={
            entry.keyURL && (
              <button
                type="button"
                onClick={() => entry.keyURL && void window.wevir.openExternal(entry.keyURL)}
                className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:focus-ring"
              >
                {t('welcome.getKey')}
                <ExternalLink className="size-3" />
              </button>
            )
          }
        >
          {(id) => (
            <Input
              id={id}
              type="password"
              value={form.apiKey}
              onChange={(event) => onChange({ apiKey: event.target.value })}
              placeholder={
                form.hasSecret
                  ? t('provider.form.apiKeyPlaceholderSet')
                  : t('provider.form.apiKeyPlaceholder')
              }
              autoComplete="off"
              spellCheck={false}
              className="h-10 font-mono"
              autoFocus={!custom && !resourceURL}
            />
          )}
        </Field>
      )}
    </div>
  );
}

function Field({
  label,
  error,
  aside,
  children,
}: {
  label: string;
  error?: string;
  aside?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-soft-foreground">
          {label}
        </label>
        {aside}
      </div>
      {children(id)}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function ReadyStep({
  connected,
  onBack,
  onStart,
}: {
  connected: Connected;
  onBack: () => void;
  onStart: () => void;
}) {
  return (
    <section className="animate-in duration-500 fade-in slide-in-from-bottom-2">
      <StepHeader title={t('welcome.ready.title')} />
      <div className="flex items-center gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5">
        <ProviderLogo logo={connected.entry.logo} fallback={connected.name} className="size-7" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{connected.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{connected.model}</p>
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 text-sm',
            connected.verified ? 'text-success' : 'text-muted-foreground',
          )}
        >
          {connected.verified && (
            <span className="flex size-4 items-center justify-center rounded-full bg-success/15 animate-in zoom-in-50 duration-300">
              <Check className="size-3" strokeWidth={3} />
            </span>
          )}
          {t(connected.verified ? 'welcome.ready.verified' : 'welcome.ready.unverified')}
        </span>
      </div>
      <Footer className="mt-10">
        <Button type="button" variant="ghost" onClick={onBack}>
          {t('welcome.back')}
        </Button>
        <Button
          type="button"
          onClick={onStart}
          className="h-10 px-5 text-base"
          data-action="welcome-start"
          autoFocus
        >
          {t('welcome.start')}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </Footer>
    </section>
  );
}

function connectedFrom(entry: CatalogEntry, form: ProviderForm, verified: boolean): Connected {
  const model =
    form.kind === 'deepseek-official'
      ? form.defaultModelId
      : (form.models[form.defaultIndex]?.id ?? form.models[0]?.id ?? '');
  return { entry, name: form.displayName.trim() || t(entry.name), model, verified };
}

function uniqueCustomId(taken: string[]): string {
  if (!taken.includes('custom')) return 'custom';
  for (let n = 2; ; n++) if (!taken.includes(`custom-${n}`)) return `custom-${n}`;
}
