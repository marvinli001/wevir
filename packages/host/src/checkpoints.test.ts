// 回合快照（0.20.0，domain-model §3.13）：对着真实的 git 打快照、读回合 diff、清理 ref，以及 SessionManager 在回合前后的调用。

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { MethodSchemas, type SessionId, type TurnId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECKPOINT_REF_PREFIX, checkpointRef, TurnCheckpoints } from './checkpoints.js';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();

const SID = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';
const T1 = 'trn_01JA2B3C4D5E6F7G8H9JKMNP01' as TurnId;
const T2 = 'trn_01JA2B3C4D5E6F7G8H9JKMNP02' as TurnId;
const T3 = 'trn_01JA2B3C4D5E6F7G8H9JKMNP03' as TurnId;

function sh(cwd: string, ...args: string[]): string {
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

function repo(root = realpathSync(tempDir())): string {
  sh(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(root, '.gitignore'), 'ignored.log\n');
  sh(root, 'add', '.');
  sh(root, 'commit', '-q', '-m', 'init');
  return root;
}

function refs(dir: string): string[] {
  return sh(dir, 'for-each-ref', '--format=%(refname)', `${CHECKPOINT_REF_PREFIX}/`)
    .split('\n')
    .filter(Boolean);
}

const open = new Set<string>([SID]);
/** 用例结束时 dispose：等没打完的快照里的 git 退出，Windows 上才删得掉临时目录。 */
const services: TurnCheckpoints[] = [];
function checkpoints(options: Partial<ConstructorParameters<typeof TurnCheckpoints>[0]> = {}) {
  const warnings: unknown[] = [];
  const service = new TurnCheckpoints({
    isOpen: (id) => open.has(id),
    onWarning: (message, fields) => warnings.push({ message, ...fields }),
    ...options,
  });
  services.push(service);
  return { service, warnings };
}

afterEach(async () => {
  open.clear();
  open.add(SID);
  await Promise.all(services.splice(0).map((service) => service.dispose()));
});

describe('TurnCheckpoints', () => {
  it('回合的 diff 只含回合里的改动，不碰索引、HEAD 与分支', async () => {
    const dir = repo();
    const { service } = checkpoints();
    // 回合开始前用户已经改了 a.txt。
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nuser\n');
    const head = sh(dir, 'rev-parse', 'HEAD');
    const index = readFileSync(join(dir, '.git', 'index'));
    await service.beforeTurn(SID, dir, T1);
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nuser\n');
    writeFileSync(join(dir, 'new.md'), 'hello\n');
    writeFileSync(join(dir, 'ignored.log'), 'noise\n');
    service.afterTurn(SID, dir, T1);
    await service.settled(SID);

    expect(refs(dir)).toEqual([checkpointRef(SID, T1, 'after'), checkpointRef(SID, T1, 'before')]);
    const result = await service.diff(SID, dir, T1);
    expect(MethodSchemas['workspace.diff'].result.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      repo: true,
      branch: 'main',
      base: sh(dir, 'rev-parse', checkpointRef(SID, T1, 'before')).trim(),
      head: sh(dir, 'rev-parse', checkpointRef(SID, T1, 'after')).trim(),
      fileCount: 2,
      added: 2,
      removed: 1,
    });
    expect(result.files).toEqual([
      { path: 'a.txt', status: 'modified', added: 1, removed: 1 },
      { path: 'new.md', status: 'added', added: 1, removed: 0 },
    ]);
    expect(result.patch).toContain('-two\n+TWO\n');
    expect(result.patch).not.toContain('ignored.log');
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(dir, '.git', 'index')).equals(index)).toBe(true);
    expect(sh(dir, 'branch', '--format=%(refname)')).toBe('refs/heads/main\n');
    expect(sh(dir, 'status', '--porcelain')).toBe(' M a.txt\n?? new.md\n');
    // 快照的父提交是 HEAD，提交说明记着统计。
    expect(sh(dir, 'log', '-1', '--format=%P%n%s', checkpointRef(SID, T1, 'after'))).toBe(
      `${head.trim()}\nwevir checkpoint after files=2 added=2 removed=1\n`,
    );

    expect(await service.list(SID, dir)).toEqual({
      repo: true,
      turns: [{ turnId: T1, fileCount: 2, added: 2, removed: 1 }],
    });
  });

  it('还没有回合后的快照时对现在的工作树；没有回合前的快照时 no_checkpoint', async () => {
    const dir = repo();
    const { service } = checkpoints();
    await service.beforeTurn(SID, dir, T1);
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    const live = await service.diff(SID, dir, T1);
    expect(live).toMatchObject({ repo: true, live: true });
    expect(live).not.toHaveProperty('head');
    expect(live.files).toEqual([{ path: 'b.txt', status: 'untracked', added: 1, removed: 0 }]);
    expect(await service.list(SID, dir)).toEqual({ repo: true, turns: [{ turnId: T1 }] });
    expect(await service.diff(SID, dir, T2)).toEqual({ repo: true, unavailable: 'no_checkpoint' });
    expect(await service.diff(SID, join(realpathSync(tempDir()), '..'), T1)).toMatchObject({
      repo: false,
    });
  });

  it('回合里 pull 带进来的文件不算，回合自己的提交算', async () => {
    const dir = repo();
    // 上游早就有的提交（提交时间在回合开始之前）。
    sh(dir, 'checkout', '-q', '-b', 'upstream');
    writeFileSync(join(dir, 'upstream.txt'), 'u\n');
    sh(dir, 'add', 'upstream.txt');
    execFileSync('git', ['commit', '-q', '-m', 'upstream'], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
        GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
        GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
      },
    });
    sh(dir, 'checkout', '-q', 'main');
    const { service } = checkpoints();
    await service.beforeTurn(SID, dir, T1);
    sh(dir, 'merge', '-q', '--ff-only', 'upstream');
    writeFileSync(join(dir, 'mine.txt'), 'm\n');
    sh(dir, 'add', 'mine.txt');
    sh(dir, 'commit', '-q', '-m', 'mine');
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    service.afterTurn(SID, dir, T1);
    const result = await service.diff(SID, dir, T1);
    expect(result.files?.map((file) => file.path)).toEqual(['a.txt', 'mine.txt']);
    expect(result.patch).not.toContain('upstream.txt');
    expect((await service.list(SID, dir)).turns[0]).toMatchObject({ fileCount: 2 });
  });

  it('关闭的会话删掉它的 ref；第一次在仓库里打快照时清掉已关闭的会话留下的；最多留 maxTurns 个回合', async () => {
    const dir = repo();
    const stale = 'ses_01JA2B3C4D5E6F7G8H9JKMNPZZ';
    sh(dir, 'update-ref', `${CHECKPOINT_REF_PREFIX}/${stale}/${T1}/before`, 'HEAD');
    const { service } = checkpoints({ maxTurns: 2 });
    for (const turn of [T1, T2, T3]) {
      await service.beforeTurn(SID, dir, turn);
      service.afterTurn(SID, dir, turn);
    }
    await service.settled(SID);
    expect(refs(dir).filter((ref) => ref.includes(stale))).toEqual([]);
    expect((await service.list(SID, dir)).turns.map((turn) => turn.turnId)).toEqual([T2, T3]);
    service.dropSession(SID, dir);
    await service.settled(SID);
    expect(refs(dir)).toEqual([]);
  });

  it('不跑仓库配置的钩子、过滤器与签名程序', async () => {
    const dir = repo();
    const marker = join(dir, '.git', 'ran');
    const script = join(dir, '.git', 'evil.sh');
    writeFileSync(script, `#!/bin/sh\necho "$0 $@" >> '${marker}'\ncat\n`);
    chmodSync(script, 0o755);
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    for (const hook of ['reference-transaction', 'post-commit', 'pre-commit']) {
      writeFileSync(join(dir, '.git', 'hooks', hook), `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(join(dir, '.git', 'hooks', hook), 0o755);
    }
    sh(dir, 'config', 'core.fsmonitor', script);
    sh(dir, 'config', 'filter.evil.clean', script);
    sh(dir, 'config', 'filter.evil.process', script);
    sh(dir, 'config', 'filter.evil.required', 'true');
    sh(dir, 'config', 'commit.gpgSign', 'true');
    sh(dir, 'config', 'gpg.program', script);
    writeFileSync(join(dir, '.gitattributes'), '* filter=evil\n');
    const { service, warnings } = checkpoints();
    await service.beforeTurn(SID, dir, T1);
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    service.afterTurn(SID, dir, T1);
    await service.settled(SID);
    expect(warnings).toEqual([]);
    expect(refs(dir)).toHaveLength(2);
    expect((await service.diff(SID, dir, T1)).files?.map((file) => file.path)).toEqual(['a.txt']);
    expect(existsSync(marker)).toBe(false);
  });

  it('不是仓库、sparse checkout 时不打；超时后这个目录不再打', async () => {
    const plain = realpathSync(tempDir());
    const { service, warnings } = checkpoints();
    await service.beforeTurn(SID, plain, T1);
    expect(warnings).toEqual([]);

    const dir = join(plain, 'r');
    mkdirSync(dir);
    repo(dir);
    sh(dir, 'config', 'core.sparseCheckout', 'true');
    await service.beforeTurn(SID, dir, T1);
    expect(refs(dir)).toEqual([]);
    expect(warnings).toMatchObject([{ message: 'checkpoint skipped', reason: 'sparse_checkout' }]);

    sh(dir, 'config', 'core.sparseCheckout', 'false');
    const slow = checkpoints({ timeoutMs: 1 });
    await slow.service.beforeTurn(SID, dir, T1);
    await slow.service.beforeTurn(SID, dir, T2);
    expect(refs(dir)).toEqual([]);
    expect(slow.warnings).toMatchObject([
      { message: 'checkpoint timed out; disabled for this directory' },
    ]);
  });
});

describe('SessionManager 与方法', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  function setup() {
    const root = realpathSync(tempDir());
    const storage = storages.open(join(root, 'data'));
    const workspaceDir = join(root, 'ws');
    mkdirSync(workspaceDir);
    repo(workspaceDir);
    const T0 = '2026-10-15T00:00:00.000Z';
    storage.workspaces.insert({
      id: 'ws_1',
      rootPath: workspaceDir,
      displayName: 'ws',
      createdAt: T0,
      updatedAt: T0,
    });
    storage.providers.insert({
      id: 'mock',
      kind: 'openai-compatible',
      displayName: 'Mock',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'm' }],
      defaultModelId: 'm',
      createdAt: T0,
      updatedAt: T0,
    });
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const turnCheckpoints = new TurnCheckpoints({
      isOpen: (id) => storage.sessions.get(id)?.state !== 'closed',
    });
    services.push(turnCheckpoints);
    const manager = new SessionManager({
      storage,
      events,
      adapter: new EchoAdapter({ stepDelayMs: 0 }),
      checkpoints: turnCheckpoints,
    });
    managers.push(manager);
    const methods = createHostMethods({
      storage,
      events,
      sessions: manager,
      secrets: new FileSecretStore(join(root, 'data')),
      checkpoints: turnCheckpoints,
    });
    return { storage, events, manager, methods, workspaceDir };
  }
  const context = { client: identity, capabilities: {} };

  it('每个回合前后打快照，关闭会话删掉；方法读得到回合 diff', async () => {
    const { events, manager, methods, workspaceDir } = setup();
    const session = await manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = session.id as SessionId;
    const { turnId } = await manager.send(
      { sessionId, content: [{ type: 'text', text: 'hi' }] },
      identity,
    );
    await vi.waitFor(() => expect(events.snapshot(sessionId)?.session.state).toBe('idle'));
    // echo 不改文件：回合 diff 是空的。
    expect(
      await methods['workspace.diff'](
        { workspaceId: 'ws_1', sessionId, source: { kind: 'turn', turnId: turnId as TurnId } },
        context,
      ),
    ).toMatchObject({ repo: true, fileCount: 0, patch: '' });
    expect(await methods['session.checkpoints']({ sessionId }, context)).toEqual({
      repo: true,
      turns: [{ turnId, fileCount: 0, added: 0, removed: 0 }],
    });
    expect(refs(workspaceDir)).toHaveLength(2);
    await expect(
      methods['workspace.diff'](
        { workspaceId: 'ws_1', source: { kind: 'turn', turnId: turnId as TurnId } },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

    await manager.close(sessionId);
    await vi.waitFor(() => expect(refs(workspaceDir)).toEqual([]));
  });

  it('uncommitted、branch 与 diffFile；路径不许往上走', async () => {
    const { methods, workspaceDir } = setup();
    writeFileSync(join(workspaceDir, 'a.txt'), 'changed\n');
    const diff = await methods['workspace.diff'](
      { workspaceId: 'ws_1', source: { kind: 'uncommitted' } },
      context,
    );
    expect(diff.files?.map((file) => file.path)).toEqual(['a.txt']);
    expect(
      await methods['workspace.diff']({ workspaceId: 'ws_1', source: { kind: 'branch' } }, context),
    ).toMatchObject({ repo: true, baseRef: 'main' });
    expect(
      await methods['workspace.diffFile'](
        { workspaceId: 'ws_1', oldRev: diff.base, oldPath: 'a.txt', newPath: 'a.txt' },
        context,
      ),
    ).toEqual({ oldContents: 'one\ntwo\n', newContents: 'changed\n' });
    await expect(
      methods['workspace.diffFile']({ workspaceId: 'ws_1', newPath: '../data/x' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      methods['workspace.diffFile']({ workspaceId: 'ws_1', oldPath: 'a.txt' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      methods['session.checkpoints']({ sessionId: SID as SessionId }, context),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  // 0.22.0 的文件方法与上面同一个目录规则（文件索引等的细节在 workspace-files.test.ts）。
  it('workspace.files、listDir、readFile；路径不许往上走', async () => {
    const { methods } = setup();
    expect(
      await methods['workspace.files']({ workspaceId: 'ws_1', query: 'a.t' }, context),
    ).toMatchObject({ entries: [{ path: 'a.txt', kind: 'file' }] });
    expect(
      (await methods['workspace.listDir']({ workspaceId: 'ws_1', path: '' }, context)).entries,
    ).toContainEqual({ path: 'a.txt', kind: 'file' });
    expect(
      await methods['workspace.readFile']({ workspaceId: 'ws_1', path: 'a.txt' }, context),
    ).toEqual({ path: 'a.txt', size: 8, text: 'one\ntwo\n' });
    await expect(
      methods['workspace.readFile']({ workspaceId: 'ws_1', path: '../data/x' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      methods['workspace.listDir']({ workspaceId: 'ws_1', path: '/etc' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      methods['workspace.files']({ workspaceId: 'ws_9', query: '' }, context),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
  });
});
