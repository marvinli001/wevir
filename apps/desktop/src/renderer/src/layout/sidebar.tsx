import type { Session } from '@wevir/protocol';
import { cn } from 'cn';
import {
  Blocks,
  ChartColumn,
  ChevronDown,
  Folder,
  FolderOpen,
  Plus,
  Rows3,
  Settings,
  SquarePen,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { NavLink, useLocation, useNavigate, useParams } from 'react-router';
import { Collapse } from '@/components/collapse';
import { IconButton } from '@/components/icon-button';
import { ArchiveIcon, PinIcon } from '@/components/session-icons';
import { StatusDot, type StatusTone } from '@/components/status-dot';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { isUnread, useSeenSessions } from '@/data/seen-sessions';
import { usePinnedSessions, useSessionActions } from '@/data/session-actions';
import { useWorkbenchData } from '@/data/workbench-data';
import {
  chatsOf,
  groupByStatus,
  isChats,
  pinnedFirst,
  projectsOf,
  type SessionMarker,
  type StatusRow,
  sessionMarker,
  type WorkspaceEntry,
} from '@/data/workbench-model';
import { usePinnedWorkspaces } from '@/data/workspace-actions';
import { Orb } from '@/fx/orb';
import { turnOrb } from '@/fx/orb-state';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { pluginsAvailability } from '@/plugins/plugins-model';
import { workspaceLabel } from '@/projects/chats';
import { openCreateProject } from '@/projects/create-project';
import { rememberWorkspace } from '@/routes/last-location';
import { paths } from '@/routes/paths';
import { UpdateEntryButton } from '@/updates/update-entry';
import { usageAvailability } from '@/usage/usage-model';
import { layoutPrefs, toggleWorkspace } from './layout-state';
import { beginPinDrag, PinDragGhost, PinnedGroup, usePinDragId } from './pin-drag';
import { ProjectContextMenuItems } from './project-context-menu';
import { RoleLabel } from './role-label';
import { SessionContextMenuItems } from './session-context-menu';

/** 侧栏的一行：悬停是表面色的淡底，当前项是同样的淡底加一圈 1 px 的选中细边（U5，§63 起不再是整块表面色）。 */
const ROW =
  'flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-base outline-none ' +
  'transition-[color,background-color,box-shadow] duration-150 ease-smooth hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring/50';
const ROW_ACTIVE =
  'bg-sidebar-accent/70 text-sidebar-accent-foreground ring-1 ring-selected-border ring-inset hover:bg-sidebar-accent/70';
/** 行右边悬停出现的置顶与归档（U34）：22 px、6 px 圆角，说明文字色，悬停时前景色加一层淡底。 */
const ROW_ACTION =
  'size-[22px] rounded-md text-muted-foreground hover:bg-sidebar-foreground/8 hover:text-foreground dark:hover:bg-sidebar-foreground/10';

/** 每个项目先列这么多个会话，其余的点“显示更多”。 */
const SESSIONS_SHOWN = 5;
/** 按状态分组时“已完成”先列这么多个（U19）。 */
const COMPLETED_SHOWN = 10;

/**
 * 左栏（U5 照 Codex 桌面端）：顶上一条拖动区（后退、前进与侧栏开关浮在它上面，见 window-controls.tsx；浮层里的侧栏把
 * 它们放进 `controls`）、“新建会话”与“插件”（0.42.0，Host 有 `plugins` 功能才有）、会话（U19 起默认按状态分三组，可切换成“项目 → 会话”两级树）、底部的更新入口（有新版本时，
 * ADR-0007 补记 4）、“使用统计”（0.62.0，Host 有 `usage_stats` 功能才有）与设置入口。不显示与 Host 的连接状态：连上时什么都不
 * 显示，断线时只有窗口右下角的连接通知（host/connection-toast.tsx）。
 */
export function Sidebar({ controls }: { controls?: ReactNode }) {
  const location = useLocation();
  // Host 有 `plugins` 功能才有“插件”入口（0.42.0）；断线重连期间 client 还在，入口不闪。
  const { client } = useHostConnection();
  const showPlugins = pluginsAvailability(client?.hello.features) === 'ready';
  // Host 有 `usage_stats` 功能才有“使用统计”入口（0.62.0），在设置上面。
  const showUsage = usageAvailability(client?.hello.features) === 'ready';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="app-drag flex h-11 shrink-0 items-center pl-[max(0.5rem,var(--traffic-lights-inset))]">
        {controls}
      </div>

      <div className="shrink-0 space-y-px px-2 pb-2">
        <NavLink
          to={paths.home()}
          end
          className={({ isActive }) => cn(ROW, isActive && ROW_ACTIVE)}
        >
          <SquarePen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {t('sidebar.newSession')}
        </NavLink>
        {showPlugins && (
          <NavLink
            to={paths.plugins()}
            className={({ isActive }) => cn(ROW, isActive && ROW_ACTIVE)}
            data-testid="sidebar-plugins"
          >
            <Blocks className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {t('sidebar.plugins')}
          </NavLink>
        )}
      </div>

      <ProjectsSection />
      <PinDragGhost />

      <div className="shrink-0 p-2">
        <UpdateEntryButton className="mb-0.5" />
        {showUsage && (
          <NavLink
            to={paths.usage()}
            className={({ isActive }) => cn(ROW, 'mb-px', isActive && ROW_ACTIVE)}
            data-testid="sidebar-usage"
          >
            <ChartColumn className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {t('sidebar.usage')}
          </NavLink>
        )}
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
      <ScrollArea fade className="min-h-0 flex-1">
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
      className={cn(
        'text-muted-foreground',
        active && 'bg-sidebar-accent/70 text-foreground ring-1 ring-selected-border ring-inset',
      )}
      onClick={() => layoutPrefs.set((prefs) => ({ ...prefs, sidebarView: view }))}
      data-testid={`sidebar-view-${view}`}
    >
      {view === 'status' ? <Rows3 /> : <Folder />}
    </IconButton>
  );
}

