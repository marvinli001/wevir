// 环境（0.15.0，U22.1，domain-model §3.10）：environment.* 方法与按环境建会话（真实的 git worktree）；不用环境、单独新开 worktree
// 的会话（0.18.0）。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const context = { client: identity, capabilities: {} };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

function setup(adapter = new EchoAdapter({ stepDelayMs: 0 })) {
  const root = realpathSync(tempDir());
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const storage = storages.open(dataDir);
  const events = new EventStore({ storage, deltaWindowMs: 5 });
  const worktreesDir = join(dataDir, 'worktrees');
  const sessions = new SessionManager({ storage, events, adapter, worktreesDir });
  const methods = createHostMethods({
    storage,
    events,
    sessions,
    secrets: new FileSecretStore(dataDir),
  });
  storage.providers.insert({
    id: 'mock',
    kind: 'openai-compatible',
    displayName: 'Mock',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'm' }],
    defaultModelId: 'm',
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
  });
  /** 一个有一次提交的仓库（`sub` 是它的子目录），登记成工作区。 */
  const project = async (name: string, options: { git?: boolean; sub?: boolean } = {}) => {
    const dir = join(root, name);
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'a.txt'), 'a\n');
    if (options.git !== false) {
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'init');
    }
    const rootPath = options.sub ? join(dir, 'sub') : dir;
    return (await methods['workspace.add']({ rootPath }, context)).workspace;
  };
  return { methods, storage, sessions, worktreesDir, project };
}

