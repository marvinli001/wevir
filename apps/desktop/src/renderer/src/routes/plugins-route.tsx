import { Blocks } from 'lucide-react';
import { Navigate, useParams } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { pluginsAvailability, resolveTab } from '@/plugins/plugins-model';
import { PluginsPage } from '@/plugins/plugins-page';
import { CenterPage } from './center-page';
import { paths } from './paths';
import { PendingPage } from './route-states';

/**
 * `/plugins` 与 `/plugins/:tab`（0.42.0，desktop-layout.md §23）：Host 没有 `plugins` 功能时是空状态；没连上过先等；分段认不出或
 * Host 不支持（没有 `plugin_packages` 就没有“插件”分段）时转到默认分段，URL 里不留不能用的分段。
 */
export function PluginsRoute() {
  const { tab } = useParams();
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
  const resolved = resolveTab(tab, features);
  if (resolved.redirect) return <Navigate to={paths.plugins(resolved.tab)} replace />;
  return <PluginsPage tab={resolved.tab} client={client} features={features} />;
}
