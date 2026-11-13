import {
  isRpcError,
  type OfflineConversation,
  offlineTranscript,
  sendOutcomeUnknown,
} from '@wevir/client-sdk';
import type { Session, WevirEvent } from '@wevir/protocol';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  browserConversations,
  browserDrafts,
  clearBrowserLibrary,
  saveBrowserConversation,
} from '@/data/browser-library';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { capabilities } from '@/platform/platform';

export function OfflineLibrary() {
  const { client, view, identity } = useHostConnection();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<OfflineConversation[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [current, setCurrent] = useState<OfflineConversation>();
  const [draft, setDraft] = useState('');
  const [ready, setReady] = useState(false);
  const [loadedDraftKey, setLoadedDraftKey] = useState<string>();
  const [sendUncertain, setSendUncertain] = useState(false);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const edited = useRef(false);
  const online =
    view.status === 'connected' && client?.can('session.read') === true && identity !== undefined;
  const draftKey = current
    ? `${current.hostId}/${current.clientId}/${current.session.id}`
    : undefined;
  const scope = useRef(draftKey);
  scope.current = draftKey;
  const browser = !capabilities().localHost;
  useEffect(() => {
    if (!browser || !open) return;
    void browserConversations().then(setSaved, () => setError(t('portable.storageError')));
    if (online && client)
      void client.request('session.list', {}).then(
        ({ sessions }) => setSessions(sessions),
        () => setError(t('portable.readError')),
      );
  }, [open, browser, client, online]);
  useEffect(() => {
    setReady(false);
    setSendUncertain(false);
    edited.current = false;
    if (!draftKey) return;
    let live = true;
    void browserDrafts.readState(draftKey).then(
      (value) => {
        if (live) {
          if (!edited.current) setDraft(value.text);
          setSendUncertain(value.uncertain);
          setReady(true);
          setLoadedDraftKey(draftKey);
        }
      },
      () => {
        if (live) setError(t('portable.storageError'));
      },
    );
    return () => {
      live = false;
    };
  }, [draftKey]);
  useEffect(() => {
    if (draftKey && ready && loadedDraftKey === draftKey)
      void browserDrafts
        .writeState(draftKey, { text: draft, uncertain: sendUncertain })
        .catch(() => setError(t('portable.storageError')));
  }, [draftKey, draft, ready, loadedDraftKey, sendUncertain]);
  const selectedSessionId = current?.session.id;
  const selectedHostId = current?.hostId;
  const selectedClientId = current?.clientId;
  useEffect(() => {
    if (
      !open ||
      !online ||
      !client ||
      !selectedSessionId ||
      selectedHostId !== client.hello.hostId ||
      selectedClientId !== identity?.clientId
    )
      return;
    let active = true;
    const events: WevirEvent[] = [];
    const subscription = client.subscribe(selectedSessionId, { elideSuperseded: true });
    void (async () => {
      const { session } = await client.request(
        'session.get',
        { sessionId: selectedSessionId },
        { queue: false },
      );
      for await (const item of subscription) {
        if (!active) break;
        if (item.type === 'reset') events.length = 0;
        if (item.type === 'event' && item.event.type !== 'engine.raw') events.push(item.event);
        if (events.length > 3000 || JSON.stringify(events).length > 2000000) {
          setError(t('portable.cacheLimit'));
          break;
        }
        if (item.type === 'caught_up') {
          const value: OfflineConversation = {
            hostId: client.hello.hostId,
            clientId: identity?.clientId ?? '',
            session,
            events: [...events],
            savedAt: new Date().toISOString(),
          };
          if (active) {
            setCurrent(value);
            await saveBrowserConversation(value);
          }
        }
      }
    })().catch(() => {
      if (active) setError(t('portable.readError'));
    });
    return () => {
      active = false;
      subscription.close();
    };
  }, [
    open,
    online,
    client,
    selectedHostId,
    selectedClientId,
    selectedSessionId,
    identity?.clientId,
  ]);
  if (!browser) return null;
  const canSend =
    online &&
    client?.can('session.write') === true &&
    current?.hostId === client.hello.hostId &&
    current?.clientId === identity?.clientId &&
    !current?.session.readOnly;
  const transcript = current ? offlineTranscript(current) : undefined;
  const selectConversation = (value: OfflineConversation) => {
    if (
      current?.hostId === value.hostId &&
      current.clientId === value.clientId &&
      current.session.id === value.session.id
    )
      return;
    setDraft('');
    setCurrent(value);
  };
  return (
    <>
      <Button
        className="fixed right-4 bottom-4 z-40"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        {t('portable.library')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('portable.library')}</DialogTitle>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            <div className="flex flex-wrap gap-2">
              {saved.map((value) => (
                <Button
                  key={`${value.hostId}/${value.clientId}/${value.session.id}`}
                  variant="outline"
                  size="sm"
                  onClick={() => selectConversation(value)}
                >
                  {value.session.title}
                </Button>
              ))}
              {online &&
                sessions.map((session) => (
                  <Button
                    key={session.id}
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (client) {
                        selectConversation({
                          hostId: client.hello.hostId,
                          clientId: identity?.clientId ?? '',
                          session,
                          events: [],
                          savedAt: new Date().toISOString(),
                        });
                      }
                    }}
                  >
                    {session.title}
                  </Button>
                ))}
            </div>
            {transcript?.messages.map((message) => (
              <div key={message.id} className="space-y-1 border-b border-border py-2">
                <p className="whitespace-pre-wrap break-words">
                  {message.parts
                    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                    .join('\n')}
                </p>
              </div>
            ))}
          </div>
          {current && (
            <>
              <p className="text-xs text-muted-foreground">
                {t(sendUncertain ? 'portable.sendUnknown' : 'portable.draft')}
              </p>
              <Textarea
                aria-label={t(sendUncertain ? 'portable.sendUnknown' : 'portable.draft')}
                value={draft}
                onChange={(e) => {
                  edited.current = true;
                  setDraft(e.target.value);
                }}
              />
              <Button
                disabled={!canSend || !ready || !draft.trim() || sending}
                onClick={() => {
                  if (!client || !current || !canSend) return;
                  const text = draft;
                  const key = draftKey as string;
                  setSending(true);
                  setError(undefined);
                  void (async () => {
                    await browserDrafts.writeState(key, { text, uncertain: true });
                    if (scope.current === key) setSendUncertain(true);
                    await client.request(
                      'session.send',
                      {
                        sessionId: current.session.id,
                        content: [{ type: 'text', text }],
                        clientMessageId: crypto.randomUUID(),
                      },
                      { queue: false },
                    );
                    await browserDrafts.settle(key, text);
                    if (scope.current === key) {
                      setSendUncertain(false);
                      setDraft((value) => (value === text ? '' : value));
                    }
                  })()
                    .catch(async (error: unknown) => {
                      const uncertain = sendOutcomeUnknown(error);
                      if (!uncertain)
                        await browserDrafts.settle(key).catch(() => {
                          if (scope.current === key) setError(t('portable.storageError'));
                        });
                      if (scope.current === key) {
                        setSendUncertain(uncertain);
                        setError(isRpcError(error) ? describe(error) : t('portable.sendUnknown'));
                      }
                    })
                    .finally(() => setSending(false));
                }}
              >
                {t('portable.send')}
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void clearBrowserLibrary().then(
                () => {
                  setSaved([]);
                  setCurrent(undefined);
                  setDraft('');
                },
                () => setError(t('portable.storageError')),
              );
            }}
          >
            {t('portable.clearCache')}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
