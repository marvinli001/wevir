// 助理页：左栏聊天列表，右边是对话与资料面板（0.197.0，channel_panel）；旧 Host 保留四个页签。
// 助理群（0.133.0）也在列表里：叠放的成员头像；选中时只有群的时间线，头部列出成员。
// 页面窄到两栏放不下（手机上的 Wevir Web）时列表与对话二选一：没选中时是列表，选中后是对话，头部有返回；线程也占满整页。

import type { WevirClient } from '@wevir/client-sdk';
import type { Channel, ChannelId, SessionId } from '@wevir/protocol';
import { cn } from 'cn';
import {
  ArrowLeft,
  Bot,
  Ellipsis,
  PanelRight,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate, useSearchParams } from 'react-router';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { describe } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { createPersistedStore } from '@/lib/store';
import { useElementSize } from '@/lib/use-element-size';
import { paths } from '@/routes/paths';
import { deleteComposerInputs } from '@/session/composer-drafts';
import { formatMessageTime } from '@/session/format';
import { Segmented } from '@/settings/settings-ui';
import { AssistantAvatar, GroupAvatar } from './assistant-avatar';
import { editAssistant, openAssistantDialog } from './assistant-dialog';
import { AssistantPanel } from './assistant-panel';
import { MemoryPanel, SchedulePanel, TasksPanel } from './assistant-panels';
import { ThreadPage, ThreadPane } from './assistant-thread';
import { AssistantTimeline } from './assistant-timeline';
import {
  assistantsById,
  groupMembers,
  groupsSupported,
  panelSupported,
  previewLine,
  ROW_STATE_LABEL,
  rowState,
  schedulesSupported,
} from './assistants-model';
import { editGroup, openGroupDialog } from './group-dialog';
import { useAssistantList, useAssistantView } from './use-assistants';

type Tab = 'conversation' | 'tasks' | 'schedule' | 'memory';

/** 提示条显示多久。 */
const ERROR_MS = 6000;

/** 页面窄于它就只显示一栏：列表 288（w-72）加上对话至少 312。 */
const SPLIT_MIN_WIDTH = 600;

const panelPreferences = createPersistedStore<Record<string, boolean>>(
  'wevir.assistant-panel.v1',
  {},
  (raw) =>
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === 'boolean'))
      : undefined,
);

export function AssistantsPage({
  client,
  channelId,
  threadId,
}: {
  client: WevirClient;
  channelId?: ChannelId;
  /** 占满右边的线程会话。 */
  threadId?: SessionId;
}) {
  const list = useAssistantList(client);
  const channels = list.channels;
  const assistants = useMemo(() => assistantsById(channels), [channels]);
  const groups = groupsSupported(client.hello.features);
  const assistantList = [...assistants.values()];
  const [pageRef, page] = useElementSize();
  const narrow = page.width < SPLIT_MIN_WIDTH;
  // 一栏时线程窗格放不下，`?thread=` 也占满整页。
  const [search] = useSearchParams();
  const paneThread = (search.get('thread') ?? undefined) as SessionId | undefined;
  const pageThread = threadId ?? (narrow ? paneThread : undefined);
  // 一栏时没有助理就不显示空列表，直接是带“新建”的空状态。
  const showList =
    !narrow || (channelId === undefined && channels !== undefined && channels.length > 0);
  return (
    <div
      ref={pageRef}
      className="flex h-full min-h-0"
      data-testid="assistants-page"
      data-layout={narrow ? 'single' : 'split'}
    >
      {showList && (
        <aside
          className={cn(
            'flex shrink-0 flex-col',
            narrow ? 'min-w-0 flex-1' : 'w-72 border-r border-border',
          )}
        >
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
            <h1 className="text-base font-semibold">{t('assistants.title')}</h1>
            {groups ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <IconButton label={t('assistants.new')} data-action="new-menu">
                      <Plus />
                    </IconButton>
                  }
                />
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onClick={openAssistantDialog} data-action="new-assistant">
                    <Bot />
                    {t('assistants.new')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={assistantList.length < 2}
                    onClick={() => openGroupDialog(assistantList)}
                    data-action="new-group"
                  >
                    <Users />
                    {t('assistants.group.new')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <IconButton
                label={t('assistants.new')}
                onClick={openAssistantDialog}
                data-action="new-assistant"
              >
                <Plus />
              </IconButton>
            )}
          </div>
          <nav
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
            aria-label={t('assistants.title')}
          >
            {channels?.map((channel) => (
              <AssistantRow key={channel.id} channel={channel} assistants={assistants} />
            ))}
          </nav>
        </aside>
      )}
      {(!narrow || !showList) && (
        <main className="flex min-w-0 flex-1 flex-col">
          {channelId !== undefined && pageThread !== undefined ? (
            <ThreadPage
              key={pageThread}
              client={client}
              channelId={channelId}
              sessionId={pageThread}
              assistant={assistants.get(channelId)}
              paneAvailable={!narrow}
            />
          ) : channelId !== undefined ? (
            <AssistantPane
              key={channelId}
              client={client}
              channelId={channelId}
              assistants={assistants}
              narrow={narrow}
              pageWidth={page.width}
            />
          ) : channels === undefined ? null : (
            <EmptyState
              icon={<Bot />}
              title={t(channels.length === 0 ? 'assistants.empty' : 'assistants.pick')}
              action={
                channels.length === 0 && (
                  <Button onClick={openAssistantDialog} data-action="new-assistant-empty">
                    <Plus />
                    {t('assistants.new')}
                  </Button>
                )
              }
            />
          )}
        </main>
      )}
    </div>
  );
}

