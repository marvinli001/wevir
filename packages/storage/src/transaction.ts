import type { SqliteDatabase } from './driver.js';

/**
 * 在一个 `BEGIN IMMEDIATE` 事务里执行 `fn`：`fn` 正常返回则 `COMMIT` 并返回它的结果，抛错则
 * `ROLLBACK` 并把原错误抛出。`BEGIN IMMEDIATE` 一开始就拿写锁，不会出现读到一半才因升级写锁
 * 失败的情况。
 *
 * 规则（ADR-0003 决策 1）：
 *
 * - **`fn` 必须是同步函数，事务内不得 `await`。** 一个数据目录只有一个连接；`await` 让出事件循环后，
 *   其他调用的语句会落进这个还没结束的事务里，跟着它一起提交或回滚。`fn` 返回 Promise（或任何
 *   thenable）视为违规：回滚并抛 `TypeError`。注意此时 `await` 之后的代码仍会在事务外执行，
 *   这条检查只能兜底，不能代替代码审查。
 * - **不支持嵌套。** 已在事务中时再调用直接抛错，不用 SAVEPOINT 模拟；需要组合时，把内层逻辑写成
 *   不开事务的普通函数，由最外层调用 `transaction`。
 */
export function transaction<T>(db: SqliteDatabase, fn: () => T): T {
  if (db.isTransaction) {
    throw new Error('transaction() 不支持嵌套：连接已在事务中');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (isThenable(result)) {
      throw new TypeError('transaction() 的 fn 必须是同步函数：事务内不得 await，已回滚');
    }
    db.exec('COMMIT');
    return result;
  } catch (err) {
    // 部分错误（如 SQLITE_FULL）会让 SQLite 自动回滚，此时已不在事务中。
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
