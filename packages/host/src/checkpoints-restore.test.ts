// 撤销与重做的文件部分（0.51.0，domain-model §3.22）：对着真实的 git 把目录还原到回合的“前”快照、再还原回撤销之前。

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TurnId } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { checkpointRef, RestoreError, TurnCheckpoints } from './checkpoints.js';
import { useTempDir } from './test-utils.js';

const tempDir = useTempDir();

const SID = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';
const T1 = 'trn_01JA2B3C4D5E6F7G8H9JKMNP01' as TurnId;
const T2 = 'trn_01JA2B3C4D5E6F7G8H9JKMNP02' as TurnId;

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

function repo(): string {
  const root = realpathSync(tempDir());
  sh(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(root, 'b.txt'), 'bee\n');
  writeFileSync(join(root, '.gitignore'), 'ignored.log\n');
  sh(root, 'add', '.');
  sh(root, 'commit', '-q', '-m', 'init');
  return root;
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');

const services: TurnCheckpoints[] = [];
function service(): TurnCheckpoints {
  const created = new TurnCheckpoints({ isOpen: () => true });
  services.push(created);
  return created;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((created) => created.dispose()));
});

/** 回合里改的：a.txt 改了，b.txt 删了，sub/new.txt 新增（连目录），被忽略的 ignored.log 也写了。 */
function turnEdits(dir: string): void {
  writeFileSync(join(dir, 'a.txt'), 'changed\n');
  rmSync(join(dir, 'b.txt'));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'new.txt'), 'new\n');
  writeFileSync(join(dir, 'ignored.log'), 'log\n');
}

