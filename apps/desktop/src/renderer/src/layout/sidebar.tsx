import type { Session } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight, PanelLeftClose, Plus, Settings, SquarePen } from 'lucide-react';
import { Link, NavLink, useLocation, useParams } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { StatusDot, type StatusTone } from '@/components/status-dot';
import { ScrollArea } from '@/components/ui/scroll-area';
import { isUnread, useSeenSessions } from '@/data/seen-sessions';
import { useWorkbenchData } from '@/data/workbench-data';
import { type SessionMarker, sessionMarker, type WorkspaceEntry } from '@/data/workbench-model';
import { useHostConnection } from '@/host/host-connection';
import { hostIndicator } from '@/host/host-status';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { layoutPrefs, toggleWorkspace } from './layout-state';

const ROW =
  'flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-sm outline-none ' +
  'hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-sidebar-ring/50';

/** 左栏：标题与收起按钮、“工作区 → 会话”两级树、底部的设置入口与 Host 连接状态。 */
export function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  const location = useLocation();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between pr-2 pl-3.5">
        <span className="text-sm font-semibold tracking-wide">{t('app.name')}</span>
        <IconButton label={t('layout.collapseSidebar')} onClick={onCollapse} tooltipSide="bottom">
          <PanelLeftClose />
        </IconButton>
      </div>

      <div className="shrink-0 px-2 pb-1">
        <NewSessionLink />
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between pr-2 pl-3.5">
        <h2 className="text-xs font-medium text-muted-foreground">{t('sidebar.workspaces')}</h2>
        <IconButton
          label={t('sidebar.addWorkspace')}
          size="icon-xs"
          nativeButton={false}
          render={<Link to={paths.settings('workspaces')} state={{ from: location }} />}
        >
          <Plus />
        </IconButton>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label={t('sidebar.workspaces')} className="px-2 pb-2">
          <WorkspaceTree />
        </nav>
      </ScrollArea>

      <div className="shrink-0 space-y-0.5 border-t border-sidebar-border p-2">
        <NavLink
          to={paths.settings()}
          state={{ from: location }}
          className={({ isActive }) => cn(ROW, isActive && 'bg-sidebar-accent')}
        >
          <Settings className="size-4 text-muted-foreground" aria-hidden />
          {t('sidebar.settings')}
        </NavLink>
        <HostStatus />
      </div>
    </div>
  );
}

/** “新建会话”：进当前工作区（没有选中时是第一个工作区）的新会话草稿，草稿页里可以换工作区。 */
function NewSessionLink() {
  const data = useWorkbenchData();
  const { workspaceId } = useParams();
  if (data.status !== 'ready' || data.workspaces.length === 0) return null;
  const target =
    data.workspaces.find((entry) => entry.workspace.id === workspaceId) ?? data.workspaces[0];
  if (!target) return null;
  return (
    <Link to={paths.draft(target.workspace.id)} className={cn(ROW, 'text-sidebar-foreground')}>
      <SquarePen className="size-4 text-muted-foreground" aria-hidden />
      {t('sidebar.newSessionAny')}
    </Link>
  );
}

function WorkspaceTree() {
  const data = useWorkbenchData();
  const { collapsedWorkspaces } = layoutPrefs.use();
  const seen = useSeenSessions();

  if (data.status === 'loading') {
    return <p className="px-1.5 py-1 text-sm text-faint-foreground">{t('common.loading')}</p>;
  }
  if (data.status === 'error') {
    return (
      <p className="px-1.5 py-1 text-sm break-words text-destructive">
        {t('sidebar.loadFailed', { error: data.error })}
      </p>
    );
  }
  if (data.workspaces.length === 0) {
    return <p className="px-1.5 py-1 text-sm text-faint-foreground">{t('sidebar.noWorkspaces')}</p>;
  }
  return (
    <ul className="space-y-0.5">
      {data.workspaces.map((entry) => (
        <WorkspaceItem
          key={entry.workspace.id}
          entry={entry}
          expanded={!collapsedWorkspaces.includes(entry.workspace.id)}
          isUnread={(session) => isUnread(seen, session)}
        />
      ))}
    </ul>
  );
}

