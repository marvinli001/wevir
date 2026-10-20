import { describe, expect, it } from 'vitest';
import { T0, T1, T2, useTempStorage, workspace } from './test-utils.js';

describe('workspaces', () => {
  const { storage } = useTempStorage();

  it('插入与读取', () => {
    const repo = storage().workspaces;
    repo.insert(workspace());
    expect(repo.get('ws_01')).toEqual(workspace());
    expect(repo.getByRootPath('/home/u/project')).toEqual(workspace());
    expect(repo.get('ws_missing')).toBeUndefined();
    expect(repo.getByRootPath('/nope')).toBeUndefined();
  });

  it('root_path 唯一', () => {
    const repo = storage().workspaces;
    repo.insert(workspace());
    expect(() => repo.insert(workspace({ id: 'ws_02' }))).toThrow(
      /UNIQUE constraint failed: workspaces\.root_path/,
    );
  });

  it('id 唯一', () => {
    const repo = storage().workspaces;
    repo.insert(workspace());
    expect(() => repo.insert(workspace({ rootPath: '/other' }))).toThrow(
      /UNIQUE constraint failed: workspaces\.id/,
    );
  });

  it('软删除后从默认列表隐藏，按 rootPath 仍能找到并恢复', () => {
    const repo = storage().workspaces;
    repo.insert(workspace());
    repo.insert(workspace({ id: 'ws_02', rootPath: '/b', createdAt: T1, updatedAt: T1 }));

    expect(repo.markRemoved('ws_01', T2)).toBe(true);
    expect(repo.markRemoved('ws_01', T2)).toBe(false);
    expect(repo.list().map((w) => w.id)).toEqual(['ws_02']);
    expect(repo.list({ includeRemoved: true }).map((w) => w.id)).toEqual(['ws_01', 'ws_02']);
    expect(repo.getByRootPath('/home/u/project')).toEqual(
      workspace({ removedAt: T2, updatedAt: T2 }),
    );

    expect(repo.restore('ws_01', T2)).toBe(true);
    expect(repo.restore('ws_01', T2)).toBe(false);
    expect(repo.get('ws_01')).toEqual(workspace({ updatedAt: T2 }));
    expect(repo.list().map((w) => w.id)).toEqual(['ws_01', 'ws_02']);
  });

  it('改名', () => {
    const repo = storage().workspaces;
    repo.insert(workspace());
    expect(repo.rename('ws_01', '新名字', T1)).toBe(true);
    expect(repo.get('ws_01')).toEqual(workspace({ displayName: '新名字', updatedAt: T1 }));
    expect(repo.rename('ws_missing', 'x', T1)).toBe(false);
    expect(repo.get('ws_01')?.createdAt).toBe(T0);
  });

  it('其他源文件夹：插入时带上、整组替换、空数组清空', () => {
    const repo = storage().workspaces;
    repo.insert(workspace({ extraFolders: ['/home/u/docs'] }));
    expect(repo.get('ws_01')?.extraFolders).toEqual(['/home/u/docs']);
    expect(repo.setExtraFolders('ws_01', ['/b', '/a'], T1)).toBe(true);
    expect(repo.get('ws_01')).toEqual(workspace({ extraFolders: ['/b', '/a'], updatedAt: T1 }));
    expect(repo.setExtraFolders('ws_01', [], T2)).toBe(true);
    expect(repo.get('ws_01')).toEqual(workspace({ updatedAt: T2 }));
    expect(repo.setExtraFolders('ws_missing', ['/a'], T1)).toBe(false);
  });
});
