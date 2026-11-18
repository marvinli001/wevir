// 助理开出的线程（0.120.0）：线程会话在助理的隐藏工作区里，不在左栏的数据与会话路由里，这里按 ID 经 `session.get` 读一次，之后交给
// 会话视图跟它的事件流。两种开法：时间线旁边的窗格（`?thread=`），或占满右边（`/assistants/:channelId/thread/:sessionId`）。

import type { WevirClient } from '@wevir/client-sdk';
import type { Channel, ChannelId, ChannelThread, Session, SessionId } from '@wevir/protocol';
import {
  ArrowLeft,
  Check,
  Ellipsis,
  GitBranch,
  Maximize2,
  MessagesSquare,
  PanelRight,
  RotateCcw,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ErrorNote } from '@/components/error-note';
import { IconButton } from '@/components/icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { SessionView } from '@/session/session-view';
import { AssistantAvatar } from './assistant-avatar';
import { panelSupported } from './assistants-model';
import { useAssistantView } from './use-assistants';

/** 按 ID 读一个会话再画会话视图；读不到时写原因。 */
function ThreadSession({
  client,
  sessionId,
  variant,
  onLoaded,
}: {
  client: WevirClient;
  sessionId: SessionId;
  variant: 'main' | 'pane';
  onLoaded?: (session: Session) => void;
}) {
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState<string>();
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  useEffect(() => {
    let stopped = false;
    setSession(undefined);
    setError(undefined);
    client
      .request('session.get', { sessionId })
      .then((snapshot) => {
        if (stopped) return;
        setSession(snapshot.session);
        loaded.current?.(snapshot.session);
      })
      .catch((reason: unknown) => {
        if (!stopped) setError(describe(reason));
      });
    return () => {
      stopped = true;
    };
  }, [client, sessionId]);
  if (error) return <Note>{t('assistants.thread.missing', { error })}</Note>;
  if (!session) return <Note>{t('assistants.thread.loading')}</Note>;
  return <SessionView key={session.id} session={session} variant={variant} />;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <MessagesSquare aria-hidden className="size-6 stroke-[1.5] text-muted-foreground" />
      <p className="max-w-64 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function ThreadHeader({
  title,
  children,
  leading,
  assistant,
}: {
  title: string;
  children: ReactNode;
  leading?: ReactNode;
  assistant?: Channel;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      {leading ??
        (assistant?.assistant ? (
          <AssistantAvatar avatar={assistant.assistant.avatar} size={24} />
        ) : (
          <GitBranch aria-hidden className="ml-1 size-4 shrink-0 text-muted-foreground" />
        ))}
      <div className="min-w-0 flex-1">
        {assistant && <p className="truncate text-xs text-muted-foreground">{assistant.title}</p>}
        <h2 className="truncate text-sm font-medium">{title}</h2>
      </div>
      {children}
    </header>
  );
}

function ThreadMenu({
  client,
  channelId,
  sessionId,
  resolved: initial,
}: {
  client: WevirClient;
  channelId: ChannelId;
  sessionId: SessionId;
  resolved: boolean;
}) {
  const [resolved, setResolved] = useState(initial);
  const [error, setError] = useState<string>();
  useEffect(() => setResolved(initial), [initial]);
  const toggle = async () => {
    try {
      const { thread } = await client.request('channel.resolveThread', {
        channelId,
        sessionId,
        resolved: !resolved,
      });
      setResolved(thread.status === 'resolved');
      setError(undefined);
    } catch (reason) {
      setError(describe(reason));
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <IconButton label={t('assistants.actions')} data-action="thread-menu">
            <Ellipsis />
          </IconButton>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={toggle} data-action={resolved ? 'reopen' : 'resolve'}>
          {resolved ? <RotateCcw /> : <Check />}
          {t(
            resolved
              ? 'assistants.thread.reopen'
              : panelSupported(client.hello.features)
                ? 'assistants.thread.complete'
                : 'assistants.thread.resolve',
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
      {error !== undefined && (
        <ErrorNote className="max-w-40 text-xs [&>span]:truncate" title={error}>
          {error}
        </ErrorNote>
      )}
    </DropdownMenu>
  );
}

/** 时间线旁边的线程窗格：标题、“在主视图打开”、关闭。 */
export function ThreadPane({
  client,
  channelId,
  sessionId,
  thread,
  assistant,
  onClose,
}: {
  client: WevirClient;
  channelId: ChannelId;
  sessionId: SessionId;
  thread: ChannelThread | undefined;
  assistant?: Channel;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  return (
    <aside
      className="flex w-[min(30rem,50%)] shrink-0 flex-col border-l border-border"
      aria-label={t('assistants.thread.pane')}
      data-thread-pane={sessionId}
    >
      <ThreadHeader title={thread?.title ?? t('assistants.thread.pane')} assistant={assistant}>
        {thread !== undefined && (
          <ThreadMenu
            key={sessionId}
            client={client}
            channelId={channelId}
            sessionId={sessionId}
            resolved={thread.status === 'resolved'}
          />
        )}
        <IconButton
          label={t('assistants.thread.openMain')}
          onClick={() => navigate(paths.assistantThread(channelId, sessionId))}
          data-action="thread-main"
        >
          <Maximize2 />
        </IconButton>
        <IconButton label={t('common.close')} onClick={onClose} data-action="thread-close">
          <X />
        </IconButton>
      </ThreadHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        <ThreadSession client={client} sessionId={sessionId} variant="pane" />
      </div>
    </aside>
  );
}

/** 占满右边的线程：返回助理的对话、“在窗格中打开”（页面窄到放不下窗格时没有）。 */
export function ThreadPage({
  client,
  channelId,
  sessionId,
  paneAvailable,
  assistant,
}: {
  client: WevirClient;
  channelId: ChannelId;
  sessionId: SessionId;
  paneAvailable: boolean;
  assistant?: Channel;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState<string>();
  const panel = panelSupported(client.hello.features);
  const view = useAssistantView(client, channelId);
  const thread = view.view?.threads.find((item) => item.sessionId === sessionId);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-thread-page={sessionId}>
      <ThreadHeader
        title={title ?? ''}
        assistant={panel ? assistant : undefined}
        leading={
          <IconButton
            label={t('assistants.thread.back')}
            onClick={() => navigate(paths.assistant(channelId))}
            data-action="thread-back"
          >
            <ArrowLeft />
          </IconButton>
        }
      >
        {panel && thread !== undefined && (
          <ThreadMenu
            client={client}
            channelId={channelId}
            sessionId={sessionId}
            resolved={thread.status === 'resolved'}
          />
        )}
        {paneAvailable && (
          <IconButton
            label={t('assistants.thread.openPane')}
            onClick={() => navigate(paths.assistantThread(channelId, sessionId, true))}
            data-action="thread-pane"
          >
            <PanelRight />
          </IconButton>
        )}
      </ThreadHeader>
      <ThreadSession
        client={client}
        sessionId={sessionId}
        variant="main"
        onLoaded={(session) => setTitle(session.title)}
      />
    </div>
  );
}
