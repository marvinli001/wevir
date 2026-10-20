// workspace.update（0.49.0）：项目改名，经方法表对着真实存储；0.63.0 起也改其他源文件夹。

import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MethodSchemas } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const context = { client: identity, capabilities: {} };

describe('workspace.update', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  function setup() {
    const root = realpathSync(tempDir());
    const storage = storages.open(join(root, 'data'));
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const manager = new SessionManager({
      storage,
      events,
      adapter: new EchoAdapter({ stepDelayMs: 0 }),
    });
    managers.push(manager);
    const methods = createHostMethods({
      storage,
      events,
      sessions: manager,
      secrets: new FileSecretStore(join(root, 'data')),
    });
    const folder = join(root, 'alpha');
    mkdirSync(folder);
    const other = (name: string) => {
      const dir = join(root, name);
      mkdirSync(dir);
      return realpathSync(dir);
    };
    return { methods, folder: realpathSync(folder), root, other };
  }

  it('只改显示名：去掉首尾空白，rootPath 与创建时间不变，列表跟着变', async () => {
    const { methods, folder } = setup();
    const { workspace } = await methods['workspace.add']({ rootPath: folder }, context);
    const { workspace: renamed } = await methods['workspace.update'](
      { workspaceId: workspace.id, displayName: '  前端  ' },
      context,
    );
    expect(MethodSchemas['workspace.update'].result.safeParse({ workspace: renamed }).success).toBe(
      true,
    );
    expect(renamed).toMatchObject({
      id: workspace.id,
      rootPath: workspace.rootPath,
      displayName: '前端',
      createdAt: workspace.createdAt,
    });
    expect((await methods['workspace.list']({}, context)).workspaces).toEqual([renamed]);
  });

  it('名字没变时不动更新时间', async () => {
    const { methods, folder } = setup();
    const { workspace } = await methods['workspace.add']({ rootPath: folder }, context);
    const { workspace: same } = await methods['workspace.update'](
      { workspaceId: workspace.id, displayName: workspace.displayName },
      context,
    );
    expect(same.updatedAt).toBe(workspace.updatedAt);
  });

  it('空白的名字是 INVALID_PARAMS，原名保留', async () => {
    const { methods, folder } = setup();
    const { workspace } = await methods['workspace.add']({ rootPath: folder }, context);
    expect(() =>
      methods['workspace.update']({ workspaceId: workspace.id, displayName: '   ' }, context),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    expect((await methods['workspace.list']({}, context)).workspaces[0]?.displayName).toBe(
      workspace.displayName,
    );
  });

  it('不存在与已移除的项目是 WORKSPACE_NOT_FOUND', async () => {
    const { methods, folder } = setup();
    expect(() =>
      methods['workspace.update'](
        { workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR', displayName: 'x' },
        context,
      ),
    ).toThrow(expect.objectContaining({ code: 'WORKSPACE_NOT_FOUND' }));
    const { workspace } = await methods['workspace.add']({ rootPath: folder }, context);
    methods['workspace.remove']({ workspaceId: workspace.id }, context);
    expect(() =>
      methods['workspace.update']({ workspaceId: workspace.id, displayName: 'x' }, context),
    ).toThrow(expect.objectContaining({ code: 'WORKSPACE_NOT_FOUND' }));
  });

  it('改过的名字在移除后重新添加同一文件夹时保留', async () => {
    const { methods, folder } = setup();
    const { workspace } = await methods['workspace.add']({ rootPath: folder }, context);
    await methods['workspace.update']({ workspaceId: workspace.id, displayName: '后端' }, context);
    methods['workspace.remove']({ workspaceId: workspace.id }, context);
    const again = await methods['workspace.add']({ rootPath: folder }, context);
    expect(again.created).toBe(false);
    expect(again.workspace).toMatchObject({ id: workspace.id, displayName: '后端' });
  });

  it('其他源文件夹：add 时带上，update 整组替换（取 realpath），[] 清空；只改名时不动它们', async () => {
    const { methods, folder, root, other } = setup();
    const docs = other('docs');
    const api = other('api');
    const { workspace } = await methods['workspace.add'](
      { rootPath: folder, extraFolders: [docs] },
      context,
    );
    expect(workspace.extraFolders).toEqual([docs]);
    expect(
      MethodSchemas['workspace.add'].result.safeParse({ workspace, created: true }).success,
    ).toBe(true);

    symlinkSync(api, join(root, 'api-link'));
    const { workspace: changed } = await methods['workspace.update'](
      { workspaceId: workspace.id, extraFolders: [join(root, 'api-link'), docs] },
      context,
    );
    expect(changed).toMatchObject({
      displayName: workspace.displayName,
      extraFolders: [api, docs],
    });

    const { workspace: renamed } = await methods['workspace.update'](
      { workspaceId: workspace.id, displayName: '全栈' },
      context,
    );
    expect(renamed.extraFolders).toEqual([api, docs]);

    const { workspace: cleared } = await methods['workspace.update'](
      { workspaceId: workspace.id, extraFolders: [] },
      context,
    );
    expect(cleared.extraFolders).toBeUndefined();
    expect((await methods['workspace.list']({}, context)).workspaces).toEqual([cleared]);
  });

  it('其他源文件夹不能是主文件夹、不能重复、要存在；出错时什么都不改', async () => {
    const { methods, folder, root, other } = setup();
    const docs = other('docs');
    const { workspace } = await methods['workspace.add']({ rootPath: folder }, context);
    const update = (extraFolders: string[]) =>
      methods['workspace.update'](
        { workspaceId: workspace.id, displayName: '改了', extraFolders },
        context,
      );
    await expect(update([folder])).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(update([docs, docs])).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(update([join(root, 'missing')])).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_INVALID',
      data: { reason: 'not_found' },
    });
    await expect(update(['relative/path'])).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_INVALID',
      data: { reason: 'not_absolute' },
    });
    await expect(
      methods['workspace.add']({ rootPath: docs, extraFolders: [join(root, 'missing')] }, context),
    ).rejects.toMatchObject({ code: 'WORKSPACE_PATH_INVALID' });
    const { workspaces } = await methods['workspace.list']({}, context);
    expect(workspaces).toEqual([workspace]);
  });
});
