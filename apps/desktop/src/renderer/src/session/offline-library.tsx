import {
  isRpcError,
  type OfflineConversation,
  offlineTranscript,
  sendOutcomeUnknown,
} from '@wevir/client-sdk';
import type { Session, WevirEvent } from '@wevir/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  browserConversations,
  browserDrafts,
  clearBrowserLibrary,
  saveBrowserConversation,
  watchBrowserLibrary,
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
  const [confirmClear, setConfirmClear] = useState(false);
  const edited = useRef(false);
  const online =
    view.status === 'connected' && client?.can('session.read') === true && identity !== undefined;
  const draftKey = current
    ? `${current.hostId}/${current.clientId}/${current.session.id}`
    : undefined;
  const scope = useRef(draftKey);
  scope.current = draftKey;
  const browser = !capabilities().localHost;
  const reset = useCallback(() => {
    setSaved([]);
    setSessions([]);
    setCurrent(undefined);
    setDraft('');
    setSendUncertain(false);
    setReady(false);
    setLoadedDraftKey(undefined);
    setSending(false);
    setError(undefined);
    edited.current = false;
  }, []);
  useEffect(() => (browser ? watchBrowserLibrary(reset) : undefined), [browser, reset]);
  useEffect(() => {
    if (!browser || !open) return;
    let active = true;
    void browserConversations().then(
      (value) => {
        if (active) setSaved(value);
      },
      () => {
        if (active) setError(t('portable.storageError'));
      },
    );
    if (online && client)
      void client.request('session.list', {}).then(
        ({ sessions }) => {
          if (active) setSessions(sessions);
        },
        () => {
          if (active) setError(t('portable.readError'));
        },
      );
    return () => {
      active = false;
    };
  }, [open, browser, client, online]);
  useEffect(() => {
    setError(undefined);
    setReady(false);
    setLoadedDraftKey(undefined);
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
        if (live) {
          setError(t('portable.storageError'));
          setReady(true);
          setLoadedDraftKey(draftKey);
        }
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
    let caughtUp = false;
    const key = `${selectedHostId}/${selectedClientId}/${selectedSessionId}`;
    const reconcile = async (events: readonly WevirEvent[]) => {
      const previous = await browserDrafts.readState(key);
      const next = await browserDrafts.reconcile(key, events);
      if (active && scope.current === key && previous.uncertain && !next.uncertain) {
        setSendUncertain(false);
        setDraft((current) => (current === previous.submittedText ? next.text : current));
      }
    };
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
        if (item.type === 'event' && item.event.type !== 'engine.raw') {
          events.push(item.event);
          if (caughtUp && item.event.type === 'user.message') await reconcile([item.event]);
        }
        if (events.length > 3000 || JSON.stringify(events).length > 2000000) {
          setError(t('portable.cacheLimit'));
          break;
        }
        if (item.type === 'caught_up') {
          caughtUp = true;
          await reconcile(events);
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
  const transcript = useMemo(() => {
    try {
      return { value: current ? offlineTranscript(current) : undefined, failed: false };
    } catch {
      return { value: undefined, failed: true };
    }
  }, [current]);
  if (!browser) return null;
  const canSend =
    online &&
    client?.can('session.write') === true &&
    current?.hostId === client.hello.hostId &&
    current?.clientId === identity?.clientId &&
    !current?.session.readOnly;
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
        <DialogContent
          aria-describedby={undefined}
          className="flex max-h-[85dvh] flex-col sm:max-w-2xl"
        >
          <DialogHeader>
            <DialogTitle>{t('portable.library')}</DialogTitle>
          </DialogHeader>
          {(error || transcript.failed) && (
            <p role="alert" className="break-words text-destructive">
              {error ?? t('portable.readError')}
            </p>
          )}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            <div className="flex flex-wrap gap-2">
              {saved.map((value) => (
                <Button
                  key={`${value.hostId}/${value.clientId}/${value.session.id}`}
                  variant="outline"
                  size="sm"
                  className="min-w-0 max-w-full truncate"
                  onClick={() => selectConversation(value)}
                >
                  <span className="min-w-0 truncate">{value.session.title}</span>
                </Button>
              ))}
              {online &&
                sessions.map((session) => (
                  <Button
                    key={session.id}
                    variant="ghost"
                    size="sm"
                    className="min-w-0 max-w-full truncate"
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
                    <span className="min-w-0 truncate">{session.title}</span>
                  </Button>
                ))}
            </div>
            {transcript.value?.messages.map((message) => (
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
                  let id: string = crypto.randomUUID();
                  setSending(true);
                  setError(undefined);
                  void (async () => {
                    const attempt = await browserDrafts.begin(key, text, id);
                    id = attempt.clientMessageId;
                    const sentText = attempt.submittedText ?? text;
                    if (scope.current === key) setSendUncertain(true);
                    await client.request(
                      'session.send',
                      {
                        sessionId: current.session.id,
                        content: [{ type: 'text', text: sentText }],
                        clientMessageId: id,
                      },
                      { queue: false },
                    );
                    await browserDrafts.settle(key, sentText, id);
                    if (scope.current === key) {
                      setSendUncertain(false);
                      setDraft((value) => (value === sentText ? '' : value));
                    }
                  })()
                    .catch(async (error: unknown) => {
                      const uncertain = sendOutcomeUnknown(error);
                      if (!uncertain)
                        await browserDrafts.settle(key, undefined, id).catch(() => {
                          if (scope.current === key) setError(t('portable.storageError'));
                        });
                      if (scope.current === key) {
                        setSendUncertain(uncertain);
                        setError(isRpcError(error) ? describe(error) : t('portable.sendUnknown'));
                      }
                    })
                    .finally(() => {
                      if (scope.current === key) setSending(false);
                    });
                }}
              >
                {t('portable.send')}
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={sending}
            onClick={() => setConfirmClear(true)}
          >
            {t('portable.clearCache')}
          </Button>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t('portable.clearCache')}
        confirmLabel={t('portable.clearCache')}
        onConfirm={clearBrowserLibrary}
        failure={() => t('portable.storageError')}
      >
        {t('portable.clearCacheConsequence')}
      </ConfirmDialog>
    </>
  );
}
