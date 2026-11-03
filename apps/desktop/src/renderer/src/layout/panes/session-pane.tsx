import type { Session, SessionId } from '@wevir/protocol';
import { MessagesSquare } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranscript } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { insertQuote } from '@/session/composer';
import { SessionView } from '@/session/session-view';
import { sideReturnText } from '@/session/side-session';
import type { PaneTab } from '../pane-state';

/**
 * 支线窗格（U23.1，desktop-layout.md §17、desktop-tokens.md §30）：参数里的支线会话的完整会话视图——消息流、审批与提问、
 * 自己的输入框。支线不在左栏的列表里，会话本身经 `session.get` 读一次；状态、标题与消息都跟着它的事件流。
 */
export function SessionPane({ tab }: { tab: PaneTab }) {
  const { client } = useHostConnection();
  const sessionId = tab.params?.sessionId as SessionId | undefined;
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!client || !sessionId) return;
    let stopped = false;
    client
      .request('session.get', { sessionId })
      .then((snapshot) => {
        if (!stopped) setSession(snapshot.session);
      })
      .catch((reason: unknown) => {
        if (!stopped) setError(describe(reason));
      });
    return () => {
      stopped = true;
    };
  }, [client, sessionId]);

  if (error) return <Note>{t('side.missing', { error })}</Note>;
  if (!session) return <Note>{t('side.loading')}</Note>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {session.side && session.forkedFrom && <ReturnToMain session={session} />}
      <div className="min-h-0 flex-1">
        <SessionView session={session} variant="pane" />
      </div>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <MessagesSquare aria-hidden className="size-6 stroke-[1.5] text-muted-foreground" />
      <p className="max-w-64 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function ReturnToMain({ session }: { session: Session }) {
  const transcript = useTranscript(session.id)?.transcript;
  const [returned, setReturned] = useState<string>();
  const text = transcript && sideReturnText(transcript);
  return (
    <div className="flex justify-end border-b border-border px-3 py-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={!text || returned === text}
        data-action="return-side"
        onClick={() => {
          if (!text || !session.forkedFrom) return;
          insertQuote(session.forkedFrom.sessionId, text);
          setReturned(text);
        }}
      >
        {t(returned === text && text ? 'side.returned' : 'side.return')}
      </Button>
    </div>
  );
}
