import { SlidersHorizontal } from 'lucide-react';
import { Navigate, useLocation, useParams } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { resolveTuningTab, tuningAvailability } from '@/tuning/tuning-model';
import { TuningPage } from '@/tuning/tuning-page';
import { CenterPage } from './center-page';
import { paths } from './paths';
import { PendingPage } from './route-states';

/**
 * `/tuning` 与 `/tuning/:tab`（0.85.0，desktop-layout.md §34）：同插件页，Host 没有 `tuning` 功能时是空状态；分段认不出时转到
 * 默认分段，地址里的范围与版本（`?workspace=&version=`）跟着带过去。
 */
export function TuningRoute() {
  const { tab } = useParams();
  const { search } = useLocation();
  const { client } = useHostConnection();
  const features = client?.hello.features;
  const availability = tuningAvailability(features);
  if (client === undefined || features === undefined || availability === 'pending') {
    return <PendingPage />;
  }
  if (availability === 'unsupported') {
    return (
      <CenterPage>
        <EmptyState icon={<SlidersHorizontal />} title={t('tuning.unsupported')} />
      </CenterPage>
    );
  }
  const resolved = resolveTuningTab(tab, features);
  if (resolved.redirect) return <Navigate to={`${paths.tuning(resolved.tab)}${search}`} replace />;
  return <TuningPage tab={resolved.tab} client={client} features={features} />;
}
