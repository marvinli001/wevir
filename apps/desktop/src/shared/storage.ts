// 设置 → 存储（照 Codex 桌面端的 Storage）：Wevir 在本机数据目录里占了多少、分在哪几类，哪几类能手动清理。主进程量
// （main/storage.ts）、清理，渲染进程只显示。数据目录是 Host 的（会话、worktree、引擎数据），只有缓存、内置浏览器的数据
// 与日志这三类不经 Host 也能安全地清；会话在左栏与“已归档”里管理。

/** 各类，按条形图里的顺序。 */
export const STORAGE_CATEGORIES = [
  'sessions',
  'worktrees',
  'engines',
  'cache',
  'browser',
  'logs',
  'other',
] as const;
export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

/** 能在存储页里清理的几类。 */
export const CLEANABLE_CATEGORIES = ['cache', 'browser', 'logs'] as const;
export type CleanableCategory = (typeof CLEANABLE_CATEGORIES)[number];

export function isCleanableCategory(value: unknown): value is CleanableCategory {
  return (CLEANABLE_CATEGORIES as readonly unknown[]).includes(value);
}

export interface StorageUsage {
  /** 数据目录（绝对路径）。 */
  root: string;
  /** 整个数据目录的字节数。 */
  total: number;
  /** 每类的字节数，`STORAGE_CATEGORIES` 的顺序、每类一项；加起来是 `total`。 */
  categories: { id: StorageCategory; bytes: number }[];
}
