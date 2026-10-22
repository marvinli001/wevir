// 插件页（0.42.0，docs/architecture/desktop-layout.md §23、desktop-tokens.md §52；市场分段见 plugin-market.md §9）：主窗格里的一列，
// 顶行是页标题与右边的操作（市场分段的搜索、刷新、齿轮，各分段共用的“添加”下拉），下面是分段切换与当前分段；市场的分组列表与
// 条目详情各占整页。整页是拖放区。数据是 `plugins.list`（use-plugins.ts）与 `market.index`（market/use-market.ts）。

import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import type { Connector, HostFeatures } from '@wevir/protocol';
import { ChevronDown, FileUp, Import, Server } from 'lucide-react';
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useWorkbenchData } from '@/data/workbench-data';
import { chatsOf, projectsOf } from '@/data/workbench-model';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { workspaceLabel } from '@/projects/chats';
import { type PluginsTab, paths } from '@/routes/paths';
import { type Notice, NoticeBanner, Segmented } from '@/settings/settings-ui';
import { AddDialog, type AddRequest } from './add-dialog';
import { ConnectorDialog, type ConnectorDialogRequest } from './connector-dialog';
import { ConnectorList } from './connector-list';
import { signInConnector } from './connector-login';
import { rememberPluginsTab } from './last-tab';
import { MarketInstallContext, type MarketInstallContextValue } from './market/install-button';
import { MarketEntryPage } from './market/market-entry-page';
import { MarketGroupPage, MarketHome, MarketToolbar } from './market/market-tab';
import { useMarket, useMarketSource } from './market/use-market';
import { removePlugin } from './plugin-actions';
import { PluginList } from './plugin-list';
import { PluginsContext, type PluginsContextValue } from './plugins-context';
import { pluginSignIn, pluginsById, visibleTabs } from './plugins-model';
import { SkillList } from './skill-list';
import { usePlugins } from './use-plugins';

/** 市场分段里占整页的视图：一个分组的完整列表，或一个条目的详情。 */
export type MarketView =
  | { kind: 'group'; groupId: string }
  | { kind: 'entry'; source: string; entry: string };

