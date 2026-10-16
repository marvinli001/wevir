// workspace.files / workspace.listDir / workspace.readFile（0.22.0）：对着真实的目录与 git 仓库。

import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { MethodSchemas } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { useTempDir } from './test-utils.js';
import {
  FILE_INDEX_MAX_ENTRIES,
  FileIndex,
  listDirectory,
  readWorkspaceFile,
  scorePath,
  searchIndex,
  WriteRejected,
  writeWorkspaceFile,
} from './workspace-files.js';

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

/** src/app/composer.tsx、src/lib/util.ts、README.md、docs/guide.md，忽略 dist/ 与 *.log。 */
function tree(dir: string): void {
  mkdirSync(join(dir, 'src', 'app'), { recursive: true });
  mkdirSync(join(dir, 'src', 'lib'));
  mkdirSync(join(dir, 'docs'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'src', 'app', 'composer.tsx'), 'export {};\n');
  writeFileSync(join(dir, 'src', 'lib', 'util.ts'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'README.md'), '# Demo\n');
  writeFileSync(join(dir, 'docs', 'guide.md'), 'guide\n');
  writeFileSync(join(dir, 'dist', 'bundle.js'), 'built\n');
  writeFileSync(join(dir, 'debug.log'), 'log\n');
  writeFileSync(join(dir, '.gitignore'), 'dist/\n*.log\n');
}

/** 同一个临时目录下的工作目录与它外面的目录。 */
function twoDirs(): { dir: string; outside: string } {
  const base = realpathSync(tempDir());
  const dir = join(base, 'ws');
  const outside = join(base, 'outside');
  mkdirSync(dir);
  mkdirSync(outside);
  return { dir, outside };
}

function gitRepo(): string {
  const dir = realpathSync(tempDir());
  tree(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  // 没跟踪、没被忽略的文件也要在索引里。
  writeFileSync(join(dir, 'src', 'lib', 'new.ts'), 'new\n');
  return dir;
}

describe('文件索引与名字搜索', () => {
  it('git 仓库：跟踪的与没被忽略的未跟踪文件，文件夹取父目录，被忽略的不在里面', async () => {
    const dir = gitRepo();
    const snapshot = await new FileIndex().snapshot(dir);
    expect(snapshot.files.sort()).toEqual([
      '.gitignore',
      'README.md',
      'docs/guide.md',
      'src/app/composer.tsx',
      'src/lib/new.ts',
      'src/lib/util.ts',
    ]);
    expect(snapshot.directories.sort()).toEqual(['docs', 'src', 'src/app', 'src/lib']);
    expect(snapshot.truncated).toBe(false);
  });

  it('不是 git 仓库：遍历目录，跳过 node_modules 与符号链接', async () => {
    const dir = realpathSync(tempDir());
    tree(dir);
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), '');
    symlinkSync(join(dir, 'README.md'), join(dir, 'link.md'));
    const snapshot = await new FileIndex().snapshot(dir);
    expect(snapshot.files).toContain('dist/bundle.js');
    expect(snapshot.files).not.toContain('link.md');
    expect(snapshot.files.some((path) => path.startsWith('node_modules'))).toBe(false);
    expect(snapshot.directories).not.toContain('node_modules');
  });

  it('名字的匹配优先于路径，空查询按层级', async () => {
    const dir = gitRepo();
    const snapshot = await new FileIndex().snapshot(dir);
    expect(searchIndex(snapshot, 'comp', 10).entries[0]).toEqual({
      path: 'src/app/composer.tsx',
      kind: 'file',
    });
    expect(searchIndex(snapshot, '@util', 10).entries[0]?.path).toBe('src/lib/util.ts');
    expect(searchIndex(snapshot, 'src/lib', 10, 'directory').entries).toEqual([
      { path: 'src/lib', kind: 'directory' },
    ]);
    expect(searchIndex(snapshot, 'zzz', 10).entries).toEqual([]);
    const browse = searchIndex(snapshot, '', 3);
    expect(browse.entries.map((entry) => entry.path)).toEqual(['docs', 'src', '.gitignore']);
    expect(browse.truncated).toBe(true);
    const files = searchIndex(snapshot, '', 50, 'file').entries;
    expect(files.every((entry) => entry.kind === 'file')).toBe(true);
    expect(MethodSchemas['workspace.files'].result.safeParse(browse).success).toBe(true);
  });

  it('打分：前缀好于包含，子序列最差', () => {
    const prefix = scorePath('src/composer.tsx', 'comp') as number;
    const includes = scorePath('src/mycomposer.tsx', 'comp') as number;
    const fuzzy = scorePath('src/cxoxmxp.ts', 'comp') as number;
    expect(prefix).toBeLessThan(includes);
    expect(includes).toBeLessThan(fuzzy);
    expect(scorePath('src/a.ts', 'zz')).toBeNull();
  });

  it('索引缓存几秒，过期后重建', async () => {
    const dir = gitRepo();
    let now = 1000;
    const index = new FileIndex(() => now);
    const first = await index.snapshot(dir);
    writeFileSync(join(dir, 'later.ts'), '');
    expect(await index.snapshot(dir)).toBe(first);
    now += 10_000;
    expect((await index.snapshot(dir)).files).toContain('later.ts');
    expect(FILE_INDEX_MAX_ENTRIES).toBe(25_000);
  });
});

