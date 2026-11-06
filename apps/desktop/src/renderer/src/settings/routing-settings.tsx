import { type EventSubscription, hostSupports } from '@wevir/client-sdk';
import { DEFAULT_HOST_SETTINGS, type MethodResult, type RoutingSettings } from '@wevir/protocol';
import { cn } from 'cn';
import { ArrowDown, ArrowRight, GripVertical, Plus, Trash2 } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { QuotaNode } from '@/components/quota-node';
import { Switch } from '@/components/switch';
import { Button, buttonVariants } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useHostSettings } from '@/data/host-settings';
import { pickerOrder, sourceOf, sourceTitle } from '@/data/sources';
import { useAccounts, useWorkbenchData } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { paths } from '@/routes/paths';
import { modelLabel } from '@/session/handoff-model';
import { ModelList } from '@/session/model-picker';
import { lastChoice, resolveChoice } from '@/session/start-session';
import { useNow } from '@/session/use-now';
import {
  isRoutingSwitch,
  moveRoutingNode,
  type RoutingNode,
  routingMenuProviders,
  routingNodes,
  routingReason,
} from './routing-model';
import {
  LIST_CARD,
  NoticeBanner,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
} from './settings-ui';

type Decisions = MethodResult<'routing.decisions'>;
type Decision = Decisions['decisions'][number];

