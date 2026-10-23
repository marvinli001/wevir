import type { ChannelId, SessionId } from '@wevir/protocol';
import { Bot } from 'lucide-react';
import { useParams } from 'react-router';
import { assistantsAvailability } from '@/assistants/assistants-model';
import { AssistantsPage } from '@/assistants/assistants-page';
import { EmptyState } from '@/components/empty-state';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { CenterPage } from './center-page';
import { PendingPage } from './route-states';

/** `/assistants`、`/assistants/:channelId` 与它的线程（0.120.0）：Host 没有 `channels` 功能时是空状态；没连上过先等。 */
export function AssistantsRoute() {
  const { client } = useHostConnection();
  const { channelId, sessionId } = useParams();
  // 断线重连期间 client 还在，沿用上次 hello 的功能表，页面不跳回加载状态。
  const availability = assistantsAvailability(client?.hello.features);
  if (client === undefined || availability === 'pending') return <PendingPage />;
  if (availability === 'unsupported') {
    return (
      <CenterPage>
        <EmptyState icon={<Bot />} title={t('assistants.unsupported')} />
      </CenterPage>
    );
  }
  return (
    <AssistantsPage
      client={client}
      {...(channelId !== undefined && { channelId: channelId as ChannelId })}
      {...(sessionId !== undefined && { threadId: sessionId as SessionId })}
    />
  );
}
