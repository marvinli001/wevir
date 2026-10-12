import { describe, expect, it } from 'vitest';
import { openDatabase } from './driver.js';
import { seedSession, useTempStorage, workspace } from './test-utils.js';
import { transaction } from './transaction.js';

describe('transaction', () => {
  const { storage } = useTempStorage();

  it('fn 正常返回则提交，并返回 fn 的结果', () => {
    const s = storage();
    const result = transaction(s.db, () => {
      s.workspaces.insert(workspace());
      return 42;
    });
    expect(result).toBe(42);
    expect(s.db.isTransaction).toBe(false);
    expect(s.workspaces.get('ws_01')).toBeDefined();
  });

  it('fn 抛错则回滚，原错误照样抛出', () => {
    const s = storage();
    const boom = new Error('boom');
    expect(() =>
      transaction(s.db, () => {
        s.workspaces.insert(workspace());
        throw boom;
      }),
    ).toThrow(boom);
    expect(s.db.isTransaction).toBe(false);
    expect(s.workspaces.get('ws_01')).toBeUndefined();
  });

  it('事务中途违反约束时整体回滚', () => {
    const s = storage();
    expect(() =>
      s.transaction(() => {
        s.workspaces.insert(workspace({ id: 'ws_a', rootPath: '/same' }));
        s.workspaces.insert(workspace({ id: 'ws_b', rootPath: '/same' }));
      }),
    ).toThrow(/UNIQUE constraint failed: workspaces\.root_path/);
    expect(s.workspaces.list({ includeRemoved: true })).toEqual([]);
  });

  // 规则：fn 必须同步，事务内不得 await。返回 Promise 视为违规，回滚并抛 TypeError。
  it('fn 返回 Promise 时回滚并抛 TypeError', () => {
    const s = storage();
    expect(() =>
      transaction(s.db, async () => {
        s.workspaces.insert(workspace());
      }),
    ).toThrow(TypeError);
    expect(s.db.isTransaction).toBe(false);
    expect(s.workspaces.get('ws_01')).toBeUndefined();
  });

  // 规则：不支持嵌套。内层调用抛错，外层随之回滚。
  it('嵌套调用抛错，外层整体回滚', () => {
    const s = storage();
    expect(() =>
      s.transaction(() => {
        s.workspaces.insert(workspace());
        s.transaction(() => s.workspaces.insert(workspace({ id: 'ws_02', rootPath: '/b' })));
      }),
    ).toThrow(/不支持嵌套/);
    expect(s.db.isTransaction).toBe(false);
    expect(s.workspaces.list({ includeRemoved: true })).toEqual([]);
  });

  it('BEGIN IMMEDIATE 在事务开始时就拿写锁', () => {
    const s = storage();
    const other = openDatabase(s.path);
    try {
      other.exec('PRAGMA busy_timeout = 0');
      transaction(s.db, () => {
        // 还没有任何写操作，另一个连接已经拿不到写锁（DEFERRED 事务此时不持锁）。
        expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/database is locked/);
      });
      other.exec('BEGIN IMMEDIATE');
      other.exec('ROLLBACK');
    } finally {
      other.close();
    }
  });

  it('回滚后连接仍可用', () => {
    const s = storage();
    expect(() =>
      s.transaction(() => {
        seedSession(s);
        throw new Error('x');
      }),
    ).toThrow('x');
    s.transaction(() => seedSession(s));
    expect(s.sessions.get('ses_01')).toBeDefined();
  });
});
