// 插件页（0.42.0，docs/architecture/desktop-layout.md §23、desktop-tokens.md §52）：主窗格里的一列，顶上是分段切换与“添加”，下面是
// 当前分段的列表；整页是拖放区。数据是 `plugins.list`（use-plugins.ts），各组件经 PluginsContext 取用。

import type { WevirClient } from '@wevir/client-sdk';
import type { Connector, HostFeatures } from '@wevir/protocol';
import { Plus } from 'lucide-react';
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { type PluginsTab, paths } from '@/routes/paths';
import { type Notice, NoticeBanner, Segmented } from '@/settings/settings-ui';
import { AddDialog, type AddRequest } from './add-dialog';
import { ConnectorDialog, type ConnectorDialogRequest } from './connector-dialog';
import { ConnectorList } from './connector-list';
import { PluginList } from './plugin-list';
import { PluginsContext, type PluginsContextValue } from './plugins-context';
import { pluginsById, visibleTabs } from './plugins-model';
import { SkillList } from './skill-list';
import { usePlugins } from './use-plugins';

export function PluginsPage({
  tab,
  client,
  features,
}: {
  tab: PluginsTab;
  client: WevirClient;
  features: HostFeatures;
}) {
  const navigate = useNavigate();
  const data = usePlugins();
  const [notice, setNotice] = useState<Notice>();
  // 每个分段各自展开的一行。
  const [expanded, setExpanded] = useState<Partial<Record<PluginsTab, string>>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [add, setAdd] = useState<AddRequest | null>(null);
  const [connector, setConnector] = useState<ConnectorDialogRequest | null>(null);
  const [dragging, setDragging] = useState(false);
  const requests = useRef(0);
  const state = data.state;

  // 换分段时收起上一个分段的结果通知。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换分段时触发。
  useEffect(() => setNotice(undefined), [tab]);

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
          }
        : undefined,
    [client, state, data, busy, run, navigate],
  );

  const openAdd = (init: Omit<AddRequest, 'id'> = {}) => {
    setNotice(undefined);
    setAdd({ id: ++requests.current, ...init });
  };
  const onAddClick = () => (tab === 'connectors' ? setConnector({ kind: 'add' }) : openAdd());

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
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-180 px-5 pt-6 pb-16 sm:px-10">
          <div className="mb-5 flex items-center justify-between gap-3">
            <Segmented<PluginsTab>
              label={t('plugins.tabs')}
              value={tab}
              onChange={(next) => navigate(paths.plugins(next), { replace: true })}
              options={tabs.map((value) => ({ value, label: t(`plugins.tab.${value}`) }))}
            />
            <Button onClick={onAddClick} disabled={context === undefined} data-action="add">
              <Plus data-icon="inline-start" />
              {t('plugins.add')}
            </Button>
          </div>
          {notice && (
            <div className="mb-4" data-testid="plugins-notice">
              <NoticeBanner notice={notice} />
            </div>
          )}
          {state.status === 'loading' && (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          )}
          {state.status === 'error' && (
            <NoticeBanner
              notice={{
                tone: 'error',
                text: t('plugins.loadFailed', { error: describe(state.error) }),
              }}
            />
          )}
          {context && (
            <PluginsContext value={context}>
              {tab === 'plugins' && <PluginList expanded={expanded.plugins} onExpand={expand} />}
              {tab === 'connectors' && (
                <ConnectorList expanded={expanded.connectors} onExpand={expand} />
              )}
              {tab === 'skills' && <SkillList expanded={expanded.skills} onExpand={expand} />}
              <AddDialog
                request={add}
                packages={tabs.includes('plugins')}
                onClose={() => setAdd(null)}
              />
              <ConnectorDialog request={connector} onClose={() => setConnector(null)} />
            </PluginsContext>
          )}
        </div>
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
