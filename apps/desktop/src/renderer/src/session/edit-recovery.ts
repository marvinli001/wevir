import type { WevirClient } from '@wevir/client-sdk';
import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  messageContentIssue,
  type SessionId,
  type TurnId,
  type UserContentPart,
} from '@wevir/protocol';
import { browserLibraryDatabase } from '@/data/browser-library';
import type { TranscriptState } from '@/data/transcript-store';
import { t } from '@/i18n';
import { currentComposerScope } from './composer-drafts';
import { lastTurnId } from './turn-model';

export interface SavedEdit {
  sessionId: SessionId;
  turnId: TurnId;
  latest: TurnId;
  history: boolean;
  content: UserContentPart[];
  collaborationMode?: 'plan';
  clientMessageId: string;
}

export const EDIT_RECOVERY_CHANGED = 'wevir:edit-recovery';

export function editRecoveryMode(
  draft: SavedEdit,
  state: TranscriptState | undefined,
  canRewind: boolean,
  fromSeq: number,
) {
  if (!state?.caughtUp) return 'waiting';
  const t = state.transcript;
  if (
    t.messages.some((m) => m.role === 'user' && m.clientMessageId === draft.clientMessageId) ||
    t.pendingMessages.some((m) => m.clientMessageId === draft.clientMessageId)
  )
    return 'accepted';
  const original = t.messages.find(
    (m) => m.role === 'user' && !m.steered && m.turnId === draft.turnId,
  );
  if (!original) return 'send';
  return canRewind && original.seqRange[0] >= fromSeq && lastTurnId(t) === draft.latest
    ? 'replace'
    : 'append';
}

async function transaction<T>(
  scope: string,
  mode: IDBTransactionMode,
  run: (table: IDBObjectStore, result: (value: T) => void) => void,
): Promise<T> {
  const db = await browserLibraryDatabase();
  if (scope !== currentComposerScope()) throw new Error(t('message.editStorageFailed'));
  return new Promise((resolve, reject) => {
    const tx = db.transaction('composer', mode, { durability: 'strict' });
    let value: T;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(tx.error ?? new Error(t('message.editStorageFailed')));
    run(tx.objectStore('composer'), (next) => {
      value = next;
    });
  });
}

export async function readSavedEdit(scope: string, sessionId: SessionId) {
  if (scope !== currentComposerScope()) return undefined;
  return transaction<SavedEdit | undefined>(scope, 'readonly', (table, done) => {
    const get = table.get(['edit-recovery', scope, sessionId]);
    get.onsuccess = () => done(get.result);
  });
}

export async function saveEdit(scope: string, draft: SavedEdit) {
  if (
    messageContentIssue(draft.content) ||
    draft.content.reduce((sum, part) => sum + (part.type === 'text' ? 0 : part.size), 0) >
      MESSAGE_ATTACHMENT_MAX_BYTES
  ) {
    throw new Error(t('message.editLimit'));
  }
  try {
    await transaction<void>(scope, 'readwrite', (table) => {
      table.add(draft, ['edit-recovery', scope, draft.sessionId]);
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'ConstraintError')
      throw new Error(t('message.editPending'));
    throw new Error(t('message.editStorageFailed'), { cause: error });
  }
  window.dispatchEvent(new Event(EDIT_RECOVERY_CHANGED));
}

export async function removeSavedEdit(scope: string, draft: SavedEdit) {
  await transaction<void>(scope, 'readwrite', (table) => {
    const key = ['edit-recovery', scope, draft.sessionId];
    const get = table.get(key);
    get.onsuccess = () => {
      if (get.result?.clientMessageId === draft.clientMessageId) table.delete(key);
    };
  });
  window.dispatchEvent(new Event(EDIT_RECOVERY_CHANGED));
}

export async function sendSavedEdit(
  client: WevirClient,
  scope: string,
  draft: SavedEdit,
  rewind: boolean,
) {
  const current = await readSavedEdit(scope, draft.sessionId);
  if (current?.clientMessageId !== draft.clientMessageId) throw new Error(t('message.editChanged'));
  if (rewind) {
    await client.request('session.rewind', {
      sessionId: draft.sessionId,
      turnId: draft.turnId,
      ...(draft.history && { through: true, expectedLatestTurnId: draft.latest }),
    });
  }
  await client.request('session.send', {
    sessionId: draft.sessionId,
    clientMessageId: draft.clientMessageId,
    content: draft.content,
    ...(draft.collaborationMode && { collaborationMode: draft.collaborationMode }),
  });
  await removeSavedEdit(scope, draft);
}
