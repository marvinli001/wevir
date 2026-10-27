// 本地缓存的表结构与读写：用 Node 自带的 SQLite（同一套 SQL），加密只在真机的 SQLCipher 上（cache-store.ts）。

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  type CacheDatabase,
  ComputerCache,
  cacheProvider,
  lazyCache,
  MAX_BYTES,
  MAX_CONVERSATIONS,
  MAX_EVENTS,
  trimEvents,
} from './cache';
import { session } from './test-utils';

function nodeDb(path = ':memory:'): CacheDatabase & { db: DatabaseSync } {
  const db = new DatabaseSync(path);
  return {
    db,
    execAsync: async (sql) => {
      db.exec(sql);
    },
    runAsync: async (sql, ...params) => db.prepare(sql).run(...params),
    getFirstAsync: async <T>(sql: string, ...params: (string | number | null)[]) =>
      (db.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T>(sql: string, ...params: (string | number | null)[]) =>
      db.prepare(sql).all(...params) as T[],
    closeAsync: async () => db.close(),
  };
}

function event(seq: number, type: string, payload: object = {}): WevirEvent {
  return {
    seq,
    sessionId: 'ses_1',
    ts: '2026-10-27T08:00:00.000Z',
    type,
    source: 'host',
    payload,
  } as WevirEvent;
}

/** `turns` 个回合，每个回合一条用户消息与 `per - 1` 条回答。 */
function conversation(turns: number, per: number, text = 'x'): WevirEvent[] {
  const out: WevirEvent[] = [];
  for (let t = 0; t < turns; t++) {
    out.push(event(out.length + 1, 'user.message', { text }));
    for (let i = 1; i < per; i++) out.push(event(out.length + 1, 'assistant.message', { text }));
  }
  return out;
}

const SES = 'ses_1' as SessionId;

describe('ComputerCache', () => {
  it('存取会话列表与对话；重开同一个库仍在', async () => {
    const file = join(tmpdir(), `wevir-cache-${process.pid}-${Date.now()}.db`);
    let now = new Date('2026-10-27T08:00:00.000Z');
    const first = await ComputerCache.open(nodeDb(file), () => now);
    expect(await first.loadSessions()).toBeUndefined();
    expect(await first.loadConversation(SES)).toBeUndefined();
    const sessions = [session('ses_1', '2026-10-27T07:00:00.000Z')];
    await first.saveSessions(sessions);
    now = new Date('2026-10-27T08:01:00.000Z');
    await first.saveConversation(SES, {
      session: sessions[0] as never,
      events: conversation(2, 3),
    });
    await first.close();

    const second = await ComputerCache.open(nodeDb(file));
    expect(await second.loadSessions()).toEqual({ sessions, savedAt: '2026-10-27T08:00:00.000Z' });
    const loaded = await second.loadConversation(SES);
    expect(loaded).toMatchObject({ savedAt: '2026-10-27T08:01:00.000Z', truncated: false });
    expect(loaded?.events).toHaveLength(6);
    await second.close();
    rmSync(file, { force: true });
  });

  it('只留最近看过的对话', async () => {
    let tick = 0;
    const cache = await ComputerCache.open(
      nodeDb(),
      () => new Date(Date.UTC(2026, 9, 27, 8, 0, tick++)),
    );
    for (let i = 0; i <= MAX_CONVERSATIONS; i++) {
      await cache.saveConversation(`ses_${i}` as SessionId, {
        session: session(`ses_${i}`, '2026-10-27T07:00:00.000Z'),
        events: conversation(1, 2),
      });
    }
    expect(await cache.loadConversation('ses_0' as SessionId)).toBeUndefined();
    expect(await cache.loadConversation(`ses_${MAX_CONVERSATIONS}` as SessionId)).toBeDefined();
  });

  it('版本不认识时清空重建；坏的 JSON 当作没有', async () => {
    const db = nodeDb();
    db.db.exec(
      'CREATE TABLE meta (key TEXT, value TEXT, saved_at TEXT); PRAGMA user_version = 99;',
    );
    const cache = await ComputerCache.open(db);
    expect(await cache.loadSessions()).toBeUndefined();
    db.db.exec("INSERT INTO meta VALUES ('sessions', '{not json', '2026-10-27T08:00:00.000Z')");
    expect(await cache.loadSessions()).toBeUndefined();
  });
});

describe('trimEvents', () => {
  it('不超上限时原样留下', () => {
    const events = conversation(3, 4);
    expect(trimEvents(events)).toMatchObject({ events, truncated: false });
  });

  it('超过条数时从回合开头切', () => {
    const events = conversation(Math.ceil(MAX_EVENTS / 10) + 5, 10);
    const { events: kept, truncated } = trimEvents(events);
    expect(truncated).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(MAX_EVENTS);
    expect(kept[0]?.type).toBe('user.message');
    expect(kept.at(-1)).toBe(events.at(-1));
  });

  it('超过字节时再切掉前面的回合', () => {
    const big = 'y'.repeat(200_000);
    const events = conversation(20, 2, big);
    const { json, events: kept } = trimEvents(events);
    expect(json.length).toBeLessThanOrEqual(MAX_BYTES);
    expect(kept[0]?.type).toBe('user.message');
    expect(kept.length).toBeGreaterThan(0);
  });
});

describe('lazyCache / cacheProvider', () => {
  it('打不开时当作没有缓存，只警告一次', async () => {
    const warn = vi.fn();
    const cache = lazyCache(() => Promise.reject(new Error('no SQLCipher')), warn);
    expect(await cache.loadSessions()).toBeUndefined();
    await cache.saveSessions([]);
    expect(await cache.loadConversation(SES)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('每台电脑一个库；退出这台电脑时关库再删', async () => {
    const opened: string[] = [];
    const removed: string[] = [];
    const provider = cacheProvider({
      open: async (routeId) => {
        opened.push(routeId);
        return ComputerCache.open(nodeDb());
      },
      remove: async (routeId) => {
        removed.push(routeId);
      },
    });
    const a = provider.open({ routeId: 'a' });
    expect(provider.open({ routeId: 'a' })).toBe(a);
    await a.saveSessions([session('ses_1', '2026-10-27T07:00:00.000Z')]);
    await provider.open({ routeId: 'b' }).loadSessions();
    expect(opened).toEqual(['a', 'b']);
    await provider.forget({ routeId: 'a' });
    expect(removed).toEqual(['a']);
    expect(await a.loadSessions()).toBeUndefined();
  });
});
