import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUSY_TIMEOUT_MS, openDatabase } from './driver.js';
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
