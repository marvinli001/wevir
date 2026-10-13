import type { Session } from '@wevir/protocol';
import { MessagesSquare, SquarePen } from 'lucide-react';
import { useEffect } from 'react';
import { useParams } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { markSeen } from '@/data/seen-sessions';
import { useWorkbenchData } from '@/data/workbench-data';
import { resolveRoute, type WorkspaceEntry } from '@/data/workbench-model';
import { t } from '@/i18n';
import { CenterPage } from './center-page';
import { NotFound } from './not-found';
import { PendingPage } from './route-states';

/**
 * `/workspace/:workspaceId/session/:sessionId` 与新会话草稿 `/workspace/:workspaceId/session`。工作区与
 * 会话只按 URL 找，找不到就是“未找到”。骨架只有占位：消息流、审批与发送在 T5.3 接入。
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

function SessionView({ session }: { session: Session }) {
  useEffect(() => markSeen(session), [session]);
  return (
    <CenterPage footer={<Composer />}>
      <EmptyState icon={<MessagesSquare />} title={t('session.placeholderTitle')}>
        <p>{t('session.placeholderBody', { state: t(`session.state.${session.state}`) })}</p>
      </EmptyState>
    </CenterPage>
  );
}

function DraftView({ entry }: { entry: WorkspaceEntry }) {
  return (
    <CenterPage footer={<Composer />}>
      <EmptyState icon={<SquarePen />} title={t('session.draftTitle')}>
        <p>{t('session.draftBody', { workspace: entry.workspace.displayName })}</p>
        <p className="mt-1 font-mono text-sm break-all text-faint-foreground">
          {entry.workspace.rootPath}
        </p>
      </EmptyState>
    </CenterPage>
  );
}

/** 输入框的位置与尺寸占位，骨架阶段不可用。 */
function Composer() {
  return (
    <div className="rounded-xl border border-input bg-card shadow-xs">
      <Textarea
        disabled
        aria-label={t('session.composerPlaceholder')}
        placeholder={t('session.composerPlaceholder')}
        className="min-h-20 resize-none border-0 bg-transparent px-3 pt-3 text-base shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
      />
      <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
        <span className="text-xs text-faint-foreground">{t('session.composerDisabled')}</span>
        <Button size="sm" disabled>
          {t('session.send')}
        </Button>
      </div>
    </div>
  );
}