export function RoutingSettingsPage() {
  const { view } = useHostConnection();
  const host = useHostSettings();
  const data = useWorkbenchData();
  const accounts = useAccounts();
  const stored = lastChoice.use();
  const now = useNow(15_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dragged, setDragged] = useState<number>();
  const [drop, setDrop] = useState<number>();
  const routing = host.settings.routing ?? (DEFAULT_HOST_SETTINGS.routing as RoutingSettings);
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'usage_limit_routing');
  if (data.status !== 'ready') return <SettingsLoading data={data} />;
  const providers = pickerOrder(data.providers);
  const pickable = routingMenuProviders(providers, accounts);
  const current = resolveChoice(pickable, stored);
  // 同订阅段的顺序以 Host 的 provider.list 为准，模型菜单的品牌排序只用于选择。
  const nodes = routingNodes(data.providers, accounts, current, routing, now);
  const next = routing.enabled
    ? nodes.findIndex((node) => node.section !== 'current' && !node.reason)
    : -1;
  const editable = supported && host.editable && !busy;
  const save = async (patch: Partial<RoutingSettings>) => {
    setBusy(true);
    setError(undefined);
    try {
      await host.update({ routing: { ...routing, ...patch } });
    } catch (reason) {
      setError(t('routing.failed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
  const updateNode = (node: RoutingNode, patch: Partial<RoutingSettings['chain'][number]>) => {
    const chain =
      node.chainIndex === undefined
        ? [...routing.chain, { providerId: node.providerId, ...patch }]
        : routing.chain.map((entry, index) =>
            index === node.chainIndex ? { ...entry, ...patch } : entry,
          );
    void save({ chain });
  };
  const move = (from: number, to: number) => {
    setDragged(undefined);
    setDrop(undefined);
    const chain = moveRoutingNode(routing.chain, from, to);
    if (chain !== routing.chain) void save({ chain });
  };
  const backups = nodes.filter((node) => node.section === 'backup');
  return (
    <div data-testid="routing-settings" data-enabled={routing.enabled}>
      {error && (
        <div className="mb-3">
          <NoticeBanner notice={{ tone: 'error', text: error }} />
        </div>
      )}
      <SettingsSection>
        <div className={LIST_CARD}>
          <SettingsRow
            title={t('routing.enabled')}
            control={
              <Switch
                label={t('routing.enabled')}
                checked={routing.enabled}
                disabled={!editable}
                onChange={(enabled) => void save({ enabled })}
                data-action="routing-toggle"
              />
            }
          />
          <SettingsRow
            title={t('routing.preferReset')}
            control={
              <Switch
                label={t('routing.preferReset')}
                checked={routing.preferSoonestReset}
                disabled={!editable}
                onChange={(preferSoonestReset) => void save({ preferSoonestReset })}
                data-action="routing-reset"
              />
            }
          />
        </div>
      </SettingsSection>
      <SettingsSection
        title={t('routing.chain')}
        action={
          <RoutingModelMenu
            providers={pickable}
            value={current}
            disabled={!editable}
            label={t('routing.add')}
            onChoose={(providerId, modelId) => {
              const existing = routing.chain.findIndex(
                (node) => node.providerId === providerId && node.modelId === modelId,
              );
              if (existing < 0) void save({ chain: [...routing.chain, { providerId, modelId }] });
            }}
            add
          />
        }
      >
        <div className="@container">
          <ol
            className="flex flex-col pb-2 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] @min-[42rem]:flex-row @min-[42rem]:items-stretch @min-[42rem]:overflow-x-auto"
            aria-label={t('routing.chain')}
            data-testid="routing-chain"
          >
            {nodes.map((node, index) => {
              const backupIndex = backups.indexOf(node);
              const canDrag = editable && node.section === 'backup';
              return (
                <Fragment key={node.key}>
                  {index > 0 && (
                    <li
                      aria-hidden
                      className={cn(
                        'flex shrink-0 items-center justify-center gap-1 py-2 text-muted-foreground @min-[42rem]:w-12 @min-[42rem]:flex-col @min-[42rem]:px-1',
                        next > 0 &&
                          index <= next &&
                          nodes.slice(0, index).some((node) => node.reason === 'exhausted') &&
                          'text-running',
                      )}
                      data-next-hop={index === next || undefined}
                    >
                      <ArrowDown className="size-4 @min-[42rem]:hidden" />
                      <ArrowRight className="hidden size-4 @min-[42rem]:block" />
                      {index === next && (
                        <span className="text-center text-[0.625rem] leading-tight">
                          {t('routing.next')}
                        </span>
                      )}
                    </li>
                  )}
                  <li
                    className={cn(
                      'min-w-0 rounded-xl transition-[opacity,box-shadow] duration-150 @min-[42rem]:w-56 @min-[42rem]:shrink-0',
                      dragged === node.chainIndex && dragged !== undefined && 'opacity-50',
                      drop === node.chainIndex && drop !== undefined && 'ring-1 ring-running',
                    )}
                    data-routing-node={node.providerId}
                    data-chain-index={node.chainIndex}
                    data-section={node.section}
                    onDragOver={(event) => {
                      if (!canDrag || dragged === undefined) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      setDrop(node.chainIndex);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (canDrag && dragged !== undefined && node.chainIndex !== undefined)
                        move(dragged, node.chainIndex);
                    }}
                  >
                    <QuotaNode
                      provider={node.provider}
                      providerId={node.providerId}
                      modelId={node.modelId}
                      accounts={accounts}
                      now={now}
                      reason={node.reason}
                      heading={
                        <>
                          <span>
                            {t(
                              node.section === 'current'
                                ? 'routing.current'
                                : node.section === 'account'
                                  ? 'routing.account'
                                  : 'routing.backup',
                            )}
                          </span>
                          {node.section === 'backup' && (
                            <button
                              type="button"
                              aria-label={t('routing.reorder')}
                              disabled={!editable}
                              draggable={canDrag}
                              data-action="routing-drag"
                              className="cursor-grab rounded-sm p-1 outline-none hover:bg-muted focus-visible:focus-ring active:cursor-grabbing disabled:opacity-50"
                              onDragStart={(event) => {
                                event.dataTransfer.setData(
                                  'application/x-wevir-routing-node',
                                  String(node.chainIndex),
                                );
                                event.dataTransfer.effectAllowed = 'move';
                                setDragged(node.chainIndex);
                              }}
                              onDragEnd={() => {
                                setDragged(undefined);
                                setDrop(undefined);
                              }}
                              onKeyDown={(event) => {
                                const delta =
                                  event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                                    ? -1
                                    : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                                      ? 1
                                      : 0;
                                if (!delta) return;
                                event.preventDefault();
                                const target = backups[backupIndex + delta];
                                if (
                                  node.chainIndex !== undefined &&
                                  target?.chainIndex !== undefined
                                )
                                  move(node.chainIndex, target.chainIndex);
                              }}
                            >
                              <GripVertical aria-hidden className="size-3.5" />
                            </button>
                          )}
                        </>
                      }
                      controls={
                        <>
                          <RoutingModelMenu
                            providers={
                              node.section === 'current'
                                ? routingMenuProviders(providers, accounts, node.providerId)
                                : providers.filter((provider) => provider.id === node.providerId)
                            }
                            value={node}
                            disabled={!editable || !node.provider}
                            label={t('routing.model')}
                            onChoose={(providerId, modelId) => {
                              if (node.section === 'current')
                                lastChoice.set({ providerId, modelId });
                              else updateNode(node, { modelId });
                            }}
                          />
                          {node.section !== 'current' && (
                            <>
                              <Switch
                                label={t('routing.node.enabled')}
                                checked={node.enabled}
                                disabled={!editable}
                                onChange={(enabled) => updateNode(node, { enabled })}
                                data-action="routing-node-toggle"
                              />
                              {node.section === 'backup' && (
                                <IconButton
                                  label={t('routing.remove')}
                                  size="icon-xs"
                                  disabled={!editable}
                                  data-action="routing-remove"
                                  onClick={() =>
                                    void save({
                                      chain: routing.chain.filter(
                                        (_, index) => index !== node.chainIndex,
                                      ),
                                    })
                                  }
                                >
                                  <Trash2 />
                                </IconButton>
                              )}
                            </>
                          )}
                        </>
                      }
                    />
                  </li>
                </Fragment>
              );
            })}
          </ol>
          {nodes.length === 0 && (
            <p className="py-6 text-sm text-muted-foreground">{t('routing.empty')}</p>
          )}
        </div>
      </SettingsSection>
      <RecentDecisions supported={supported} />
    </div>
  );
}

function RoutingModelMenu({
  providers,
  value,
  disabled,
  label,
  onChoose,
  add,
}: {
  providers: Parameters<typeof ModelList>[0]['providers'];
  value: Parameters<typeof ModelList>[0]['value'] | undefined;
  disabled: boolean;
  label: string;
  onChoose(providerId: string, modelId: string): void;
  add?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        className={buttonVariants({ size: 'xs', variant: 'ghost' })}
        data-action={add ? 'routing-add' : 'routing-model'}
      >
        {add && <Plus aria-hidden />}
        {label}
      </PopoverTrigger>
      <PopoverContent className="w-72 gap-0 p-0" align="end" sideOffset={6}>
        <ModelList
          providers={providers}
          locked={() => false}
          value={value ?? { providerId: '', modelId: '' }}
          onChoose={(providerId, model) => {
            setOpen(false);
            onChoose(providerId, model.id);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function RecentDecisions({ supported }: { supported: boolean }) {
  const { client } = useHostConnection();
  const data = useWorkbenchData();
  const accounts = useAccounts();
  const navigate = useNavigate();
  const [page, setPage] = useState<Decisions>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const subscription = useRef<EventSubscription>(undefined);
  useEffect(() => () => subscription.current?.close(), []);
  useEffect(() => {
    if (!client || !supported) return;
    let active = true;
    let order = 0;
    const read = () => {
      const request = ++order;
      void client.request('routing.decisions', { limit: 20 }).then(
        (result) => {
          if (active && order === request) {
            setPage(result);
            setError(undefined);
          }
        },
        (reason: unknown) => {
          if (active && order === request)
            setError(t('routing.readFailed', { error: describe(reason) }));
        },
      );
    };
    read();
    const off = client.onSessionsChanged(read);
    window.addEventListener('focus', read);
    return () => {
      active = false;
      off();
      window.removeEventListener('focus', read);
    };
  }, [client, supported]);
  if (data.status !== 'ready') return null;
  const providers = data.providers;
  const sessions = new Map(
    data.workspaces.flatMap((entry) =>
      entry.sessions.map((session) => [session.id, session] as const),
    ),
  );
  const open = async (decision: Decision) => {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    try {
      const { session } = await client.request('session.get', { sessionId: decision.sessionId });
      let seq = decision.seq;
      if (decision.to) {
        const feed = client.subscribe(decision.sessionId, {
          sinceSeq: decision.seq,
          elideSuperseded: true,
        });
        subscription.current = feed;
        try {
          for await (const item of feed) {
            if (item.type === 'caught_up') break;
            if (item.type === 'event' && isRoutingSwitch(item.event, decision)) {
              seq = item.event.seq;
              break;
            }
          }
        } finally {
          feed.close();
          subscription.current = undefined;
        }
      }
      void navigate(paths.sessionAt(session.workspaceId, session.id, seq));
    } catch (reason) {
      setError(t('routing.openFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
  const more = async () => {
    if (!client || !page?.nextCursor) return;
    setBusy(true);
    try {
      const result = await client.request('routing.decisions', {
        cursor: page.nextCursor,
        limit: 20,
      });
      setPage({ ...result, decisions: [...page.decisions, ...result.decisions] });
    } catch (reason) {
      setError(t('routing.readFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection title={t('routing.decisions')} data-testid="routing-decisions">
      {error && <NoticeBanner notice={{ tone: 'error', text: error }} />}
      {!page && !error && (
        <p className="py-4 text-sm text-muted-foreground">{t('common.loading')}</p>
      )}
      {page?.decisions.length === 0 && (
        <p className="py-4 text-sm text-muted-foreground">{t('routing.decisions.empty')}</p>
      )}
      <ul className="divide-y divide-border">
        {page?.decisions.map((decision) => (
          <li key={`${decision.sessionId}:${decision.seq}`}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void open(decision)}
              data-decision-seq={decision.seq}
              className="block w-full rounded-lg px-1 py-3 text-left outline-none hover:bg-muted/50 focus-visible:focus-ring disabled:opacity-50"
            >
              <span className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
                <span className="truncate text-sm text-foreground">
                  {sessions.get(decision.sessionId)?.title || decision.sessionId}
                </span>
                <time className="shrink-0 tabular-nums" dateTime={decision.at}>
                  {new Date(decision.at).toLocaleString(currentLocale(), {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-soft-foreground">
                <span>
                  {modelLabel(providers, decision.from.providerId, decision.from.modelId, accounts)}
                </span>
                <ArrowRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span>
                  {decision.to
                    ? modelLabel(providers, decision.to.providerId, decision.to.modelId, accounts)
                    : t('routing.noTarget')}
                </span>
              </span>
              {decision.skipped.length > 0 && (
                <span className="mt-1.5 block text-xs text-muted-foreground">
                  {t('handoff.detail.skipped')}
                  {t('common.colon')}
                  {decision.skipped
                    .map((skip) => {
                      const provider = providers.find(
                        (provider) => provider.id === skip.providerId,
                      );
                      const source = provider && sourceOf(provider);
                      const name = provider
                        ? source
                          ? sourceTitle(provider, accounts, t(source.name))
                          : provider.displayName
                        : skip.providerId;
                      return `${name} · ${routingReason(skip.reason)}`;
                    })
                    .join(t('common.listSeparator'))}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {page?.nextCursor && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void more()}>
          {t('routing.decisions.more')}
        </Button>
      )}
    </SettingsSection>
  );
}
