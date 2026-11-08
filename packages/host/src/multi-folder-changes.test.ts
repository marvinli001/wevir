import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { GitExpectedState, GitStatusResult, SessionId, WorkspaceId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore, type SessionRecord } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { GitService } from './git/service.js';
import { createHostMethods, type HostMethods } from './host-methods.js';
import { SessionManager } from './session-manager.js';
import { identity, T0, TURN, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const context = { client: identity, capabilities: {} };
const managers: SessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
  }).trim();
}

function repo(name: string): string {
  const dir = join(tempDir(), name);
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'a.txt'), `${name} original\n`);
  writeFileSync(join(dir, 'sub', 'b.txt'), 'nested\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Tester');
  git(dir, 'config', 'user.email', 'tester@example.com');
  git(dir, 'config', 'commit.gpgSign', 'false');
  git(dir, 'config', 'core.hooksPath', join(dir, '.git', 'hooks'));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  return realpathSync.native(dir);
}

function alias(target: string, path: string): string {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
  return path;
}

function setup() {
  const primary = repo('primary');
  const extra = repo('extra');
  const workspaceId = 'ws_primary' as WorkspaceId;
  const data = join(tempDir(), 'data');
  const storage = storages.open(data);
  storage.workspaces.insert({
    id: workspaceId,
    rootPath: primary,
    extraFolders: [extra],
    displayName: 'primary',
    createdAt: T0,
    updatedAt: T0,
  });
  const events = new EventStore({ storage, deltaWindowMs: 5 });
  const sessions = new SessionManager({ storage, events, adapter: new EchoAdapter() });
  managers.push(sessions);
  const verification = vi.fn(async () => ({ checks: [], runs: [] }));
  const methods = createHostMethods({
    storage,
    events,
    sessions,
    secrets: new FileSecretStore(data),
    git: new GitService({ verification }),
  });
  const session = (fields: Partial<SessionRecord> = {}): SessionId => {
    const id = fields.id ?? 'ses_primary';
    storage.sessions.insert({
      id,
      workspaceId,
      cwd: primary,
      engine: 'echo',
      engineSessionId: `engine-${id}`,
      providerId: 'mock',
      modelId: 'mock',
      title: '',
      titleSource: 'first_prompt',
      state: 'idle',
      lastSeq: 0,
      createdAt: T0,
      updatedAt: T0,
      ...fields,
    });
    return id as SessionId;
  };
  return { methods, storage, primary, extra, workspaceId, session, verification };
}

function expectedOf(status: GitStatusResult): GitExpectedState {
  expect(status.repo).toBe(true);
  expect(status.index).toBeDefined();
  return { head: status.head ?? null, index: status.index ?? '' };
}

type Scope = { workspaceId: WorkspaceId; sessionId?: SessionId; folder?: string };
function calls(methods: HostMethods, expected: GitExpectedState) {
  return [
    (params: Scope) => methods['workspace.git'](params, context),
    (params: Scope) =>
      methods['workspace.diff']({ ...params, source: { kind: 'uncommitted' } }, context),
    (params: Scope) => methods['workspace.diffFile']({ ...params, newPath: 'a.txt' }, context),
    (params: Scope) => methods['git.status'](params, context),
    (params: Scope) => methods['git.stage']({ ...params, paths: ['a.txt'], expected }, context),
    (params: Scope) => methods['git.unstage']({ ...params, paths: ['a.txt'], expected }, context),
    (params: Scope) => methods['git.commit']({ ...params, message: 'change', expected }, context),
  ];
}

const folderError = { code: 'INVALID_PARAMS', data: { issues: [{ path: ['folder'] }] } };

