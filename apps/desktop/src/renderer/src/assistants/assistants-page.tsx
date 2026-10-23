// 助理页（0.120.0，Host 功能 `channels`）：左栏是聊天列表（头像、名字、最后一条、时间、状态、未读），右边是选中的助理：头部（头像、
// 名字、职责、暂停与删除），四个页签（对话、任务、日程与规矩、记忆）。照 Grok、Muse、Duet 一类个人助理：每个助理一条时间线。

import type { WevirClient } from '@wevir/client-sdk';
import type { Channel, ChannelId } from '@wevir/protocol';
import { cn } from 'cn';
import { Bot, Ellipsis, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
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
import { describe } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { paths } from '@/routes/paths';
import { formatMessageTime } from '@/session/format';
import { Segmented } from '@/settings/settings-ui';
import { AssistantAvatar } from './assistant-avatar';
import { openAssistantDialog } from './assistant-dialog';
import { MemoryPanel, SchedulePanel, TasksPanel } from './assistant-panels';
import { AssistantTimeline } from './assistant-timeline';
import { ROW_STATE_LABEL, rowState, schedulesSupported } from './assistants-model';
import { useAssistantList, useAssistantView } from './use-assistants';

type Tab = 'conversation' | 'tasks' | 'schedule' | 'memory';

/** 提示条显示多久。 */
const ERROR_MS = 6000;

export function AssistantsPage({
  client,
  channelId,
}: {
  client: WevirClient;
  channelId?: ChannelId;
}) {
  const list = useAssistantList(client);
  const channels = list.channels;
  return (
    <div className="flex h-full min-h-0" data-testid="assistants-page">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
          <h1 className="text-base font-semibold">{t('assistants.title')}</h1>
          <IconButton
            label={t('assistants.new')}
            onClick={openAssistantDialog}
            data-action="new-assistant"
          >
            <Plus />
          </IconButton>
        </div>
        <nav
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
          aria-label={t('assistants.title')}
        >
          {channels?.map((channel) => (
            <AssistantRow key={channel.id} channel={channel} />
          ))}
        </nav>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {channelId !== undefined ? (
          <AssistantPane key={channelId} client={client} channelId={channelId} />
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
    </div>
  );
}

function AssistantRow({ channel }: { channel: Channel }) {
  const state = rowState(channel);
  const preview = channel.lastPost?.preview;
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
    >
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
            {state === 'idle' ? (preview ?? '') : t(ROW_STATE_LABEL[state])}
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

function AssistantPane({ client, channelId }: { client: WevirClient; channelId: ChannelId }) {
  const state = useAssistantView(client, channelId);
  const [tab, setTab] = useState<Tab>('conversation');
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const navigate = useNavigate();
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
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-assistant-view={channel.id}>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-2.5">
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
        <IconButton
          label={t(paused ? 'assistants.resume' : 'assistants.pause')}
          onClick={togglePause}
          data-action={paused ? 'resume' : 'pause'}
        >
          {paused ? <Play /> : <Pause />}
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton label={t('assistants.actions')} data-action="assistant-menu">
                <Ellipsis />
              </IconButton>
            }
          />
          <DropdownMenuContent align="end" className="w-44">
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
      {error && (
        <p className="shrink-0 bg-destructive/10 px-5 py-1.5 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {tab === 'conversation' ? (
        <AssistantTimeline
          client={client}
          view={view}
          loadingOlder={state.loadingOlder}
          onLoadOlder={state.loadOlder}
          onPosted={state.addPost}
          onError={setError}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-180 px-5 py-6">
            {tab === 'tasks' && (
              <TasksPanel client={client} channel={channel} tasks={view.tasks} onError={setError} />
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
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('assistants.delete.title', { name: channel.title })}
        confirmLabel={t('assistants.delete')}
        failure={(reason) => t('assistants.actionFailed', { error: reason })}
        onConfirm={async () => {
          await client.request('channel.delete', { channelId });
          navigate(paths.assistants());
        }}
      >
        <p>{t('assistants.delete.body')}</p>
      </ConfirmDialog>
    </div>
  );
}