/** 按状态的三组（U19）：待处理、进行中、最近 7 天的已完成；组内按最近活动，右边写项目名。 */
function StatusTree() {
  const data = useWorkbenchData();
  const seen = useSeenSessions();
  const pinned = usePinnedSessions();
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
  // 置顶的会话（U34，本机）单独一组排在最前，不再出现在别的组里。
  const pinnedRows = pinnedOf(data.workspaces, pinned);
  const isPinned = (row: StatusRow) => pinned.includes(row.session.id);
  const needsYou = groups.needsYou.filter((row) => !isPinned(row));
  const running = groups.running.filter((row) => !isPinned(row));
  const completed = groups.completed.filter((row) => !isPinned(row));
  if (pinnedRows.length + needsYou.length + running.length + completed.length === 0) {
    return (
      <p className="px-2 py-1 text-sm text-muted-foreground">
        {t(data.workspaces.length === 0 ? 'sidebar.noProjects' : 'sidebar.noSessions')}
      </p>
    );
  }
  const rowContent = ({ session, workspace }: StatusRow) => (
    <SessionRow
      workspaceId={workspace.id}
      session={session}
      unread={isUnread(seen, session)}
      project={projectLabel(workspace, session)}
    />
  );
  const row = (entry: StatusRow) => <li key={entry.session.id}>{rowContent(entry)}</li>;
  return (
    <div className="space-y-2 pt-1" data-testid="sidebar-status">
      <PinnedGroup rows={pinnedRows} render={rowContent} />
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
  const pinned = usePinnedSessions();
  const pinnedProjects = usePinnedWorkspaces();

  if (data.status === 'loading') return null;
  if (data.status === 'error') {
    return (
      <p className="px-2 py-1 text-sm break-words text-destructive">
        {t('sidebar.loadFailed', { error: data.error })}
      </p>
    );
  }
  // 置顶的项目（本机）排在前面。
  const projects = pinnedFirst(projectsOf(data.workspaces), pinnedProjects);
  // 不在项目里的会话（0.39.0）：项目下面单独一组“对话”。
  const chats = chatsOf(data.workspaces);
  const chatSessions = chats?.sessions ?? [];
  if (projects.length === 0 && chatSessions.length === 0) {
    return <p className="px-2 py-1 text-sm text-muted-foreground">{t('sidebar.noProjects')}</p>;
  }
  const pinnedRows = pinnedOf(data.workspaces, pinned);
  return (
    <>
      <div className="pt-1 pb-2 empty:hidden">
        <PinnedGroup
          rows={pinnedRows}
          render={({ session, workspace }) => (
            <SessionRow
              workspaceId={workspace.id}
              session={session}
              unread={isUnread(seen, session)}
              project={projectLabel(workspace, session)}
            />
          )}
        />
      </div>
      <ul className="space-y-px">
        {projects.map((entry) => (
          <ProjectItem
            key={entry.workspace.id}
            entry={entry}
            expanded={!collapsedWorkspaces.includes(entry.workspace.id)}
            pinned={pinnedProjects.includes(entry.workspace.id)}
            isUnread={(session) => isUnread(seen, session)}
          />
        ))}
      </ul>
      {chats && chatSessions.length > 0 && (
        <ChatsGroup
          workspaceId={chats.workspace.id}
          sessions={chatSessions}
          isUnread={(session) => isUnread(seen, session)}
        />
      )}
    </>
  );
}

/** 按项目分组时项目下面的“对话”（0.39.0，照 Codex 桌面端）：不在项目里的会话，标题右边悬停出现“新对话”。 */
function ChatsGroup({
  workspaceId,
  sessions,
  isUnread,
}: {
  workspaceId: string;
  sessions: readonly Session[];
  isUnread: (session: Session) => boolean;
}) {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  return (
    <section
      aria-labelledby="sidebar-group-chats"
      data-testid="sidebar-group-chats"
      className="group/chats pt-3"
    >
      <div className="relative flex h-6 items-center">
        <h3 id="sidebar-group-chats" className="px-2 text-xs font-medium text-muted-foreground">
          {t('sidebar.chats')}
        </h3>
        <IconButton
          label={t('sidebar.newChat')}
          size="icon-xs"
          className="absolute right-1 text-muted-foreground opacity-0 group-hover/chats:opacity-100 focus-visible:opacity-100"
          onClick={() => {
            rememberWorkspace(null);
            navigate(paths.home());
          }}
        >
          <SquarePen />
        </IconButton>
      </div>
      <MoreList
        items={sessions}
        limit={SESSIONS_SHOWN}
        activeIndex={sessions.findIndex((session) => session.id === sessionId)}
        render={(session) => (
          <li key={session.id}>
            <SessionRow workspaceId={workspaceId} session={session} unread={isUnread(session)} />
          </li>
        )}
      />
    </section>
  );
}

/** 行右边写的项目名与悬停提示的路径：对话写“对话”，路径是它自己的文件夹。 */
function projectLabel(
  workspace: WorkspaceEntry['workspace'],
  session: Session,
): { displayName: string; rootPath: string } {
  return isChats(workspace)
    ? { displayName: workspaceLabel(workspace), rootPath: session.cwd }
    : workspace;
}

/** 置顶的会话，按置顶的先后（后置顶的在前）；不在列表里的（归档、移除）跳过。 */
function pinnedOf(workspaces: readonly WorkspaceEntry[], pinned: readonly string[]): StatusRow[] {
  if (pinned.length === 0) return [];
  const byId = new Map<string, StatusRow>();
  for (const entry of workspaces) {
    for (const session of entry.sessions) {
      byId.set(session.id, { session, workspace: entry.workspace });
    }
  }
  return pinned.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

function ProjectItem({
  entry,
  expanded,
  pinned,
  isUnread,
}: {
  entry: WorkspaceEntry;
  expanded: boolean;
  pinned: boolean;
  isUnread: (session: Session) => boolean;
}) {
  const { workspace, sessions } = entry;
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const listId = `project-sessions-${workspace.id}`;
  const FolderIcon = expanded ? FolderOpen : Folder;

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger
          render={<div className="group/project relative" data-project-id={workspace.id} />}
        >
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
            {pinned && (
              <PinIcon
                filled
                data-pinned-project=""
                className="size-3 shrink-0 text-muted-foreground group-hover/project:hidden"
              />
            )}
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
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ProjectContextMenuItems entry={entry} pinned={pinned} />
        </ContextMenuContent>
      </ContextMenu>
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
  // 目标进行中（0.35.0，照 T3 Code 的侧栏）：回合之间也标着，agent 还会接着做。
  const goal = session.goal?.status === 'active';
  // 右键菜单与悬停的按钮用同一套动作（data/session-actions.ts）。
  const actions = useSessionActions(session);
  const { pinned } = actions;
  const pinLabel = t(pinned ? 'session.unpin' : 'session.pin');
  const dragging = usePinDragId() === session.id;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            className={cn(
              'group/session relative transition-opacity duration-150',
              dragging && 'opacity-40',
            )}
            onPointerDown={(event) => beginPinDrag(event, session)}
          />
        }
      >
        <NavLink
          to={paths.session(workspaceId, session.id)}
          title={project && `${project.displayName} · ${project.rootPath}`}
          draggable={false}
          className={({ isActive }) =>
            cn(
              ROW,
              'text-soft-foreground select-none group-focus-within/session:pr-14 group-hover/session:pr-14',
              isActive && ROW_ACTIVE,
            )
          }
        >
          <span className="flex w-4 shrink-0 justify-center">
            {(marker === 'running' ||
              marker === 'awaiting_approval' ||
              marker === 'awaiting_input') &&
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
          <span
            className={cn('min-w-0 flex-1 truncate', unread && 'font-semibold text-foreground')}
          >
            {session.title || t('session.untitled')}
          </span>
          {session.openedBy?.role !== undefined && (
            <RoleLabel
              role={session.openedBy.role}
              className="group-focus-within/session:hidden group-hover/session:hidden"
            />
          )}
          {/* 悬停时让出位置给置顶与归档（U34）。 */}
          <span className="flex shrink-0 items-center group-focus-within/session:hidden group-hover/session:hidden">
            {badge ? (
              <span className="shrink-0 rounded-sm bg-warning/10 px-1.5 text-xs leading-5 font-medium text-warning">
                {markerInfo?.label}
              </span>
            ) : goal ? (
              <span
                data-goal
                className="shrink-0 rounded-sm bg-running/10 px-1.5 text-xs leading-5 font-medium text-running"
              >
                {t('session.marker.goal')}
              </span>
            ) : unread ? (
              <StatusDot tone="accent" label={t('session.marker.unread')} className="size-1.5" />
            ) : (
              project && (
                <span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">
                  {project.displayName}
                </span>
              )
            )}
          </span>
        </NavLink>
        <div
          data-row-actions=""
          className="absolute inset-y-0 right-1 flex items-center gap-px opacity-0 transition-opacity duration-150 group-focus-within/session:opacity-100 group-hover/session:opacity-100"
        >
          <IconButton
            label={pinLabel}
            size="icon-xs"
            className={ROW_ACTION}
            onClick={actions.togglePin}
            data-action="pin-session"
          >
            <PinIcon filled={pinned} className="size-3.5" />
          </IconButton>
          {actions.archive && (
            <IconButton
              label={t('session.archive')}
              size="icon-xs"
              className={ROW_ACTION}
              onClick={actions.archive}
              data-action="archive-session"
            >
              <ArchiveIcon className="size-3.5" />
            </IconButton>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SessionContextMenuItems cwd={session.cwd} actions={actions} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
