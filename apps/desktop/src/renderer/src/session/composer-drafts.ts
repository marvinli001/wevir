import {
  IMAGE_MAX_PER_MESSAGE,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_TEXT_MAX_LENGTH,
  type SessionId,
} from '@wevir/protocol';
import { browserLibraryDatabase, watchBrowserLibrary } from '@/data/browser-library';
import { t } from '@/i18n';
import { createStore } from '@/lib/store';
import { ComposerHistory } from './composer-history';
import type { ComposerAttachmentPart, SourceImageType } from './composer-images';

export interface DraftAttachment {
  key: string;
  kind: 'image' | 'file';
  size: number;
  name?: string;
  thumbnail?: string;
  sourceType?: SourceImageType;
  failure?: string;
  blob?: Blob;
  // 编辑既有消息时已经有 Host 引用。新附件保留本地字节，重启后可重新上传。
  part?: ComposerAttachmentPart;
}
export interface ComposerDraft {
  text: string;
  pastes: readonly { key: string; text: string }[];
  attachments: readonly DraftAttachment[];
}
const empty: ComposerDraft = { text: '', pastes: [], attachments: [] };

export function hasDraft(draft: ComposerDraft): boolean {
  return !!(draft.text.trim() || draft.pastes.length || draft.attachments.length);
}
export function textLength(draft: ComposerDraft): number {
  return draft.text.length + draft.pastes.reduce((sum, paste) => sum + paste.text.length, 0);
}
export function attachmentBytes(draft: ComposerDraft): number {
  return draft.attachments.reduce(
    (sum, attachment) => sum + (attachment.sourceType ? 0 : attachment.size),
    0,
  );
}
export function draftIssue(draft: ComposerDraft): string | undefined {
  if (textLength(draft) > MESSAGE_TEXT_MAX_LENGTH)
    return t('composer.textLimit', { count: MESSAGE_TEXT_MAX_LENGTH });
  if (draft.attachments.length > IMAGE_MAX_PER_MESSAGE)
    return t('composer.attachmentLimit', { count: IMAGE_MAX_PER_MESSAGE });
  if (attachmentBytes(draft) > MESSAGE_ATTACHMENT_MAX_BYTES)
    return t('composer.attachmentBudget', { count: MESSAGE_ATTACHMENT_MAX_BYTES / 1024 / 1024 });
  return undefined;
}
export interface DraftState {
  draft: ComposerDraft;
  error?: string | undefined;
}
type Edit = (draft: ComposerDraft) => ComposerDraft;
let scope: string | undefined;
const drafts = new Map<string, ReturnType<typeof makeDraft>>();
const generation = createStore(0);
function clearStores() {
  const previous = [...drafts.values()];
  drafts.clear();
  for (const draft of previous) draft.reset();
  generation.set((value) => value + 1);
}
export function bindComposerDrafts(hostId: string, clientId: string) {
  const next = `${hostId}/${clientId}`;
  if (scope !== next) {
    scope = next;
    clearStores();
  }
}
export function unbindComposerDrafts() {
  scope = undefined;
  clearStores();
}
watchBrowserLibrary(clearStores);
export function currentComposerScope() {
  return scope;
}
export function useComposerScope() {
  generation.use();
  return currentComposerScope();
}

