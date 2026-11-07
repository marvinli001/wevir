import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUSY_TIMEOUT_MS, openDatabase, openReadOnlyDatabase } from './driver.js';
import { useTempDir, useTempStorage } from './test-utils.js';

describe('openDatabase', () => {
  const dataDir = useTempDir();

  it('设置 WAL、synchronous=NORMAL、外键与 busy timeout', () => {
    const db = openDatabase(join(dataDir(), 'x.db'));
    try {
      const pragma = (name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
      expect(pragma('journal_mode')).toBe('wal');
      expect(pragma('synchronous')).toBe(1); // NORMAL
      expect(pragma('foreign_keys')).toBe(1);
      expect(pragma('busy_timeout')).toBe(BUSY_TIMEOUT_MS);
      expect(pragma('journal_size_limit')).toBe(64 * 1024 * 1024);
      expect(pragma('cache_size')).toBe(-32000);
      expect(pragma('temp_store')).toBe(2);
      expect(BUSY_TIMEOUT_MS).toBe(5000);
    } finally {
      db.close();
    }
  });

  it('外键确实生效', () => {
    const db = openDatabase(join(dataDir(), 'x.db'));
    try {
      db.exec(
        'CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (p INTEGER REFERENCES p (id))',
      );
      expect(() => db.exec('INSERT INTO c VALUES (1)')).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });
});

describe('openReadOnlyDatabase', () => {
  const dataDir = useTempDir();

  it('读得到别人写的库（含 WAL 里没合并的），写不进，不建文件', () => {
    const file = join(dataDir(), 'other.db');
    const writer = openDatabase(file);
    try {
      writer.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (7)');
      const reader = openReadOnlyDatabase(file);
      try {
        expect(reader.prepare('SELECT v FROM t').all()).toEqual([{ v: 7 }]);
        expect(() => reader.exec('INSERT INTO t VALUES (8)')).toThrow(/readonly/);
      } finally {
        reader.close();
      }
    } finally {
      writer.close();
    }
    expect(() => openReadOnlyDatabase(join(dataDir(), 'missing.db'))).toThrow();
    expect(existsSync(join(dataDir(), 'missing.db'))).toBe(false);
  });
});

describe('openStorage', () => {
  const { storage, dataDir } = useTempStorage();

  it('数据库文件是 <数据目录>/wevir.db，WAL 伴随文件在同一目录', () => {
    expect(storage().path).toBe(join(dataDir(), 'wevir.db'));
    expect(readFileSync(storage().path).subarray(0, 15).toString()).toBe('SQLite format 3');
    storage().workspaces.insert({
      id: 'ws_01',
      rootPath: '/a',
      displayName: 'a',
      createdAt: 'x',
      updatedAt: 'x',
    });
    expect(existsSync(join(dataDir(), 'wevir.db-wal'))).toBe(true);
  });

  it('整库整理同时满足空闲 64 MiB 与 25% 才执行，保留剩余数据', () => {
    const s = storage();
    s.db.exec('CREATE TABLE filler (body BLOB)');
    const insert = s.db.prepare('INSERT INTO filler VALUES (zeroblob(4194304))');
    s.transaction(() => {
      for (let i = 0; i < 80; i++) insert.run();
    });
    s.db.exec('DELETE FROM filler WHERE rowid <= 1');
    expect(s.vacuum()).toBe(false);
    s.db.exec('DELETE FROM filler WHERE rowid <= 18');
    expect(s.freeBytes()).toBeGreaterThan(64 * 1024 * 1024);
    expect(s.vacuum()).toBe(false);
    s.db.exec('DELETE FROM filler WHERE rowid <= 26');
    expect(s.vacuum()).toBe(true);
    expect(s.freeBytes()).toBe(0);
    expect(s.db.prepare('SELECT count(*) AS n FROM filler').get()?.n).toBe(54);
    expect(s.vacuum()).toBe(false);
  }, 30_000);
});

describe('驱动边界', () => {
  it('只有 driver.ts 加载 node:sqlite', () => {
    const srcDir = new URL('.', import.meta.url);
    const offenders = readdirSync(srcDir)
      .filter((file) => file.endsWith('.ts') && file !== 'driver.ts' && file !== 'driver.test.ts')
      .filter((file) => /['"`]node:sqlite['"`]/.test(readFileSync(new URL(file, srcDir), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('package.json 没有任何 SQLite 依赖', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const deps = [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ].flatMap((field) => Object.keys(pkg[field] ?? {}));
    expect(deps.filter((name) => /sqlite/i.test(name))).toEqual([]);
  });
});
