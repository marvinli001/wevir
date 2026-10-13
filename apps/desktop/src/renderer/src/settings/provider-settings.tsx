import type { WevirClient } from '@wevir/client-sdk';
import type { ProviderProfile, Session } from '@wevir/protocol';
import { cn } from 'cn';
import {
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useCallback, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { StatusDot } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import { useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { ProviderEditor, type SaveOutcome } from './provider-editor';
import { editForm, newDeepSeekForm, newOpenAIForm, type ProviderForm } from './provider-form';
import { DEEPSEEK_OFFICIAL_ID, OPENAI_PRESETS, type OpenAIPreset } from './provider-presets';
import { presentTestError, presentTestResult, type TestPresentation } from './provider-test-result';
import { openSessions, removeClosingSessions } from './remove';
import { type Notice, NoticeBanner, SettingsLoading } from './settings-ui';

type View = { kind: 'list' } | { kind: 'pick' } | { kind: 'form'; form: ProviderForm };

type TestState = { status: 'running' } | { status: 'done'; result: TestPresentation };

/**
 * 设置 → 模型 Provider（T5.4）：列表、新增（先选 DeepSeek 官方或 OpenAI 兼容模板）、编辑、删除、测试连接。
 * Key 只在表单里输入一次，之后只显示“已设置”。保存后自动测一次连接（有 Key 时）。
 */
export function ProviderSettings() {
  const data = useWorkbenchData();
  const store = useWorkbenchStore();
  const { client } = useHostConnection();
  const [view, setView] = useState<View>({ kind: 'list' });
  const [notice, setNotice] = useState<Notice>();
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [removing, setRemoving] = useState<ProviderProfile>();

  const runTest = useCallback(
    async (providerId: string) => {
      if (!client) return;
      setTests((current) => ({ ...current, [providerId]: { status: 'running' } }));
      let result: TestPresentation;
      try {
        result = presentTestResult(await client.request('provider.test', { providerId }));
      } catch (error) {
        result = presentTestError(error);
      }
      setTests((current) => ({ ...current, [providerId]: { status: 'done', result } }));
    },
    [client],
  );

  if (data.status !== 'ready') return <SettingsLoading data={data} />;
  const { providers } = data;
  const takenIds = providers.map((provider) => provider.id);
  const sessions = data.workspaces.flatMap((entry) => entry.sessions);

  const saved = async (outcome: SaveOutcome) => {
    await store?.refresh();
    setView({ kind: 'list' });
    setTests(({ [outcome.id]: _stale, ...rest }) => rest);
    if (outcome.engineError !== undefined) {
      setNotice({
        tone: 'warning',
        text: t('provider.engineNotApplied', {
          name: outcome.displayName,
          error: outcome.engineError,
        }),
      });
    } else if (outcome.hasSecret) {
      setNotice({ tone: 'success', text: t('provider.saved', { name: outcome.displayName }) });
    } else {
      setNotice({ tone: 'warning', text: t('provider.savedNoKey', { name: outcome.displayName }) });
    }
    if (outcome.hasSecret) void runTest(outcome.id);
  };

  if (view.kind === 'form' && client) {
    return (
      <ProviderEditor
        client={client}
        initial={view.form}
        takenIds={takenIds}
        onSaved={saved}
        onCancel={() => setView({ kind: view.form.editing ? 'list' : 'pick' })}
      />
    );
  }
  if (view.kind === 'pick') {
    return (
      <ProviderPicker
        deepseekExists={takenIds.includes(DEEPSEEK_OFFICIAL_ID)}
        onBack={() => setView({ kind: 'list' })}
        onPick={(preset) =>
          setView({
            kind: 'form',
            form: preset === 'deepseek' ? newDeepSeekForm() : newOpenAIForm(preset, takenIds),
          })
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <p className="text-muted-foreground">{t('provider.intro')}</p>
        <Button
          onClick={() => {
            setNotice(undefined);
            setView({ kind: 'pick' });
          }}
          disabled={!client}
          data-action="add-provider"
        >
          <Plus />
          {t('provider.add')}
        </Button>
      </div>
      {!client && <NoticeBanner notice={{ tone: 'info', text: t('settings.noHost') }} />}
      {notice && <NoticeBanner notice={notice} />}
      {providers.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-muted-foreground">
          {t('provider.empty')}
        </p>
      ) : (
        <ul className="space-y-3">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              test={tests[provider.id]}
              disabled={!client}
              onTest={() => void runTest(provider.id)}
              onEdit={() => {
                setNotice(undefined);
                setView({ kind: 'form', form: editForm(provider) });
              }}
              onRemove={() => setRemoving(provider)}
            />
          ))}
        </ul>
      )}
      {removing && client && (
        <RemoveProviderDialog
          provider={removing}
          sessions={sessions}
          onClose={() => setRemoving(undefined)}
          onConfirm={async () => {
            await removeProvider(client, removing.id);
            await store?.refresh();
            setTests(({ [removing.id]: _gone, ...rest }) => rest);
          }}
        />
      )}
    </div>
  );
}

async function removeProvider(client: WevirClient, providerId: string): Promise<void> {
  await removeClosingSessions(client, () => client.request('provider.remove', { providerId }));
}

