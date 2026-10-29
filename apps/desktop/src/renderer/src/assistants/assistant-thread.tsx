// 助理开出的线程（0.120.0）：线程会话在助理的隐藏工作区里，不在左栏的数据与会话路由里，这里按 ID 经 `session.get` 读一次，之后交给
// 会话视图跟它的事件流。两种开法：时间线旁边的窗格（`?thread=`），或占满右边（`/assistants/:channelId/thread/:sessionId`）。

import type { WevirClient } from '@wevir/client-sdk';
import type { ChannelId, ChannelThread, Session, SessionId } from '@wevir/protocol';
import { ArrowLeft, GitBranch, Maximize2, MessagesSquare, PanelRight, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { SessionView } from '@/session/session-view';

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
}: {
  title: string;
  children: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      {leading ?? <GitBranch aria-hidden className="ml-1 size-4 shrink-0 text-muted-foreground" />}
      <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
      {children}
    </header>
  );
}

/** 时间线旁边的线程窗格：标题、“在主视图打开”、关闭。 */
export function ThreadPane({
  client,
  channelId,
  sessionId,
  thread,
  onClose,
}: {
  client: WevirClient;
  channelId: ChannelId;
  sessionId: SessionId;
  thread: ChannelThread | undefined;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  return (
    <aside
      className="flex w-[min(30rem,50%)] shrink-0 flex-col border-l border-border"
      aria-label={t('assistants.thread.pane')}
      data-thread-pane={sessionId}
    >
      <ThreadHeader title={thread?.title ?? t('assistants.thread.pane')}>
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
}: {
  client: WevirClient;
  channelId: ChannelId;
  sessionId: SessionId;
  paneAvailable: boolean;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState<string>();
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-thread-page={sessionId}>
      <ThreadHeader
        title={title ?? ''}
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
