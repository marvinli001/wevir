import { type OfflineConversation, offlineTranscript, PersistentDrafts } from '@wevir/client-sdk';

let opened: Promise<IDBDatabase> | undefined;
function database() {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('wevir-derived-library', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('browser storage unavailable'));
  });
  return opened;
}
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', mode);
    const request = run(tx.objectStore('records'));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(new Error('browser storage unavailable'));
    tx.onerror = () => reject(new Error('browser storage unavailable'));
  });
}
const key = (value: OfflineConversation) =>
  `conversation/${value.hostId}/${value.clientId}/${value.session.id}`;
export async function saveBrowserConversation(value: OfflineConversation) {
  if (value.events.length > 3000 || JSON.stringify(value.events).length > 2000000) return;
  await transaction('readwrite', (store) => store.put({ kind: 'conversation', value }, key(value)));
  const all = await browserConversations();
  for (const old of all.slice(30))
    await transaction('readwrite', (store) => store.delete(key(old)));
}
export async function browserConversations(): Promise<OfflineConversation[]> {
  const rows = await transaction<unknown[]>('readonly', (store) => store.getAll());
  const values = rows
    .filter(
      (row): row is { kind: 'conversation'; value: OfflineConversation } =>
        typeof row === 'object' &&
        row !== null &&
        (row as { kind?: string }).kind === 'conversation',
    )
    .map((row) => row.value)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  for (const value of values) offlineTranscript(value);
  return values;
}
export async function clearBrowserLibrary() {
  await transaction('readwrite', (store) => store.clear());
}
export const browserDrafts = new PersistentDrafts({
  get: async (key) => {
    const row = await transaction<unknown>('readonly', (store) => store.get(`draft/${key}`));
    return typeof row === 'string' ? row : undefined;
  },
  set: async (key, value) => {
    await transaction('readwrite', (store) => store.put(value, `draft/${key}`));
  },
  delete: async (key) => {
    await transaction('readwrite', (store) => store.delete(`draft/${key}`));
  },
});
