import type { WevirClient } from '@wevir/client-sdk';
import type { SessionId } from '@wevir/protocol';
import { FilePenLine } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { watchBrowserLibrary } from '@/data/browser-library';
import type { TranscriptState } from '@/data/transcript-store';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { EditContent } from './edit-content';
import {
  EDIT_RECOVERY_CHANGED,
  editRecoveryMode,
  readSavedEdit,
  removeSavedEdit,
  type SavedEdit,
  sendSavedEdit,
} from './edit-recovery';

export function EditRecoveryPanel({
  scope,
  sessionId,
  client,
  sending,
  canSend,
  canRewind,
  fromSeq,
  read,
}: {
  scope: string;
  sessionId: SessionId;
  client: WevirClient | undefined;
  sending: boolean;
  canSend: boolean;
  canRewind: boolean;
  fromSeq: number;
  read: () => TranscriptState | undefined;
}) {
  const [draft, setDraft] = useState<SavedEdit>();
  const [mode, setMode] = useState<ReturnType<typeof editRecoveryMode>>();
  const selected = useRef<string>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let version = 0;
    const refresh = async () => {
      const generation = ++version;
      try {
        const saved = await readSavedEdit(scope, sessionId);
        if (generation !== version) return;
        setDraft(saved);
        if (saved?.clientMessageId !== selected.current) setMode(undefined);
        setError(undefined);
      } catch {
        if (generation === version) setError(t('message.editStorageFailed'));
      }
    };
    void refresh();
    const unwatch = watchBrowserLibrary(refresh);
    window.addEventListener(EDIT_RECOVERY_CHANGED, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      ++version;
      unwatch();
      window.removeEventListener(EDIT_RECOVERY_CHANGED, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [scope, sessionId]);
  useEffect(() => {
    if (!draft || sending || editRecoveryMode(draft, read(), canRewind, fromSeq) !== 'accepted')
      return;
    void removeSavedEdit(scope, draft).catch(() => setError(t('message.editStorageFailed')));
  }, [draft, sending, read, scope, canRewind, fromSeq]);
  if (sending) return null;
  if (!draft) return error && <ErrorNote className="mb-2 text-xs">{error}</ErrorNote>;
  const state = () => editRecoveryMode(draft, read(), canRewind, fromSeq);
  const act = async (discard: boolean) => {
    if (busy || !mode) return;
    setBusy(true);
    setError(undefined);
    try {
      const current = state();
      if (discard || current === 'accepted') await removeSavedEdit(scope, draft);
      else if (!client || !canSend || current !== mode || current === 'waiting') {
        setMode(current);
        setError(t('message.editChanged'));
        return;
      } else await sendSavedEdit(client, scope, draft, current === 'replace');
      setMode(undefined);
    } catch (reason) {
      setError(t('message.editFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="mb-2 flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-1.5 text-sm"
      data-edit-recovery
    >
      <FilePenLine aria-hidden className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1">{t('message.editSaved')}</span>
      <Button
        size="xs"
        variant="outline"
        onClick={() => {
          setError(undefined);
          selected.current = draft.clientMessageId;
          setMode(state());
        }}
      >
        {t('message.editOpen')}
      </Button>
      {mode && (
        <Dialog open onOpenChange={(open) => !open && !busy && setMode(undefined)}>
          <DialogContent className="sm:max-w-md">
            <DialogTitle>{t('message.editSaved')}</DialogTitle>
            <div className="max-h-[45vh] overflow-auto rounded-md bg-muted/55 p-2.5">
              <EditContent content={draft.content} />
            </div>
            {mode === 'replace' && (
              <p className="text-xs text-muted-foreground">{t('message.editHistoryImpact')}</p>
            )}
            {mode === 'accepted' && (
              <p className="text-xs text-muted-foreground">{t('message.editAccepted')}</p>
            )}
            {error && <ErrorNote className="text-xs">{error}</ErrorNote>}
            <DialogFooter>
              {mode !== 'accepted' && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(true)}>
                  {t('message.editDiscard')}
                </Button>
              )}
              <Button
                size="sm"
                disabled={busy || (mode !== 'accepted' && (!canSend || mode === 'waiting'))}
                onClick={() => void act(false)}
              >
                {t(
                  mode === 'replace'
                    ? 'message.editHistoryConfirm'
                    : mode === 'append'
                      ? 'message.editAppend'
                      : mode === 'accepted'
                        ? 'common.close'
                        : 'message.editSend',
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
