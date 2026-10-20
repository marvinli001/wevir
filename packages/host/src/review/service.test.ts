// 行级批注（0.67.0）：对着临时目录里的真实 git 仓库与真实的库。发送走一个记下参数的假 SessionManager.send。

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MethodParams, SessionId, WorkspaceId } from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import { HostError } from '../errors.js';
import { identity, SES, SES2, T0, useStorages, useTempDir } from '../test-utils.js';
import { loadReviewTemplate, type ReviewDirectory, ReviewService } from './service.js';

const tempDir = useTempDir();
const storages = useStorages();
const WS = 'ws_1' as WorkspaceId;

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
  }).trim();
}

const CONVERT = [
  'export function toCelsius(f: number) {',
  '  return (f - 32) * 5 / 9;',
  '}',
  '',
  'export function toFahrenheit(c: number) {',
  '  return c * 9 / 5 + 32;',
  '}',
  '',
].join('\n');

interface Setup {
  dir: string;
  storage: Storage;
  service: ReviewService;
  where: ReviewDirectory;
  base: string;
  sent: MethodParams<'session.send'>[];
}

function setup(): Setup {
  const root = realpathSync(tempDir());
  const dir = join(root, 'repo');
  mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  writeFileSync(
    join(dir, 'convert.ts'),
    'export function toCelsius(f: number) {\n  return f;\n}\n',
  );
  writeFileSync(join(dir, 'old.ts'), 'const a = 1;\nconst b = 2;\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  writeFileSync(join(dir, 'convert.ts'), CONVERT);
  const storage = storages.open(join(root, 'data'));
  storage.workspaces.insert({
    id: WS,
    rootPath: dir,
    displayName: 'repo',
    createdAt: T0,
    updatedAt: T0,
  });
  storage.workspaces.insert({
    id: 'ws_2',
    rootPath: '/elsewhere',
    displayName: 'other',
    createdAt: T0,
    updatedAt: T0,
  });
  for (const [id, workspaceId] of [
    [SES, WS],
    [SES2, 'ws_2'],
  ] as const) {
    storage.sessions.insert({
      id,
      workspaceId,
      cwd: dir,
      engine: 'codex',
      engineSessionId: `engine-${id}`,
      providerId: 'p',
      modelId: 'm',
      title: '',
      titleSource: 'first_prompt',
      state: 'idle',
      lastSeq: 0,
      createdAt: T0,
      updatedAt: T0,
    });
  }
  const sent: MethodParams<'session.send'>[] = [];
  const service = new ReviewService({
    storage,
    sessions: {
      send: async (params) => {
        sent.push(params);
        return { turnId: 'trn_9', seq: 4 };
      },
    },
    template: loadReviewTemplate(),
  });
  return {
    dir,
    storage,
    service,
    where: { workspaceId: WS, dir },
    base: sh(dir, 'rev-parse', 'HEAD'),
    sent,
  };
}

/** 发出的消息正文。 */
function textOf(params: MethodParams<'session.send'> | undefined): string {
  const part = params?.content[0];
  return part?.type === 'text' ? part.text : '';
}

function newSide(base: string, startLine: number, endLine: number, body = '负数要四舍五入') {
  return {
    sessionId: SES,
    source: { kind: 'uncommitted' as const },
    base,
    path: 'convert.ts',
    side: 'new' as const,
    startLine,
    endLine,
    body,
  };
}

describe('review.add / review.list', () => {
  it('Host 自己从磁盘读出那几行；文件改了按原文重新定位，原文没了标过期', async () => {
    const { dir, service, where, base } = setup();
    const comment = await service.add(where, newSide(base, 5, 7));
    expect(comment).toMatchObject({
      path: 'convert.ts',
      side: 'new',
      startLine: 5,
      endLine: 7,
      branch: 'main',
      snippet: 'export function toFahrenheit(c: number) {\n  return c * 9 / 5 + 32;\n}',
      status: 'pending',
      anchor: { state: 'current', startLine: 5, endLine: 7 },
    });

    writeFileSync(join(dir, 'convert.ts'), `// units\n// more\n${CONVERT}`);
    expect((await service.list(where))[0]?.anchor).toEqual({
      state: 'relocated',
      startLine: 7,
      endLine: 9,
    });

    writeFileSync(join(dir, 'convert.ts'), CONVERT.replace('c * 9 / 5 + 32', 'c * 1.8 + 32'));
    expect((await service.list(where))[0]?.anchor).toEqual({
      state: 'outdated',
      reason: 'changed',
    });

    rmSync(join(dir, 'convert.ts'));
    expect((await service.list(where))[0]?.anchor).toEqual({
      state: 'outdated',
      reason: 'file_missing',
    });
  });

  it('旧的一侧读基线提交（重命名时读原来的路径），工作树怎么改都不动', async () => {
    const { dir, service, where, base } = setup();
    renameSync(join(dir, 'old.ts'), join(dir, 'renamed.ts'));
    writeFileSync(join(dir, 'renamed.ts'), 'const a = 1;\n');
    const comment = await service.add(where, {
      ...newSide(base, 2, 2, '为什么删掉 b'),
      path: 'renamed.ts',
      previousPath: 'old.ts',
      side: 'old',
    });
    expect(comment.snippet).toBe('const b = 2;');
    writeFileSync(join(dir, 'renamed.ts'), 'something else\n');
    expect((await service.list(where))[0]?.anchor.state).toBe('current');
  });

  it('回合快照的新的一侧读快照提交，之后对着磁盘定位', async () => {
    const { dir, service, where, base } = setup();
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'turn');
    const head = sh(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'convert.ts'), 'replaced\n');
    const comment = await service.add(where, {
      ...newSide(base, 2, 2),
      source: { kind: 'turn', turnId: 'trn_1' },
      head,
    });
    expect(comment.snippet).toBe('  return (f - 32) * 5 / 9;');
    expect((await service.list(where))[0]?.anchor).toEqual({
      state: 'outdated',
      reason: 'changed',
    });
  });

  it('不合法的位置与路径都拒绝', async () => {
    const { service, where, base } = setup();
    await expect(service.add(where, newSide(base, 7, 9))).rejects.toThrow(/outside the file/);
    await expect(service.add(where, newSide(base, 3, 2))).rejects.toThrow(/before startLine/);
    await expect(service.add(where, { ...newSide(base, 1, 1), path: '../x' })).rejects.toThrow(
      /relative path/,
    );
    await expect(
      service.add(where, { ...newSide(base, 1, 1), path: 'nope.ts', side: 'old' }),
    ).rejects.toThrow(/not_found/);
  });

  it('只列这个目录、这个工作区的；只有没发的能改', async () => {
    const { service, where, base } = setup();
    const comment = await service.add(where, newSide(base, 1, 1));
    expect(await service.list({ workspaceId: 'ws_2' as WorkspaceId, dir: where.dir })).toEqual([]);
    expect((await service.update(comment.id, '  换成 Math.round  ')).body).toBe('换成 Math.round');
    await service.send(where, { commentIds: [comment.id], targetSessionId: SES }, identity);
    await expect(service.update(comment.id, 'x')).rejects.toThrow(/already sent/);
    expect(await service.list(where, 'pending')).toEqual([]);
    expect(service.remove([comment.id, comment.id])).toBe(1);
  });
});

