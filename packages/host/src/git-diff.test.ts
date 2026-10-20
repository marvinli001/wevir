// workspace.diff / workspace.diffFile（0.20.0）：对着真实的 git 在临时目录里建仓库。

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { MethodSchemas } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  chunkPath,
  DIFF_FILE_MAX_LENGTH,
  isSafeRelativePath,
  parseNameStatus,
  parseNumstat,
  readBranch,
  readDiffFile,
  readUncommitted,
  splitPatch,
  splitRawNumstat,
  UNTRACKED_MAX_FILES,
} from './git-diff.js';
import { useTempDir } from './test-utils.js';

const tempDir = useTempDir();

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

/** 一个有一次提交的仓库：a.txt 三行、bin.dat 二进制、sub/b.txt、.gitignore。 */
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

const valid = (result: unknown) =>
  expect(MethodSchemas['workspace.diff'].result.safeParse(result).success).toBe(true);

describe('workspace.diff：uncommitted', () => {
  it('不是仓库时是 repo: false', async () => {
    expect(await readUncommitted(realpathSync(tempDir()))).toEqual({ repo: false });
  });

  it('改动、删除、暂存、二进制与未跟踪文件，忽略的不算；不碰用户的索引', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 9, 9]));
    sh(dir, 'rm', '-q', 'sub/b.txt');
    writeFileSync(join(dir, 'staged.txt'), 'x\ny\n');
    sh(dir, 'add', 'staged.txt');
    writeFileSync(join(dir, 'new.md'), 'hello\n');
    writeFileSync(join(dir, 'ignored.log'), 'noise\n');
    const indexBefore = readFileSync(join(dir, '.git', 'index'));
    const statusBefore = sh(dir, 'status', '--porcelain');

    const result = await readUncommitted(dir);
    valid(result);
    expect(result).toMatchObject({
      repo: true,
      base: sh(dir, 'rev-parse', 'HEAD').trim(),
      branch: 'main',
      fileCount: 5,
      added: 5,
      removed: 2,
    });
    expect(result.files).toEqual([
      { path: 'a.txt', status: 'modified', added: 2, removed: 1 },
      { path: 'bin.dat', status: 'modified', binary: true },
      { path: 'new.md', status: 'untracked', added: 1, removed: 0 },
      { path: 'staged.txt', status: 'added', added: 2, removed: 0 },
      { path: 'sub/b.txt', status: 'deleted', added: 0, removed: 1 },
    ]);
    const chunks = splitPatch(result.patch ?? '');
    expect(chunks.map(chunkPath)).toEqual([
      'a.txt',
      'bin.dat',
      'new.md',
      'staged.txt',
      'sub/b.txt',
    ]);
    expect(result.patch).toContain('+++ b/new.md\n@@ -0,0 +1 @@\n+hello\n');
    expect(result.patch).not.toContain('ignored.log');
    expect(readFileSync(join(dir, '.git', 'index')).equals(indexBefore)).toBe(true);
    expect(sh(dir, 'status', '--porcelain')).toBe(statusBefore);
  });

  it('跟踪重命名；工作区是子目录时只算它里面的，路径相对它', async () => {
    const dir = repo();
    sh(dir, 'mv', 'sub/b.txt', 'sub/c.txt');
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    const result = await readUncommitted(join(dir, 'sub'));
    expect(result.files).toEqual([
      { path: 'c.txt', previousPath: 'b.txt', status: 'renamed', added: 0, removed: 0 },
    ]);
    expect(result.patch).toContain('rename from b.txt\nrename to c.txt');
  });

  it('还没有提交时对空树', async () => {
    const dir = realpathSync(tempDir());
    sh(dir, 'init', '-q', '-b', 'start');
    writeFileSync(join(dir, 'x.txt'), '1\n2\n');
    sh(dir, 'add', 'x.txt');
    writeFileSync(join(dir, 'y.txt'), 'y\n');
    const result = await readUncommitted(dir);
    valid(result);
    expect(result).toMatchObject({
      repo: true,
      base: sh(dir, 'hash-object', '-t', 'tree', '/dev/null').trim(),
      branch: 'start',
      fileCount: 2,
    });
    expect(result.files?.map((file) => [file.path, file.status])).toEqual([
      ['x.txt', 'added'],
      ['y.txt', 'untracked'],
    ]);
  });

  it('单个文件超过上限只列出，别的照给', async () => {
    const dir = repo();
    const line = `${'x'.repeat(99)}\n`;
    writeFileSync(join(dir, 'huge.txt'), line.repeat(Math.ceil(DIFF_FILE_MAX_LENGTH / 100) + 10));
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const result = await readUncommitted(dir);
    valid(result);
    expect(result.truncated).toBe(true);
    expect(result.files?.find((file) => file.path === 'huge.txt')).toMatchObject({
      status: 'untracked',
      omitted: 'too_large',
    });
    expect(result.files?.find((file) => file.path === 'a.txt')?.omitted).toBeUndefined();
    expect(splitPatch(result.patch ?? '').map(chunkPath)).toEqual(['a.txt']);
  });

  it(`未跟踪文件多于 ${UNTRACKED_MAX_FILES} 个时不算它们的 diff`, async () => {
    const dir = repo();
    mkdirSync(join(dir, 'many'));
    for (let index = 0; index <= UNTRACKED_MAX_FILES; index += 1) {
      writeFileSync(join(dir, 'many', `${index}.txt`), 'x\n');
    }
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const result = await readUncommitted(dir);
    expect(result.fileCount).toBe(UNTRACKED_MAX_FILES + 2);
    expect(result.files?.[0]).toMatchObject({ path: 'a.txt', status: 'modified' });
    expect(result.files?.[1]).toMatchObject({ status: 'untracked', omitted: 'over_limit' });
    expect(result.files).toHaveLength(2000);
    expect(result.truncated).toBe(true);
  }, 30_000);

  it('并发的调用共用一次读取', async () => {
    const dir = repo();
    const [first, second] = [readUncommitted(dir), readUncommitted(dir)];
    expect(first).toBe(second);
    await first;
    const third = readUncommitted(dir);
    expect(third).not.toBe(first);
    // 等它的 git 退出：Windows 上还在跑的 git 占着目录，删不掉临时目录。
    await third;
  });
});

