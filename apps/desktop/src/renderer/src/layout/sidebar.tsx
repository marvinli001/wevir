import type { Session } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronDown, Folder, FolderOpen, Plus, Rows3, Settings, SquarePen } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { NavLink, useLocation, useNavigate, useParams } from 'react-router';
import { Collapse } from '@/components/collapse';
import { IconButton } from '@/components/icon-button';
import { StatusDot, type StatusTone } from '@/components/status-dot';
import { ScrollArea } from '@/components/ui/scroll-area';
import { isUnread, useSeenSessions } from '@/data/seen-sessions';
import { useWorkbenchData } from '@/data/workbench-data';
import {
  groupByStatus,
  type SessionMarker,
  type StatusRow,
  sessionMarker,
  type WorkspaceEntry,
} from '@/data/workbench-model';
import { Orb } from '@/fx/orb';
import { turnOrb } from '@/fx/orb-state';
import { t } from '@/i18n';
import { openCreateProject } from '@/projects/create-project';
import { rememberWorkspace } from '@/routes/last-location';
import { paths } from '@/routes/paths';
import { layoutPrefs, toggleWorkspace } from './layout-state';

/** 侧栏的一行：悬停是表面色的淡底，当前项是表面色（照 Codex 桌面端，U5）。 */
const ROW =
  'flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-base outline-none ' +
  'transition-colors duration-150 hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring/50';
const ROW_ACTIVE = 'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent';

/** 每个项目先列这么多个会话，其余的点“显示更多”。 */
const SESSIONS_SHOWN = 5;
/** 按状态分组时“已完成”先列这么多个（U19）。 */
const COMPLETED_SHOWN = 10;

/**
 * 左栏（U5 照 Codex 桌面端）：顶上一条拖动区（后退、前进与侧栏开关浮在它上面，见 window-controls.tsx；浮层里的侧栏把
 * 它们放进 `controls`）、“新建会话”、会话（U19 起默认按状态分三组，可切换成“项目 → 会话”两级树）、底部的设置入口。不显示与 Host 的连接状态：连上时什么都不
 * 显示，断线时只有窗口顶部的连接提示（host/connection-banner.tsx）。
 */
export function Sidebar({ controls }: { controls?: ReactNode }) {
  const location = useLocation();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="app-drag flex h-11 shrink-0 items-center pl-[max(0.5rem,var(--traffic-lights-inset))]">
        {controls}
      </div>

      <div className="shrink-0 px-2 pb-2">
        <NavLink
          to={paths.home()}
          end
          className={({ isActive }) => cn(ROW, isActive && ROW_ACTIVE)}
        >
          <SquarePen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {t('sidebar.newSession')}
        </NavLink>
      </div>

      <ProjectsSection />

      <div className="shrink-0 p-2">
        <NavLink
          to={paths.settings()}
          state={{ from: location }}
          className={({ isActive }) => cn(ROW, isActive && ROW_ACTIVE)}
        >
          <Settings className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {t('sidebar.settings')}
        </NavLink>
      </div>
    </div>
  );
}

/**
 * 会话一节：标题点一下收起整节（Codex 的“项目 ⌄”），右边是按状态 / 按项目的切换（U19，desktop-layout.md §13）与创建项目的
 * +。
 */
function ProjectsSection() {
  const { projectsCollapsed, sidebarView } = layoutPrefs.use();
  const title = t(sidebarView === 'status' ? 'sidebar.sessions' : 'sidebar.projects');
  return (
    <>
      <div className="group/projects flex h-7 shrink-0 items-center justify-between pr-2 pl-2">
        <button
          type="button"
          aria-expanded={!projectsCollapsed}
          aria-controls="sidebar-projects"
          onClick={() =>
            layoutPrefs.set((p) => ({ ...p, projectsCollapsed: !p.projectsCollapsed }))
          }
          className="flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/50"
        >
          {title}
          <ChevronDown
            aria-hidden
            className={cn(
              'size-3.5 opacity-0 transition-[opacity,rotate] duration-200 group-hover/projects:opacity-100',
              projectsCollapsed && '-rotate-90 opacity-100',
            )}
          />
        </button>
        <div className="flex items-center gap-0.5">
          <ViewButton view="status" current={sidebarView} />
          <ViewButton view="project" current={sidebarView} />
          <IconButton
            label={t('sidebar.createProject')}
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => openCreateProject()}
          >
            <Plus />
          </IconButton>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <nav id="sidebar-projects" aria-label={title} className="px-2 pb-2">
          <Collapse open={!projectsCollapsed}>
            {sidebarView === 'status' ? <StatusTree /> : <ProjectTree />}
          </Collapse>
        </nav>
      </ScrollArea>
    </>
  );
}

