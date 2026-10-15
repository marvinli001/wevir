import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type ApprovalRepository, createApprovalRepository } from './approvals.js';
import { openDatabase, type SqliteDatabase } from './driver.js';
import { createEnvironmentRepository, type EnvironmentRepository } from './environments.js';
import { createEventRepository, type EventRepository } from './events.js';
import { migrate } from './migrate.js';
import { createProviderProfileRepository, type ProviderProfileRepository } from './providers.js';
import { createSendReceiptRepository, type SendReceiptRepository } from './send-receipts.js';
import { createSessionRepository, type SessionRepository } from './sessions.js';
import { transaction } from './transaction.js';
import { createWorkspaceRepository, type WorkspaceRepository } from './workspaces.js';

/** 数据库文件名，位于数据目录下（另有 `-wal`、`-shm` 两个伴随文件）。 */
export const DATABASE_FILE = 'wevir.db';

export interface Storage {
  /** 数据库文件的路径。 */
  readonly path: string;
  readonly db: SqliteDatabase;
  /** 见 `transaction()`：`fn` 必须同步，不支持嵌套。 */
  transaction<T>(fn: () => T): T;
  readonly workspaces: WorkspaceRepository;
  /** 保存的环境（0004_environments）。 */
  readonly environments: EnvironmentRepository;
  readonly providers: ProviderProfileRepository;
  readonly sessions: SessionRepository;
  readonly events: EventRepository;
  readonly approvals: ApprovalRepository;
  readonly sendReceipts: SendReceiptRepository;
  close(): void;
}

/**
 * 打开 `<dataDir>/wevir.db`（不存在则创建，数据目录也一并创建），在事务里把 schema 迁移到最新版本，
 * 返回各表的仓储。只有 Host 进程打开数据库，一个数据目录同时只有一个 Host（ADR-0003 背景）。
 */
export function openStorage(options: { dataDir: string }): Storage {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const path = join(options.dataDir, DATABASE_FILE);
  const db = openDatabase(path);
  try {
    migrate(db);
    return {
      path,
      db,
      transaction: (fn) => transaction(db, fn),
      workspaces: createWorkspaceRepository(db),
      environments: createEnvironmentRepository(db),
      providers: createProviderProfileRepository(db),
      sessions: createSessionRepository(db),
      events: createEventRepository(db),
      approvals: createApprovalRepository(db),
      sendReceipts: createSendReceiptRepository(db),
      close: () => db.close(),
    };
  } catch (err) {
    db.close();
    throw err;
  }
}
