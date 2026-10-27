import { hostSupports } from '@wevir/client-sdk';
import type { Session } from '@wevir/protocol';
import { cn } from 'cn';
import {
  Blocks,
  Bot,
  CalendarClock,
  ChartColumn,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
  Rows3,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
} from 'lucide-react';
import { type KeyboardEvent, memo, type ReactNode, useState } from 'react';
import { NavLink, useLocation, useNavigate, useParams } from 'react-router';
import { assistantsAvailability } from '@/assistants/assistants-model';
import { automationsAvailability } from '@/automations/automations-model';
import { Collapse } from '@/components/collapse';
import { Hint } from '@/components/hint';
import { IconButton } from '@/components/icon-button';
import { ArchiveIcon, PinIcon } from '@/components/session-icons';
import { StatusDot, type StatusTone } from '@/components/status-dot';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { isUnread, useSeenSessions } from '@/data/seen-sessions';
import { usePinnedSessions, useSessionActions } from '@/data/session-actions';

import { type SessionThread, threadSessions } from '@/data/session-threads';
import { useSessionActivity, useWorkbenchData } from '@/data/workbench-data';
import {
  chatsOf,
  groupByStatus,
  inOrder,
  isChats,
  projectsOf,
  type SessionMarker,
  type StatusRow,
  sessionMarker,
  type WorkspaceEntry,
} from '@/data/workbench-model';
import {
  usePinnedWorkspaces,
  useProjectOrder,
  useWorkspaceManagement,
} from '@/data/workspace-actions';
import { Orb } from '@/fx/orb';
import { turnOrb } from '@/fx/orb-state';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { formatShortcut, SHORTCUTS } from '@/lib/shortcuts';
import { platformSlots } from '@/platform/platform';
import { pluginsAvailability } from '@/plugins/plugins-model';
import { workspaceLabel } from '@/projects/chats';
import { openCreateProject } from '@/projects/create-project';
import { rememberWorkspace } from '@/routes/last-location';
import { paths } from '@/routes/paths';
import { searchOpen } from '@/search/search-model';
import { ActivityText, RunClock } from '@/session/agent-status';
import { tuningAvailability } from '@/tuning/tuning-model';
import { UpdateEntryButton } from '@/updates/update-entry';
import { usageAvailability } from '@/usage/usage-model';
import { layoutPrefs, toggleThread, toggleWorkspace } from './layout-state';
import { beginPinDrag, PinDragGhost, PinnedGroup, usePinDragId } from './pin-drag';
import { ProjectContextMenuItems } from './project-context-menu';
import {
  beginProjectDrag,
  ProjectDragGhost,
  ProjectDropLine,
  useProjectDragId,
} from './project-drag';
import { RoleLabel } from './role-label';
import { SessionContextMenuItems } from './session-context-menu';
import { DoneMark, GlyphReveal, motionElapsed } from './session-marks';
import { sessionMotion } from './session-motion';

/** 侧栏的一行：悬停是表面色的淡底，当前项是同样的淡底加一圈 1 px 的选中细边（U5，§63 起不再是整块表面色）。 */
const ROW =
  'flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-base outline-none ' +
  'transition-[color,background-color,box-shadow] duration-150 ease-smooth hover:bg-sidebar-accent/70 focus-visible:focus-ring';
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
 * 它们放进 `controls`）、“新建会话”“助理”（0.120.0，Host 有 `channels` 功能才有）“自动化”（0.66.0，Host 有 `automations` 功能才有）与“插件”（0.42.0，Host 有 `plugins` 功能才有）、“调优”（0.85.0，Host 有 `tuning` 功能才有）、会话（U19 起默认按状态分三组，可切换成“项目 → 会话”两级树）、底部的更新入口（有新版本时，
 * ADR-0007 补记 4）、“使用统计”（0.62.0，Host 有 `usage_stats` 功能才有）与设置入口。不显示与 Host 的连接状态：连上时什么都不
 * 显示，断线时只有窗口右下角的连接通知（host/connection-toast.tsx）。
 */
