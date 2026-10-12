// 测试共用：每个用例一个临时数据目录，用完删除。只被 *.test.ts 引用，不进 index。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import type { SessionRecord } from './sessions.js';
import { openStorage, type Storage } from './storage.js';
import type { WorkspaceRecord } from './workspaces.js';

export const T0 = '2026-10-13T00:00:00.000Z';
export const T1 = '2026-10-13T00:00:01.000Z';
export const T2 = '2026-10-13T00:00:02.000Z';

/** 注册 beforeEach / afterEach：每个用例一个新的临时数据目录，结束时删除。 */
export function useTempDir(): () => string {
  let dir: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wevir-storage-'));
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  return () => {
    if (!dir) throw new Error('useTempDir() 只能在用例里取值');
    return dir;
  };
}

/** 在临时数据目录上打开 Storage，用例结束时关闭。 */
export function useTempStorage(): { storage: () => Storage; dataDir: () => string } {
  const dataDir = useTempDir();
  let storage: Storage | undefined;
  beforeEach(() => {
    storage = openStorage({ dataDir: dataDir() });
  });
  afterEach(() => {
    if (storage?.db.isOpen) storage.close();
    storage = undefined;
  });
  return {
    dataDir,
    storage: () => {
      if (!storage) throw new Error('useTempStorage() 只能在用例里取值');
      return storage;
    },
  };
}

export function workspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: 'ws_01',
    rootPath: '/home/u/project',
    displayName: 'project',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'ses_01',
    workspaceId: 'ws_01',
    cwd: '/home/u/project',
    engine: 'dsh',
    engineSessionId: '0b7c6c1e-0000-4000-8000-000000000001',
    providerId: 'deepseek-official',
    modelId: 'deepseek-chat',
    title: '',
    titleSource: 'first_prompt',
    state: 'idle',
    lastSeq: 0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** 插入工作区与会话，满足 events / approvals / send_receipts 的外键。 */
export function seedSession(
  storage: Storage,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  const record = session(overrides);
  if (!storage.workspaces.get(record.workspaceId)) {
    storage.workspaces.insert(
      workspace({ id: record.workspaceId, rootPath: `/home/u/${record.workspaceId}` }),
    );
  }
  storage.sessions.insert(record);
  return record;
}
