// session.delete 与 session.usage（0.43.0，domain-model §3.20）、归档时的 worktree 快照（0.81.0，§3.36）：经方法表对着 EchoAdapter
// 的会话，真实的 git worktree、对话文件夹、历史文件与图片。

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { MethodSchemas, type SessionId, type WorkspaceId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatFolders } from './chats.js';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { ImageStore } from './images.js';
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

/** 只有文件头的 PNG。 */
function png(): string {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(2, 16);
  bytes.writeUInt32BE(2, 20);
  return bytes.toString('base64');
}

const managers: SessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

async function setup(adapter: EchoAdapter = new EchoAdapter({ stepDelayMs: 0 })) {
  const root = realpathSync(tempDir());
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const storage = storages.open(dataDir);
  const events = new EventStore({ storage, deltaWindowMs: 5 });
  const worktreesDir = join(dataDir, 'worktrees');
  const historyDir = join(dataDir, 'history');
  const toolOutputDir = join(dataDir, 'tool-output');
  const forgotten: SessionId[][] = [];
  const chats = new ChatFolders({ dir: join(dataDir, 'chats') });
  await chats.load();
  const images = new ImageStore({ dir: join(dataDir, 'images') });
  const sessions = new SessionManager({
    storage,
    events,
    adapter,
    worktreesDir,
    historyDir,
    toolOutputDir,
    appTools: { grant: () => undefined, forget: (ids) => forgotten.push([...ids]) },
    chats,
    images,
  });
  managers.push(sessions);
  const methods = createHostMethods({
    storage,
    events,
    sessions,
    secrets: new FileSecretStore(dataDir),
    chats,
    images,
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
  /** 一个有一次提交的仓库，登记成工作区。 */
  const project = async (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    git(dir, 'init', '-q', '-b', 'main');
    // Windows 上 git 默认 core.autocrlf=true，还原与检出会把 LF 的文件写成 CRLF；这里测的是改动怎么跟着走，行尾由仓库自己定。
    git(dir, 'config', 'core.autocrlf', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    return {
      dir,
      workspace: (await methods['workspace.add']({ rootPath: dir }, context)).workspace,
    };
  };
  const send = async (sessionId: SessionId, text: string, image?: boolean) => {
    const content: Parameters<SessionManager['send']>[0]['content'] = [{ type: 'text', text }];
    if (image) {
      const { image: part } = await methods['image.upload'](
        { mimeType: 'image/png', data: png() },
        context,
      );
      content.push(part);
    }
    await sessions.send({ sessionId, content }, identity);
    await vi.waitFor(() => expect(events.snapshot(sessionId)?.session.state).toBe('idle'));
  };
  const archive = (sessionId: SessionId) =>
    methods['session.archive']({ sessionId, archived: true }, context);
  return {
    root,
    dataDir,
    storage,
    events,
    sessions,
    methods,
    adapter,
    worktreesDir,
    historyDir,
    toolOutputDir,
    forgotten,
    project,
    send,
    archive,
  };
}

describe('session.delete', () => {
  it('删掉已归档的对话：库里的行、对话文件夹、历史文件、只有它引用的图片与引擎会话', async () => {
    const h = await setup();
    const { session } = await h.methods['session.create']({ providerId: 'mock' }, context);
    const sessionId = session.id as SessionId;
    await h.send(sessionId, 'hello', true);
    writeFileSync(join(session.cwd, 'notes.md'), 'x'.repeat(2048));
    mkdirSync(h.historyDir, { recursive: true });
    writeFileSync(join(h.historyDir, `${sessionId}.json`), '{}');
    mkdirSync(join(h.toolOutputDir, sessionId), { recursive: true });
    writeFileSync(join(h.toolOutputDir, sessionId, 'process-p1.log'), 'y'.repeat(4096));
    const imageFiles = readdirImages(h.dataDir);
    expect(imageFiles).toHaveLength(2);
    const engineSessionId = h.storage.sessions.get(sessionId)?.engineSessionId as string;

    await h.archive(sessionId);
    const [usage] = (await h.methods['session.usage']({ archived: true }, context)).sessions;
    expect(usage).toMatchObject({ sessionId, worktrees: [] });
    expect(usage?.eventBytes).toBeGreaterThan(0);
    // 对话文件夹里的 2 KiB、进程日志的 4 KiB、历史文件与图片的两份文件。
    expect(usage?.fileBytes).toBeGreaterThan(2048 + 4096 + 64);
    expect(MethodSchemas['session.usage'].result.safeParse({ sessions: [usage] }).success).toBe(
      true,
    );

    const result = await h.methods['session.delete']({ sessionId }, context);
    expect(result).toEqual({ sessionIds: [sessionId] });
    expect(MethodSchemas['session.delete'].result.safeParse(result).success).toBe(true);
    expect(h.storage.sessions.get(sessionId)).toBeUndefined();
    expect(h.storage.events.lastSeq(sessionId)).toBe(0);
    expect(existsSync(session.cwd)).toBe(false);
    expect(existsSync(join(h.historyDir, `${sessionId}.json`))).toBe(false);
    expect(existsSync(join(h.toolOutputDir, sessionId))).toBe(false);
    // 后台进程随会话结束。
    expect(h.forgotten).toEqual([[sessionId]]);
    expect(readdirImages(h.dataDir)).toEqual([]);
    await expect(
      h.adapter.resumeSession(engineSessionId, {
        cwd: session.cwd,
        providerId: 'mock',
        modelId: 'm',
      }),
    ).rejects.toMatchObject({ code: 'session_lost' });
    expect(() => h.methods['session.get']({ sessionId }, context)).toThrow(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' }),
    );
    expect((await h.methods['session.list']({ archived: true }, context)).sessions).toEqual([]);
    await expect(h.methods['session.delete']({ sessionId }, context)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
  });

  it('别的会话还引用的图片留着；分支出去的会话留着', async () => {
    const h = await setup();
    const { session } = await h.methods['session.create']({ providerId: 'mock' }, context);
    const main = session.id as SessionId;
    await h.send(main, 'look', true);
    const { session: branch } = await h.methods['session.fork']({ sessionId: main }, context);
    await h.archive(main);

    await h.methods['session.delete']({ sessionId: main }, context);
    expect(readdirImages(h.dataDir)).toHaveLength(2);
    const kept = await h.methods['session.get']({ sessionId: branch.id }, context);
    expect(kept.session.forkedFrom?.sessionId).toBe(main);

    await h.archive(branch.id as SessionId);
    await h.methods['session.delete']({ sessionId: branch.id as SessionId }, context);
    expect(readdirImages(h.dataDir)).toEqual([]);
  });

  it('子会话与支线一起删；它们自己、没归档的、不存在的会话被拒绝', async () => {
    const h = await setup();
    const { workspace } = await h.project('app');
    const { session } = await h.methods['session.create'](
      { workspaceId: workspace.id, providerId: 'mock' },
      context,
    );
    const main = session.id as SessionId;
    await h.send(main, 'subagent hello');
    const [child] = (await h.methods['session.list']({ parentSessionId: main }, context)).sessions;
    expect(child).toBeDefined();
    const side = await h.sessions.fork({ sessionId: main, side: true });

    await expect(h.methods['session.delete']({ sessionId: main }, context)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await h.archive(main);
    for (const sessionId of [child?.id, side.id] as SessionId[]) {
      await expect(h.methods['session.delete']({ sessionId }, context)).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
      });
    }
    await expect(
      h.methods['session.delete']({ sessionId: 'ses_missing' as SessionId }, context),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });

    const result = await h.methods['session.delete']({ sessionId: main }, context);
    expect(result.sessionIds[0]).toBe(main);
    expect(new Set(result.sessionIds)).toEqual(new Set([main, child?.id, side.id]));
    for (const sessionId of result.sessionIds) {
      expect(h.storage.sessions.get(sessionId)).toBeUndefined();
      expect(h.storage.events.lastSeq(sessionId)).toBe(0);
    }
    // 项目里的会话不碰工作区目录。
    expect(existsSync(join(session.cwd, 'a.txt'))).toBe(true);
  });

  it('worktree 有没提交的改动时拒绝、什么都不删；force 时一起删，合并过的分支删掉', async () => {
    const h = await setup();
    const { dir, workspace } = await h.project('app');
    const { session } = await h.methods['session.create'](
      { workspaceId: workspace.id, providerId: 'mock', worktree: 'new' },
      context,
    );
    const sessionId = session.id as SessionId;
    const [worktree] = session.worktrees ?? [];
    expect(worktree).toBeDefined();
    const root = worktree?.path as string;
    writeFileSync(join(root, 'a.txt'), 'changed\n');
    // 被忽略的文件不算改动，但算大小。
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'big.js'), 'y'.repeat(4096));

    const [before] = (await h.methods['session.usage']({}, context)).sessions;
    expect(before?.worktrees).toEqual([
      {
        workspaceId: workspace.id as WorkspaceId,
        branch: worktree?.branch,
        path: root,
        bytes: expect.any(Number),
        dirty: true,
      },
    ]);
    expect(before?.worktrees[0]?.bytes).toBeGreaterThan(4096);

    // 0.81.0：归档时打快照、删目录；快照里有没提交的改动，同样算有改动。
    await h.archive(sessionId);
    const [usage] = (await h.methods['session.usage']({ archived: true }, context)).sessions;
    expect(usage?.worktrees).toEqual([
      {
        workspaceId: workspace.id as WorkspaceId,
        branch: worktree?.branch,
        path: root,
        bytes: 0,
        dirty: true,
        missing: true,
        archived: true,
      },
    ]);

    const refused = await Promise.resolve()
      .then(() => h.methods['session.delete']({ sessionId }, context))
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: 'RESOURCE_IN_USE',
      data: { sessionIds: [sessionId], worktrees: [{ path: root, branch: worktree?.branch }] },
    });
    expect(h.storage.sessions.get(sessionId)).toBeDefined();
    expect(git(dir, 'for-each-ref', 'refs/wevir/worktree-archive/')).not.toBe('');

    const result = await h.methods['session.delete']({ sessionId, force: true }, context);
    expect(result).toEqual({ sessionIds: [sessionId] });
    expect(existsSync(join(h.worktreesDir, sessionId))).toBe(false);
    expect(git(dir, 'worktree', 'list', '--porcelain')).not.toContain(root);
    expect(git(dir, 'branch', '--list', worktree?.branch as string)).toBe('');
    expect(git(dir, 'for-each-ref', 'refs/wevir/worktree-archive/')).toBe('');
    // 原仓库不受影响。
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a\n');
  });

  it('没合并的分支留着；目录已经不在的 worktree 直接跳过', async () => {
    const h = await setup();
    const { dir, workspace } = await h.project('app');
    const create = () =>
      h.methods['session.create'](
        { workspaceId: workspace.id, providerId: 'mock', worktree: 'new' },
        context,
      );
    const { session: committed } = await create();
    const committedRoot = committed.worktrees?.[0]?.path as string;
    const branch = committed.worktrees?.[0]?.branch as string;
    writeFileSync(join(committedRoot, 'b.txt'), 'b\n');
    git(committedRoot, 'add', '.');
    git(committedRoot, 'commit', '-q', '-m', 'work');
    await h.archive(committed.id as SessionId);
    const result = await h.methods['session.delete'](
      { sessionId: committed.id as SessionId },
      context,
    );
    expect(result).toEqual({ sessionIds: [committed.id], keptBranches: [branch] });
    expect(git(dir, 'branch', '--list', branch).trim()).toContain(branch);
    expect(existsSync(committedRoot)).toBe(false);

    const { session: gone } = await create();
    const goneRoot = gone.worktrees?.[0]?.path as string;
    git(dir, 'worktree', 'remove', '--force', goneRoot);
    await h.archive(gone.id as SessionId);
    const [usage] = (await h.methods['session.usage']({ archived: true }, context)).sessions;
    expect(usage?.worktrees[0]).toMatchObject({
      path: goneRoot,
      bytes: 0,
      dirty: false,
      missing: true,
    });
    await h.methods['session.delete']({ sessionId: gone.id as SessionId }, context);
    expect(h.storage.sessions.get(gone.id)).toBeUndefined();
  });

  it('引擎没有 deleteSession 时库与文件照删，结果带 engineDataKept', async () => {
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    Object.defineProperty(adapter, 'deleteSession', { value: undefined });
    const h = await setup(adapter);
    const { session } = await h.methods['session.create']({ providerId: 'mock' }, context);
    await h.send(session.id as SessionId, 'hello');
    await h.archive(session.id as SessionId);
    const result = await h.methods['session.delete'](
      { sessionId: session.id as SessionId },
      context,
    );
    expect(result).toEqual({ sessionIds: [session.id], engineDataKept: true });
    expect(h.storage.sessions.get(session.id)).toBeUndefined();
  });

  it('删掉大量事件之后库文件变小（VACUUM）', async () => {
    const h = await setup();
    const { session } = await h.methods['session.create']({ providerId: 'mock' }, context);
    const sessionId = session.id as SessionId;
    await h.send(sessionId, 'hello');
    const last = h.storage.events.lastSeq(sessionId);
    h.storage.transaction(() => {
      for (let index = 1; index <= 40; index += 1) {
        h.storage.events.insert({
          sessionId,
          seq: last + index,
          ts: '2026-10-17T00:00:00.000Z',
          type: 'test.filler',
          source: 'host',
          payload: { text: 'z'.repeat(60_000) },
        });
      }
    });
    await h.archive(sessionId);
    h.storage.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = statSync(h.storage.path).size;
    expect(before).toBeGreaterThan(2 * 1024 * 1024);
    await h.methods['session.delete']({ sessionId }, context);
    expect(statSync(h.storage.path).size).toBeLessThan(before / 2);
    expect(h.storage.freeBytes()).toBeLessThan(1024 * 1024);
  });
});

