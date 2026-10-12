import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqliteDatabase } from './driver.js';
import { transaction } from './transaction.js';

// 手写 SQL 迁移：<包根>/migrations/NNNN_name.sql，版本号从 1 开始连续。已发布的迁移文件不再修改，
// 改表结构一律加新文件。迁移文件里不要写 BEGIN / COMMIT，整批迁移由 migrate() 放在一个事务里。

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface MigrationResult {
  /** 迁移前的版本，新库为 0。 */
  from: number;
  to: number;
  /** 本次执行的迁移版本号；已是最新时为空。 */
  applied: number[];
}

// src/ 与 dist/ 都在包根下一层，所以源码运行（Vitest）和构建产物都从这里读 SQL；
// package.json 的 files 包含 migrations/。
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

const SCHEMA_VERSION_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL
) STRICT`;

/** 读取并校验迁移目录：文件名合规、版本号从 1 开始连续。 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => {
      const match = FILE_PATTERN.exec(file);
      if (!match?.[1] || !match[2]) {
        throw new Error(`迁移文件名不合规：${file}（应为 NNNN_name.sql）`);
      }
      return {
        version: Number(match[1]),
        name: match[2],
        sql: readFileSync(join(dir, file), 'utf8'),
      };
    })
    .sort((a, b) => a.version - b.version);
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`迁移版本号必须从 1 开始连续，第 ${index + 1} 个是 ${migration.version}`);
    }
  });
  return migrations;
}

/** 数据库当前的 schema 版本；没有迁移过为 0。 */
export function schemaVersion(db: SqliteDatabase): number {
  const table = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_version'")
    .get();
  if (!table) return 0;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get();
  return Number(row?.version ?? 0);
}

/**
 * 在一个事务里把数据库迁移到最新版本，可重复执行：已是最新时什么都不做。任何一个迁移失败，
 * 整批回滚，版本不变。数据库版本高于本程序已知的最新版本（被更新的 Wevir 打开过）时拒绝运行。
 */
export function migrate(
  db: SqliteDatabase,
  migrations: Migration[] = loadMigrations(),
): MigrationResult {
  return transaction(db, () => {
    db.exec(SCHEMA_VERSION_DDL);
    const from = schemaVersion(db);
    const latest = migrations.at(-1)?.version ?? 0;
    if (from > latest) {
      throw new Error(`数据库 schema 版本 ${from} 高于本程序支持的 ${latest}，请升级 Wevir`);
    }
    const record = db.prepare(
      'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
    );
    const applied: number[] = [];
    for (const migration of migrations) {
      if (migration.version <= from) continue;
      db.exec(migration.sql);
      record.run(migration.version, migration.name, new Date().toISOString());
      applied.push(migration.version);
    }
    return { from, to: Math.max(from, latest), applied };
  });
}