function WorkspaceItem({
  entry,
  expanded,
  isUnread,
}: {
  entry: WorkspaceEntry;
  expanded: boolean;
  isUnread: (session: Session) => boolean;
}) {
  const { workspace, sessions } = entry;
  const listId = `workspace-sessions-${workspace.id}`;
  return (
    <li>
      <div className="group/workspace flex items-center rounded-md hover:bg-sidebar-accent/60">
        <button
          type="button"
          className={cn(ROW, 'flex-1 hover:bg-transparent')}
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={t(expanded ? 'sidebar.collapseWorkspace' : 'sidebar.expandWorkspace', {
            name: workspace.displayName,
          })}
          title={workspace.rootPath}
          onClick={() => toggleWorkspace(workspace.id)}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90',
            )}
          />
          <span className="min-w-0 flex-1 truncate text-left font-medium">
            {workspace.displayName}
          </span>
        </button>
        <IconButton
          label={t('sidebar.newSession')}
          size="icon-xs"
          className="mr-1 opacity-0 group-hover/workspace:opacity-100 focus-visible:opacity-100"
          nativeButton={false}
          render={<Link to={paths.draft(workspace.id)} />}
        >
          <Plus />
        </IconButton>
      </div>
      {expanded && (
        <ul id={listId} className="space-y-0.5">
          {sessions.length === 0 ? (
            <li className="flex h-8 items-center pl-7 text-sm text-faint-foreground">
              {t('sidebar.noSessions')}
            </li>
          ) : (
            sessions.map((session) => (
              <li key={session.id}>
                <SessionRow
                  workspaceId={workspace.id}
                  session={session}
                  unread={isUnread(session)}
                />
              </li>
            ))
          )}
        </ul>
      )}
    </li>
  );
}

const MARKERS: Record<SessionMarker, { tone: StatusTone; label: string; pulse?: boolean }> = {
  running: { tone: 'accent', label: t('session.marker.running'), pulse: true },
  awaiting_approval: { tone: 'warning', label: t('session.marker.awaitingApproval') },
  error: { tone: 'danger', label: t('session.marker.error') },
};

/** 会话行：左侧状态点（运行中 / 待审批 / 出错），标题，右侧“待审批”标签或未读点。 */
function SessionRow({
  workspaceId,
  session,
  unread,
}: {
  workspaceId: string;
  session: Session;
  unread: boolean;
}) {
  const marker = sessionMarker(session);
  const markerInfo = marker && MARKERS[marker];
  return (
    <NavLink
      to={paths.session(workspaceId, session.id)}
      className={({ isActive }) =>
        cn(ROW, 'pl-6', isActive && 'bg-sidebar-accent text-sidebar-accent-foreground')
      }
    >
      <span className="flex w-4 shrink-0 justify-center">
        {markerInfo && (
          <StatusDot tone={markerInfo.tone} label={markerInfo.label} pulse={markerInfo.pulse} />
        )}
      </span>
      <span className={cn('min-w-0 flex-1 truncate', unread && 'font-semibold')}>
        {session.title || t('session.untitled')}
      </span>
      {marker === 'awaiting_approval' ? (
        <span className="shrink-0 rounded-sm bg-warning/10 px-1.5 text-xs leading-5 font-medium text-warning">
          {t('session.marker.awaitingApproval')}
        </span>
      ) : (
        unread && (
          <StatusDot tone="accent" label={t('session.marker.unread')} className="size-1.5" />
        )
      )}
    </NavLink>
  );
}

function HostStatus() {
  const { view, hostStatus } = useHostConnection();
  const { tone, pulse, text } = hostIndicator(view, hostStatus);
  const error =
    hostStatus?.phase === 'failed'
      ? hostStatus.error
      : view.status === 'failed' || view.status === 'closed'
        ? view.error
        : undefined;
  return (
    <p
      role="status"
      data-testid="connection-status"
      title={error}
      className="flex h-7 items-center gap-2 px-2 text-xs text-muted-foreground"
    >
      <StatusDot tone={tone} pulse={pulse} />
      <span className="truncate">{text}</span>
    </p>
  );
}