describe('environment.*', () => {
  it('增删改查；名字去掉首尾空白，文件夹不能重复，工作区要在', async () => {
    const h = setup();
    const a = await h.project('a');
    const b = await h.project('b', { git: false });
    const { environment } = await h.methods['environment.create'](
      {
        name: '  前后端  ',
        folders: [
          { workspaceId: a.id, worktree: 'new' },
          { workspaceId: b.id, worktree: 'none' },
        ],
      },
      context,
    );
    expect(environment).toMatchObject({ name: '前后端', location: { kind: 'local' } });
    expect((await h.methods['environment.list']({}, context)).environments).toEqual([environment]);

    const updated = await h.methods['environment.update'](
      { environmentId: environment.id, name: '改名' },
      context,
    );
    expect(updated.environment).toMatchObject({ name: '改名', folders: environment.folders });

    expect(() =>
      h.methods['environment.create'](
        {
          name: 'x',
          folders: [
            { workspaceId: a.id, worktree: 'none' },
            { workspaceId: a.id, worktree: 'new' },
          ],
        },
        context,
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    expect(() =>
      h.methods['environment.create'](
        {
          name: 'x',
          folders: [{ workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPZZ', worktree: 'none' }],
        },
        context,
      ),
    ).toThrow(expect.objectContaining({ code: 'WORKSPACE_NOT_FOUND' }));
    expect(() =>
      h.methods['environment.create']({ name: '   ', folders: environment.folders }, context),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));

    expect(h.methods['environment.remove']({ environmentId: environment.id }, context)).toEqual({});
    expect(() =>
      h.methods['environment.remove']({ environmentId: environment.id }, context),
    ).toThrow(expect.objectContaining({ code: 'ENVIRONMENT_NOT_FOUND' }));
  });
});

describe('按环境建会话', () => {
  it('主文件夹新开 worktree 作 cwd，其余文件夹是额外目录；字段写进会话与 session.created', async () => {
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    const create = vi.spyOn(adapter, 'createSession');
    const h = setup(adapter);
    const app = await h.project('app', { sub: true });
    const api = await h.project('api', { git: false });
    const { environment } = await h.methods['environment.create'](
      {
        name: 'env',
        folders: [
          { workspaceId: app.id, worktree: 'new' },
          { workspaceId: api.id, worktree: 'none' },
        ],
      },
      context,
    );
    const { session } = await h.methods['session.create'](
      { workspaceId: app.id, providerId: 'mock', environmentId: environment.id },
      context,
    );
    const worktreeRoot = join(h.worktreesDir, session.id, '1-app');
    expect(session).toMatchObject({
      workspaceId: app.id,
      cwd: join(worktreeRoot, 'sub'),
      environmentId: environment.id,
      extraRoots: [api.rootPath],
      worktrees: [
        {
          workspaceId: app.id,
          path: join(worktreeRoot, 'sub'),
          branch: `wevir/${session.id.slice(-8).toLowerCase()}`,
        },
      ],
    });
    expect(existsSync(join(worktreeRoot, 'sub', 'a.txt'))).toBe(true);
    expect(git(join(worktreeRoot, 'sub'), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      session.worktrees?.[0]?.branch,
    );
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      cwd: join(worktreeRoot, 'sub'),
      additionalRoots: [api.rootPath],
    });
    const created = h.storage.events.list(session.id, { limit: 1 })[0];
    expect(created?.payload).toMatchObject({
      environmentId: environment.id,
      extraRoots: [api.rootPath],
    });
  });

  it('workspaceId 不是主文件夹、环境不在、要 worktree 的不是仓库时不建会话，已建的 worktree 撤回', async () => {
    const h = setup();
    const app = await h.project('app');
    const plain = await h.project('plain', { git: false });
    const { environment } = await h.methods['environment.create'](
      {
        name: 'env',
        folders: [
          { workspaceId: app.id, worktree: 'new' },
          { workspaceId: plain.id, worktree: 'new' },
        ],
      },
      context,
    );
    await expect(
      h.methods['session.create'](
        { workspaceId: plain.id, providerId: 'mock', environmentId: environment.id },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      h.methods['session.create'](
        {
          workspaceId: app.id,
          providerId: 'mock',
          environmentId: 'env_01JA2B3C4D5E6F7G8H9JKMNPZZ',
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_FOUND' });
    await expect(
      h.methods['session.create'](
        { workspaceId: app.id, providerId: 'mock', environmentId: environment.id },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: expect.stringContaining('plain') });
    // app 的 worktree 已建好，又撤回了：目录与分支都不在。
    expect(existsSync(h.worktreesDir) ? readdirSync(h.worktreesDir) : []).toEqual([]);
    expect(git(app.rootPath, 'branch', '--list', 'wevir/*').trim()).toBe('');
    expect(git(app.rootPath, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(h.storage.sessions.list()).toEqual([]);
  });

  it('引擎不支持额外目录时，多文件夹的环境建不了会话', async () => {
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    Object.defineProperty(adapter, 'additionalRoots', { value: undefined });
    const h = setup(adapter);
    const a = await h.project('a', { git: false });
    const b = await h.project('b', { git: false });
    const { environment } = await h.methods['environment.create'](
      {
        name: 'env',
        folders: [
          { workspaceId: a.id as WorkspaceId, worktree: 'none' },
          { workspaceId: b.id as WorkspaceId, worktree: 'none' },
        ],
      },
      context,
    );
    await expect(
      h.methods['session.create'](
        { workspaceId: a.id, providerId: 'mock', environmentId: environment.id },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
});

describe('单独新开 worktree 的会话（0.18.0）', () => {
  it("worktree: 'new' 在工作区的仓库里新开 worktree 作 cwd，不记环境；none 与省略一样用工作区目录", async () => {
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    const create = vi.spyOn(adapter, 'createSession');
    const h = setup(adapter);
    const app = await h.project('app', { sub: true });
    const { session } = await h.methods['session.create'](
      { workspaceId: app.id, providerId: 'mock', worktree: 'new' },
      context,
    );
    const worktreeRoot = join(h.worktreesDir, session.id, '1-app');
    const branch = `wevir/${session.id.slice(-8).toLowerCase()}`;
    expect(session).toMatchObject({
      workspaceId: app.id,
      cwd: join(worktreeRoot, 'sub'),
      worktrees: [{ workspaceId: app.id, path: join(worktreeRoot, 'sub'), branch }],
    });
    expect(session.environmentId).toBeUndefined();
    expect(session.extraRoots).toBeUndefined();
    expect(git(join(worktreeRoot, 'sub'), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ cwd: join(worktreeRoot, 'sub') });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('additionalRoots');
    const created = h.storage.events.list(session.id, { limit: 1 })[0];
    expect(created?.payload).toMatchObject({
      cwd: join(worktreeRoot, 'sub'),
      worktrees: [{ branch }],
    });
    expect(created?.payload).not.toHaveProperty('environmentId');

    const local = await h.methods['session.create'](
      { workspaceId: app.id, providerId: 'mock', worktree: 'none' },
      context,
    );
    expect(local.session.cwd).toBe(app.rootPath);
    expect(local.session.worktrees).toBeUndefined();
  });

  it('不是仓库、与 environmentId 同时给时不建会话，也不留 worktree', async () => {
    const h = setup();
    const app = await h.project('app');
    const plain = await h.project('plain', { git: false });
    await expect(
      h.methods['session.create'](
        { workspaceId: plain.id, providerId: 'mock', worktree: 'new' },
        context,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: expect.stringContaining('plain'),
      data: { issues: [{ path: ['worktree'] }] },
    });
    const { environment } = await h.methods['environment.create'](
      { name: 'env', folders: [{ workspaceId: app.id, worktree: 'none' }] },
      context,
    );
    await expect(
      h.methods['session.create'](
        { workspaceId: app.id, providerId: 'mock', environmentId: environment.id, worktree: 'new' },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS', data: { issues: [{ path: ['worktree'] }] } });
    expect(existsSync(h.worktreesDir) ? readdirSync(h.worktreesDir) : []).toEqual([]);
    expect(git(app.rootPath, 'branch', '--list', 'wevir/*').trim()).toBe('');
    expect(h.storage.sessions.list()).toEqual([]);
  });
});

describe('有多个源文件夹的项目（0.64.0）', () => {
  /** 一个项目，另带一个普通文件夹作为其他源文件夹。 */
  async function projectWithDocs(h: ReturnType<typeof setup>) {
    const app = await h.project('app');
    const docs = join(realpathSync(tempDir()), 'docs');
    mkdirSync(docs);
    const { workspace } = await h.methods['workspace.update'](
      { workspaceId: app.id, extraFolders: [docs] },
      context,
    );
    return { app: workspace, docs: realpathSync(docs) };
  }

  it('普通会话与单独新开 worktree 的会话都把其他源文件夹作为额外目录，不为它们开 worktree', async () => {
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    const create = vi.spyOn(adapter, 'createSession');
    const h = setup(adapter);
    const { app, docs } = await projectWithDocs(h);
    const { session: plain } = await h.methods['session.create'](
      { workspaceId: app.id, providerId: 'mock' },
      context,
    );
    expect(plain).toMatchObject({ cwd: app.rootPath, extraRoots: [docs] });
    expect(plain.environmentId).toBeUndefined();
    expect(create.mock.calls[0]?.[0]).toMatchObject({ additionalRoots: [docs] });

    const { session: isolated } = await h.methods['session.create'](
      { workspaceId: app.id, providerId: 'mock', worktree: 'new' },
      context,
    );
    expect(isolated.cwd).toBe(join(h.worktreesDir, isolated.id, '1-app'));
    expect(isolated.extraRoots).toEqual([docs]);
    expect(isolated.worktrees).toHaveLength(1);
  });

  it('按环境建的会话只用环境的文件夹', async () => {
    const h = setup();
    const { app } = await projectWithDocs(h);
    const { environment } = await h.methods['environment.create'](
      { name: 'env', folders: [{ workspaceId: app.id, worktree: 'none' }] },
      context,
    );
    const { session } = await h.methods['session.create'](
      { workspaceId: app.id, providerId: 'mock', environmentId: environment.id },
      context,
    );
    expect(session.extraRoots).toBeUndefined();
  });

  it('引擎不支持额外目录时照常建会话，只是不给其他源文件夹', async () => {
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    Object.defineProperty(adapter, 'additionalRoots', { value: undefined });
    const h = setup(adapter);
    const { app } = await projectWithDocs(h);
    const { session } = await h.methods['session.create'](
      { workspaceId: app.id, providerId: 'mock' },
      context,
    );
    expect(session.cwd).toBe(app.rootPath);
    expect(session.extraRoots).toBeUndefined();
  });

  it('其他源文件夹不在了时不建会话（WORKSPACE_PATH_INVALID）', async () => {
    const h = setup();
    const { app, docs } = await projectWithDocs(h);
    rmSync(docs, { recursive: true });
    await expect(
      h.methods['session.create']({ workspaceId: app.id, providerId: 'mock' }, context),
    ).rejects.toMatchObject({ code: 'WORKSPACE_PATH_INVALID', data: { path: docs } });
    expect(h.storage.sessions.list()).toEqual([]);
  });
});
