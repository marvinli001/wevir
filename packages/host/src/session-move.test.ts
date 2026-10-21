// session.move（0.81.0，domain-model §3.36）：经方法表对着 EchoAdapter 的会话与真实的 git 仓库，在项目目录与 worktree 之间来回移动。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MethodSchemas, type SessionId, type WevirEvent } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatFolders } from './chats.js';
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

const status = (dir: string) =>
  git(dir, 'status', '--porcelain').split('\n').filter(Boolean).sort();

const managers: SessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

async function setup(options: { relocatable?: boolean } = {}) {
  const adapter = new EchoAdapter({ stepDelayMs: 0, relocatable: options.relocatable === true });
  const root = realpathSync(tempDir());
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const storage = storages.open(dataDir);
  const events = new EventStore({ storage, deltaWindowMs: 5 });
  const worktreesDir = join(dataDir, 'worktrees');
  const chats = new ChatFolders({ dir: join(dataDir, 'chats') });
  await chats.load();
  const sessions = new SessionManager({
    storage,
    events,
    adapter,
    worktreesDir,
    historyDir: join(dataDir, 'history'),
    chats,
  });
  managers.push(sessions);
  const methods = createHostMethods({
    storage,
    events,
    sessions,
    secrets: new FileSecretStore(dataDir),
    chats,
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
  const dir = join(root, 'app');
  mkdirSync(dir);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  git(dir, 'init', '-q', '-b', 'main');
  // Windows 上 git 默认 core.autocrlf=true，还原与检出会把 LF 的文件写成 CRLF；这里测的是改动怎么跟着走，行尾由仓库自己定。
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  const { workspace } = await methods['workspace.add']({ rootPath: dir }, context);
  const { session } = await methods['session.create'](
    { workspaceId: workspace.id, providerId: 'mock' },
    context,
  );
  const sessionId = session.id as SessionId;
  const send = async (text: string) => {
    await sessions.send({ sessionId, content: [{ type: 'text', text }] }, identity);
    await vi.waitFor(() => expect(events.snapshot(sessionId)?.session.state).toBe('idle'), {
      timeout: 20_000,
    });
  };
  const move = (to: 'worktree' | 'local') => methods['session.move']({ sessionId, to }, context);
  const typesSince = (seq: number) =>
    events
      .readSince(sessionId, seq)
      .map((event: WevirEvent) => event.type)
      .filter((type) => type.startsWith('session.'));
  return {
    adapter,
    dataDir,
    worktreesDir,
    storage,
    events,
    methods,
    dir,
    sessionId,
    send,
    move,
    typesSince,
  };
}

describe('session.move', () => {
  it('移进 worktree：改动与未跟踪文件跟着走，原处回到 HEAD（被忽略的留着）；换不了目录的引擎新开引擎会话、交摘要', async () => {
    const h = await setup();
    await h.send('hello');
    writeFileSync(join(h.dir, 'a.txt'), 'changed\n');
    writeFileSync(join(h.dir, 'new.txt'), 'new\n');
    mkdirSync(join(h.dir, 'node_modules'));
    writeFileSync(join(h.dir, 'node_modules', 'x.js'), 'x');
    const before = h.events.snapshot(h.sessionId)?.session;
    const lastSeq = before?.lastSeq ?? 0;

    const result = await h.move('worktree');
    expect(MethodSchemas['session.move'].result.safeParse(result).success).toBe(true);
    const branch = `wevir/${h.sessionId.slice(-8).toLowerCase()}`;
    const cwd = join(h.worktreesDir, h.sessionId, '1-app');
    expect(result.moved).toEqual({
      to: 'worktree',
      from: h.dir,
      cwd,
      branch,
      ref: expect.stringMatching(new RegExp(`^refs/wevir/move/${h.sessionId}/`)),
      engine: 'handoff',
    });
    expect(result.session.cwd).toBe(cwd);
    expect(result.session.worktrees).toEqual([
      { workspaceId: result.session.workspaceId, path: cwd, branch },
    ]);
    expect(result.session.engine.sessionId).not.toBe(before?.engine.sessionId);
    expect(result.session.state).toBe('idle');
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('changed\n');
    expect(readFileSync(join(cwd, 'new.txt'), 'utf8')).toBe('new\n');
    expect(status(cwd)).toEqual([' M a.txt', '?? new.txt']);
    expect(status(h.dir)).toEqual([]);
    expect(readFileSync(join(h.dir, 'a.txt'), 'utf8')).toBe('a\n');
    expect(existsSync(join(h.dir, 'node_modules', 'x.js'))).toBe(true);
    expect(git(h.dir, 'show', `${result.moved.ref}:a.txt`)).toBe('changed\n');
    expect(h.typesSince(lastSeq)).toEqual(['session.moved', 'session.handoff']);
    const handoff = h.events
      .readSince(h.sessionId, lastSeq)
      .find((event) => event.type === 'session.handoff');
    expect(handoff?.type === 'session.handoff' && handoff.payload.context).toContain('hello');

    // 会话照常能用，引擎会话在新目录里。
    await h.send('again');
    expect(h.storage.sessions.get(h.sessionId)?.cwd).toBe(cwd);
  });

  it('能换目录的引擎接着用原来的引擎会话（session.resumed），并补一条说明', async () => {
    const h = await setup({ relocatable: true });
    await h.send('hello');
    const before = h.events.snapshot(h.sessionId)?.session;
    const inject = vi.spyOn(h.adapter, 'injectNote');
    const result = await h.move('worktree');
    expect(result.moved.engine).toBe('resumed');
    expect(result.session.engine.sessionId).toBe(before?.engine.sessionId);
    expect(h.typesSince(before?.lastSeq ?? 0)).toEqual(['session.moved', 'session.resumed']);
    expect(inject).toHaveBeenCalledWith(
      before?.engine.sessionId,
      expect.stringContaining(result.moved.cwd),
    );
    await h.send('again');
  });

  it('移回本地：本地换到 worktree 的分支并带上改动，worktree 删掉；再移进 worktree 时本地换回原来的分支', async () => {
    const h = await setup();
    const { moved } = await h.move('worktree');
    const wt = moved.cwd;
    writeFileSync(join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'work');
    writeFileSync(join(wt, 'a.txt'), 'wip\n');

    const back = await h.move('local');
    expect(back.moved).toMatchObject({
      to: 'local',
      from: wt,
      cwd: h.dir,
      branch: moved.branch,
      previousBranch: 'main',
      engine: 'handoff',
    });
    expect(back.session.cwd).toBe(h.dir);
    expect(back.session.worktrees).toBeUndefined();
    expect(existsSync(wt)).toBe(false);
    expect(git(h.dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(moved.branch);
    expect(readFileSync(join(h.dir, 'b.txt'), 'utf8')).toBe('b\n');
    expect(status(h.dir)).toEqual([' M a.txt']);

    const again = await h.move('worktree');
    expect(again.moved.branch).toBe(moved.branch);
    expect(git(h.dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(status(h.dir)).toEqual([]);
    expect(existsSync(join(h.dir, 'b.txt'))).toBe(false);
    expect(readFileSync(join(again.moved.cwd, 'a.txt'), 'utf8')).toBe('wip\n');
    expect(git(again.moved.cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(moved.branch);
  });

  it('拒绝：本地有没提交的改动时不能移回、已经在 worktree 里不能再移进、不在 worktree 里不能移回；什么都不动', async () => {
    const h = await setup();
    const local = await Promise.resolve()
      .then(() => h.move('local'))
      .catch((error: unknown) => error);
    expect(local).toMatchObject({ code: 'INVALID_STATE' });

    const { moved } = await h.move('worktree');
    const twice = await Promise.resolve()
      .then(() => h.move('worktree'))
      .catch((error: unknown) => error);
    expect(twice).toMatchObject({ code: 'INVALID_STATE' });

    writeFileSync(join(h.dir, 'a.txt'), 'local edit\n');
    writeFileSync(join(moved.cwd, 'a.txt'), 'worktree edit\n');
    const dirty = await Promise.resolve()
      .then(() => h.move('local'))
      .catch((error: unknown) => error);
    expect(dirty).toMatchObject({ code: 'INVALID_STATE' });
    expect(h.storage.sessions.get(h.sessionId)?.cwd).toBe(moved.cwd);
    expect(readFileSync(join(moved.cwd, 'a.txt'), 'utf8')).toBe('worktree edit\n');
    expect(readFileSync(join(h.dir, 'a.txt'), 'utf8')).toBe('local edit\n');
  });

  it('引擎挂不上时撤回：worktree 与分支删掉，原处的改动放回，会话还在原处', async () => {
    const h = await setup();
    writeFileSync(join(h.dir, 'a.txt'), 'changed\n');
    writeFileSync(join(h.dir, 'new.txt'), 'new\n');
    vi.spyOn(h.adapter, 'createSession').mockRejectedValueOnce(new Error('boom'));
    const failed = await Promise.resolve()
      .then(() => h.move('worktree'))
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: 'ENGINE_ERROR' });
    expect(h.storage.sessions.get(h.sessionId)?.cwd).toBe(h.dir);
    expect(existsSync(join(h.worktreesDir, h.sessionId, '1-app'))).toBe(false);
    expect(git(h.dir, 'branch', '--list', 'wevir/*')).toBe('');
    expect(status(h.dir)).toEqual([' M a.txt', '?? new.txt']);
    await h.send('still here');
  });

  it('删除会话时删掉移动的快照 ref', async () => {
    const h = await setup();
    await h.move('worktree');
    await h.move('local');
    expect(git(h.dir, 'for-each-ref', 'refs/wevir/move/')).not.toBe('');
    await h.methods['session.archive']({ sessionId: h.sessionId, archived: true }, context);
    await h.methods['session.delete']({ sessionId: h.sessionId }, context);
    expect(git(h.dir, 'for-each-ref', 'refs/wevir/move/')).toBe('');
  });
});