export const Sidebar = memo(function Sidebar({ controls }: { controls?: ReactNode }) {
  const location = useLocation();
  // Host 有 `plugins` 功能才有“插件”入口（0.42.0）；断线重连期间 client 还在，入口不闪。
  const { client } = useHostConnection();
  // 插件的列表与管理都要 `host.manage`：远程设备没有时不显示入口。
  const showPlugins =
    pluginsAvailability(client?.hello.features) === 'ready' && (client?.can('host.manage') ?? true);
  // Host 有 `tuning` 功能才有“调优”入口（0.85.0），在“插件”下面。
  // 调优的决定与开关都要 `host.manage`：远程设备没有时不显示入口。
  const showTuning =
    tuningAvailability(client?.hello.features) === 'ready' && (client?.can('host.manage') ?? true);
  // Host 有 `usage_stats` 功能才有“使用统计”入口（0.62.0），在设置上面。
  const showUsage = usageAvailability(client?.hello.features) === 'ready';
  // Host 有 `automations` 功能才有“自动化”入口（0.66.0），在“新建会话”下面。
  const showAutomations = automationsAvailability(client?.hello.features) === 'ready';
  // Host 有 `channels` 功能才有“助理”入口（0.120.0），在“自动化”上面。
  const showAssistants = assistantsAvailability(client?.hello.features) === 'ready';
  // Host 有 `session_search` 功能才有“搜索”入口（0.77.0），在“新建会话”下面。
  const showSearch = client !== undefined && hostSupports(client.hello.features, 'session_search');
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
        {showSearch && (
          <button
            type="button"
            onClick={() => searchOpen.set(true)}
            className={cn(ROW, 'group/search w-full text-left')}
            data-testid="sidebar-search"
          >
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1">{t('sidebar.search')}</span>
            <kbd className="font-sans text-xs text-muted-foreground opacity-0 group-hover/search:opacity-100 group-focus-visible/search:opacity-100">
              {formatShortcut(SHORTCUTS.search)}
            </kbd>
          </button>
        )}
        {showAssistants && (
          <NavLink
            to={paths.assistants()}
            className={({ isActive }) => cn(ROW, isActive && ROW_ACTIVE)}
            data-testid="sidebar-assistants"
          >
            <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {t('sidebar.assistants')}
          </NavLink>
        )}
        {showAutomations && (
          <NavLink
            to={paths.automations()}
            className={({ isActive }) => cn(ROW, isActive && ROW_ACTIVE)}
            data-testid="sidebar-automations"
          >
            <CalendarClock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {t('sidebar.automations')}
          </NavLink>
        )}
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
        {showTuning && (
          <NavLink
            to={paths.tuning()}
            className={({ isActive }) => cn(ROW, isActive && ROW_ACTIVE)}
            data-testid="sidebar-tuning"
          >
            <SlidersHorizontal className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {t('sidebar.tuning')}
          </NavLink>
        )}
      </div>

      <ProjectsSection />
      <PinDragGhost />
      <ProjectDragGhost />

      <div className="shrink-0 p-2">
        <UpdateEntryButton className="mb-0.5" />
        {platformSlots().sidebarFooter?.()}
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
});

/**
 * 会话一节：标题点一下收起整节（Codex 的“项目 ⌄”），右边是按状态 / 按项目的切换（U19，desktop-layout.md §13）与创建项目的
 * +。
 */
function ProjectsSection() {
  const { projectsCollapsed, sidebarView } = layoutPrefs.use();
  const title = t(sidebarView === 'status' ? 'sidebar.sessions' : 'sidebar.projects');
  const manage = useWorkspaceManagement();
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
          className="flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:focus-ring"
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
          {manage.create && (
            <IconButton
              label={t('sidebar.createProject')}
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => openCreateProject()}
            >
              <Plus />
            </IconButton>
          )}
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