describe('review.send', () => {
  it('一组批注拼成一条用户消息：标明是审阅意见，给出文件、行、原文与意见；之后标为已发送', async () => {
    const { dir, service, where, base, sent } = setup();
    const moved = await service.add(where, newSide(base, 6, 6, '用 Math.round'));
    const stale = await service.add(where, newSide(base, 2, 2, '整数除法？'));
    const removed = await service.add(where, {
      ...newSide(base, 2, 2, '这里为什么返回 f'),
      side: 'old',
    });
    writeFileSync(
      join(dir, 'convert.ts'),
      `// header\n${CONVERT.replace('(f - 32) * 5 / 9', '((f - 32) * 5) / 9')}`,
    );

    const result = await service.send(
      where,
      { commentIds: [moved.id, stale.id, removed.id], targetSessionId: SES, delivery: 'queue' },
      identity,
    );
    expect(result).toMatchObject({ turnId: 'trn_9', seq: 4 });
    expect(result.comments.map((comment) => comment.status)).toEqual(['sent', 'sent', 'sent']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sessionId: SES, delivery: 'queue' });
    const text = textOf(sent[0]);
    expect(text).toContain('3 条批注（用户的审阅意见）');
    expect(text).toContain(`路径相对目录 \`${dir}\``);
    expect(text).toContain(`分支 main，HEAD ${base.slice(0, 7)}`);
    expect(text).toContain('### 1. convert.ts，第 7 行（当前文件；写批注时在第 6 行）');
    expect(text).toContain('```ts\n  return c * 9 / 5 + 32;\n```\n\n意见：用 Math.round');
    expect(text).toContain('### 2. convert.ts，原第 2 行（已过期：文件已改，找不到这几行）');
    expect(text).toContain(`### 3. convert.ts，改动前的第 2 行（基线 ${base.slice(0, 7)}）`);
    expect(text).toContain('```ts\n  return f;\n```');

    const stored = await service.list(where);
    expect(stored.map((comment) => comment.sent)).toEqual([
      expect.objectContaining({ sessionId: SES, turnId: 'trn_9' }),
      expect.objectContaining({ sessionId: SES, turnId: 'trn_9' }),
      expect.objectContaining({ sessionId: SES, turnId: 'trn_9' }),
    ]);
    await expect(
      service.send(where, { commentIds: [moved.id], targetSessionId: SES }, identity),
    ).rejects.toThrow(/already sent/);
  });

  it('目标会话要在同一个工作区；批注要在这个目录；发送失败时批注保持未发送', async () => {
    const { service, where, base, storage } = setup();
    const comment = await service.add(where, newSide(base, 1, 1));
    await expect(
      service.send(
        where,
        { commentIds: [comment.id], targetSessionId: SES2 as SessionId },
        identity,
      ),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(
      service.send(
        { workspaceId: WS, dir: '/other' },
        { commentIds: [comment.id], targetSessionId: SES },
        identity,
      ),
    ).rejects.toThrow(/another directory/);

    const failing = new ReviewService({
      storage,
      sessions: {
        send: async () => {
          throw new HostError('SESSION_BUSY', 'busy', { state: 'running' });
        },
      },
      template: loadReviewTemplate(),
    });
    await expect(
      failing.send(where, { commentIds: [comment.id], targetSessionId: SES }, identity),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect((await service.list(where))[0]?.status).toBe('pending');
  });

  it('片段里有反引号时围栏更长', async () => {
    const { dir, service, where, base, sent } = setup();
    writeFileSync(join(dir, 'doc.md'), 'use ```js``` fences\n');
    const comment = await service.add(where, { ...newSide(base, 1, 1), path: 'doc.md' });
    await service.send(where, { commentIds: [comment.id], targetSessionId: SES }, identity);
    expect(textOf(sent[0])).toContain('````md\nuse ```js``` fences\n````');
  });
});