/** 一栏时对话头部最左边：回到列表。 */
function BackToList() {
  const navigate = useNavigate();
  return (
    <IconButton
      label={t('assistants.back')}
      onClick={() => navigate(paths.assistants())}
      data-action="assistants-back"
    >
      <ArrowLeft />
    </IconButton>
  );
}

function AssistantRow({
  channel,
  assistants,
}: {
  channel: Channel;
  assistants: ReadonlyMap<string, Channel>;
}) {
  const state = rowState(channel);
  const preview = previewLine(channel, assistants);
  const time = channel.lastPost && formatMessageTime(channel.lastPost.at, currentLocale());
  return (
    <NavLink
      to={paths.assistant(channel.id)}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-2.5 py-2 outline-none hover:bg-muted focus-visible:focus-ring',
          isActive && 'bg-muted',
        )
      }
      data-assistant-id={channel.id}
      data-assistant-state={state}
      data-channel-kind={channel.kind}
    >
      {channel.kind === 'group' && (
        <GroupAvatar
          members={groupMembers(channel, assistants).flatMap((member) =>
            member.assistant ? [member.assistant.avatar] : [],
          )}
          size={32}
          working={state === 'working'}
          className="shrink-0"
        />
      )}
      {channel.assistant && (
        <AssistantAvatar
          avatar={channel.assistant.avatar}
          size={32}
          working={state === 'working'}
          paused={state === 'paused'}
          className="shrink-0"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{channel.title}</span>
          {time && <span className="shrink-0 text-xs text-muted-foreground">{time}</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {state === 'idle' ? preview : t(ROW_STATE_LABEL[state])}
          </span>
          {channel.pendingCount !== undefined ? (
            <span
              className="shrink-0 rounded-full bg-warning/15 px-1.5 text-xs leading-5 font-medium text-warning"
              data-pending={channel.pendingCount}
            >
              {channel.pendingCount}
            </span>
          ) : (
            channel.unreadCount !== undefined && (
              <span
                className="shrink-0 rounded-full bg-primary px-1.5 text-xs leading-5 font-medium text-primary-foreground"
                data-unread={channel.unreadCount}
              >
                {channel.unreadCount}
              </span>
            )
          )}
        </div>
      </div>
    </NavLink>
  );
}

function AssistantPane({
  client,
  channelId,
  assistants,
  narrow,
  pageWidth,
}: {
  client: WevirClient;
  channelId: ChannelId;
  assistants: ReadonlyMap<string, Channel>;
  /** 一栏：头部有返回，页签另起一行，线程占满整页。 */
  narrow: boolean;
  pageWidth: number;
}) {
  const state = useAssistantView(client, channelId);
  const [tab, setTab] = useState<Tab>('conversation');
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const panel = panelSupported(client.hello.features);
  const panelPreference = panelPreferences.use()[channelId];
  const panelOpen = panelPreference ?? pageWidth >= 1100;
  const floating = pageWidth < 1100;
  const showPanel = (open: boolean) => {
    panelPreferences.set((current) => ({ ...current, [channelId]: open }));
  };
  const navigate = useNavigate();
  // 时间线旁边的线程窗格（`?thread=`）。
  const [search, setSearch] = useSearchParams();
  const threadId = (search.get('thread') ?? undefined) as SessionId | undefined;
  const closeThread = () =>
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('thread');
        return next;
      },
      { replace: true },
    );
  useEffect(() => {
    if (error === undefined) return;
    const timer = window.setTimeout(() => setError(undefined), ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [error]);
  const view = state.view;
  if (view === undefined) {
    return state.error === undefined ? null : (
      <EmptyState icon={<Bot />} title={describe(state.error)} />
    );
  }
  const { channel } = view;
  if (channel.kind === 'group') {
    return (
      <GroupPane
        client={client}
        view={view}
        state={state}
        assistants={assistants}
        error={error}
        onError={setError}
        narrow={narrow}
      />
    );
  }
  const paused = channel.state === 'paused';
  const openTasks = view.tasks.filter(
    (task) => task.status === 'pending' || task.status === 'in_progress',
  ).length;
  const togglePause = () =>
    client
      .request('channel.update', { channelId, paused: !paused })
      .catch((reason: unknown) =>
        setError(t('assistants.actionFailed', { error: describe(reason) })),
      );
  const tabs = (
    <Segmented<Tab>
      label={t('assistants.tabs')}
      value={tab}
      onChange={setTab}
      options={[
        { value: 'conversation', label: t('assistants.tab.conversation') },
        {
          value: 'tasks',
          label:
            openTasks > 0
              ? t('assistants.tab.tasksCount', { count: openTasks })
              : t('assistants.tab.tasks'),
        },
        { value: 'schedule', label: t('assistants.tab.schedule') },
        { value: 'memory', label: t('assistants.tab.memory') },
      ]}
    />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-assistant-view={channel.id}>
      <header
        className={cn(
          'flex shrink-0 items-center border-b border-border py-2.5',
          narrow ? 'gap-2 px-3' : 'gap-3 px-5',
        )}
      >
        {narrow && <BackToList />}
        {channel.assistant && (
          <AssistantAvatar
            avatar={channel.assistant.avatar}
            size={36}
            working={channel.state === 'working'}
            paused={paused}
            className="shrink-0"
          />
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{channel.title}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {[t(ROW_STATE_LABEL[rowState(channel)]), channel.assistant?.description]
              .filter((part) => part !== undefined && part !== '')
              .join(' · ')}
          </p>
        </div>
        {!panel && !narrow && tabs}
        {panel ? (
          <IconButton
            label={t('assistants.panel.title')}
            aria-expanded={panelOpen && threadId === undefined}
            onClick={() => {
              closeThread();
              showPanel(threadId !== undefined || !panelOpen);
            }}
            data-action="assistant-panel-toggle"
          >
            <PanelRight />
          </IconButton>
        ) : (
          <IconButton
            label={t(paused ? 'assistants.resume' : 'assistants.pause')}
            onClick={togglePause}
            data-action={paused ? 'resume' : 'pause'}
          >
            {paused ? <Play /> : <Pause />}
          </IconButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton label={t('assistants.actions')} data-action="assistant-menu">
                <Ellipsis />
              </IconButton>
            }
          />
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => editAssistant(channel)} data-action="edit">
              <Pencil />
              {t('assistants.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setConfirming(true)}
              data-action="delete"
            >
              <Trash2 />
              {t('assistants.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {!panel && narrow && (
        <div className="shrink-0 overflow-x-auto border-b border-border px-3 py-2 *:w-full">
          {tabs}
        </div>
      )}
      {error && (
        <p className="shrink-0 bg-destructive/10 px-5 py-1.5 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {panel || tab === 'conversation' ? (
            <AssistantTimeline
              client={client}
              view={view}
              assistants={assistants}
              loadingOlder={state.loadingOlder}
              onLoadOlder={state.loadOlder}
              onPosted={state.addPost}
              onOpenThread={(thread) =>
                navigate(paths.assistantThread(channelId, thread.sessionId, !narrow), {
                  replace: threadId !== undefined,
                })
              }
              onError={setError}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-180 px-5 py-6">
                {tab === 'tasks' && (
                  <TasksPanel
                    client={client}
                    channel={channel}
                    tasks={view.tasks}
                    onError={setError}
                  />
                )}
                {tab === 'schedule' && (
                  <SchedulePanel
                    client={client}
                    channel={channel}
                    schedules={schedulesSupported(client.hello.features)}
                    onError={setError}
                  />
                )}
                {tab === 'memory' && <MemoryPanel client={client} channel={channel} />}
              </div>
            </div>
          )}
        </div>
        {threadId !== undefined && (
          <ThreadPane
            key={threadId}
            client={client}
            channelId={channelId}
            sessionId={threadId}
            thread={view.threads.find((thread) => thread.sessionId === threadId)}
            assistant={panel ? channel : undefined}
            onClose={closeThread}
          />
        )}
        {panel && panelOpen && threadId === undefined && !floating && (
          <aside
            className="flex w-80 shrink-0 flex-col border-l border-border"
            data-panel-mode="docked"
          >
            <div className="flex h-12 shrink-0 items-center justify-between px-4">
              <span className="text-sm font-medium">{t('assistants.panel.title')}</span>
              <IconButton label={t('common.close')} onClick={() => showPanel(false)}>
                <X />
              </IconButton>
            </div>
            <AssistantPanel
              client={client}
              view={view}
              error={error}
              onPause={togglePause}
              onOpenThread={(thread) => {
                showPanel(false);
                navigate(paths.assistantThread(channelId, thread.sessionId, !narrow));
              }}
              onError={setError}
            />
          </aside>
        )}
      </div>
      {panel && floating && (
        <Sheet open={panelOpen && threadId === undefined} onOpenChange={showPanel}>
          <SheetContent
            className={cn(
              'gap-0 pt-10',
              narrow
                ? 'data-[side=right]:w-full data-[side=right]:sm:max-w-none'
                : 'data-[side=right]:w-80 data-[side=right]:sm:max-w-80',
            )}
            aria-describedby={undefined}
            data-panel-mode={narrow ? 'page' : 'overlay'}
          >
            <SheetTitle className="sr-only">{t('assistants.panel.title')}</SheetTitle>
            <AssistantPanel
              client={client}
              view={view}
              error={error}
              onPause={togglePause}
              onOpenThread={(thread) => {
                showPanel(false);
                navigate(paths.assistantThread(channelId, thread.sessionId, !narrow));
              }}
              onError={setError}
            />
          </SheetContent>
        </Sheet>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('assistants.delete.title', { name: channel.title })}
        confirmLabel={t('assistants.delete')}
        failure={(reason) => t('assistants.actionFailed', { error: reason })}
        onConfirm={async () => {
          await client.request('channel.delete', { channelId });
          await deleteComposerInputs([`channel/${channelId}`]);
          navigate(paths.assistants());
        }}
      >
        <p>{t('assistants.delete.body')}</p>
      </ConfirmDialog>
    </div>
  );
}

/** 群（0.133.0）：头部是叠放的成员头像、群名与成员名，菜单里编辑与删除；下面只有群的时间线。 */
function GroupPane({
  client,
  view,
  state,
  assistants,
  error,
  onError,
  narrow,
}: {
  client: WevirClient;
  view: NonNullable<ReturnType<typeof useAssistantView>['view']>;
  state: ReturnType<typeof useAssistantView>;
  assistants: ReadonlyMap<string, Channel>;
  error: string | undefined;
  onError: (text: string) => void;
  narrow: boolean;
}) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const { channel } = view;
  const members = groupMembers(channel, assistants);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-assistant-view={channel.id}>
      <header
        className={cn(
          'flex shrink-0 items-center border-b border-border py-2.5',
          narrow ? 'gap-2 px-3' : 'gap-3 px-5',
        )}
      >
        {narrow && <BackToList />}
        <GroupAvatar
          members={members.flatMap((member) => (member.assistant ? [member.assistant.avatar] : []))}
          size={36}
          working={channel.state === 'working'}
          className="shrink-0"
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{channel.title}</h2>
          <p className="truncate text-xs text-muted-foreground" data-group-members>
            {members.map((member) => member.title).join('、')}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton label={t('assistants.actions')} data-action="group-menu">
                <Ellipsis />
              </IconButton>
            }
          />
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              onClick={() => editGroup(channel, [...assistants.values()])}
              data-action="edit-group"
            >
              <Pencil />
              {t('assistants.group.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setConfirming(true)}
              data-action="delete-group"
            >
              <Trash2 />
              {t('assistants.group.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {error && (
        <p className="shrink-0 bg-destructive/10 px-5 py-1.5 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <AssistantTimeline
        client={client}
        view={view}
        assistants={assistants}
        loadingOlder={state.loadingOlder}
        onLoadOlder={state.loadOlder}
        onPosted={state.addPost}
        onOpenThread={() => undefined}
        onError={onError}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('assistants.group.delete.title', { name: channel.title })}
        confirmLabel={t('assistants.group.delete')}
        failure={(reason) => t('assistants.actionFailed', { error: reason })}
        onConfirm={async () => {
          await client.request('channel.delete', { channelId: channel.id });
          await deleteComposerInputs([`channel/${channel.id}`]);
          navigate(paths.assistants());
        }}
      >
        <p>{t('assistants.group.delete.body')}</p>
      </ConfirmDialog>
    </div>
  );
}
