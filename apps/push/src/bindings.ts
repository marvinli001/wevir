import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PushPlatform } from '@wevir/protocol';

/**
 * 一条绑定的键：`SHA-256("wevir-push/1 binding\n" ‖ 路由 ID ‖ "\n" ‖ 平台 ‖ "\n" ‖ 令牌)` 的十六进制。网关只存这个哈希与路由 ID 的哈希，
 * 不存令牌：要推送时 Host 的请求里带着令牌，算出同一个键就知道绑定过。令牌是长随机数，哈希反推不出来。
 */
export function bindingKey(routeId: string, platform: PushPlatform, token: string): string {
  return createHash('sha256')
    .update(`wevir-push/1 binding\n${routeId}\n${platform}\n${token}`)
    .digest('hex');
}

export function routeKey(routeId: string): string {
  return createHash('sha256').update(`wevir-push/1 route\n${routeId}`).digest('hex');
}

/** 绑定的存储。`add` 在这台电脑的绑定数到了上限时返回 `limit`。 */
export interface BindingStore {
  has(key: string): boolean;
  add(key: string, route: string, max: number): 'added' | 'exists' | 'limit';
  remove(key: string): boolean;
  /** 记下最近一次推送的时间（按天），清理长期不用的绑定用。 */
  touch(key: string, at: number): void;
  /** 删掉 `before` 之前就没用过的绑定，返回删了几条。 */
  prune(before: number): number;
  count(): number;
  close(): void;
}

const DAY_MS = 86_400_000;

/** 只在内存里：没设 `WEVIR_PUSH_DATA_DIR` 时用，网关重启后手机要重新绑定（重新连上电脑时会自动做）。 */
export class MemoryBindingStore implements BindingStore {
  readonly #bindings = new Map<string, { route: string; usedAt: number }>();

  has(key: string): boolean {
    return this.#bindings.has(key);
  }

  add(key: string, route: string, max: number): 'added' | 'exists' | 'limit' {
    if (this.#bindings.has(key)) return 'exists';
    let count = 0;
    for (const binding of this.#bindings.values()) if (binding.route === route) count += 1;
    if (count >= max) return 'limit';
    this.#bindings.set(key, { route, usedAt: Date.now() });
    return 'added';
  }

  remove(key: string): boolean {
    return this.#bindings.delete(key);
  }

  touch(key: string, at: number): void {
    const binding = this.#bindings.get(key);
    if (binding) binding.usedAt = at;
  }

  prune(before: number): number {
    let removed = 0;
    for (const [key, binding] of this.#bindings) {
      if (binding.usedAt < before) {
        this.#bindings.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  count(): number {
    return this.#bindings.size;
  }

  close(): void {}
}

/** 存在 `<目录>/bindings.db`（node:sqlite）。表里只有两个哈希与按天取整的时间。 */
export class SqliteBindingStore implements BindingStore {
  readonly #db: DatabaseSync;
  readonly #has;
  readonly #insert;
  readonly #countRoute;
  readonly #remove;
  readonly #touch;
  readonly #prune;
  readonly #count;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.#db = new DatabaseSync(join(dir, 'bindings.db'));
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS bindings (
        key TEXT PRIMARY KEY,
        route TEXT NOT NULL,
        used_day INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS bindings_route ON bindings (route);
    `);
    this.#has = this.#db.prepare('SELECT 1 FROM bindings WHERE key = ?');
    this.#insert = this.#db.prepare('INSERT INTO bindings (key, route, used_day) VALUES (?, ?, ?)');
    this.#countRoute = this.#db.prepare('SELECT COUNT(*) AS n FROM bindings WHERE route = ?');
    this.#remove = this.#db.prepare('DELETE FROM bindings WHERE key = ?');
    this.#touch = this.#db.prepare(
      'UPDATE bindings SET used_day = ? WHERE key = ? AND used_day < ?',
    );
    this.#prune = this.#db.prepare('DELETE FROM bindings WHERE used_day < ?');
    this.#count = this.#db.prepare('SELECT COUNT(*) AS n FROM bindings');
  }

  has(key: string): boolean {
    return this.#has.get(key) !== undefined;
  }

  add(key: string, route: string, max: number): 'added' | 'exists' | 'limit' {
    if (this.has(key)) return 'exists';
    const row = this.#countRoute.get(route) as { n: number } | undefined;
    if ((row?.n ?? 0) >= max) return 'limit';
    this.#insert.run(key, route, Math.floor(Date.now() / DAY_MS));
    return 'added';
  }

  remove(key: string): boolean {
    return Number(this.#remove.run(key).changes) > 0;
  }

  touch(key: string, at: number): void {
    const day = Math.floor(at / DAY_MS);
    this.#touch.run(day, key, day);
  }

  prune(before: number): number {
    return Number(this.#prune.run(Math.floor(before / DAY_MS)).changes);
  }

  count(): number {
    return (this.#count.get() as { n: number }).n;
  }

  close(): void {
    this.#db.close();
  }
}
