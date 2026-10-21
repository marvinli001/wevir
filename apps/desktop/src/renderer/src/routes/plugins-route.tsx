import type { HostFeatures } from '@wevir/protocol';
import { Blocks } from 'lucide-react';
import { Navigate, useParams } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { getLastPluginsTab } from '@/plugins/last-tab';
import { landingTab, pluginsAvailability, resolveTab } from '@/plugins/plugins-model';
import { type MarketView, PluginsPage } from '@/plugins/plugins-page';
import { usePlugins } from '@/plugins/use-plugins';
import { CenterPage } from './center-page';
import { paths } from './paths';
import { PendingPage } from './route-states';

/**
 * `/plugins`、`/plugins/:tab` 与市场的 `/plugins/market/group/:groupId`、`/plugins/market/:source/:entry`（0.42.0，desktop-layout.md
 * §23；市场见 plugin-market.md §9）：Host 没有 `plugins` 功能时是空状态；没连上过先等；`/plugins` 按 `landingTab` 转到一个分段；
 * 分段认不出或 Host 不支持时转回 `/plugins`，URL 里不留不能用的分段。
 */
export function PluginsRoute() {
  const { tab, groupId, source, entry } = useParams();
  const { client } = useHostConnection();
  // 断线重连期间 client 还在，沿用上次 hello 的功能表，页面不跳回加载状态。
  const features = client?.hello.features;
  const availability = pluginsAvailability(features);
  if (client === undefined || features === undefined || availability === 'pending') {
    return <PendingPage />;
  }
  if (availability === 'unsupported') {
    return (
      <CenterPage>
        <EmptyState icon={<Blocks />} title={t('plugins.unsupported')} />
      </CenterPage>
    );
  }
  const market: MarketView | undefined =
    groupId !== undefined
      ? { kind: 'group', groupId }
      : source !== undefined && entry !== undefined
        ? { kind: 'entry', source, entry }
        : undefined;
  const param = market === undefined ? tab : 'market';
  if (param === undefined) return <PluginsLanding features={features} />;
  const resolved = resolveTab(param, features);
  if (resolved === undefined) return <Navigate to={paths.plugins()} replace />;
  return <PluginsPage tab={resolved} market={market} client={client} features={features} />;
}

/** `/plugins`：等 `plugins.list` 读到（看装没装过东西），再转到 `landingTab` 定的分段。 */
function PluginsLanding({ features }: { features: HostFeatures }) {
  const { state } = usePlugins();
  if (state.status === 'loading') return <PendingPage />;
  const list = state.status === 'ready' ? state.list : undefined;
  return <Navigate to={paths.plugins(landingTab(features, getLastPluginsTab(), list))} replace />;
}