describe('workspace.diff：branch', () => {
  it('对默认分支的 merge-base：本分支的提交加上没提交的改动', async () => {
    const dir = repo();
    const mainSha = sh(dir, 'rev-parse', 'HEAD').trim();
    sh(dir, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, 'feature.txt'), 'f\n');
    sh(dir, 'add', 'feature.txt');
    sh(dir, 'commit', '-q', '-m', 'feature');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    // main 后来又往前走，不算进本分支。
    sh(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'later.txt'), 'later\n');
    sh(dir, 'add', 'later.txt');
    sh(dir, 'commit', '-q', '-m', 'later');
    sh(dir, 'checkout', '-q', 'feature');

    const result = await readBranch(dir);
    valid(result);
    expect(result).toMatchObject({ repo: true, base: mainSha, baseRef: 'main', branch: 'feature' });
    expect(result.files?.map((file) => file.path)).toEqual(['a.txt', 'feature.txt']);
    expect((await readUncommitted(dir)).files?.map((file) => file.path)).toEqual(['a.txt']);
  });

  it('origin 的 HEAD 优先', async () => {
    const dir = repo();
    sh(dir, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    sh(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    expect(await readBranch(dir)).toMatchObject({ repo: true, baseRef: 'origin/trunk' });
  });

  it('找不到默认分支时同 uncommitted，没有 baseRef', async () => {
    const dir = repo();
    sh(dir, 'branch', '-m', 'main', 'work');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const result = await readBranch(dir);
    expect(result).not.toHaveProperty('baseRef');
    expect(result.files?.map((file) => file.path)).toEqual(['a.txt']);
  });
});

describe('不执行仓库配置里的命令', () => {
  it('fsmonitor、外部 diff、textconv 与仓库定义的过滤器都不跑', async () => {
    const dir = repo();
    const marker = join(dir, '.git', 'ran');
    const script = join(dir, '.git', 'evil.sh');
    writeFileSync(script, `#!/bin/sh\necho "$0 $@" >> '${marker}'\ncat\n`);
    chmodSync(script, 0o755);
    sh(dir, 'config', 'core.fsmonitor', script);
    sh(dir, 'config', 'diff.external', script);
    sh(dir, 'config', 'diff.evil.textconv', script);
    sh(dir, 'config', 'filter.evil.clean', script);
    sh(dir, 'config', 'filter.evil.smudge', script);
    sh(dir, 'config', 'filter.evil.process', script);
    sh(dir, 'config', 'filter.evil.required', 'true');
    writeFileSync(join(dir, '.gitattributes'), '* diff=evil filter=evil\n');
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    writeFileSync(join(dir, 'untracked.txt'), 'u\n');

    const uncommitted = await readUncommitted(dir);
    expect(uncommitted).toMatchObject({ repo: true, branch: 'main' });
    expect(uncommitted.files?.map((file) => file.path)).toContain('untracked.txt');
    expect(await readBranch(dir)).toMatchObject({ repo: true });
    expect(
      await readDiffFile(dir, {
        oldRev: uncommitted.base as string,
        oldPath: 'a.txt',
        newPath: 'a.txt',
      }),
    ).toEqual({ oldContents: 'one\ntwo\nthree\n', newContents: 'changed\n' });
    expect(existsSync(marker)).toBe(false);
  });

  it('core.worktree 指到别处时不当仓库', async () => {
    const dir = repo();
    const elsewhere = realpathSync(tempDir());
    mkdirSync(join(elsewhere, 'other'));
    sh(dir, 'config', 'core.worktree', join(elsewhere, 'other'));
    expect(await readUncommitted(dir)).toEqual({ repo: false });
  });
});

