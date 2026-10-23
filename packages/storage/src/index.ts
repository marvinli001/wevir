// Host 的本地存储（ADR-0003）：node:sqlite 上的表结构、迁移与仓储，以及密钥存储。
//
// 本包不依赖 @wevir/protocol：存储层不需要 zod，记录里也有不上线缆的列（removedAt、secretRef、
// 回执等）。记录类型里的 ID、枚举都是 string；协议拥有的大结构（事件 payload、审批选项等）
// 原样存 JSON、类型为 unknown；小而稳定的结构（ActiveTurn、ClientIdentity 等）按同形单独声明。
// 记录与线缆类型之间的转换由 Host 负责。

export * from './accounts.js';
export * from './approval-rules.js';
export * from './approvals.js';
export * from './channels.js';
export * from './devices.js';
export {
  BUSY_TIMEOUT_MS,
  openDatabase,
  openReadOnlyDatabase,
  type SqliteDatabase,
  type SqliteRunResult,
  type SqliteStatement,
  type SqlParams,
  type SqlRow,
  type SqlValue,
} from './driver.js';
export * from './environments.js';
export * from './events.js';
export * from './inbox.js';
export * from './migrate.js';
export * from './profile-versions.js';
export * from './providers.js';
export * from './retros.js';
export * from './review-comments.js';
export * from './search.js';
export * from './secrets.js';
export * from './send-receipts.js';
export * from './sessions.js';
export * from './storage.js';
export * from './transaction.js';
export * from './tuning-proposals.js';
export * from './tuning-runs.js';
export * from './usage.js';
export * from './workspaces.js';
