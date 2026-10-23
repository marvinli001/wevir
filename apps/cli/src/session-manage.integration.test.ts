// 会话的管理命令（show、config、rename、undo / redo、fork、compact、cancel、close、archive、delete）对着进程内的 echo Host。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunningHost } from '@wevir/host';
import type { SessionSnapshot } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { run, startEchoHost, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
let host: RunningHost | undefined;
afterEach(async () => {
  await host?.shutdown();
  host = undefined;
});

async function setup(stepDelayMs = 1) {
  const home = join(tempDir(), 'home');
  const workspace = join(tempDir(), 'project');
  mkdirSync(workspace);
  host = await startEchoHost(home, { stepDelayMs });
  const added = await run(
    [
      'provider',
      'add',
      '--kind',
      'openai-compatible',
      '--id',
      'echo-test',
      '--base-url',
      'http://127.0.0.1:9/v1',
      '--model',
      'echo-model',
    ],
    { home, input: 'sk-from-stdin\n' },
  );
  expect(added.code, added.err).toBe(0);
  return { home, workspace };
}

async function snapshot(home: string, id: string): Promise<SessionSnapshot> {
  const shown = await run(['session', 'show', id, '--json'], { home });
  expect(shown.code, shown.err).toBe(0);
  return JSON.parse(shown.out) as SessionSnapshot;
}

/** 建会话、发一条消息，等这一轮结束。 */
async function sessionWithTurn(home: string, workspace: string, prompt = 'hello there') {
  const created = await run(['session', 'new', '-w', workspace, '--detach', prompt], { home });
  expect(created.code, created.err).toBe(0);
  const id = /已创建会话 (ses_\w+)/.exec(created.out)?.[1] as string;
  await waitFor(async () => (await snapshot(home, id)).session.state === 'idle');
  return id;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待超时');
}

describe('会话管理', () => {
  it('show、rename、config 与 list --json', async () => {
    const { home, workspace } = await setup();
    const id = await sessionWithTurn(home, workspace);
    const shown = await run(['session', 'show', id.slice(0, 20)], { home });
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain(id);
    expect(shown.out).toMatch(/状态\s+空闲/);
    expect(shown.out).toMatch(/模型\s+echo-test\/echo-model/);
    expect(shown.out).toMatch(/权限\s+请求批准/);

    expect((await run(['session', 'rename', id, 'My', 'chat'], { home })).out).toContain(
      '已改名：My chat',
    );
    const config = await run(
      ['session', 'config', id, '--effort', 'high', '--permission', 'full_access'],
      { home },
    );
    expect(config.code, config.err).toBe(0);
    expect(config.out).toContain('模型 echo-test/echo-model · 推理 high · 完全访问');
    const reset = await run(['session', 'config', id, '--default-effort'], { home });
    expect(reset.out).toContain('推理 默认');
    const conflict = await run(['session', 'config', id, '--effort', 'low', '--default-effort'], {
      home,
    });
    expect(conflict.code).toBe(2);
    const bad = await run(['session', 'config', id, '--permission', 'maybe'], { home });
    expect(bad.err).toContain('未知权限模式：maybe');

    const listed = await run(['session', 'list', '--json'], { home });
    const sessions = JSON.parse(listed.out) as Array<{ id: string; title: string }>;
    expect(sessions.map((s) => [s.id, s.title])).toEqual([[id, 'My chat']]);
    expect((await snapshot(home, id)).session.permissionMode).toBe('full_access');
  });

  it('undo / redo、fork、compact、close', async () => {
    const { home, workspace } = await setup();
    const id = await sessionWithTurn(home, workspace);
    const undone = await run(['session', 'undo', id], { home });
    expect(undone.code, undone.err).toBe(0);
    expect(undone.out).toMatch(/已撤销回合 trn_\w+：/);
    expect((await run(['session', 'redo', id], { home })).out).toMatch(/已重做回合 trn_\w+：/);

    const forked = await run(['session', 'fork', id, '--json'], { home });
    expect(forked.code, forked.err).toBe(0);
    const branch = JSON.parse(forked.out) as { id: string };
    expect(branch.id).not.toBe(id);
    expect((await run(['session', 'list'], { home })).out).toContain(branch.id);

    const compact = await run(['session', 'compact', id], { home });
    expect(compact.code, compact.err).toBe(0);
    expect(compact.out).toMatch(/正在压缩上下文（回合 trn_\w+）/);
    await waitFor(async () => (await snapshot(home, id)).session.state === 'idle');
    expect((await run(['session', 'close', id], { home })).out).toContain(`已关闭：${id}`);
  });

  it('cancel：空闲时说明，运行中取消', async () => {
    // `slow`：回合要在 cancel 到达时还在运行。
    const { home, workspace } = await setup(20);
    const created = await run(
      ['session', 'new', '-w', workspace, '--detach', 'a slow answer that keeps going'],
      { home },
    );
    const id = /已创建会话 (ses_\w+)/.exec(created.out)?.[1] as string;
    const cancelled = await run(['session', 'cancel', id], { home });
    expect(cancelled.code, cancelled.err).toBe(0);
    expect(cancelled.out).toContain(`已请求取消：${id}`);
    await waitFor(async () => (await snapshot(home, id)).session.state === 'idle');
    const idle = await run(['session', 'cancel', id], { home });
    expect(idle.code).toBe(1);
    expect(idle.err).toContain('会话没有在运行');
  });

  it('archive、list --archived、unarchive、delete（前缀能找到已归档的会话）', async () => {
    const { home, workspace } = await setup();
    const id = await sessionWithTurn(home, workspace);
    expect((await run(['session', 'archive', id], { home })).out).toContain(`已归档：${id}`);
    expect((await run(['session', 'list'], { home })).out).toContain('暂无会话');
    expect((await run(['session', 'list', '--archived'], { home })).out).toContain(id);
    expect((await run(['session', 'unarchive', id.slice(0, 22)], { home })).out).toContain(
      `已取消归档：${id}`,
    );
    expect((await run(['session', 'list', '--archived'], { home })).out).toContain(
      '暂无已归档的会话',
    );
    await run(['session', 'archive', id], { home });
    const deleted = await run(['session', 'delete', id.slice(0, 22)], { home });
    expect(deleted.code, deleted.err).toBe(0);
    expect(deleted.out).toContain('已删除 1 个会话');
    const gone = await run(['session', 'show', id], { home });
    expect(gone.code).toBe(1);
  });

  it('session new 不带 -w：建在“对话”里；--permission 与 --effort', async () => {
    const { home } = await setup();
    const created = await run(
      [
        'session',
        'new',
        '--detach',
        '--permission',
        'auto_review',
        '--effort',
        'low',
        'just chatting',
      ],
      { home },
    );
    expect(created.code, created.err).toBe(0);
    const id = /已创建会话 (ses_\w+)/.exec(created.out)?.[1] as string;
    const { session } = await snapshot(home, id);
    expect(session.permissionMode).toBe('auto_review');
    expect(session.reasoningEffort).toBe('low');
    const worktree = await run(['session', 'new', '--worktree', 'x'], { home });
    expect(worktree.code).toBe(2);
    expect(worktree.err).toContain('--worktree 需要 -w <路径>');
  });
});