describe('workspace.diffFile', () => {
  it('旧的一侧取版本库，新的一侧读磁盘或版本库', async () => {
    const dir = repo();
    const head = sh(dir, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'a.txt'), 'new\n');
    expect(await readDiffFile(dir, { oldRev: head, oldPath: 'a.txt', newPath: 'a.txt' })).toEqual({
      oldContents: 'one\ntwo\nthree\n',
      newContents: 'new\n',
    });
    expect(await readDiffFile(dir, { newRev: head, newPath: 'sub/b.txt' })).toEqual({
      newContents: 'b\n',
    });
    // 子目录里的路径相对它。
    expect(await readDiffFile(join(dir, 'sub'), { oldRev: head, oldPath: 'b.txt' })).toEqual({
      oldContents: 'b\n',
    });
  });

  it('二进制、太大、不存在与指到目录外的链接', async () => {
    const dir = repo();
    const head = sh(dir, 'rev-parse', 'HEAD').trim();
    expect(await readDiffFile(dir, { oldRev: head, oldPath: 'bin.dat' })).toEqual({
      unavailable: 'binary',
    });
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
    expect(await readDiffFile(dir, { newPath: 'big.txt' })).toEqual({ unavailable: 'too_large' });
    expect(await readDiffFile(dir, { oldRev: head, oldPath: 'nope.txt' })).toEqual({
      unavailable: 'not_found',
    });
    // 工作区是 sub/，链接指到它外面的 a.txt。
    symlinkSync(join(dir, 'a.txt'), join(dir, 'sub', 'link.txt'));
    expect(await readDiffFile(join(dir, 'sub'), { newPath: 'link.txt' })).toEqual({
      unavailable: 'not_found',
    });
    expect(await readDiffFile(join(dir, 'sub'), { newPath: 'b.txt' })).toEqual({
      newContents: 'b\n',
    });
  });

  it('路径要相对、不往上走', () => {
    expect(isSafeRelativePath('src/a.ts')).toBe(true);
    expect(isSafeRelativePath('a b/c.d')).toBe(true);
    for (const path of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', './a', 'a\\b', 'a\0b']) {
      expect(isSafeRelativePath(path), path).toBe(false);
    }
  });
});

describe('解析', () => {
  it('numstat：重命名多两个字段，二进制没有行数', () => {
    expect(parseNumstat('3\t1\ta b.txt\0-\t-\timg.png\0' + '0\t0\t\0old.txt\0new.txt\0')).toEqual([
      { path: 'a b.txt', added: 3, removed: 1 },
      { path: 'img.png' },
      { path: 'new.txt', previousPath: 'old.txt', added: 0, removed: 0 },
    ]);
  });

  it('name-status：重命名与复制按新路径', () => {
    expect([...parseNameStatus('M\0a\0R087\0old\0new\0A\0b\0T\0t\0C100\0x\0y\0D\0d\0')]).toEqual([
      ['a', 'modified'],
      ['new', 'renamed'],
      ['b', 'added'],
      ['t', 'type_changed'],
      ['y', 'copied'],
      ['d', 'deleted'],
    ]);
  });

  it('raw 加 numstat 一次的输出拆回 name-status 与 numstat 两份', () => {
    const raw =
      ':100644 100644 1111111 0000000 M\0:odd.txt\0' +
      ':100644 100644 2222222 3333333 R087\0old\0new\0' +
      ':000000 100644 0000000 4444444 A\0' +
      '1\t2\tlooks like numstat\0' +
      ':100644 100644 5555555 6666666 C100\0x\0y\0';
    const numstat = '3\t1\t:odd.txt\0' + '0\t0\t\0old\0new\0' + '1\t0\t1\t2\tlooks like numstat\0';
    expect(splitRawNumstat(raw + numstat)).toEqual({
      nameStatus: 'M\0:odd.txt\0R087\0old\0new\0A\0' + '1\t2\tlooks like numstat\0C100\0x\0y\0',
      numstat,
    });
    expect(splitRawNumstat('')).toEqual({ nameStatus: '', numstat: '' });
  });

  it('补丁按文件切开，认出每段的文件', () => {
    const patch = [
      'diff --git a/a.txt b/a.txt',
      'index 1..2 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-diff --git a/fake b/fake',
      '+x',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git "a/tab\\there" "b/tab\\there"',
      '--- "a/tab\\there"',
      '+++ "b/tab\\there"',
      'diff --git a/old name b/new name',
      'similarity index 100%',
      'rename from old name',
      'rename to new name',
      'diff --git a/中文.md b/中文.md',
      'new file mode 100644',
      '',
    ].join('\n');
    const chunks = splitPatch(patch);
    expect(chunks.map(chunkPath)).toEqual([
      'a.txt',
      'gone.txt',
      'img.png',
      'run.sh',
      'tab\there',
      'new name',
      '中文.md',
    ]);
    expect(chunks.join('')).toBe(patch);
    expect(chunks[0]).toContain('-diff --git a/fake b/fake');
  });
});
