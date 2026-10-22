import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSubscriptionAccountRepository,
  type SubscriptionAccountRepository,
} from './accounts.js';
import { type ApprovalRuleRepository, createApprovalRuleRepository } from './approval-rules.js';
import { type ApprovalRepository, createApprovalRepository } from './approvals.js';
import { createDeviceRepository, type DeviceRepository } from './devices.js';
import { openDatabase, type SqliteDatabase } from './driver.js';
import { createEnvironmentRepository, type EnvironmentRepository } from './environments.js';
import { createEventRepository, type EventRepository } from './events.js';
import { createInboxRepository, type InboxRepository } from './inbox.js';
import { migrate } from './migrate.js';
import {
  createProfileVersionRepository,
  type ProfileVersionRepository,
} from './profile-versions.js';
import { createProviderProfileRepository, type ProviderProfileRepository } from './providers.js';
import { createRetroRepository, type RetroRepository } from './retros.js';
import { createReviewCommentRepository, type ReviewCommentRepository } from './review-comments.js';
import { createSearchRepository, type SearchRepository } from './search.js';
import { createSendReceiptRepository, type SendReceiptRepository } from './send-receipts.js';
import { createSessionRepository, type SessionRepository } from './sessions.js';
import { transaction } from './transaction.js';
import {
  createTuningProposalRepository,
  type TuningProposalRepository,
} from './tuning-proposals.js';
import { createTuningRunRepository, type TuningRunRepository } from './tuning-runs.js';
import { createUsageRepository, type UsageRepository } from './usage.js';
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
  /** 可持久的审批规则（0017_approval_rules）。 */
  readonly approvalRules: ApprovalRuleRepository;
  readonly sendReceipts: SendReceiptRepository;
  /** 用量统计（0011_usage_records）。 */
  readonly usage: UsageRepository;
  /** 订阅的多个账号（0013_subscription_accounts）。 */
  readonly accounts: SubscriptionAccountRepository;
  /** diff 上的行级批注（0015_review_comments）。 */
  readonly reviewComments: ReviewCommentRepository;
  /** 任务回顾的投影与模型摘要（0016_session_retros）。 */
  readonly retros: RetroRepository;
  /** 调优的档案版本（0019_profile_versions）。 */
  readonly profileVersions: ProfileVersionRepository;
  /** 调优的建议（0020_tuning_proposals）。 */
  readonly tuningProposals: TuningProposalRepository;
  /** 调优的生成记录与试用指标用的查询（0024_tuning_auto）。 */
  readonly tuningRuns: TuningRunRepository;
  /** 收件箱的收起记录与重建用的查询（0022_inbox_dismissals）。 */
  readonly inbox: InboxRepository;
  /** 配对过的远程设备（0023_devices）。 */
  readonly devices: DeviceRepository;
  /** 会话全文搜索的派生索引（协议 0.77.0）：不走迁移，打开库时按索引版本建表，可以整体重建。 */
  readonly search: SearchRepository;
  /** 库文件里空闲页的字节数（0.43.0）：删掉行之后文件不会自己变小。 */
  freeBytes(): number;
  /** `VACUUM` 并截断 WAL（0.43.0，`session.delete` 之后空闲页多时）：文件变小。不能在事务里调用。 */
  vacuum(): void;
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
      approvalRules: createApprovalRuleRepository(db),
      sendReceipts: createSendReceiptRepository(db),
      usage: createUsageRepository(db),
      accounts: createSubscriptionAccountRepository(db),
      reviewComments: createReviewCommentRepository(db),
      retros: createRetroRepository(db),
      profileVersions: createProfileVersionRepository(db),
      tuningProposals: createTuningProposalRepository(db),
      tuningRuns: createTuningRunRepository(db),
      inbox: createInboxRepository(db),
      devices: createDeviceRepository(db),
      search: createSearchRepository(db),
      freeBytes: () => {
        const free = db.prepare('PRAGMA freelist_count').get() as { freelist_count: number };
        const size = db.prepare('PRAGMA page_size').get() as { page_size: number };
        return Number(free.freelist_count) * Number(size.page_size);
      },
      vacuum: () => {
        db.exec('VACUUM');
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      },
      close: () => db.close(),
    };
  } catch (err) {
    db.close();
    throw err;
  }
}
