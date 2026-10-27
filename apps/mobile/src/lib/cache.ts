// 本地缓存：每台电脑一个 SQLite 库，存会话列表与最近看过的对话（会话与它的事件），离线时照样能看。库由 SQLCipher 整库加密，
// 每台电脑一把随机密钥放钥匙串（cache-store.ts）；这里只有表结构与读写，数据库由调用方给（真机是 expo-sqlite，测试用 node:sqlite）。
//
// 对话存事件而不是画好的行：离线时用同一个投影（client-sdk 的 `TranscriptProjection`）重算，页面怎么画都不受影响。每个对话只留最近
// 的一段（从某条 `user.message` 起，最多 `MAX_EVENTS` 条、`MAX_BYTES` 字节），每台电脑只留最近看过的 `MAX_CONVERSATIONS` 个。
// 缓存坏了、读不出来就当没有：它只是加速与离线查看用的，不是数据的来源。

import type { Session, SessionId, WevirEvent } from '@wevir/protocol';

/** expo-sqlite `SQLiteDatabase` 里用到的部分。 */
export interface CacheDatabase {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: (string | number | null)[]): Promise<unknown>;
  getFirstAsync<T>(source: string, ...params: (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(source: string, ...params: (string | number | null)[]): Promise<T[]>;
  closeAsync(): Promise<void>;
}

/** 一个对话最多留多少条事件。 */
export const MAX_EVENTS = 3_000;
/** 一个对话的事件最多多少字节（JSON 的 UTF-16 长度，近似）。 */
export const MAX_BYTES = 2_000_000;
/** 每台电脑最多留几个对话。 */
export const MAX_CONVERSATIONS = 30;
/** 会话列表最多存几个。 */
export const MAX_SESSIONS = 300;

const SCHEMA_VERSION = 1;

export interface CachedSessions {
  sessions: Session[];
  savedAt: string;
}

export interface CachedConversation {
  session: Session;
  events: WevirEvent[];
  savedAt: string;
  /** 只存了最近的一段。 */
  truncated: boolean;
}

/** 会话列表与会话页用的缓存接口；读写失败都不抛（读到 `undefined`）。 */
export interface SessionCache {
  loadSessions(): Promise<CachedSessions | undefined>;
  saveSessions(sessions: readonly Session[]): Promise<void>;
  loadConversation(sessionId: SessionId): Promise<CachedConversation | undefined>;
  saveConversation(
    sessionId: SessionId,
    conversation: { session: Session; events: readonly WevirEvent[] },
  ): Promise<void>;
}

/** 从 `start` 起第一条 `user.message`（一个回合的开头）；没有时就是 `start`。 */
function turnBoundary(events: readonly WevirEvent[], start: number): number {
  for (let i = start; i < events.length; i++) if (events[i]?.type === 'user.message') return i;
  return start;
}

/** 留最近的一段：不超过条数与字节上限，从回合开头切。 */
export function trimEvents(events: readonly WevirEvent[]): {
  events: WevirEvent[];
  json: string;
  truncated: boolean;
} {
  let start = events.length > MAX_EVENTS ? turnBoundary(events, events.length - MAX_EVENTS) : 0;
  let json = JSON.stringify(events.slice(start));
  while (json.length > MAX_BYTES && start < events.length) {
    const next = turnBoundary(events, start + Math.max(1, Math.ceil((events.length - start) / 4)));
    start = next > start ? next : events.length;
    json = JSON.stringify(events.slice(start));
  }
  return { events: events.slice(start), json, truncated: start > 0 };
}

export class ComputerCache implements SessionCache {
  readonly #db: CacheDatabase;
  readonly #now: () => Date;

  private constructor(db: CacheDatabase, now: () => Date) {
    this.#db = db;
    this.#now = now;
  }

  /** 建表（第一次）或核对版本；版本不认识时清空重建。 */
  static async open(db: CacheDatabase, now: () => Date = () => new Date()): Promise<ComputerCache> {
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    const version = row?.user_version ?? 0;
    if (version !== SCHEMA_VERSION) {
      await db.execAsync(`
        DROP TABLE IF EXISTS meta;
        DROP TABLE IF EXISTS conversations;
        CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, saved_at TEXT NOT NULL);
        CREATE TABLE conversations (
          session_id TEXT PRIMARY KEY NOT NULL,
          session TEXT NOT NULL,
          events TEXT NOT NULL,
          truncated INTEGER NOT NULL,
          saved_at TEXT NOT NULL
        );
        CREATE INDEX conversations_saved_at ON conversations (saved_at);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    }
    return new ComputerCache(db, now);
  }

  async loadSessions(): Promise<CachedSessions | undefined> {
    const row = await this.#db.getFirstAsync<{ value: string; saved_at: string }>(
      "SELECT value, saved_at FROM meta WHERE key = 'sessions'",
    );
    if (row === null) return undefined;
    const sessions = parse<Session[]>(row.value);
    return Array.isArray(sessions) ? { sessions, savedAt: row.saved_at } : undefined;
  }

  async saveSessions(sessions: readonly Session[]): Promise<void> {
    await this.#db.runAsync(
      "INSERT OR REPLACE INTO meta (key, value, saved_at) VALUES ('sessions', ?, ?)",
      JSON.stringify(sessions.slice(0, MAX_SESSIONS)),
      this.#now().toISOString(),
    );
  }

  async loadConversation(sessionId: SessionId): Promise<CachedConversation | undefined> {
    const row = await this.#db.getFirstAsync<{
      session: string;
      events: string;
      truncated: number;
      saved_at: string;
    }>(
      'SELECT session, events, truncated, saved_at FROM conversations WHERE session_id = ?',
      sessionId,
    );
    if (row === null) return undefined;
    const session = parse<Session>(row.session);
    const events = parse<WevirEvent[]>(row.events);
    if (session === undefined || !Array.isArray(events)) return undefined;
    return { session, events, savedAt: row.saved_at, truncated: row.truncated === 1 };
  }

  async saveConversation(
    sessionId: SessionId,
    conversation: { session: Session; events: readonly WevirEvent[] },
  ): Promise<void> {
    const { json, truncated } = trimEvents(conversation.events);
    await this.#db.runAsync(
      'INSERT OR REPLACE INTO conversations (session_id, session, events, truncated, saved_at) VALUES (?, ?, ?, ?, ?)',
      sessionId,
      JSON.stringify(conversation.session),
      json,
      truncated ? 1 : 0,
      this.#now().toISOString(),
    );
    await this.#db.runAsync(
      `DELETE FROM conversations WHERE session_id NOT IN
        (SELECT session_id FROM conversations ORDER BY saved_at DESC, session_id LIMIT ${MAX_CONVERSATIONS})`,
    );
  }

  close(): Promise<void> {
    return this.#db.closeAsync();
  }
}

function parse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * 按需打开、出错不抛的缓存：第一次用时才打开库，打不开就一直当没有缓存（记一条警告）。写入排队，前一次没写完不并发写。
 */
export function lazyCache(
  open: () => Promise<ComputerCache>,
  warn: (message: string, error: unknown) => void = () => {},
): SessionCache & { close(): Promise<void> } {
  let opened: Promise<ComputerCache | undefined> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const get = () => {
    opened ??= open().catch((error: unknown) => {
      warn('could not open the local cache', error);
      return undefined;
    });
    return opened;
  };
  const read = async <T>(fn: (cache: ComputerCache) => Promise<T>): Promise<T | undefined> => {
    const cache = await get();
    if (cache === undefined) return undefined;
    try {
      return await fn(cache);
    } catch (error) {
      warn('could not read the local cache', error);
      return undefined;
    }
  };
  const write = (fn: (cache: ComputerCache) => Promise<void>): Promise<void> => {
    const next = queue.then(async () => {
      const cache = await get();
      if (cache === undefined) return;
      try {
        await fn(cache);
      } catch (error) {
        warn('could not write the local cache', error);
      }
    });
    queue = next;
    return next;
  };
  return {
    loadSessions: () => read((c) => c.loadSessions()),
    saveSessions: (sessions) => write((c) => c.saveSessions(sessions)),
    loadConversation: (sessionId) => read((c) => c.loadConversation(sessionId)),
    saveConversation: (sessionId, conversation) =>
      write((c) => c.saveConversation(sessionId, conversation)),
    close: async () => {
      await queue;
      const cache = await opened;
      opened = Promise.resolve(undefined);
      await cache?.close();
    },
  };
}

/** 各台电脑的缓存（按路由 ID，一台一个库）。 */
export interface CacheProvider {
  open(record: { routeId: string }): SessionCache;
  /** 退出这台电脑：关库，删库与密钥。 */
  forget(record: { routeId: string }): Promise<void>;
}

export function cacheProvider(options: {
  open(routeId: string): Promise<ComputerCache>;
  remove(routeId: string): Promise<void>;
  warn?: (message: string, error: unknown) => void;
}): CacheProvider {
  const caches = new Map<string, ReturnType<typeof lazyCache>>();
  return {
    open({ routeId }) {
      let cache = caches.get(routeId);
      if (cache === undefined) {
        cache = lazyCache(() => options.open(routeId), options.warn);
        caches.set(routeId, cache);
      }
      return cache;
    },
    async forget({ routeId }) {
      const cache = caches.get(routeId);
      caches.delete(routeId);
      await cache?.close().catch(() => {});
      await options.remove(routeId);
    },
  };
}
