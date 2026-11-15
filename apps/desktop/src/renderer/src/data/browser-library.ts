import { type OfflineConversation, offlineTranscript, PersistentDrafts } from '@wevir/client-sdk';

let opened: Promise<IDBDatabase> | undefined;
let blocked = false;
let activeScope: string | undefined;
let cacheGeneration = 0;
let authorizationGeneration = 0;
const cleared = new Set<() => void>();
const epoch = '1970-01-01T00:00:00.000Z';
function database() {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('wevir-derived-library', 2);
    let failed = false;
    const unavailable = () => {
      failed = true;
      clearTimeout(timeout);
      reject(new Error('browser storage unavailable'));
    };
    const timeout = setTimeout(unavailable, 5000);
    request.onblocked = unavailable;
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains('records')
        ? (request.transaction as IDBTransaction).objectStore('records')
        : request.result.createObjectStore('records');
      if (!store.indexNames.contains('savedAt')) store.createIndex('savedAt', 'savedAt');
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        const name = String(item.key),
          row = item.value;
        if (name.startsWith('draft/') && typeof row === 'string')
          item.update({ kind: 'draft', value: row, savedAt: epoch });
        else if (row?.kind === 'conversation')
          item.update({ ...row, savedAt: row.value?.savedAt ?? epoch });
        item.continue();
      };
    };
    request.onsuccess = () => {
      clearTimeout(timeout);
      if (failed) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => {
        request.result.close();
        opened = undefined;
      };
      resolve(request.result);
    };
    request.onerror = unavailable;
  }).catch((error: unknown) => {
    opened = undefined;
    throw error;
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
async function records() {
  const db = await database();
  return new Promise<{ rows: unknown[]; keys: IDBValidKey[] }>((resolve, reject) => {
    const tx = db.transaction('records'),
      store = tx.objectStore('records');
    const rows = store.getAll(),
      keys = store.getAllKeys();
    tx.oncomplete = () => resolve({ rows: rows.result, keys: keys.result });
    tx.onerror = () => reject(new Error('browser storage unavailable'));
  });
}
const key = (value: OfflineConversation) =>
  `conversation/${value.hostId}/${value.clientId}/${value.session.id}`;
const scope = (name: string) =>
  name.startsWith('conversation/')
    ? name.slice(13)
    : name.startsWith('draft/')
      ? name.slice(6).replace(/\/state-v1$/, '')
      : undefined;
async function remove(keys: readonly IDBValidKey[]) {
  if (keys.length)
    await transaction('readwrite', (store) => {
      for (const key of keys) store.delete(key);
      return store.count();
    });
}
async function prune() {
  const db = await database();
  const stale = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const tx = db.transaction('records'),
      cursor = tx.objectStore('records').index('savedAt').openKeyCursor(null, 'prev');
    const scopes = new Set<string>(),
      keys: IDBValidKey[] = [];
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return;
      const group = scope(String(item.primaryKey));
      if (group && !scopes.has(group)) {
        if (scopes.size < 30) scopes.add(group);
        else keys.push(item.primaryKey);
      }
      item.continue();
    };
    tx.oncomplete = () => resolve(keys);
    tx.onerror = () => reject(new Error('browser storage unavailable'));
  });
  await remove(stale);
}
function writable(name: string) {
  return !blocked && (activeScope === undefined || name.startsWith(`${activeScope}/`));
}
export async function saveBrowserConversation(value: OfflineConversation) {
  if (!writable(`${value.hostId}/${value.clientId}/${value.session.id}`)) return;
  if (value.events.length > 3000 || JSON.stringify(value.events).length > 2000000) return;
  await transaction('readwrite', (store) => {
    if (writable(`${value.hostId}/${value.clientId}/${value.session.id}`))
      store.put({ kind: 'conversation', value, savedAt: value.savedAt }, key(value));
    return store.count();
  });
  await prune();
}
export async function browserConversations(): Promise<OfflineConversation[]> {
  if (blocked) return [];
  const generation = cacheGeneration;
  const { rows, keys } = await records();
  const values: OfflineConversation[] = [],
    invalid: IDBValidKey[] = [];
  for (const [index, raw] of rows.entries()) {
    if ((raw as { kind?: string } | null)?.kind !== 'conversation') continue;
    const value = (raw as { value: OfflineConversation }).value;
    try {
      if (
        !value ||
        typeof value.savedAt !== 'string' ||
        typeof value.hostId !== 'string' ||
        typeof value.clientId !== 'string'
      )
        throw new Error('invalid cache entry');
      offlineTranscript(value);
      if (key(value) !== keys[index]) throw new Error('invalid cache key');
      values.push(value);
    } catch {
      const name = keys[index];
      if (name !== undefined) invalid.push(name);
    }
  }
  if (generation !== cacheGeneration || blocked) return [];
  await remove(invalid);
  if (generation !== cacheGeneration || blocked) return [];
  values.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return values;
}
export async function clearBrowserLibrary() {
  cacheGeneration++;
  await browserDrafts.drain();
  await transaction('readwrite', (store) => store.clear());
  for (const listener of cleared) listener();
}
export function watchBrowserLibrary(listener: () => void) {
  cleared.add(listener);
  return () => {
    cleared.delete(listener);
  };
}
export async function invalidateBrowserLibrary() {
  authorizationGeneration++;
  cacheGeneration++;
  blocked = true;
  activeScope = undefined;
  for (const listener of cleared) listener();
  await clearBrowserLibrary();
}
export async function bindBrowserLibrary(hostId: string, clientId: string) {
  try {
    await bind(hostId, clientId);
    return !blocked && activeScope === `${hostId}/${clientId}`;
  } catch (error) {
    console.warn('Offline library unavailable', error);
    return false;
  }
}
async function bind(hostId: string, clientId: string) {
  const next = `${hostId}/${clientId}`;
  if (!blocked && activeScope === next) return;
  const generation = ++authorizationGeneration;
  blocked = true;
  await browserDrafts.drain();
  const previous = await transaction('readonly', (store) => store.get('meta/scope'));
  const keys = await transaction('readonly', (store) => store.getAllKeys());
  if (generation !== authorizationGeneration) return;
  if (
    (previous !== undefined && previous !== next) ||
    keys.some((key) => {
      const group = scope(String(key));
      return group !== undefined && !group.startsWith(`${next}/`);
    })
  )
    await clearBrowserLibrary();
  await transaction('readwrite', (store) => {
    if (generation === authorizationGeneration) store.put(next, 'meta/scope');
    return store.count();
  });
  if (generation !== authorizationGeneration) return;
  activeScope = next;
  blocked = false;
}
export const browserDrafts = new PersistentDrafts({
  get: async (key) => {
    if (blocked) throw new Error('browser cache is unavailable');
    const generation = cacheGeneration;
    const row = await transaction<unknown>('readonly', (store) => store.get(`draft/${key}`));
    if (generation !== cacheGeneration || blocked) throw new Error('browser cache is unavailable');
    return typeof row === 'string'
      ? row
      : (row as { kind?: string; value?: string } | null)?.kind === 'draft'
        ? (row as { value: string }).value
        : undefined;
  },
  set: async (key, value) => {
    if (!writable(key)) throw new Error('browser cache is unavailable');
    await transaction('readwrite', (store) => {
      if (!writable(key)) throw new Error('browser cache is unavailable');
      return store.put({ kind: 'draft', value, savedAt: new Date().toISOString() }, `draft/${key}`);
    });
    await prune();
  },
  delete: async (key) => {
    await transaction('readwrite', (store) => store.delete(`draft/${key}`));
  },
});