describe('multi-folder changes', () => {
  it.each([
    { withSession: false, selectExtra: false },
    { withSession: true, selectExtra: false },
    { withSession: false, selectExtra: true },
    { withSession: true, selectExtra: true },
  ])('读写选定的仓库：%j', async ({ withSession, selectExtra }) => {
    const { methods, primary, extra, workspaceId, session, verification } = setup();
    const sessionId = session({ extraRoots: [extra] });
    const target = selectExtra ? extra : primary;
    const other = selectExtra ? primary : extra;
    const name = selectExtra ? 'extra' : 'primary';
    const params: Scope = {
      workspaceId,
      ...(withSession && { sessionId }),
      ...(selectExtra && {
        folder: withSession ? alias(extra, join(tempDir(), 'extra-alias')) : extra,
      }),
    };
    git(target, 'checkout', '-q', '-b', 'change');
    const otherHead = git(other, 'rev-parse', 'HEAD');
    writeFileSync(join(target, 'a.txt'), `${name} changed\n`);
    writeFileSync(join(other, 'a.txt'), 'other changed\n');
    expect(await methods['workspace.git'](params, context)).toMatchObject({
      repo: true,
      branch: 'change',
      files: [{ path: 'a.txt' }],
    });
    const diff = await methods['workspace.diff'](
      { ...params, source: { kind: 'uncommitted' } },
      context,
    );
    expect(diff.patch).toContain(`+${name} changed`);
    expect(
      await methods['workspace.diffFile'](
        { ...params, oldRev: diff.base, oldPath: 'a.txt', newPath: 'a.txt' },
        context,
      ),
    ).toEqual({ oldContents: `${name} original\n`, newContents: `${name} changed\n` });

    let status = await methods['git.status'](params, context);
    const expectVerification = (value: GitStatusResult) => {
      if (withSession && !selectExtra) expect(value.verification).toBeDefined();
      else expect(value.verification).toBeUndefined();
    };
    expectVerification(status);
    ({ status } = await methods['git.stage'](
      { ...params, paths: ['a.txt'], expected: expectedOf(status) },
      context,
    ));
    expectVerification(status);
    expect(git(target, 'diff', '--cached', '--name-only')).toBe('a.txt');
    expect(
      (await methods['workspace.diff']({ ...params, source: { kind: 'staged' } }, context)).patch,
    ).toContain(`+${name} changed`);
    ({ status } = await methods['git.unstage'](
      { ...params, paths: ['a.txt'], expected: expectedOf(status) },
      context,
    ));
    expectVerification(status);
    expect(git(target, 'diff', '--cached', '--name-only')).toBe('');
    ({ status } = await methods['git.stage'](
      { ...params, paths: ['a.txt'], expected: expectedOf(status) },
      context,
    ));
    const result = await methods['git.commit'](
      { ...params, message: 'change', expected: expectedOf(status) },
      context,
    );
    expect(result.outcome.kind).toBe('committed');
    expectVerification(result.status);
    expect(result.status.fileCount).toBe(0);
    expect(git(target, 'log', '-1', '--format=%s')).toBe('change');
    expect(git(other, 'rev-parse', 'HEAD')).toBe(otherHead);
    expect(git(other, 'diff', '--cached', '--name-only')).toBe('');
    expect(
      (await methods['workspace.diff']({ ...params, source: { kind: 'branch' } }, context)).patch,
    ).toContain(`+${name} changed`);
    if (withSession && !selectExtra) expect(verification).toHaveBeenCalledWith(sessionId);
    else expect(verification).not.toHaveBeenCalled();
  });

  it('所有入口拒绝相对、非法、不存在、非目录、列表外与后代路径', async () => {
    const { methods, primary, extra, workspaceId, session } = setup();
    const sessionId = session({ extraRoots: [extra] });
    const outside = join(tempDir(), 'outside');
    mkdirSync(outside);
    const expected = expectedOf(await methods['git.status']({ workspaceId }, context));
    const folders = [
      '',
      '.',
      'extra',
      join(tempDir(), 'missing'),
      join(extra, 'a.txt'),
      `${extra}\0`,
      outside,
      join(primary, 'sub'),
      join(extra, 'sub'),
      `${primary}${sep}..`,
      alias(outside, join(primary, 'escape')),
      `${extra}${sep}..${sep}outside`,
      ...(process.platform === 'win32' ? ['C:relative', '\\\\?invalid'] : ['C:\\outside']),
    ];
    for (const call of calls(methods, expected)) {
      for (const folder of folders) {
        await expect(call({ workspaceId, sessionId, folder })).rejects.toMatchObject(folderError);
      }
    }
    expect(git(extra, 'status', '--porcelain')).toBe('');
  });

  it('允许列表和请求都取 realpath，归一化后必须精确相等；主目录别名保留验证记录', async () => {
    const { methods, storage, primary, extra, workspaceId, session, verification } = setup();
    const primaryAlias = alias(primary, join(tempDir(), 'primary-alias'));
    const extraAlias = alias(extra, join(tempDir(), 'extra-alias'));
    storage.workspaces.setExtraFolders(workspaceId, [extraAlias], T0);
    const sessionId = session({ cwd: primaryAlias, extraRoots: [extraAlias] });
    for (const scope of [{ workspaceId }, { workspaceId, sessionId }]) {
      expect(await methods['workspace.git']({ ...scope, folder: extra }, context)).toMatchObject({
        repo: true,
        branch: 'main',
      });
      expect(
        await methods['git.status']({ ...scope, folder: `${extra}${sep}sub${sep}..` }, context),
      ).not.toHaveProperty('verification');
    }
    expect(verification).not.toHaveBeenCalled();
    expect(
      await methods['git.status']({ workspaceId, sessionId, folder: primary }, context),
    ).toHaveProperty('verification');
    expect(verification).toHaveBeenCalledWith(sessionId);
  });

  it('旧会话没有 extraRoots 或 worktrees，空数组也回退项目附加目录', async () => {
    const { methods, extra, workspaceId, session } = setup();
    let index = 0;
    for (const extraRoots of [undefined, []]) {
      for (const worktrees of [undefined, []]) {
        const sessionId = session({
          id: `ses_legacy_${index++}`,
          ...(extraRoots !== undefined && { extraRoots }),
          ...(worktrees !== undefined && { worktrees }),
        });
        expect(
          await methods['git.status']({ workspaceId, sessionId, folder: extra }, context),
        ).toMatchObject({ repo: true, branch: 'main' });
      }
    }
  });

  it('会话自己的 extraRoots 不混入工作区附加目录，worktree 不退回原仓库', async () => {
    const { methods, primary, extra, workspaceId, session } = setup();
    const worktree = join(tempDir(), 'worktree');
    const extraWorktree = join(tempDir(), 'extra-worktree');
    git(primary, 'worktree', 'add', '-q', '-b', 'isolated', worktree);
    git(extra, 'worktree', 'add', '-q', '-b', 'extra-isolated', extraWorktree);
    const worktrees = [{ workspaceId, path: worktree, branch: 'isolated' }];
    const sessionId = session({ cwd: worktree, extraRoots: [extraWorktree], worktrees });
    const params = { workspaceId, sessionId };
    expect(await methods['workspace.git'](params, context)).toMatchObject({
      repo: true,
      branch: 'isolated',
    });
    expect(await methods['git.status'](params, context)).toMatchObject({
      repo: true,
      branch: 'isolated',
    });
    const expected = expectedOf(await methods['git.status'](params, context));
    for (const call of calls(methods, expected)) {
      for (const folder of [primary, extra]) {
        await expect(call({ ...params, folder })).rejects.toMatchObject(folderError);
      }
    }
    writeFileSync(join(extraWorktree, 'a.txt'), 'isolated change\n');
    const target = { ...params, folder: extraWorktree };
    const status = await methods['git.status'](target, context);
    expect(status).toMatchObject({ branch: 'extra-isolated' });
    const staged = await methods['git.stage'](
      { ...target, paths: ['a.txt'], expected: expectedOf(status) },
      context,
    );
    expect(staged.status).not.toHaveProperty('verification');
    expect(git(extra, 'status', '--porcelain')).toBe('');

    const emptyId = session({ id: 'ses_empty', cwd: worktree, extraRoots: [], worktrees });
    await expect(
      methods['workspace.git']({ workspaceId, sessionId: emptyId, folder: extra }, context),
    ).rejects.toMatchObject(folderError);
    const explicitId = session({ id: 'ses_explicit', extraRoots: [extraWorktree] });
    await expect(
      methods['workspace.git']({ workspaceId, sessionId: explicitId, folder: extra }, context),
    ).rejects.toMatchObject(folderError);
    expect(await methods['git.status']({ workspaceId, folder: extra }, context)).toMatchObject({
      repo: true,
      branch: 'main',
    });
  });

  it('turn diff 携带任何 folder 都拒绝，省略时仍只读主目录快照', async () => {
    const { methods, primary, extra, workspaceId, session } = setup();
    const sessionId = session({ extraRoots: [extra] });
    const source = { kind: 'turn', turnId: TURN } as const;
    for (const scope of [{ workspaceId }, { workspaceId, sessionId }]) {
      for (const folder of [primary, extra, '', '.', join(tempDir(), 'missing')]) {
        await expect(
          methods['workspace.diff']({ ...scope, folder, source }, context),
        ).rejects.toMatchObject(folderError);
      }
    }
    expect(await methods['workspace.diff']({ workspaceId, sessionId, source }, context)).toEqual({
      repo: true,
      unavailable: 'no_checkpoint',
    });
  });

  it('folder 不绕过工作区状态和会话归属检查', async () => {
    const { methods, storage, primary, extra, workspaceId, session } = setup();
    const sessionId = session({ extraRoots: [extra] });
    const otherId = 'ws_other' as WorkspaceId;
    storage.workspaces.insert({
      id: otherId,
      rootPath: extra,
      extraFolders: [primary],
      displayName: 'other',
      createdAt: T0,
      updatedAt: T0,
    });
    const expected = expectedOf(await methods['git.status']({ workspaceId }, context));
    for (const call of calls(methods, expected)) {
      await expect(call({ workspaceId: otherId, sessionId, folder: extra })).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      });
      await expect(
        call({ workspaceId, sessionId: 'ses_missing' as SessionId, folder: extra }),
      ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
      await expect(
        call({ workspaceId: 'ws_missing' as WorkspaceId, folder: extra }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    }
    storage.workspaces.markRemoved(workspaceId, T0);
    for (const call of calls(methods, expected)) {
      await expect(call({ workspaceId, sessionId, folder: extra })).rejects.toMatchObject({
        code: 'WORKSPACE_NOT_FOUND',
      });
    }
  });
});

describe('multi-folder files', () => {
  it('readFile 与 writeFile 按 folder 读写附加文件夹，省略时仍是会话目录', async () => {
    const { methods, extra, workspaceId, session } = setup();
    const sessionId = session({ extraRoots: [extra] });
    const scope = { workspaceId, sessionId };
    await expect(
      methods['workspace.readFile']({ ...scope, path: 'a.txt' }, context),
    ).resolves.toMatchObject({ text: 'primary original\n' });
    const read = await methods['workspace.readFile'](
      { ...scope, folder: alias(extra, join(tempDir(), 'extra-alias')), path: 'sub/b.txt' },
      context,
    );
    expect(read).toMatchObject({ path: 'sub/b.txt', text: 'nested\n' });
    const base = await methods['workspace.readFile'](
      { ...scope, folder: extra, path: 'a.txt' },
      context,
    );
    expect(base.text).toBe('extra original\n');
    const written = await methods['workspace.writeFile'](
      { ...scope, folder: extra, path: 'a.txt', text: 'edited\n', expectedMtimeMs: base.mtimeMs },
      context,
    );
    expect(written.conflict).toBeUndefined();
    await expect(
      methods['workspace.readFile']({ ...scope, folder: extra, path: 'a.txt' }, context),
    ).resolves.toMatchObject({ text: 'edited\n' });
    await expect(
      methods['workspace.readFile']({ ...scope, path: 'a.txt' }, context),
    ).resolves.toMatchObject({ text: 'primary original\n' });
  });

  it('文件方法拒绝列表外的 folder 与往上走的路径', async () => {
    const { methods, extra, workspaceId, session } = setup();
    const sessionId = session({ extraRoots: [extra] });
    const outside = repo('outside');
    const scope = { workspaceId, sessionId };
    for (const call of [
      () => methods['workspace.readFile']({ ...scope, folder: outside, path: 'a.txt' }, context),
      () => methods['workspace.fileUrl']({ ...scope, folder: outside, path: 'a.txt' }, context),
      () => methods['workspace.officePdf']({ ...scope, folder: outside, path: 'a.docx' }, context),
      () =>
        methods['workspace.writeFile'](
          { ...scope, folder: outside, path: 'a.txt', text: 'x' },
          context,
        ),
      () =>
        methods['workspace.readFile'](
          { ...scope, folder: join(extra, 'sub'), path: 'b.txt' },
          context,
        ),
    ]) {
      await expect(call()).rejects.toMatchObject(folderError);
    }
    await expect(
      methods['workspace.readFile']({ ...scope, folder: extra, path: '../outside/a.txt' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
});