/** 按状态的三组（U19）：待处理、进行中、最近 7 天的已完成；组内按最近活动，行右边不写项目名。 */
function StatusTree() {
  const data = useWorkbenchData();
  const seen = useSeenSessions();
  const pinned = usePinnedSessions();
  const { sessionId } = useParams();
  const { collapsedThreads } = layoutPrefs.use();

  if (data.status === 'loading') return null;
  if (data.status === 'error') {
    return (
      <p className="px-2 py-1 text-sm break-words text-destructive">
        {t('sidebar.loadFailed', { error: data.error })}
      </p>
    );
  }
  // 置顶的会话（U34，本机）单独一组排在最前，不再出现在别的组里。
  const groups = groupByStatus(data.workspaces, Date.now(), undefined, (session) =>
    pinned.includes(session.id),
  );
  const pinnedRows = pinnedOf(data.workspaces, pinned);
  const { needsYou, running, completed } = groups;
  if (pinnedRows.length + needsYou.length + running.length + completed.length === 0) {
    return (
      <p className="px-2 py-1 text-sm text-muted-foreground">
        {t(data.workspaces.length === 0 ? 'sidebar.noProjects' : 'sidebar.noSessions')}
      </p>
    );
  }
  const rowContent = ({ session, workspace }: Pick<StatusRow, 'session' | 'workspace'>) => (
    <SessionRow workspaceId={workspace.id} session={session} unread={isUnread(seen, session)} />
  );
  const row = (entry: StatusRow) => (
    <ThreadItem
      key={entry.session.id}
      workspaceId={entry.workspace.id}
      thread={entry}
      open={threadOpen(entry, collapsedThreads, sessionId)}
      isUnread={(session) => isUnread(seen, session)}
    />
  );
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
            activeIndex={completed.findIndex((entry) => inThread(entry, sessionId))}
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
  const projectOrder = useProjectOrder();

  if (data.status === 'loading') return null;
  if (data.status === 'error') {
    return (
      <p className="px-2 py-1 text-sm break-words text-destructive">
        {t('sidebar.loadFailed', { error: data.error })}
      </p>
    );
  }
  // 按手动排的顺序（本机，拖动或上移、下移），置顶的项目（本机）再排在前面。
  const projects = inOrder(inOrder(projectsOf(data.workspaces), projectOrder), pinnedProjects);
  const listed = projects.map((entry) => entry.workspace.id);
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
      <ul className="relative space-y-px" data-project-list="">
        {projects.map((entry) => (
          <ProjectItem
            key={entry.workspace.id}
            entry={entry}
            listed={listed}
            expanded={!collapsedWorkspaces.includes(entry.workspace.id)}
            pinned={pinnedProjects.includes(entry.workspace.id)}
            isUnread={(session) => isUnread(seen, session)}
          />
        ))}
        <ProjectDropLine />
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
      <ThreadList
        workspaceId={workspaceId}
        sessions={sessions}
        activeId={sessionId}
        isUnread={isUnread}
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
function pinnedOf(
  workspaces: readonly WorkspaceEntry[],
  pinned: readonly string[],
): Array<Pick<StatusRow, 'session' | 'workspace'>> {
  if (pinned.length === 0) return [];
  const byId = new Map<string, Pick<StatusRow, 'session' | 'workspace'>>();
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
  listed,
  expanded,
  pinned,
  isUnread,
}: {
  entry: WorkspaceEntry;
  /** 左栏现在的项目顺序，菜单的上移、下移用。 */
  listed: readonly string[];
  expanded: boolean;
  pinned: boolean;
  isUnread: (session: Session) => boolean;
}) {
  const { workspace, sessions } = entry;
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const listId = `project-sessions-${workspace.id}`;
  const FolderIcon = expanded ? FolderOpen : Folder;
  const dragging = useProjectDragId() === workspace.id;

  return (
    <li data-project-row={workspace.id} className={cn(dragging && 'opacity-40')}>
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
            onPointerDown={(event) =>
              beginProjectDrag(event, { id: workspace.id, title: workspace.displayName })
            }
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
          <ProjectContextMenuItems entry={entry} pinned={pinned} listed={listed} />
        </ContextMenuContent>
      </ContextMenu>
      <Collapse open={expanded && sessions.length > 0} id={listId}>
        <ThreadList
          workspaceId={workspace.id}
          sessions={sessions}
          activeId={sessionId}
          isUnread={isUnread}
        />
      </Collapse>
    </li>
  );
}

/**
 * 一个项目（或“对话”）的会话列表：agent 开出的会话归在开出它的会话下面（session-threads.ts），“显示更多”按线程数。
 */