describe('列目录', () => {
  it('文件夹在前，标出被忽略的，不含 .git', async () => {
    const dir = gitRepo();
    const root = await listDirectory(dir, '');
    expect(root.entries).toEqual([
      { path: 'dist', kind: 'directory', ignored: true },
      { path: 'docs', kind: 'directory' },
      { path: 'src', kind: 'directory' },
      { path: '.gitignore', kind: 'file' },
      { path: 'debug.log', kind: 'file', ignored: true },
      { path: 'README.md', kind: 'file' },
    ]);
    expect((await listDirectory(dir, 'src/lib')).entries.map((entry) => entry.path)).toEqual([
      'src/lib/new.ts',
      'src/lib/util.ts',
    ]);
    expect(MethodSchemas['workspace.listDir'].result.safeParse(root).success).toBe(true);
  });

  it('不存在、指到目录外的路径是空表', async () => {
    const { dir, outside } = twoDirs();
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(outside, join(dir, 'escape'));
    expect((await listDirectory(dir, 'missing')).entries).toEqual([]);
    expect((await listDirectory(dir, 'escape')).entries).toEqual([]);
    expect((await listDirectory(dir, '')).entries).toEqual([]);
  });
});

describe('读文件', () => {
  it('文本、图片、二进制、过大与不存在', async () => {
    const dir = realpathSync(tempDir());
    writeFileSync(join(dir, 'a.txt'), '你好\n');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    writeFileSync(join(dir, 'logo.png'), png);
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([1, 0, 2]));
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
    mkdirSync(join(dir, 'folder'));

    expect(await readWorkspaceFile(dir, 'a.txt')).toEqual({
      path: 'a.txt',
      size: 7,
      mtimeMs: expect.any(Number),
      text: '你好\n',
    });
    expect(await readWorkspaceFile(dir, 'logo.png')).toEqual({
      path: 'logo.png',
      size: png.length,
      mtimeMs: expect.any(Number),
      image: { mimeType: 'image/png', data: png.toString('base64') },
    });
    expect(await readWorkspaceFile(dir, 'bin.dat')).toEqual({
      path: 'bin.dat',
      size: 3,
      unavailable: 'binary',
    });
    expect((await readWorkspaceFile(dir, 'big.txt')).unavailable).toBe('too_large');
    expect(await readWorkspaceFile(dir, 'folder')).toEqual({
      path: 'folder',
      unavailable: 'not_found',
    });
    expect((await readWorkspaceFile(dir, 'nope.txt')).unavailable).toBe('not_found');
    const result = await readWorkspaceFile(dir, 'a.txt');
    expect(MethodSchemas['workspace.readFile'].result.safeParse(result).success).toBe(true);
  });

  it('经符号链接读到目录外的文件时回 not_found', async () => {
    const { dir, outside } = twoDirs();
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));
    expect((await readWorkspaceFile(dir, 'link.txt')).unavailable).toBe('not_found');
  });
});

describe('写文件（0.32.0）', () => {
  it('按修改时间检查冲突，原地写', async () => {
    const dir = realpathSync(tempDir());
    writeFileSync(join(dir, 'a.md'), '# 旧的标题\n', { mode: 0o640 });
    linkSync(join(dir, 'a.md'), join(dir, 'hard.md'));
    const read = await readWorkspaceFile(dir, 'a.md');
    const written = await writeWorkspaceFile(dir, 'a.md', '# 新\n', read.mtimeMs);
    expect(written).toEqual({
      path: 'a.md',
      size: 6,
      mtimeMs: statSync(join(dir, 'a.md')).mtimeMs,
    });
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe('# 新\n');
    // 原地写：硬链接看到同样的内容，权限不变。
    expect(readFileSync(join(dir, 'hard.md'), 'utf8')).toBe('# 新\n');
    if (process.platform !== 'win32') expect(statSync(join(dir, 'a.md')).mode & 0o777).toBe(0o640);

    // 别人在这之后改了文件：不写，回磁盘上的状态。
    utimesSync(join(dir, 'a.md'), new Date(), new Date(Date.now() + 5000));
    const conflict = await writeWorkspaceFile(dir, 'a.md', 'mine', written.mtimeMs);
    expect(conflict).toMatchObject({ path: 'a.md', size: 6, conflict: true });
    expect(conflict.mtimeMs).not.toBe(written.mtimeMs);
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe('# 新\n');
    // 不带 expectedMtimeMs 时直接写。
    expect(await writeWorkspaceFile(dir, 'a.md', '', undefined)).toMatchObject({ size: 0 });
  });

  it('已删除算冲突；不新建、不写目录外与过大的文本', async () => {
    const { dir, outside } = twoDirs();
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));
    expect(await writeWorkspaceFile(dir, 'gone.md', 'x', 123)).toEqual({
      path: 'gone.md',
      conflict: true,
    });
    await expect(writeWorkspaceFile(dir, 'gone.md', 'x', undefined)).rejects.toBeInstanceOf(
      WriteRejected,
    );
    await expect(writeWorkspaceFile(dir, 'link.txt', 'x', undefined)).rejects.toBeInstanceOf(
      WriteRejected,
    );
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    writeFileSync(join(dir, 'a.txt'), 'a');
    await expect(
      writeWorkspaceFile(dir, 'a.txt', 'x'.repeat(1024 * 1024 + 1), undefined),
    ).rejects.toBeInstanceOf(WriteRejected);
  });
});
