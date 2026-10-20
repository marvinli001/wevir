// node:sqlite 的唯一适配点（ADR-0003 决策 1）：整个仓库只有这个模块加载 node:sqlite，其他模块只用
// 这里声明的 SqliteDatabase / SqliteStatement。将来换驱动（如 better-sqlite3）只改这一个文件。
//
// 兼容范围：engines 下限 Node 24.15（node:sqlite 进入 RC）到 Node 26。只用 24.15 已有的 API；更新的 API
// 先判断是否存在。
// - 类名：Node 26.11 起叫 Database，DatabaseSync 成为弃用别名（DEP0210）。先取 Database。
// - 用 process.getBuiltinModule 在第一次打开数据库时才加载模块，而不是在文件顶部 import：只 import
//   本包而不开库（例如只用 SecretStore）时不必加载 node:sqlite；ESM 的命名空间导入还会读到全部导出，
//   包括弃用的 DatabaseSync 别名。

/** 可以绑定到参数、也可能从结果里读出的值。 */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** 命名参数。SQL 里写 `:name`，对象里写不带前缀的 `name`（node:sqlite 默认允许）。 */
export type SqlParams = Record<string, SqlValue>;

export type SqlRow = Record<string, SqlValue>;

export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: SqlValue[]): SqliteRunResult;
  run(params: SqlParams, ...anonymous: SqlValue[]): SqliteRunResult;
  get(...params: SqlValue[]): SqlRow | undefined;
  get(params: SqlParams, ...anonymous: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
  all(params: SqlParams, ...anonymous: SqlValue[]): SqlRow[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  readonly isOpen: boolean;
  /** 连接当前是否在事务中（`sqlite3_get_autocommit` 的反面）。 */
  readonly isTransaction: boolean;
}

/** busy timeout：拿不到锁时最多等待的毫秒数（ADR-0003 决策 1）。 */
export const BUSY_TIMEOUT_MS = 5000;

type NodeSqlite = typeof import('node:sqlite');
type DatabaseConstructor = NodeSqlite['DatabaseSync'];

function databaseClass(): DatabaseConstructor {
  const sqlite = process.getBuiltinModule('node:sqlite') as NodeSqlite & {
    Database?: DatabaseConstructor;
  };
  return sqlite.Database ?? sqlite.DatabaseSync;
}

/**
 * 打开（必要时创建）数据库文件并完成连接设置：`journal_mode=WAL`、`synchronous=NORMAL`、
 * 外键开启、busy timeout 5000 ms。只建连接，不跑迁移（见 `openStorage`）。
 */
export function openDatabase(path: string): SqliteDatabase {
  const Database = databaseClass();
  // enableForeignKeyConstraints 默认开启；仍显式传入，下面再用 PRAGMA 设一次。
  const db = new Database(path, { enableForeignKeyConstraints: true });
  try {
    // defensive（24.12 加入、24.14 起默认开启）禁用能让普通 SQL 故意损坏数据库文件的功能；仍显式打开。
    db.enableDefensive(true);

    // busy_timeout 放在最前：切换 WAL 本身也可能要等锁。
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const mode = db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
    if (mode !== 'wal') {
      throw new Error(`无法把 ${path} 切换到 WAL 模式（当前为 ${String(mode)}）`);
    }
    // WAL 下 NORMAL：进程崩溃不丢已提交事务；掉电最多丢最后几个事务，不会损坏数据库。
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * 只读打开别的程序的数据库（引擎自己的会话库，例如 Antigravity 运行体记每一步 token 的 `conversations/<id>.db`）：不建文件、
 * 不改日志模式，busy timeout 同上。文件不在时抛错。
 */
export function openReadOnlyDatabase(path: string): SqliteDatabase {
  const Database = databaseClass();
  const db = new Database(path, { readOnly: true });
  try {
    db.enableDefensive(true);
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