function ViewButton({
  view,
  current,
}: {
  view: 'status' | 'project';
  current: 'status' | 'project';
}) {
  const active = view === current;
  return (
    <IconButton
      label={t(view === 'status' ? 'sidebar.view.status' : 'sidebar.view.project')}
      size="icon-xs"
      aria-pressed={active}
      className={cn('text-muted-foreground', active && 'bg-sidebar-accent text-foreground')}
      onClick={() => layoutPrefs.set((prefs) => ({ ...prefs, sidebarView: view }))}
      data-testid={`sidebar-view-${view}`}
    >
      {view === 'status' ? <Rows3 /> : <Folder />}
    </IconButton>
  );
}

/** 按状态的三组（U19）：需要你、进行中、最近 7 天的已完成；组内按最近活动，右边写项目名。 */
function StatusTree() {
  const data = useWorkbenchData();
  const seen = useSeenSessions();
  const { sessionId } = useParams();

  if (data.status === 'loading') return null;
  if (data.status === 'error') {
    return (
      <p className="px-2 py-1 text-sm break-words text-destructive">
        {t('sidebar.loadFailed', { error: data.error })}
      </p>
    );
  }
  const groups = groupByStatus(data.workspaces, Date.now());
  const { needsYou, running, completed } = groups;
  if (needsYou.length + running.length + completed.length === 0) {
    return (
      <p className="px-2 py-1 text-sm text-muted-foreground">
        {t(data.workspaces.length === 0 ? 'sidebar.noProjects' : 'sidebar.noSessions')}
      </p>
    );
  }
  const row = ({ session, workspace }: StatusRow) => (
    <li key={session.id}>
      <SessionRow
        workspaceId={workspace.id}
        session={session}
        unread={isUnread(seen, session)}
        project={workspace}
      />
    </li>
  );
  return (
    <div className="space-y-2 pt-1" data-testid="sidebar-status">
      {needsYou.length > 0 && (
        <StatusGroup title={t('sidebar.group.needsYou')} id="needs-you">
          <ul className="space-y-px">{needsYou.map(row)}</ul>
        </StatusGroup>
      )}
      {running.length > 0 && (
        <StatusGroup title={t('sidebar.group.running')} id="running">
          <ul className="space-y-px">{running.map(row)}</ul>
        </StatusGroup>
      )}
      {completed.length > 0 && (
        <StatusGroup title={t('sidebar.group.completed')} id="completed">
          <MoreList
            items={completed}
            limit={COMPLETED_SHOWN}
            activeIndex={completed.findIndex((entry) => entry.session.id === sessionId)}
            render={row}
          />
        </StatusGroup>
      )}
    </div>
  );
}