function ThreadList({
  workspaceId,
  sessions,
  activeId,
  isUnread,
}: {
  workspaceId: string;
  sessions: readonly Session[];
  activeId: string | undefined;
  isUnread: (session: Session) => boolean;
}) {
  const { collapsedThreads } = layoutPrefs.use();
  const threads = threadSessions(sessions);
  return (
    <MoreList
      items={threads}
      limit={SESSIONS_SHOWN}
      activeIndex={threads.findIndex((thread) => inThread(thread, activeId))}
      render={(thread) => (
        <ThreadItem
          key={thread.session.id}
          workspaceId={workspaceId}
          thread={thread}
          open={threadOpen(thread, collapsedThreads, activeId)}
          isUnread={isUnread}
        />
      )}
    />
  );
}

function inThread(thread: SessionThread, sessionId: string | undefined): boolean {
  return thread.session.id === sessionId || thread.children.some((child) => child.id === sessionId);
}

/**
 * 线程展开着没有：用户没收起它就展开。收起了也照样展开的两种：当前会话是其中一个子会话（免得当前项被收起来）；有子会话
 * 等审批、等回答或出错（收起的线程里不藏需要用户处理的会话）。当前会话是父会话本身时照常收起（照 Claude Code 桌面端），
 * 父会话那一行还在。
 */
function threadOpen(
  thread: SessionThread,
  collapsedThreads: readonly string[],
  activeId: string | undefined,
): boolean {
  return (
    !collapsedThreads.includes(thread.session.id) ||
    thread.children.some((child) => child.id === activeId) ||
    thread.children.some((child) => {
      const marker = sessionMarker(child);
      return marker !== undefined && marker !== 'running';
    })
  );
}

/**
 * 子会话前面那条线（照 Claude Code 桌面端）：竖线在父会话标题起点稍右，连到下一个，最后一个拐个弯收住；子会话的标题在线右边
 * 16 px，状态点落在线上（`SessionRow` 的 `branch`）。用前景色的 20%：`border` 在侧栏底色上几乎看不见。
 */
const BRANCH =
  'relative pl-11 before:pointer-events-none before:absolute before:-top-px before:left-9 before:border-l before:border-foreground/20';
const BRANCH_MID = 'before:bottom-0';
const BRANCH_LAST = 'before:h-[17px] before:w-2 before:rounded-bl-md before:border-b';

/**
 * 一个线程：开出别的会话的会话下面列着它开出的会话；收起时只留一行“N 个子会话”，点它展开。标题后面的箭头展开、收起，
 * 焦点在行上时左右方向键也行。
 */
function ThreadItem({
  workspaceId,
  thread,
  open,
  isUnread,
}: {
  workspaceId: string;
  thread: SessionThread;
  open: boolean;
  isUnread: (session: Session) => boolean;
}) {
  const { session, children } = thread;
  const count = children.length;
  // 收起时那一行写上有几个在跑；有没看过的（跑完了的）右边带未读点。需要用户处理的子会话不会收起（threadOpen）。
  const runningCount = children.filter((child) => sessionMarker(child) === 'running').length;
  const unreadChild = children.some(
    (child) => isUnread(child) && sessionMarker(child) !== 'running',
  );
  return (
    <li data-thread={count > 0 ? session.id : undefined}>
      <SessionRow
        workspaceId={workspaceId}
        session={session}
        unread={isUnread(session)}
        {...(count > 0 && { thread: { count, open } })}
      />
      {count > 0 && (
        <Collapse open={open}>
          <ul className="space-y-px pt-px">
            {children.map((child, index) => (
              <li
                key={child.id}
                className={cn(BRANCH, index === count - 1 ? BRANCH_LAST : BRANCH_MID)}
              >
                <SessionRow
                  workspaceId={workspaceId}
                  session={child}
                  unread={isUnread(child)}
                  branch
                />
              </li>
            ))}
          </ul>
        </Collapse>
      )}
      {count > 0 && !open && (
        <div className={cn(BRANCH, BRANCH_LAST, 'pt-px')}>
          <button
            type="button"
            aria-expanded={false}
            data-thread-summary={session.id}
            onClick={() => toggleThread(session.id)}
            className={cn(ROW, 'h-7 text-sm text-muted-foreground hover:text-foreground')}
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {t('sidebar.threadCount', { count })}
              {runningCount > 0 && ` · ${t('sidebar.threadRunning', { count: runningCount })}`}
            </span>
            {unreadChild && (
              <StatusDot tone="accent" label={t('session.marker.unread')} className="size-1.5" />
            )}
          </button>
        </div>
      )}
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
  awaiting_decision: { tone: 'warning', label: t('session.marker.awaitingDecision') },
  error: { tone: 'danger', label: t('session.marker.error') },
};

interface SessionRowProps {
  workspaceId: string;
  session: Session;
  unread: boolean;
  /** 按项目分组时置顶组的行右边写项目名，悬停提示是“项目名 · 路径”。 */
  project?: { displayName: string; rootPath: string };
  /** 它开出的会话归在它下面（session-threads.ts）：几个、展开着没有。标题后面有展开、收起的箭头。 */
  thread?: { count: number; open: boolean };
  /** 子会话行（`BRANCH`）：状态格移到行左边，落在那条线上，标题紧跟行首。 */
  branch?: boolean;
}

/**
 * 列表每次更新只换掉有新事件的那个会话对象，其余的会话对象不变：行按内容比较，流式回答时左栏其他行不跟着重渲染。
 * `project` 由列表每次现算（“对话”的那份是新对象），比较它的两个字段。
 */
function sameRow(a: SessionRowProps, b: SessionRowProps): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.session === b.session &&
    a.unread === b.unread &&
    a.project?.displayName === b.project?.displayName &&
    a.project?.rootPath === b.project?.rootPath &&
    a.thread?.count === b.thread?.count &&
    a.thread?.open === b.thread?.open &&
    a.branch === b.branch
  );
}

