// workspace.git（0.13.0，U18）：对着真实的 git 在临时目录里建仓库。

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MethodSchemas } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import { EventStore } from './event-store.js';
import { parseNameStatus, parseNumstat, readGitStatus } from './git-status.js';
import { createHostMethods } from './host-methods.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();

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

/** 一个有一次提交的仓库：a.txt 三行、bin.dat 二进制、sub/b.txt。 */
function repo(): string {
  const dir = realpathSync(tempDir());
  sh(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'b.txt'), 'b\n');
  writeFileSync(join(dir, '.gitignore'), 'ignored.log\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('readGitStatus', () => {
  it('不是仓库时是 repo: false', async () => {
    expect(await readGitStatus(realpathSync(tempDir()))).toEqual({ repo: false });
  });

  it('干净的仓库：分支、没有改动', async () => {
    expect(await readGitStatus(repo())).toEqual({
      repo: true,
      branch: 'main',
      added: 0,
      removed: 0,
      fileCount: 0,
      files: [],
    });
  });

  it('改动、删除、暂存、二进制与未跟踪文件；忽略的文件不算', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 9, 9]));
    sh(dir, 'rm', '-q', 'sub/b.txt');
    writeFileSync(join(dir, 'staged.txt'), 'x\ny\n');
    sh(dir, 'add', 'staged.txt');
    writeFileSync(join(dir, 'new.md'), 'hello\n');
    writeFileSync(join(dir, 'ignored.log'), 'noise\n');
    const result = await readGitStatus(dir);
    expect(result).toMatchObject({
      repo: true,
      branch: 'main',
      added: 4,
      removed: 2,
      fileCount: 5,
    });
    expect(result.files).toEqual([
      { path: 'a.txt', status: 'modified', added: 2, removed: 1 },
      { path: 'bin.dat', status: 'modified' },
      { path: 'staged.txt', status: 'added', added: 2, removed: 0 },
      { path: 'sub/b.txt', status: 'deleted', added: 0, removed: 1 },
      { path: 'new.md', status: 'untracked' },
    ]);
  });

  it('工作区是仓库的子目录时只算这个目录里的，路径相对它', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    writeFileSync(join(dir, 'sub', 'b.txt'), 'b\nc\n');
    writeFileSync(join(dir, 'sub', 'c.txt'), 'new\n');
    expect(await readGitStatus(join(dir, 'sub'))).toEqual({
      repo: true,
      branch: 'main',
      added: 1,
      removed: 0,
      fileCount: 2,
      files: [
        { path: 'b.txt', status: 'modified', added: 1, removed: 0 },
        { path: 'c.txt', status: 'untracked' },
      ],
    });
  });

  it('分离头指针时是 detachedAt；还没有提交的新仓库比较暂存区', async () => {
    const dir = repo();
    const sha = sh(dir, 'rev-parse', '--short', 'HEAD').trim();
    sh(dir, 'checkout', '-q', '--detach');
    expect(await readGitStatus(dir)).toMatchObject({ repo: true, detachedAt: sha, fileCount: 0 });
    expect(await readGitStatus(dir)).not.toHaveProperty('branch');

    const fresh = realpathSync(join(dir, 'sub'));
    sh(fresh, 'init', '-q', '-b', 'start');
    writeFileSync(join(fresh, 'x.txt'), '1\n2\n');
    sh(fresh, 'add', 'x.txt');
    expect(await readGitStatus(fresh)).toMatchObject({
      repo: true,
      branch: 'start',
      added: 2,
      fileCount: 2,
      files: [
        { path: 'x.txt', status: 'added', added: 2, removed: 0 },
        { path: 'b.txt', status: 'untracked' },
      ],
    });
  });

  it('文件多于上限时截断并标出，fileCount 仍是总数', async () => {
    const dir = repo();
    for (let index = 0; index < 205; index++) writeFileSync(join(dir, `n${index}.txt`), 'x\n');
    const result = await readGitStatus(dir);
    expect(result.fileCount).toBe(205);
    expect(result.files).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(MethodSchemas['workspace.git'].result.safeParse(result).success).toBe(true);
  });

  it('不执行仓库配置里的 fsmonitor 钩子与外部 diff', async () => {
    const dir = repo();
    const marker = join(dir, '.git', 'hook-ran');
    const script = join(dir, '.git', 'evil.sh');
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(script, 0o755);
    sh(dir, 'config', 'core.fsmonitor', script);
    sh(dir, 'config', 'diff.external', script);
    sh(dir, 'config', 'diff.evil.textconv', script);
    writeFileSync(join(dir, '.gitattributes'), 'a.txt diff=evil\n');
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    const result = await readGitStatus(dir);
    expect(result).toMatchObject({ repo: true, branch: 'main' });
    expect(existsSync(marker)).toBe(false);
  });

  it('不执行仓库定义的过滤器，结果照常', async () => {
    const dir = repo();
    const marker = join(dir, '.git', 'filter-ran');
    const script = join(dir, '.git', 'evil.sh');
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(script, 0o755);
    sh(dir, 'config', 'filter.evil.clean', script);
    sh(dir, 'config', 'filter.evil.process', script);
    sh(dir, 'config', 'filter.evil.required', 'true');
    writeFileSync(join(dir, '.gitattributes'), '* filter=evil\n');
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    expect(await readGitStatus(dir)).toEqual({
      repo: true,
      branch: 'main',
      added: 1,
      removed: 3,
      fileCount: 2,
      files: [
        { path: 'a.txt', status: 'modified', added: 1, removed: 3 },
        { path: '.gitattributes', status: 'untracked' },
      ],
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('并发的调用共用一次读取', async () => {
    const dir = repo();
    const [first, second] = [readGitStatus(dir), readGitStatus(dir)];
    expect(first).toBe(second);
    await first;
    expect(readGitStatus(dir)).not.toBe(first);
  });
});

describe('解析', () => {
  it('numstat：二进制文件没有行数，路径里可以有制表符以外的空白', () => {
    expect(parseNumstat('3\t1\ta b.txt\0-\t-\timg.png\0')).toEqual([
      { path: 'a b.txt', added: 3, removed: 1 },
      { path: 'img.png' },
    ]);
  });

  it('name-status：类型变化等按修改算', () => {
    expect([...parseNameStatus('M\0a\0A\0b\0D\0c\0T\0d\0')]).toEqual([
      ['a', 'modified'],
      ['b', 'added'],
      ['c', 'deleted'],
      ['d', 'modified'],
    ]);
  });
});

describe('workspace.git 方法', () => {
  function methods() {
    const dataDir = join(tempDir(), 'data');
    mkdirSync(dataDir);
    const storage = storages.open(dataDir);
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const sessions = new SessionManager({ storage, events, adapter: new EchoAdapter() });
    const secrets = new FileSecretStore(dataDir);
    return createHostMethods({ storage, events, sessions, secrets });
  }
  const context = { client: identity, capabilities: {} };

  it('工作区不存在、已移除、目录不在了时报错', async () => {
    const host = methods();
    const dir = join(tempDir(), 'proj');
    mkdirSync(dir);
    await expect(
      host['workspace.git']({ workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR' }, context),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    const { workspace } = await host['workspace.add']({ rootPath: dir }, context);
    expect(await host['workspace.git']({ workspaceId: workspace.id }, context)).toEqual({
      repo: false,
    });
    rmSync(dir, { recursive: true });
    await expect(
      host['workspace.git']({ workspaceId: workspace.id }, context),
    ).rejects.toMatchObject({ code: 'WORKSPACE_PATH_INVALID' });
    host['workspace.remove']({ workspaceId: workspace.id }, context);
    await expect(
      host['workspace.git']({ workspaceId: workspace.id }, context),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
  });
});