function makeDraft(key: string) {
  const owner = scope;
  const id = `${owner}/${key}`;
  const state = createStore<DraftState>({ draft: empty });
  let ready = false;
  let alive = true;
  const queued: Edit[] = [];
  const fail = () => {
    if (alive) state.set((s) => ({ ...s, error: t('composer.draftStorageFailed') }));
  };
  const write = async (run: (table: IDBObjectStore) => void) => {
    if (owner === undefined) return;
    try {
      const db = await browserLibraryDatabase();
      if (!alive || owner !== scope) return;
      const tx = db.transaction('composer', 'readwrite');
      run(tx.objectStore('composer'));
      tx.onabort = fail;
    } catch {
      fail();
    }
  };
  const writeDraft = (table: IDBObjectStore, previous: ComposerDraft, draft: ComposerDraft) => {
    if (previous.text !== draft.text) {
      if (draft.text) table.put(draft.text, [id, 'text']);
      else table.delete([id, 'text']);
    }
    // 保留附件顺序。修改文字、添加下一张图时，都不重写已有的 Blob。
    if (previous.pastes !== draft.pastes || previous.attachments !== draft.attachments) {
      if (draft.pastes.length || draft.attachments.length) {
        table.put({ pastes: draft.pastes, ids: draft.attachments.map((a) => a.key) }, [
          id,
          'parts',
        ]);
      } else table.delete([id, 'parts']);
      const old = new Map(previous.attachments.map((a) => [a.key, a]));
      for (const item of draft.attachments) {
        if (old.get(item.key) !== item) table.put(item, [id, 'attachment', item.key]);
        old.delete(item.key);
      }
      for (const key of old.keys()) table.delete([id, 'attachment', key]);
    }
  };
  const persist = (previous: ComposerDraft, draft: ComposerDraft) =>
    void write((table) => writeDraft(table, previous, draft));
  const history = new ComposerHistory(
    owner !== undefined ? id : undefined,
    () => alive && scope === owner,
    fail,
  );
  const loaded = (async () => {
    let saved = empty;
    try {
      if (owner !== undefined) {
        const db = await browserLibraryDatabase();
        if (!alive || owner !== scope) return;
        const tx = db.transaction('composer');
        const table = tx.objectStore('composer');
        const text = table.get([id, 'text']);
        const parts = table.get([id, 'parts']);
        const media = table.getAll(IDBKeyRange.bound([id, 'attachment'], [id, 'attachment', []]));
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        const byId = new Map<string, DraftAttachment>(
          (media.result as DraftAttachment[]).map((a) => [a.key, a]),
        );
        saved = {
          text: text.result ?? '',
          pastes: parts.result?.pastes ?? [],
          attachments: (parts.result?.ids ?? []).flatMap((key: string) => byId.get(key) ?? []),
        };
      }
    } catch {
      fail();
    }
    if (!alive || owner !== scope) return;
    ready = true;
    const draft = queued.splice(0).reduce((current, change) => change(current), saved);
    state.set((s) => ({ ...s, draft }));
    if (draft !== saved) persist(saved, draft);
  })();
  const edit = (change: Edit) => {
    if (!alive) return;
    const prev = state.get().draft;
    const draft = change(prev);
    if (!ready) queued.push(change);
    if (draft === prev) return;
    state.set((s) => ({ ...s, draft }));
    if (ready) persist(prev, draft);
  };
  const finish = async (sent: ComposerDraft, destination: ComposerHistory) => {
    await loaded;
    if (!alive || scope !== owner) return;
    const previous = state.get().draft;
    const pastes = new Set(sent.pastes.map((p) => p.key));
    const attached = new Set(sent.attachments.map((p) => p.key));
    const draft: ComposerDraft = {
      text: previous.text === sent.text ? '' : previous.text,
      pastes: previous.pastes.filter((p) => !pastes.has(p.key)),
      attachments: previous.attachments.filter((p) => !attached.has(p.key)),
    };
    state.set((s) => ({ ...s, draft }));
    await destination.append(sent, (table) => writeDraft(table, previous, draft));
  };
  return {
    ...state,
    edit,
    history,
    finish,
    loaded,
    reset() {
      alive = false;
      state.set({ draft: empty });
    },
  };
}

export function draftFor(key: string) {
  let draft = drafts.get(key);
  if (!draft) {
    draft = makeDraft(key);
    drafts.set(key, draft);
  }
  return draft;
}
export function useComposerDraft(key: string) {
  generation.use();
  const store = draftFor(key);
  const state = store.use();
  return { ...state, store };
}
/** Host 确认永久删除后，删除该会话/频道在本连接的草稿、检索索引和附件。 */
export async function deleteComposerInputs(keys: readonly string[]) {
  const owner = scope;
  for (const key of keys) drafts.get(key)?.reset();
  try {
    if (owner && keys.length) {
      const db = await browserLibraryDatabase();
      const tx = db.transaction('composer', 'readwrite');
      const table = tx.objectStore('composer');
      for (const key of keys) {
        const id = `${owner}/${key}`;
        table.delete(IDBKeyRange.bound([id], [id, []]));
        table.delete(['edit-recovery', owner, key]);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    }
  } finally {
    if (scope === owner) {
      for (const key of keys) drafts.delete(key);
      generation.set((n) => n + 1);
    }
  }
}
export function finishComposerSend(key: string, sent: ComposerDraft, destination?: SessionId) {
  return draftFor(key).finish(sent, draftFor(destination ?? key).history);
}