describe('TurnCheckpoints.undo / redo', () => {
  it('撤销把改的、删的、新增的文件都还原（连空出来的目录），被忽略的不动；重做再回到撤销之前；不碰索引、HEAD 与分支', async () => {
    const dir = repo();
    const head = sh(dir, 'rev-parse', 'HEAD');
    const checkpoints = service();
    await checkpoints.beforeTurn(SID, dir, T1);
    turnEdits(dir);
    checkpoints.afterTurn(SID, dir, T1);

    expect(await checkpoints.undo(SID, dir, T1)).toEqual({ status: 'restored', fileCount: 3 });
    expect(read(dir, 'a.txt')).toBe('one\ntwo\n');
    expect(read(dir, 'b.txt')).toBe('bee\n');
    expect(existsSync(join(dir, 'sub'))).toBe(false);
    expect(read(dir, 'ignored.log')).toBe('log\n');
    expect(sh(dir, 'status', '--porcelain')).toBe('');
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(sh(dir, 'for-each-ref', '--format=%(refname)', 'refs/wevir/')).toContain(
      checkpointRef(SID, T1, 'undone'),
    );

    expect(await checkpoints.redo(SID, dir, T1)).toEqual({ status: 'restored', fileCount: 3 });
    expect(read(dir, 'a.txt')).toBe('changed\n');
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
    expect(read(dir, 'sub/new.txt')).toBe('new\n');
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(sh(dir, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('撤销之前的手改也存在 undone 里，重做带回来；重做之前的手改存在 redone-from 里', async () => {
    const dir = repo();
    const checkpoints = service();
    await checkpoints.beforeTurn(SID, dir, T1);
    writeFileSync(join(dir, 'a.txt'), 'agent\n');
    checkpoints.afterTurn(SID, dir, T1);
    writeFileSync(join(dir, 'a.txt'), 'agent, then me\n');

    await checkpoints.undo(SID, dir, T1);
    expect(read(dir, 'a.txt')).toBe('one\ntwo\n');
    writeFileSync(join(dir, 'a.txt'), 'mine after undo\n');

    expect(await checkpoints.redo(SID, dir, T1)).toMatchObject({ status: 'restored' });
    expect(read(dir, 'a.txt')).toBe('agent, then me\n');
    expect(sh(dir, 'show', `${checkpointRef(SID, T1, 'redone-from')}:a.txt`)).toBe(
      'mine after undo\n',
    );
  });

  it('连着撤销两个回合，再按相反的顺序重做', async () => {
    const dir = repo();
    const checkpoints = service();
    await checkpoints.beforeTurn(SID, dir, T1);
    writeFileSync(join(dir, 'a.txt'), 'turn one\n');
    checkpoints.afterTurn(SID, dir, T1);
    await checkpoints.beforeTurn(SID, dir, T2);
    writeFileSync(join(dir, 'a.txt'), 'turn two\n');
    checkpoints.afterTurn(SID, dir, T2);

    await checkpoints.undo(SID, dir, T2);
    expect(read(dir, 'a.txt')).toBe('turn one\n');
    await checkpoints.undo(SID, dir, T1);
    expect(read(dir, 'a.txt')).toBe('one\ntwo\n');
    await checkpoints.redo(SID, dir, T1);
    expect(read(dir, 'a.txt')).toBe('turn one\n');
    await checkpoints.redo(SID, dir, T2);
    expect(read(dir, 'a.txt')).toBe('turn two\n');
  });

  it('目录本来就是回合开始前的样子：unchanged', async () => {
    const dir = repo();
    const checkpoints = service();
    await checkpoints.beforeTurn(SID, dir, T1);
    expect(await checkpoints.undo(SID, dir, T1)).toEqual({ status: 'unchanged', fileCount: 0 });
  });

  it('HEAD 动过（回合里或之后提交了）不还原，文件原样', async () => {
    const dir = repo();
    const checkpoints = service();
    await checkpoints.beforeTurn(SID, dir, T1);
    writeFileSync(join(dir, 'a.txt'), 'committed by the agent\n');
    sh(dir, 'commit', '-q', '-am', 'agent commit');
    expect(await checkpoints.undo(SID, dir, T1)).toEqual({
      status: 'unavailable',
      reason: 'head_moved',
    });
    expect(read(dir, 'a.txt')).toBe('committed by the agent\n');
  });

  it('没有快照、不在 git 仓库里：unavailable，什么都不动', async () => {
    const dir = repo();
    const checkpoints = service();
    expect(await checkpoints.undo(SID, dir, T1)).toEqual({
      status: 'unavailable',
      reason: 'no_checkpoint',
    });
    // 没撤销过就没有 undone 可重做。
    await checkpoints.beforeTurn(SID, dir, T1);
    expect(await checkpoints.redo(SID, dir, T1)).toEqual({
      status: 'unavailable',
      reason: 'no_checkpoint',
    });

    // useTempDir 一个用例只给一个目录（已经是仓库），不在仓库里的目录另建。
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'wevir-plain-')));
    try {
      writeFileSync(join(plain, 'x.txt'), 'x\n');
      expect(await checkpoints.undo(SID, plain, T1)).toEqual({
        status: 'unavailable',
        reason: 'not_git',
      });
      expect(read(plain, 'x.txt')).toBe('x\n');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('会话目录是仓库的子目录：只还原这个子目录，仓库里别处的改动不动', async () => {
    const dir = repo();
    mkdirSync(join(dir, 'pkg'));
    writeFileSync(join(dir, 'pkg', 'p.txt'), 'p\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'pkg');
    const checkpoints = service();
    const pkg = join(dir, 'pkg');
    await checkpoints.beforeTurn(SID, pkg, T1);
    writeFileSync(join(pkg, 'p.txt'), 'changed in pkg\n');
    writeFileSync(join(dir, 'a.txt'), 'changed outside\n');

    expect(await checkpoints.undo(SID, pkg, T1)).toEqual({ status: 'restored', fileCount: 1 });
    expect(read(pkg, 'p.txt')).toBe('p\n');
    expect(read(dir, 'a.txt')).toBe('changed outside\n');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '还原写不进去时抛 RestoreError，目录里的文件没被改动',
    async () => {
      const dir = repo();
      mkdirSync(join(dir, 'locked'));
      writeFileSync(join(dir, 'locked', 'f.txt'), 'orig\n');
      sh(dir, 'add', '.');
      sh(dir, 'commit', '-q', '-m', 'locked');
      const checkpoints = service();
      await checkpoints.beforeTurn(SID, dir, T1);
      writeFileSync(join(dir, 'locked', 'f.txt'), 'agent\n');
      chmodSync(join(dir, 'locked'), 0o500);
      try {
        await expect(checkpoints.undo(SID, dir, T1)).rejects.toBeInstanceOf(RestoreError);
        expect(read(dir, 'locked/f.txt')).toBe('agent\n');
      } finally {
        chmodSync(join(dir, 'locked'), 0o700);
      }
    },
  );
});
