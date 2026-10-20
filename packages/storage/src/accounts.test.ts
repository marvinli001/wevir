import { describe, expect, it } from 'vitest';
import { openStorage } from './storage.js';
import { useTempDir } from './test-utils.js';

describe('subscription_accounts', () => {
  const dataDir = useTempDir();

  it('登记、改标签、清标签、按添加先后列出、删除', () => {
    const storage = openStorage({ dataDir: dataDir() });
    try {
      const { accounts } = storage;
      accounts.upsert({ id: 'claude-3f9a', kind: 'claude', createdAt: '2026-10-20T01:00:00.000Z' });
      accounts.upsert({
        id: 'claude',
        kind: 'claude',
        label: '主号',
        createdAt: '2026-10-20T00:00:00.000Z',
      });
      expect(accounts.list().map((account) => account.id)).toEqual(['claude', 'claude-3f9a']);
      accounts.upsert({
        id: 'claude-3f9a',
        kind: 'claude',
        label: '工作',
        createdAt: '2026-10-21T00:00:00.000Z',
      });
      expect(accounts.get('claude-3f9a')).toEqual({
        id: 'claude-3f9a',
        kind: 'claude',
        label: '工作',
        createdAt: '2026-10-20T01:00:00.000Z',
      });
      accounts.upsert({ id: 'claude-3f9a', kind: 'claude', createdAt: '2026-10-20T01:00:00.000Z' });
      expect(accounts.get('claude-3f9a')?.label).toBeUndefined();
      expect(accounts.remove('claude-3f9a')).toBe(true);
      expect(accounts.remove('claude-3f9a')).toBe(false);
      expect(accounts.get('claude-3f9a')).toBeUndefined();
    } finally {
      storage.close();
    }
  });
});
