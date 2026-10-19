import type { WevirClient } from '@wevir/client-sdk';
import type { ProviderProfile, Session } from '@wevir/protocol';
import { cn } from 'cn';
import { CircleCheck, CircleX, LoaderCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { ProviderLogo } from '@/components/provider-logo';
import { StatusDot } from '@/components/status-dot';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { isPickable, pickerOrder, sourceOf } from '@/data/sources';
import { useAccounts, useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { ProviderCatalogDialog } from '@/onboarding/provider-catalog-dialog';
import { modelsOf } from '@/session/model-picker';
import { type CatalogEntry, providerLogo } from './provider-catalog';
import { ProviderEditor, type SaveOutcome } from './provider-editor';
import {
  type EditableProvider,
  editForm,
  isEditableProvider,
  newDeepSeekForm,
  newOpenAIForm,
  type ProviderForm,
} from './provider-form';
import { DEEPSEEK_OFFICIAL_ID } from './provider-presets';
import { presentTestError, presentTestResult, type TestPresentation } from './provider-test-result';
import { openSessions, removeClosingSessions } from './remove';
import {
  EmptyList,
  LIST_CARD,
  type Notice,
  NoticeBanner,
  SettingsLoading,
  SettingsSection,
} from './settings-ui';
import { SubscriptionSources } from './subscription-sources';

type View = { kind: 'list' } | { kind: 'form'; form: ProviderForm };

type TestState = { status: 'running' } | { status: 'done'; result: TestPresentation };

/**
 * 设置 → 模型服务（T5.4，U7 改样式）：列表、新增（在与首次引导相同的“模型服务”对话框里选，再填表单）、编辑、删除、测试连接。
 * Key 只在表单里输入一次，之后只显示“已设置”。有 Key、且新建或改了影响连接的字段时，保存后自动测一次连接。
 * 0.19.0 起上面是“订阅”（subscription-sources.tsx：Codex 与五种订阅的格子与详情，ChatGPT 账号也在里面），下面是“API Key”的
 * 列表，每行有在模型选择里显示的开关；页面顶上一行是现在能选的来源与模型数。
 */
export function ProviderSettings() {
  const data = useWorkbenchData();
  const store = useWorkbenchStore();
  const { client, view: connection } = useHostConnection();
  const vertexAvailable =
    connection.status === 'connected' && connection.hello.features.google_vertex === true;
  const [view, setView] = useState<View>({ kind: 'list' });
  const [notice, setNotice] = useState<Notice>();
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [removing, setRemoving] = useState<ProviderProfile>();
  const [catalogOpen, setCatalogOpen] = useState(false);

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
  const providers = data.providers.filter(isEditableProvider);
  const takenIds = data.providers.map((provider) => provider.id);
  const sessions = data.workspaces.flatMap((entry) => entry.sessions);

  const saved = async (outcome: SaveOutcome) => {
    await store?.refresh();
    setView({ kind: 'list' });
    if (outcome.connectionChanged) setTests(({ [outcome.id]: _stale, ...rest }) => rest);
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
    // 只在新建或改了 Key、地址、协议、默认模型时自动测一次（一次最小请求）；只改名称不发请求。
    if (outcome.hasSecret && outcome.connectionChanged) void runTest(outcome.id);
  };

  if (view.kind === 'form' && client) {
    return (
      <ProviderEditor
        client={client}
        initial={view.form}
        takenIds={takenIds}
        onSaved={saved}
        onCancel={() => setView({ kind: 'list' })}
      />
    );
  }

  /** 在“模型服务”对话框里选了一项：DeepSeek 官方只能有一个，已有就编辑它。 */
  const pick = (entry: CatalogEntry) => {
    setCatalogOpen(false);
    const source = entry.source;
    if (!source || (entry.id === 'google-vertex' && !vertexAvailable)) return;
    if (source.kind === 'deepseek-official') {
      const existing = providers.find((provider) => provider.id === DEEPSEEK_OFFICIAL_ID);
      setView({ kind: 'form', form: existing ? editForm(existing) : newDeepSeekForm() });
      return;
    }
    setView({
      kind: 'form',
      form: newOpenAIForm(source.kind === 'preset' ? source.preset : undefined, takenIds),
    });
  };

  return (
    <div>
      {!client && (
        <div className="mb-6">
          <NoticeBanner notice={{ tone: 'info', text: t('settings.noHost') }} />
        </div>
      )}
      <SourceSummary providers={data.providers} />
      <SettingsSection title={t('provider.section.subscriptions')}>
        <SubscriptionSources client={client} providers={data.providers} />
      </SettingsSection>
      <SettingsSection
        title={t('provider.section.keyed')}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setNotice(undefined);
              setCatalogOpen(true);
            }}
            disabled={!client}
            data-action="add-provider"
          >
            <Plus data-icon="inline-start" />
            {t('provider.add')}
          </Button>
        }
      >
        {notice && (
          <div className="mb-3">
            <NoticeBanner notice={notice} />
          </div>
        )}
        {providers.length === 0 ? (
          <EmptyList>{t('provider.emptyKeyed')}</EmptyList>
        ) : (
          <ul className={LIST_CARD}>
            {providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                test={tests[provider.id]}
                disabled={!client}
                canToggle={client?.supports('provider_enabled') === true}
                onToggle={async (enabled) => {
                  if (!client) return;
                  try {
                    await client.request('provider.setEnabled', {
                      providerId: provider.id,
                      enabled,
                    });
                    await store?.refresh();
                  } catch (error) {
                    setNotice({ tone: 'error', text: describe(error) });
                  }
                }}
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
      </SettingsSection>
      <ProviderCatalogDialog
        vertexAvailable={vertexAvailable}
        open={catalogOpen}
        onOpenChange={setCatalogOpen}
        onSelect={pick}
      />
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
  canToggle,
  onToggle,
  onTest,
  onEdit,
  onRemove,
}: {
  provider: EditableProvider;
  test: TestState | undefined;
  disabled: boolean;
  canToggle: boolean;
  onToggle: (enabled: boolean) => Promise<void>;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const running = test?.status === 'running';
  const [toggling, setToggling] = useState(false);
  const enabled = provider.enabled !== false;
  const host =
    provider.kind === 'google-vertex'
      ? `${provider.vertex?.project ?? ''} / ${provider.vertex?.location ?? 'global'}`
      : provider.baseURL
        ? safeHost(provider.baseURL)
        : t('provider.baseURLOfficial');
  return (
    <li className="group/provider px-4 py-3" data-provider-id={provider.id}>
      <div className="flex items-center gap-3.5">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background inset-well transition-opacity duration-150',
            !enabled && 'opacity-50',
          )}
        >
          <ProviderLogo logo={providerLogo(provider)} fallback={provider.displayName} />
        </span>
        <div
          className={cn('min-w-0 flex-1 transition-opacity duration-150', !enabled && 'opacity-60')}
        >
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-medium">{provider.displayName}</h3>
            <span
              className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
              data-key-status
            >
              <StatusDot tone={provider.hasSecret ? 'success' : 'warning'} className="size-1.5" />
              {provider.hasSecret ? t('provider.key.set') : t('provider.key.unset')}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            <span className="font-mono">{provider.defaultModelId}</span>
            {provider.models.length > 1 &&
              ` · ${t('provider.modelCount', { count: provider.models.length })}`}
            {` · ${host}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={onTest}
            disabled={disabled || running}
            data-action="test-provider"
          >
            {running && <LoaderCircle className="animate-spin" data-icon="inline-start" />}
            {running ? t('provider.testing') : t('provider.test')}
          </Button>
          <IconButton label={t('provider.edit')} onClick={onEdit} disabled={disabled}>
            <Pencil />
          </IconButton>
          <IconButton label={t('provider.remove')} onClick={onRemove} disabled={disabled}>
            <Trash2 />
          </IconButton>
          {canToggle && (
            <Switch
              className="ml-2"
              checked={enabled}
              label={t('provider.enabled', { name: provider.displayName })}
              disabled={disabled || toggling}
              onChange={(next) => {
                setToggling(true);
                void onToggle(next).finally(() => setToggling(false));
              }}
              data-action="toggle-provider"
            />
          )}
        </div>
      </div>
      {test?.status === 'done' && <TestResultView result={test.result} />}
    </li>
  );
}

/**
 * 页面顶上的一行（0.19.0）：模型选择里现在能选的来源叠成一排标志，旁边写“可选多少个模型、来自几个来源”。没有可选的来源时
 * 不画。
 */
function SourceSummary({ providers }: { providers: readonly ProviderProfile[] }) {
  const accounts = useAccounts();
  const pickable = pickerOrder(providers.filter((provider) => isPickable(provider, accounts)));
  if (pickable.length === 0) return null;
  const models = pickable.reduce((sum, provider) => sum + modelsOf(provider).length, 0);
  return (
    <div className="mb-8 flex items-center gap-3" data-source-summary>
      <span className="flex -space-x-1.5">
        {pickable.slice(0, 6).map((provider) => {
          const source = sourceOf(provider);
          return (
            <span
              key={provider.id}
              className="flex size-7 items-center justify-center rounded-full border border-border bg-card shadow-xs ring-2 ring-background"
              title={source ? t(source.name) : provider.displayName}
            >
              <ProviderLogo
                logo={source?.logo ?? providerLogo(provider)}
                fallback={provider.displayName}
                className="size-3.5"
              />
            </span>
          );
        })}
      </span>
      <p className="text-sm text-muted-foreground">
        {t('provider.summary', { models, sources: pickable.length })}
      </p>
    </div>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function TestResultView({ result }: { result: TestPresentation }) {
  const Icon = result.ok ? CircleCheck : CircleX;
  return (
    <div
      role="status"
      data-test-result={result.ok ? 'ok' : 'failed'}
      className={cn(
        'mt-3 ml-12.5 flex gap-2 rounded-lg px-3 py-2 text-sm animate-in fade-in slide-in-from-top-1',
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