/**
 * 运行中的会话行的第二行（代理状态）：当前动作与计时，小一号的说明文字色。还没收到这个回合的事件时（打开应用时已经在跑）写“运行中”。
 */
function SessionActivityLine({ session }: { session: Session }) {
  const activity = useSessionActivity(session.id);
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground animate-in fade-in duration-200 ease-smooth">
      {activity ? (
        <ActivityText activity={activity} className="flex-1" />
      ) : (
        <span className="flex-1 truncate">{t('session.marker.running')}</span>
      )}
      <RunClock since={session.activeTurn?.startedAt} className="shrink-0" />
    </span>
  );
}

/**
 * 会话行：标题与项目名对齐（左边一格是状态：运行中是这个回合的 thinking orb，待审批时 orb 停住；出错是状态点），右侧
 * “待审批”标签或未读点。orb 与消息流里的是同一种（fx/orb-state.ts 按会话与回合 ID 定）。状态变化有动效（§71）：orb 出现时
 * 弹出来，待审批标签与出错的状态点跳一下，回合跑完左边画一个圈勾再淡出，标题换成生成的标题时逐字显出。
 */
const SessionRow = memo(function SessionRow({
  workspaceId,
  session,
  unread,
  project,
  thread,
  branch,
}: SessionRowProps) {
  const marker = sessionMarker(session);
  const markerInfo = marker && MARKERS[marker];
  const badge = marker === 'awaiting_approval' || marker === 'awaiting_input';
  // 状态与标题的变化动效（§71）：只在这次运行里变了才有时刻。
  const motion = sessionMotion(session);
  const jumpAt = motion.markerAt;
  // 目标进行中（0.35.0，照 T3 Code 的侧栏）：回合之间也标着，agent 还会接着做。
  const goal = session.goal?.status === 'active';
  // 在跑的会话不按未读加粗：失焦时右边是灰色呼吸点，跑完了（没在看）才加粗并换成未读点。
  const working = marker === 'running';
  const live = working || marker === 'awaiting_approval' || marker === 'awaiting_input';
  const settledUnread = unread && !working;
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
          {...(thread && {
            'aria-expanded': thread.open,
            onKeyDown: (event: KeyboardEvent) => {
              if (event.key === (thread.open ? 'ArrowLeft' : 'ArrowRight')) {
                event.preventDefault();
                toggleThread(session.id);
              }
            },
          })}
          className={({ isActive }) =>
            cn(
              ROW,
              'text-soft-foreground select-none group-focus-within/session:pr-14 group-hover/session:pr-14',
              // 运行中多一行当前动作（代理状态）：行跟着变高。
              live && 'h-auto min-h-8 py-1',
              isActive && ROW_ACTIVE,
            )
          }
        >
          {({ isActive }) => (
            <>
              <span
                className={cn(
                  'flex w-4 shrink-0 justify-center',
                  branch && 'absolute inset-y-0 -left-4 items-center',
                )}
              >
                {(marker === 'running' ||
                  marker === 'awaiting_approval' ||
                  marker === 'awaiting_input') &&
                markerInfo ? (
                  <span
                    role="img"
                    aria-label={markerInfo.label}
                    className={cn(
                      'flex',
                      jumpAt !== undefined &&
                        marker === 'running' &&
                        motion.markerFrom === undefined &&
                        'status-enter',
                    )}
                    style={jumpAt === undefined ? undefined : motionElapsed(jumpAt)}
                  >
                    <Orb
                      state={turnOrb(session.id, session.activeTurn?.turnId ?? session.id)}
                      paused={marker === 'awaiting_approval' || marker === 'awaiting_input'}
                    />
                  </span>
                ) : markerInfo ? (
                  <span
                    className="flex"
                    style={jumpAt === undefined ? undefined : motionElapsed(jumpAt)}
                  >
                    <StatusDot
                      tone={markerInfo.tone}
                      label={markerInfo.label}
                      className={cn(jumpAt !== undefined && 'status-jump')}
                    />
                  </span>
                ) : (
                  motion.doneAt !== undefined && <DoneMark at={motion.doneAt} />
                )}
              </span>
              <span
                className={cn(
                  'flex min-w-0 flex-col',
                  // 有子会话时箭头紧跟在标题后面，空出来的地方放在箭头之后。
                  !thread && 'flex-1',
                )}
              >
                {/* 标题被截断时悬停看全名。 */}
                <Hint label={session.title || t('session.untitled')} whenClipped>
                  <span
                    className={cn(
                      'min-w-0 truncate',
                      settledUnread && 'font-semibold text-foreground',
                    )}
                  >
                    <GlyphReveal
                      text={session.title || t('session.untitled')}
                      at={motion.titleAt}
                    />
                  </span>
                </Hint>
                {live && <SessionActivityLine session={session} />}
              </span>
              {thread && (
                // 箭头在链接里面：点它只展开、收起，不打开会话；键盘用左右方向键（上面的 onKeyDown）。
                <span
                  aria-hidden
                  data-thread-toggle={session.id}
                  title={t(thread.open ? 'sidebar.threadCollapse' : 'sidebar.threadExpand')}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleThread(session.id);
                  }}
                  className="-ml-1 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-foreground/8 hover:text-foreground"
                >
                  {thread.open ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                </span>
              )}
              {thread && <span className="flex-1" />}
              {session.openedBy?.role !== undefined && (
                <RoleLabel
                  role={session.openedBy.role}
                  className="group-focus-within/session:hidden group-hover/session:hidden"
                />
              )}
              {/* 悬停时让出位置给置顶与归档（U34）。 */}
              <span className="flex shrink-0 items-center group-focus-within/session:hidden group-hover/session:hidden">
                {badge ? (
                  <span
                    className={cn(
                      'shrink-0 rounded-sm bg-warning/10 px-1.5 text-xs leading-5 font-medium text-warning',
                      jumpAt !== undefined && 'status-jump',
                    )}
                    style={jumpAt === undefined ? undefined : motionElapsed(jumpAt)}
                  >
                    {markerInfo?.label}
                  </span>
                ) : goal ? (
                  <span
                    data-goal
                    className="shrink-0 rounded-sm bg-running/10 px-1.5 text-xs leading-5 font-medium text-running"
                  >
                    {t('session.marker.goal')}
                  </span>
                ) : working && !isActive ? (
                  <span
                    role="img"
                    aria-label={t('session.marker.running')}
                    className="inline-block size-1.5 shrink-0 animate-breathe rounded-full bg-muted-foreground"
                  />
                ) : settledUnread ? (
                  <StatusDot
                    tone="accent"
                    label={t('session.marker.unread')}
                    className="size-1.5"
                  />
                ) : (
                  project && (
                    <span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">
                      {project.displayName}
                    </span>
                  )
                )}
              </span>
            </>
          )}
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
}, sameRow);
