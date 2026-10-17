// 不在项目里的会话（0.39.0，domain-model §3.1）：“对话”工作区与每个会话新建的文件夹。

import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { describe, expect, it, vi } from 'vitest';
import { ChatFolders } from './chats.js';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const context = { client: identity, capabilities: {} };

async function setup(options: { adapter?: EchoAdapter; chats?: boolean; dataDir?: string } = {}) {
  const dataDir = options.dataDir ?? join(realpathSync(tempDir()), 'data');
  mkdirSync(dataDir, { recursive: true });
  const storage = storages.open(dataDir);
  const events = new EventStore({ storage, deltaWindowMs: 5 });
  const adapter = options.adapter ?? new EchoAdapter({ stepDelayMs: 0 });
  let chats: ChatFolders | undefined;
  if (options.chats !== false) {
    chats = new ChatFolders({ dir: join(dataDir, 'chats') });
    await chats.load();
  }
  const sessions = new SessionManager({
    storage,
    events,
    adapter,
    worktreesDir: join(dataDir, 'worktrees'),
    ...(chats && { chats }),
  });
  const methods = createHostMethods({
    storage,
    events,
    sessions,
    secrets: new FileSecretStore(dataDir),
    ...(chats && { chats }),
  });
  if (!storage.providers.get('mock')) {
    storage.providers.insert({
      id: 'mock',
      kind: 'openai-compatible',
      displayName: 'Mock',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'm' }],
      defaultModelId: 'm',
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
    });
  }
  return { dataDir, storage, sessions, methods, adapter };
}

describe('不带 workspaceId 的 session.create', () => {
  it('建在“对话”工作区，每个会话一个新建的空文件夹', async () => {
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    const create = vi.spyOn(adapter, 'createSession');
    const h = await setup({ adapter });
    expect((await h.methods['workspace.list']({}, context)).workspaces).toEqual([]);

    const first = (await h.methods['session.create']({ providerId: 'mock' }, context)).session;
    const second = (await h.methods['session.create']({ providerId: 'mock' }, context)).session;

    const root = join(h.dataDir, 'chats');
    const { workspaces } = await h.methods['workspace.list']({}, context);
    expect(workspaces).toEqual([
      expect.objectContaining({ id: first.workspaceId, rootPath: root, kind: 'chats' }),
    ]);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(first.cwd).toBe(join(root, first.id));
    expect(second.cwd).toBe(join(root, second.id));
    expect(readdirSync(first.cwd)).toEqual([]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ cwd: first.cwd }));
    expect(h.storage.sessions.get(first.id)?.cwd).toBe(first.cwd);

    // 显式给“对话”工作区也是新文件夹，不是工作区目录本身。
    const third = (
      await h.methods['session.create'](
        { workspaceId: first.workspaceId, providerId: 'mock' },
        context,
      )
    ).session;
    expect(third.cwd).toBe(join(root, third.id));
  });

  it('在对话里发消息照常有回答', async () => {
    const h = await setup();
    const { session } = await h.methods['session.create']({ providerId: 'mock' }, context);
    const sent = await h.sessions.send(
      { sessionId: session.id, content: [{ type: 'text', text: 'hi' }] },
      identity,
    );
    expect(sent.turnId).toBeDefined();
    await vi.waitFor(async () =>
      expect(
        (await h.methods['session.get']({ sessionId: session.id }, context)).session.state,
      ).toBe('idle'),
    );
  });

  it('不能带环境或新开 worktree，也不留下文件夹', async () => {
    const h = await setup();
    const { session } = await h.methods['session.create']({ providerId: 'mock' }, context);
    await expect(
      h.methods['session.create']({ providerId: 'mock', worktree: 'new' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      h.methods['session.create'](
        { providerId: 'mock', environmentId: 'env_01JA2B3C4D5E6F7G8H9JKMNPQR' },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(readdirSync(join(h.dataDir, 'chats'))).toEqual([session.id]);
  });

  it('引擎会话建不起来时删掉刚建的文件夹', async () => {
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    vi.spyOn(adapter, 'createSession').mockRejectedValueOnce(new Error('boom'));
    const h = await setup({ adapter });
    await expect(
      h.methods['session.create']({ providerId: 'mock' }, context),
    ).rejects.toMatchObject({ code: 'ENGINE_ERROR' });
    expect(readdirSync(join(h.dataDir, 'chats'))).toEqual([]);
  });

  it('Host 没有对话时 workspaceId 必填', async () => {
    const h = await setup({ chats: false });
    await expect(
      h.methods['session.create']({ providerId: 'mock' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(existsSync(join(h.dataDir, 'chats'))).toBe(false);
  });
});

describe('“对话”工作区', () => {
  it('不能移除、改名、作为项目添加，也不能进环境', async () => {
    const h = await setup();
    const { session } = await h.methods['session.create']({ providerId: 'mock' }, context);
    const root = join(h.dataDir, 'chats');
    expect(() =>
      h.methods['workspace.remove']({ workspaceId: session.workspaceId }, context),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    expect(() =>
      h.methods['workspace.update'](
        { workspaceId: session.workspaceId, displayName: '别的名字' },
        context,
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    await expect(h.methods['workspace.add']({ rootPath: root }, context)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(
      h.methods['workspace.add']({ rootPath: session.cwd }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(() =>
      h.methods['environment.create'](
        { name: 'x', folders: [{ workspaceId: session.workspaceId, worktree: 'none' }] },
        context,
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
  });

  it('文件只能按会话读', async () => {
    const h = await setup();
    const { session } = await h.methods['session.create']({ providerId: 'mock' }, context);
    const workspaceId = session.workspaceId as WorkspaceId;
    await expect(
      h.methods['workspace.listDir']({ workspaceId, path: '' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const listed = await h.methods['workspace.listDir'](
      { workspaceId, sessionId: session.id, path: '' },
      context,
    );
    expect(listed).toMatchObject({ entries: [] });
  });

  it('Host 重启后照样认得出', async () => {
    const first = await setup();
    const { session } = await first.methods['session.create']({ providerId: 'mock' }, context);
    first.storage.close();
    const again = await setup({ dataDir: first.dataDir });
    expect((await again.methods['workspace.list']({}, context)).workspaces).toEqual([
      expect.objectContaining({ id: session.workspaceId, kind: 'chats' }),
    ]);
    const next = (await again.methods['session.create']({ providerId: 'mock' }, context)).session;
    expect(next.workspaceId).toBe(session.workspaceId);
  });
});
