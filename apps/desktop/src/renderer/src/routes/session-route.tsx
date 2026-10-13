import { useParams } from 'react-router';
import { useWorkbenchData } from '@/data/workbench-data';
import { resolveRoute } from '@/data/workbench-model';
import { t } from '@/i18n';
import { DraftView, SessionView } from '@/session/session-view';
import { NotFound } from './not-found';
import { PendingPage } from './route-states';

/**
 * `/workspace/:workspaceId/session/:sessionId` 与新会话草稿 `/workspace/:workspaceId/session`。工作区与
 * 会话只按 URL 找，找不到就是“未找到”。会话视图在 session/（T5.3）。
 */
export function SessionRoute() {
  const { workspaceId = '', sessionId } = useParams();
  const target = resolveRoute(useWorkbenchData(), workspaceId, sessionId);
  switch (target.kind) {
    case 'loading':
      return <PendingPage />;
    case 'unavailable':
      return <PendingPage error={target.error} />;
    case 'workspace-not-found':
      return <NotFound message={t('notFound.workspace', { id: target.workspaceId })} />;
    case 'session-not-found':
      return <NotFound message={t('notFound.session', { id: target.sessionId })} />;
    case 'draft':
      return <DraftView entry={target.entry} />;
    case 'session':
      return <SessionView session={target.session} />;
  }
}