describe('session.archive 的 worktree 快照', () => {
  async function worktreeSession(h: Awaited<ReturnType<typeof setup>>) {
    const { dir, workspace } = await h.project('app');
    const { session } = await h.methods['session.create'](
      { workspaceId: workspace.id, providerId: 'mock', worktree: 'new' },
      context,
    );
    const worktree = session.worktrees?.[0];
    if (worktree === undefined) throw new Error('no worktree');
    return { dir, workspace, session, sessionId: session.id as SessionId, worktree };
  }

  it('归档时打快照、删目录、留分支；取消归档时在原路径重开，改动与未跟踪文件放回，被忽略的不在', async () => {
    const h = await setup();
    const { dir, workspace, sessionId, worktree } = await worktreeSession(h);
    const root = worktree.path;
    await h.send(sessionId, 'hello');
    writeFileSync(join(root, 'a.txt'), 'changed\n');
    writeFileSync(join(root, 'new.txt'), 'new\n');
    writeFileSync(join(root, 'staged.txt'), 'staged\n');
    git(root, 'add', 'staged.txt');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'x.js'), 'x');

    const archived = await h.archive(sessionId);
    expect(archived.worktrees).toEqual([
      {
        workspaceId: workspace.id,
        branch: worktree.branch,
        path: root,
        status: 'archived',
        ref: `refs/wevir/worktree-archive/${sessionId}/1`,
      },
    ]);
    expect(MethodSchemas['session.archive'].result.safeParse(archived).success).toBe(true);
    expect(existsSync(root)).toBe(false);
    expect(git(dir, 'worktree', 'list', '--porcelain')).not.toContain(root);
    expect(git(dir, 'branch', '--list', worktree.branch)).toContain(worktree.branch);
    expect(git(dir, 'show', `refs/wevir/worktree-archive/${sessionId}/1:new.txt`)).toBe('new\n');

    const restored = await h.methods['session.archive']({ sessionId, archived: false }, context);
    expect(restored.session.archivedAt).toBeUndefined();
    expect(restored.worktrees).toEqual([
      { workspaceId: workspace.id, branch: worktree.branch, path: root, status: 'restored' },
    ]);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('changed\n');
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('new\n');
    expect(readFileSync(join(root, 'staged.txt'), 'utf8')).toBe('staged\n');
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(worktree.branch);
    // 暂存区不恢复：都是没暂存的改动与未跟踪文件。
    expect(git(root, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([
      ' M a.txt',
      '?? new.txt',
      '?? staged.txt',
    ]);
    expect(git(dir, 'for-each-ref', 'refs/wevir/worktree-archive/')).toBe('');
    expect(existsSync(join(h.worktreesDir, sessionId, 'archive.json'))).toBe(false);
    // 会话照常能接着用。
    await h.methods['session.resume']({ sessionId }, context);
    await h.send(sessionId, 'again');
  });

  it('恢复归档的会话（session.resume）也会重开 worktree', async () => {
    const h = await setup();
    const { sessionId, worktree } = await worktreeSession(h);
    writeFileSync(join(worktree.path, 'new.txt'), 'new\n');
    await h.archive(sessionId);
    expect(existsSync(worktree.path)).toBe(false);
    await h.methods['session.resume']({ sessionId }, context);
    await h.send(sessionId, 'hello');
    expect(readFileSync(join(worktree.path, 'new.txt'), 'utf8')).toBe('new\n');
  });

  it('分支之后有了新提交：只检出分支，快照留在 ref 上，删会话时删掉', async () => {
    const h = await setup();
    const { dir, sessionId, worktree } = await worktreeSession(h);
    writeFileSync(join(worktree.path, 'a.txt'), 'changed\n');
    await h.archive(sessionId);
    // 在别处给分支加一个提交。
    const other = join(h.root, 'other');
    git(dir, 'worktree', 'add', '-q', other, worktree.branch);
    writeFileSync(join(other, 'b.txt'), 'b\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'more');

    const blocked = await h.methods['session.archive']({ sessionId, archived: false }, context);
    expect(blocked.worktrees?.[0]).toMatchObject({
      status: 'failed',
      reason: 'branch_checked_out',
    });
    expect(existsSync(worktree.path)).toBe(false);
    expect(existsSync(join(h.worktreesDir, sessionId, 'archive.json'))).toBe(true);

    git(dir, 'worktree', 'remove', '--force', other);
    const resumed = await h.methods['session.archive']({ sessionId, archived: false }, context);
    const ref = `refs/wevir/worktree-archive/${sessionId}/1`;
    expect(resumed.worktrees?.[0]).toMatchObject({
      status: 'restored',
      reason: 'branch_moved',
      ref,
    });
    expect(readFileSync(join(worktree.path, 'b.txt'), 'utf8')).toBe('b\n');
    expect(readFileSync(join(worktree.path, 'a.txt'), 'utf8')).toBe('a\n');
    expect(git(dir, 'show', `${ref}:a.txt`)).toBe('changed\n');

    await h.archive(sessionId);
    await h.methods['session.delete']({ sessionId, force: true }, context);
    expect(git(dir, 'for-each-ref', 'refs/wevir/worktree-archive/')).toBe('');
  });

  it('没有 worktree 的会话：结果不带 worktrees', async () => {
    const h = await setup();
    const { workspace } = await h.project('plain');
    const { session } = await h.methods['session.create'](
      { workspaceId: workspace.id, providerId: 'mock' },
      context,
    );
    const archived = await h.archive(session.id as SessionId);
    expect(archived.worktrees).toBeUndefined();
  });
});

describe('session.usage', () => {
  it('范围同 session.list：默认不含已归档的，archived 只列它们；按会话的事件字节数', async () => {
    const h = await setup();
    const { session: a } = await h.methods['session.create']({ providerId: 'mock' }, context);
    const { session: b } = await h.methods['session.create']({ providerId: 'mock' }, context);
    await h.send(a.id as SessionId, 'hello');
    await h.archive(b.id as SessionId);
    const open = (await h.methods['session.usage']({}, context)).sessions;
    expect(open.map((usage) => usage.sessionId)).toEqual([a.id]);
    const archived = (await h.methods['session.usage']({ archived: true }, context)).sessions;
    expect(archived.map((usage) => usage.sessionId)).toEqual([b.id]);
    expect(open[0]?.eventBytes).toBeGreaterThan(archived[0]?.eventBytes ?? 0);
  });
});

function readdirImages(dataDir: string): string[] {
  const dir = join(dataDir, 'images');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name !== 'staged');
}