export function PluginsPage({
  tab,
  market,
  client,
  features,
}: {
  tab: PluginsTab;
  market?: MarketView;
  client: WevirClient;
  features: HostFeatures;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const data = usePlugins();
  const marketSource = useMarketSource(client);
  const marketData = useMarket(tab === 'market' ? marketSource : undefined);
  // 搜索词放在地址里（`?q=`），进详情再返回时还在。
  const [search, setSearch] = useSearchParams();
  const query = search.get('q') ?? '';
  const setQuery = (next: string) =>
    setSearch(next === '' ? {} : { q: next }, { replace: true, preventScrollReset: true });
  const workbench = useWorkbenchData();
  const scoped = hostSupports(features, 'external_import');
  const workspaces = useMemo(() => {
    if (workbench.status !== 'ready') return [];
    const chats = chatsOf(workbench.workspaces);
    return [...projectsOf(workbench.workspaces), ...(chats === undefined ? [] : [chats])].map(
      (entry) => ({ id: entry.workspace.id, label: workspaceLabel(entry.workspace) }),
    );
  }, [workbench]);
  const [notice, setNotice] = useState<Notice>();
  // 每个分段各自展开的一行。
  const [expanded, setExpanded] = useState<Partial<Record<PluginsTab, string>>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [add, setAdd] = useState<AddRequest | null>(null);
  const [connector, setConnector] = useState<ConnectorDialogRequest | null>(null);
  const [dragging, setDragging] = useState(false);
  const requests = useRef(0);
  const state = data.state;

  // 换分段时收起上一个分段的结果通知，并记下分段（左栏的入口下次沿用它）。
  useEffect(() => {
    setNotice(undefined);
    rememberPluginsTab(tab);
  }, [tab]);

  const run = useCallback<PluginsContextValue['run']>((id, task, failure) => {
    setBusy((current) => new Set(current).add(id));
    task()
      .catch((reason: unknown) => setNotice({ tone: 'error', text: failure(describe(reason)) }))
      .finally(() =>
        setBusy((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        }),
      );
  }, []);

  const context = useMemo<PluginsContextValue | undefined>(
    () =>
      state.status === 'ready'
        ? {
            client,
            list: state.list,
            plugins: pluginsById(state.plugins),
            data,
            busy,
            run,
            notify: setNotice,
            openPlugin: (pluginId) => {
              setExpanded((current) => ({ ...current, plugins: pluginId }));
              navigate(paths.plugins('plugins'), { replace: true });
            },
            editConnector: (target: Connector) => setConnector({ kind: 'edit', connector: target }),
            scoped,
            workspaces,
          }
        : undefined,
    [client, state, data, busy, run, navigate, scoped, workspaces],
  );

  // 市场的安装按钮：已装的插件 id，装好后重读列表（0.99.0）；要登录的 OAuth 连接器（0.97.0）。
  const installed = useMemo(
    () => new Set(state.status === 'ready' ? state.plugins.map((plugin) => plugin.id) : []),
    [state],
  );
  const signIns = useMemo(() => {
    const result = new Map<string, Connector>();
    if (state.status !== 'ready') return result;
    for (const plugin of state.plugins) {
      const connector = pluginSignIn(plugin, state.list);
      if (connector) result.set(plugin.id, connector);
    }
    return result;
  }, [state]);
  const marketInstall = useMemo<MarketInstallContextValue>(() => {
    const signIn = (connector: Connector) =>
      void signInConnector(client, connector).catch((reason: unknown) =>
        setNotice({
          tone: 'error',
          text: t('plugins.connector.signIn.failed', { error: describe(reason) }),
        }),
      );
    return {
      source: marketSource,
      installed,
      afterInstall: data.refresh,
      signIns,
      signIn,
      signInAfterInstall: (pluginId) =>
        void client.request('plugins.list').then(
          (list) => {
            const plugin = list.plugins?.find((item) => item.id === pluginId);
            const connector = plugin && pluginSignIn(plugin, list);
            if (connector && connector.oauth?.status !== 'signing_in') signIn(connector);
          },
          () => {},
        ),
      uninstall: (pluginId) => removePlugin(client, data, { id: pluginId }),
      notify: setNotice,
    };
  }, [client, marketSource, installed, signIns, data]);

  const openAdd = (init: Omit<AddRequest, 'id'> = {}) => {
    setNotice(undefined);
    setAdd({ id: ++requests.current, ...init });
  };

  // 拖放：拖进文件夹、.zip 或 SKILL.md 等于点“添加”选了它，只认一项；对话框开着时不再接。
  const acceptsDrop = context !== undefined && add === null && connector === null;
  const onDragOver = (event: DragEvent) => {
    if (!acceptsDrop || !Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };
  const onDragLeave = (event: DragEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    setDragging(false);
    if (!acceptsDrop || !Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => window.wevir.getPathForFile(file))
      .filter((path) => path !== '');
    if (paths.length === 0) return;
    if (paths.length > 1) openAdd({ error: t('plugins.add.multiple') });
    else openAdd({ path: paths[0] as string });
  };

  const tabs = visibleTabs(features);
  const expand = (id: string | undefined) => setExpanded((current) => ({ ...current, [tab]: id }));

  const lists = context && (
    <PluginsContext value={context}>
      {tab === 'plugins' && <PluginList expanded={expanded.plugins} onExpand={expand} />}
      {tab === 'connectors' && <ConnectorList expanded={expanded.connectors} onExpand={expand} />}
      {tab === 'skills' && <SkillList expanded={expanded.skills} onExpand={expand} />}
      <AddDialog request={add} packages={tabs.includes('plugins')} onClose={() => setAdd(null)} />
      <ConnectorDialog request={connector} onClose={() => setConnector(null)} />
    </PluginsContext>
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 拖放只是“添加”按钮的快捷方式，键盘与读屏走按钮。
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-testid="plugins-page"
      data-tab={tab}
      data-market-view={market?.kind}
    >
      <ScrollArea className="min-h-0 flex-1">
        <MarketInstallContext value={marketInstall}>
          <div className="mx-auto w-full max-w-240 px-5 pt-6 pb-16 sm:px-10">
            {notice && market !== undefined && (
              <div className="mb-4" data-testid="plugins-notice">
                <NoticeBanner notice={notice} />
              </div>
            )}
            {market?.kind === 'group' && (
              <MarketGroupPage data={marketData} source={marketSource} groupId={market.groupId} />
            )}
            {market?.kind === 'entry' && (
              <MarketEntryPage
                data={marketData}
                source={marketSource}
                sourceId={market.source}
                entryId={market.entry}
                onCopied={() => setNotice({ tone: 'success', text: t('plugins.market.copied') })}
              />
            )}
            {market === undefined && (
              <>
                <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                  <h1 className="text-xl font-semibold">{t('plugins.title')}</h1>
                  <div className="flex min-w-0 items-center gap-2">
                    {tab === 'market' && (
                      <MarketToolbar data={marketData} query={query} onQuery={setQuery} />
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button disabled={context === undefined} data-action="add">
                            {t('plugins.add')}
                            <ChevronDown data-icon="inline-end" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem onClick={() => openAdd()} data-action="add-file">
                          <FileUp />
                          {t('plugins.add.fromFile')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setConnector({ kind: 'add' })}
                          data-action="add-connector"
                        >
                          <Server />
                          {t('plugins.add.connector')}
                        </DropdownMenuItem>
                        {scoped && (
                          <DropdownMenuItem
                            onClick={() =>
                              navigate(paths.settings('import'), { state: { from: location } })
                            }
                            data-action="add-import"
                          >
                            <Import />
                            {t('plugins.add.import')}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                <div className="mb-5">
                  <Segmented<PluginsTab>
                    label={t('plugins.tabs')}
                    value={tab}
                    onChange={(next) => navigate(paths.plugins(next), { replace: true })}
                    options={tabs.map((value) => ({ value, label: t(`plugins.tab.${value}`) }))}
                  />
                </div>
                {notice && (
                  <div className="mb-4" data-testid="plugins-notice">
                    <NoticeBanner notice={notice} />
                  </div>
                )}
                {tab === 'market' && (
                  <MarketHome data={marketData} source={marketSource} query={query} />
                )}
                {tab !== 'market' && state.status === 'loading' && (
                  <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
                )}
                {tab !== 'market' && state.status === 'error' && (
                  <NoticeBanner
                    notice={{
                      tone: 'error',
                      text: t('plugins.loadFailed', { error: describe(state.error) }),
                    }}
                  />
                )}
              </>
            )}
            {/* 列表只在三个已安装分段里画；两个对话框在市场里也要（“添加”下拉）。 */}
            {lists}
          </div>
        </MarketInstallContext>
      </ScrollArea>
      {dragging && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-border-strong bg-background/80 text-sm text-muted-foreground animate-in fade-in duration-150"
          data-testid="plugins-drop"
        >
          {t('plugins.drop')}
        </div>
      )}
    </div>
  );
}