function ProviderCard({
  provider,
  test,
  disabled,
  onTest,
  onEdit,
  onRemove,
}: {
  provider: ProviderProfile;
  test: TestState | undefined;
  disabled: boolean;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const running = test?.status === 'running';
  return (
    <li className="rounded-lg border border-border p-4" data-provider-id={provider.id}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-medium">{provider.displayName}</h2>
            <span className="shrink-0 rounded-sm bg-muted px-1.5 text-xs leading-5 text-muted-foreground">
              {t(`provider.kind.${provider.kind}`)}
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <Detail label="ID" mono>
              {provider.id}
            </Detail>
            <Detail label={t('provider.defaultModel')}>
              <span className="font-mono">{provider.defaultModelId}</span>
              {provider.models.length > 1 && (
                <span className="text-faint-foreground">
                  {' · '}
                  {t('provider.modelCount', { count: provider.models.length })}
                </span>
              )}
            </Detail>
            <Detail label={t('provider.baseURL')} mono={!!provider.baseURL}>
              {provider.baseURL ?? t('provider.baseURLOfficial')}
            </Detail>
            <Detail label={t('provider.key')}>
              <span className="inline-flex items-center gap-1.5" data-key-status>
                <StatusDot tone={provider.hasSecret ? 'success' : 'warning'} />
                {provider.hasSecret ? t('provider.key.set') : t('provider.key.unset')}
              </span>
            </Detail>
          </dl>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={onTest}
            disabled={disabled || running}
            data-action="test-provider"
          >
            {running && <LoaderCircle className="animate-spin" />}
            {running ? t('provider.testing') : t('provider.test')}
          </Button>
          <IconButton label={t('provider.edit')} onClick={onEdit} disabled={disabled}>
            <Pencil />
          </IconButton>
          <IconButton label={t('provider.remove')} onClick={onRemove} disabled={disabled}>
            <Trash2 />
          </IconButton>
        </div>
      </div>
      {test?.status === 'done' && <TestResultView result={test.result} />}
    </li>
  );
}

function Detail({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 truncate', mono && 'font-mono')}>{children}</dd>
    </>
  );
}

function TestResultView({ result }: { result: TestPresentation }) {
  const Icon = result.ok ? CircleCheck : CircleX;
  return (
    <div
      role="status"
      data-test-result={result.ok ? 'ok' : 'failed'}
      className={cn(
        'mt-3 flex gap-2 rounded-md px-3 py-2 text-sm',
        result.ok ? 'bg-success/10' : 'bg-destructive/10',
      )}
    >
      <Icon
        className={cn('mt-0.5 size-4 shrink-0', result.ok ? 'text-success' : 'text-destructive')}
        aria-hidden
      />
      <div className="min-w-0 space-y-1">
        <p className={cn('font-medium', result.ok ? 'text-success' : 'text-destructive')}>
          {result.title}
        </p>
        {result.hint && <p className="text-foreground">{result.hint}</p>}
        {result.detail && (
          <p className="font-mono text-xs break-all text-muted-foreground">{result.detail}</p>
        )}
      </div>
    </div>
  );
}

function ProviderPicker({
  deepseekExists,
  onBack,
  onPick,
}: {
  deepseekExists: boolean;
  onBack: () => void;
  onPick: (preset: 'deepseek' | OpenAIPreset | undefined) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-1.5">
        <IconButton label={t('provider.form.back')} onClick={onBack}>
          <ArrowLeft />
        </IconButton>
        <h2 className="text-base font-medium">{t('provider.pick.title')}</h2>
      </div>
      <p className="text-muted-foreground">{t('provider.pick.body')}</p>
      <PickOption
        title={t('provider.pick.deepseek')}
        note={
          deepseekExists ? t('provider.pick.deepseek.exists') : t('provider.pick.deepseek.note')
        }
        detail="api.deepseek.com"
        disabled={deepseekExists}
        onClick={() => onPick('deepseek')}
        id="deepseek-official"
      />
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">{t('provider.pick.openai')}</h3>
        <div className="grid grid-cols-2 gap-2">
          {OPENAI_PRESETS.map((preset) => (
            <PickOption
              key={preset.id}
              title={t(preset.name)}
              detail={new URL(preset.baseURL).host}
              onClick={() => onPick(preset)}
              id={preset.id}
            />
          ))}
          <PickOption
            title={t('provider.pick.custom')}
            note={t('provider.pick.custom.note')}
            onClick={() => onPick(undefined)}
            id="custom"
          />
        </div>
      </section>
    </div>
  );
}

function PickOption({
  title,
  note,
  detail,
  disabled,
  onClick,
  id,
}: {
  title: string;
  note?: string;
  detail?: string;
  disabled?: boolean;
  onClick: () => void;
  id: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-preset={id}
      className="flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-60"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium">{title}</p>
        {detail && <p className="truncate font-mono text-xs text-muted-foreground">{detail}</p>}
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
      </div>
      {!disabled && <ChevronRight className="size-4 shrink-0 text-faint-foreground" aria-hidden />}
    </button>
  );
}

function RemoveProviderDialog({
  provider,
  sessions,
  onClose,
  onConfirm,
}: {
  provider: ProviderProfile;
  sessions: Session[];
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const open = openSessions(sessions.filter((session) => session.providerId === provider.id));
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('provider.remove.title', { name: provider.displayName })}
      confirmLabel={t('provider.remove.confirm')}
      onConfirm={onConfirm}
      failure={(error) => t('provider.remove.failed', { error })}
    >
      <p>{t('provider.remove.body', { id: provider.id })}</p>
      {open.length > 0 && <p>{t('provider.remove.openSessions', { count: open.length })}</p>}
    </ConfirmDialog>
  );
}
