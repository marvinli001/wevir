import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './driver.js';
import { loadMigrations, MIGRATIONS_DIR, migrate, schemaVersion } from './migrate.js';
import { openStorage } from './storage.js';
import { useTempDir, workspace } from './test-utils.js';

const TABLES = [
  'approvals',
  'events',
  'provider_profiles',
  'schema_version',
  'send_receipts',
  'sessions',
  'workspaces',
];

describe('migrate', () => {
  const dataDir = useTempDir();

  /** 复制正式迁移到临时目录，再追加测试用的迁移文件。 */
  function migrationsWith(extra: Record<string, string>): string {
    const dir = join(dataDir(), 'migrations');
    mkdirSync(dir);
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    for (const [file, sql] of Object.entries(extra)) writeFileSync(join(dir, file), sql);
    return dir;
  }

  it('新库迁移到最新版本，建出全部表', () => {
    const db = openDatabase(join(dataDir(), 'wevir.db'));
    try {
      expect(schemaVersion(db)).toBe(0);
      expect(migrate(db)).toEqual({ from: 0, to: 1, applied: [1] });
      expect(schemaVersion(db)).toBe(1);
      const tables = db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name);
      expect(tables).toEqual(TABLES);
      const version = db.prepare('SELECT version, name FROM schema_version').all();
      expect(version).toEqual([{ version: 1, name: 'init' }]);
    } finally {
      db.close();
    }
  });

  it('可重复执行：已是最新时什么都不做', () => {
    const db = openDatabase(join(dataDir(), 'wevir.db'));
    try {
      migrate(db);
      expect(migrate(db)).toEqual({ from: 1, to: 1, applied: [] });
      expect(migrate(db)).toEqual({ from: 1, to: 1, applied: [] });
      expect(db.prepare('SELECT COUNT(*) AS n FROM schema_version').get()?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('重新打开 Storage 不重复迁移，数据保留', () => {
    const first = openStorage({ dataDir: dataDir() });
    first.workspaces.insert(workspace());
    first.close();
    const second = openStorage({ dataDir: dataDir() });
    try {
      expect(schemaVersion(second.db)).toBe(1);
      expect(second.workspaces.get('ws_01')).toEqual(workspace());
    } finally {
      second.close();
    }
  });

  it('只执行比当前版本新的迁移', () => {
    const db = openDatabase(join(dataDir(), 'wevir.db'));
    try {
      migrate(db);
      const dir = migrationsWith({ '0002_add_notes.sql': 'CREATE TABLE notes (id TEXT) STRICT;' });
      expect(migrate(db, loadMigrations(dir))).toEqual({ from: 1, to: 2, applied: [2] });
      expect(migrate(db, loadMigrations(dir))).toEqual({ from: 2, to: 2, applied: [] });
    } finally {
      db.close();
    }
  });

  it('迁移失败时整批回滚，版本不变', () => {
    const db = openDatabase(join(dataDir(), 'wevir.db'));
    try {
      const dir = migrationsWith({
        '0002_ok.sql': 'CREATE TABLE notes (id TEXT) STRICT;',
        '0003_broken.sql': 'CREATE TABLE tags (id TEXT) STRICT;\nTHIS IS NOT SQL;',
      });
      expect(() => migrate(db, loadMigrations(dir))).toThrow(/syntax error/);
      expect(db.isTransaction).toBe(false);
      // 0001、0002 与 0003 的前半段都在同一个事务里，一起回滚。
      expect(schemaVersion(db)).toBe(0);
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
      expect(tables).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('数据库版本高于程序已知的最新版本时拒绝运行', () => {
    const db = openDatabase(join(dataDir(), 'wevir.db'));
    try {
      migrate(db, loadMigrations(migrationsWith({ '0002_x.sql': 'SELECT 1;' })));
      expect(() => migrate(db)).toThrow(/schema 版本 2 高于本程序支持的 1/);
    } finally {
      db.close();
    }
  });

  it('迁移文件名不合规或版本号不连续时报错', () => {
    expect(() => loadMigrations(migrationsWith({ '0003_gap.sql': 'SELECT 1;' }))).toThrow(
      /从 1 开始连续/,
    );
  });

  it('迁移文件名必须是 NNNN_name.sql', () => {
    expect(() => loadMigrations(migrationsWith({ '2_Bad-Name.sql': 'SELECT 1;' }))).toThrow(
      /文件名不合规/,
    );
  });
});