function StatusGroup({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  const headingId = `sidebar-group-${id}`;
  return (
    <section aria-labelledby={headingId} data-testid={`sidebar-group-${id}`}>
      <h3
        id={headingId}
        className="flex h-6 items-center px-2 text-xs font-medium text-muted-foreground"
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function ProjectTree() {
  const data = useWorkbenchData();
  const { collapsedWorkspaces } = layoutPrefs.use();
  const seen = useSeenSessions();

  if (data.status === 'loading') return null;
  if (data.status === 'error') {
    return (
      <p className="px-2 py-1 text-sm break-words text-destructive">
        {t('sidebar.loadFailed', { error: data.error })}
      </p>
    );
  }
  if (data.workspaces.length === 0) {
    return <p className="px-2 py-1 text-sm text-muted-foreground">{t('sidebar.noProjects')}</p>;
  }
  return (
    <ul className="space-y-px">
      {data.workspaces.map((entry) => (
        <ProjectItem
          key={entry.workspace.id}
          entry={entry}
          expanded={!collapsedWorkspaces.includes(entry.workspace.id)}
          isUnread={(session) => isUnread(seen, session)}
        />
      ))}
    </ul>
  );
}

function ProjectItem({
  entry,
  expanded,
  isUnread,
}: {
  entry: WorkspaceEntry;
  expanded: boolean;
  isUnread: (session: Session) => boolean;
}) {
  const { workspace, sessions } = entry;
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const listId = `project-sessions-${workspace.id}`;
  const FolderIcon = expanded ? FolderOpen : Folder;

  return (
    <li>
      <div className="group/project relative">
        <button
          type="button"
          className={cn(ROW, 'pr-8 text-sidebar-foreground')}
          aria-expanded={expanded}
          aria-controls={listId}
          title={workspace.rootPath}
          onClick={() => toggleWorkspace(workspace.id)}
        >
          <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left">{workspace.displayName}</span>
        </button>
        <IconButton
          label={t('sidebar.newSessionIn', { name: workspace.displayName })}
          size="icon-xs"
          className="absolute top-1 right-1 text-muted-foreground opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100"
          onClick={() => {
            rememberWorkspace(workspace.id);
            navigate(paths.home());
          }}
        >
          <SquarePen />
        </IconButton>
      </div>
      <Collapse open={expanded && sessions.length > 0} id={listId}>
        <MoreList
          items={sessions}
          limit={SESSIONS_SHOWN}
          activeIndex={sessions.findIndex((session) => session.id === sessionId)}
          render={(session) => (
            <li key={session.id}>
              <SessionRow workspaceId={workspace.id} session={session} unread={isUnread(session)} />
            </li>
          )}
        />
      </Collapse>
    </li>
  );
}

/**
 * 先列 `limit` 项，其余的收在“显示更多”后面，展开与收起是同一种高度过渡（U24，desktop-tokens.md §14）。当前会话排在
 * 后面时全部列出、不显示按钮，免得当前项被收起来。
 */
function MoreList<T>({
  items,
  limit,
  activeIndex,
  render,
}: {
  items: readonly T[];
  limit: number;
  activeIndex: number;
  render: (item: T) => ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const pinned = activeIndex >= limit;
  const rest = items.slice(limit);
  return (
    <>
      <ul className="space-y-px">{items.slice(0, limit).map(render)}</ul>
      {rest.length > 0 && (
        <Collapse open={showAll || pinned}>
          <ul className="space-y-px pt-px">{rest.map(render)}</ul>
        </Collapse>
      )}
      {rest.length > 0 && !pinned && (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
          className={cn(ROW, 'mt-px pl-8 text-muted-foreground hover:text-foreground')}
        >
          {t(showAll ? 'sidebar.showLess' : 'sidebar.showMore')}
        </button>
      )}
    </>
  );
}

const MARKERS: Record<SessionMarker, { tone: StatusTone; label: string }> = {
  running: { tone: 'accent', label: t('session.marker.running') },
  awaiting_approval: { tone: 'warning', label: t('session.marker.awaitingApproval') },
  awaiting_input: { tone: 'warning', label: t('session.marker.awaitingInput') },
  error: { tone: 'danger', label: t('session.marker.error') },
};

/**
 * 会话行：标题与项目名对齐（左边一格是状态：运行中是这个回合的 thinking orb，待审批时 orb 停住；出错是状态点），右侧
 * “待审批”标签或未读点。orb 与消息流里的是同一种（fx/orb-state.ts 按会话与回合 ID 定）。
 */
function SessionRow({
  workspaceId,
  session,
  unread,
  project,
}: {
  workspaceId: string;
  session: Session;
  unread: boolean;
  /** 按状态分组时（U19）行右边写项目名，悬停提示是“项目名 · 路径”。 */
  project?: { displayName: string; rootPath: string };
}) {
  const marker = sessionMarker(session);
  const markerInfo = marker && MARKERS[marker];
  const badge = marker === 'awaiting_approval' || marker === 'awaiting_input';
  return (
    <NavLink
      to={paths.session(workspaceId, session.id)}
      title={project && `${project.displayName} · ${project.rootPath}`}
      className={({ isActive }) => cn(ROW, 'text-soft-foreground', isActive && ROW_ACTIVE)}
    >
      <span className="flex w-4 shrink-0 justify-center">
        {(marker === 'running' || marker === 'awaiting_approval' || marker === 'awaiting_input') &&
        markerInfo ? (
          <span role="img" aria-label={markerInfo.label} className="flex">
            <Orb
              state={turnOrb(session.id, session.activeTurn?.turnId ?? session.id)}
              paused={marker === 'awaiting_approval' || marker === 'awaiting_input'}
            />
          </span>
        ) : (
          markerInfo && <StatusDot tone={markerInfo.tone} label={markerInfo.label} />
        )}
      </span>
      <span className={cn('min-w-0 flex-1 truncate', unread && 'font-semibold text-foreground')}>
        {session.title || t('session.untitled')}
      </span>
      {badge ? (
        <span className="shrink-0 rounded-sm bg-warning/10 px-1.5 text-xs leading-5 font-medium text-warning">
          {markerInfo?.label}
        </span>
      ) : unread ? (
        <StatusDot tone="accent" label={t('session.marker.unread')} className="size-1.5" />
      ) : (
        project && (
          <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
            {project.displayName}
          </span>
        )
      )}
    </NavLink>
  );
}
