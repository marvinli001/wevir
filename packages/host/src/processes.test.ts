// 后台进程（processes.ts）：用真实的 /bin/sh 跑小命令。Windows 上跳过（命令是 POSIX shell 写的）。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppToolError } from './app-mcp.js';
import {
  childEnv,
  completeUtf8,
  type ProcessManager as Manager,
  ProcessManager,
  type ProcessNotice,
  shellCommand,
  stripAnsi,
} from './processes.js';
import { useTempDir } from './test-utils.js';
import { ToolOutputStore } from './tool-output.js';

const tempDir = useTempDir();
const A = 'ses_A' as SessionId;
const B = 'ses_B' as SessionId;
const posix = process.platform !== 'win32';
const managers: Manager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});

function setup(env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SHELL: '/bin/sh' }) {
  const root = tempDir();
  const notices: ProcessNotice[] = [];
  const manager = new ProcessManager({
    output: new ToolOutputStore(join(root, 'tool-output')),
    onNotice: (notice) => notices.push(notice),
    env,
  });
  managers.push(manager);
  const never = new AbortController().signal;
  return { root, manager, notices, never };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.runIf(posix)('ProcessManager', () => {
  it('跑完一个命令：输出进日志，退出时通知（带最后几行），日志与偏移量读得到', async () => {
    const h = setup();
    const info = await h.manager.start(A, {
      command: 'echo first; printf "\\033[31mred\\033[0m\\n"; echo oops >&2; exit 3',
      cwd: h.root,
      name: 'demo',
    });
    expect(info).toMatchObject({ id: 'p1', name: 'demo', status: 'running' });
    expect(await h.manager.wait(A, 'p1', undefined, 5000, h.never)).toEqual({ reason: 'exit' });
    const done = h.manager.info(A, 'p1');
    expect(done).toMatchObject({ status: 'exited', exitCode: 3, signal: null, killed: false });
    // 等到的退出不再通知；再起一个不等的。
    expect(h.notices).toEqual([]);
    await h.manager.start(A, { command: 'echo bye; exit 1', cwd: h.root });
    await vi.waitFor(() => expect(h.notices).toHaveLength(1), { timeout: 5000 });
    expect(h.notices[0]).toMatchObject({
      event: 'exit',
      tail: 'bye',
      process: { id: 'p2', exitCode: 1 },
    });

    const read = await h.manager.read(A, 'p1');
    expect(read.text).toBe('first\nred\noops\n');
    expect(readFileSync(done.logPath, 'utf8')).toContain('\u001b[31mred');
    const since = await h.manager.read(A, 'p1', read.next - 5);
    expect(since.text).toBe('oops\n');
    expect(h.manager.tail(A, 'p1')).toBe('first\nred\noops');
  });

  it('notifyPattern 只通知一次；wait 的模式不算之前的输出；等到的匹配不另通知', async () => {
    const h = setup();
    await h.manager.start(A, {
      command: 'echo starting; sleep 0.2; echo ready at 1; echo ready at 2; sleep 30',
      cwd: h.root,
      notifyPattern: /ready/,
    });
    await vi.waitFor(() => expect(h.notices).toHaveLength(1), { timeout: 5000 });
    expect(h.notices[0]).toMatchObject({ event: 'match', line: 'ready at 1' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.notices).toHaveLength(1);

    await h.manager.start(A, {
      command: 'echo go; sleep 0.3; echo go again; sleep 30',
      cwd: h.root,
      notifyPattern: /again/,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const waited = await h.manager.wait(A, 'p2', /go/, 5000, h.never);
    expect(waited).toEqual({ reason: 'match', line: 'go again' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.notices).toHaveLength(1);
    expect(await h.manager.wait(A, 'p2', /never/, 50, h.never)).toEqual({ reason: 'timeout' });
    const aborted = new AbortController();
    const pending = h.manager.wait(A, 'p2', undefined, 5000, aborted.signal);
    aborted.abort();
    expect(await pending).toEqual({ reason: 'aborted' });
  });

  it('kill 结束整个进程组，agent 结束的不通知；SIGHUP 之类不算结束', async () => {
    const h = setup();
    const pidFile = join(h.root, 'child.pid');
    await h.manager.start(A, {
      command: `trap 'echo hup' HUP; sleep 30 & echo $! > ${pidFile}; while true; do sleep 0.1; done`,
      cwd: h.root,
    });
    await vi.waitFor(() => expect(readFileSync(pidFile, 'utf8').trim()).not.toBe(''), {
      timeout: 5000,
    });
    const child = Number(readFileSync(pidFile, 'utf8').trim());
    expect(alive(child)).toBe(true);
    h.manager.signal(A, 'p1', 'SIGHUP');
    await vi.waitFor(() => expect(h.manager.tail(A, 'p1')).toContain('hup'), { timeout: 5000 });
    expect(h.manager.info(A, 'p1').status).toBe('running');
    h.manager.signal(A, 'p1', 'SIGTERM');
    expect(await h.manager.wait(A, 'p1', undefined, 5000, h.never)).toEqual({ reason: 'exit' });
    expect(h.manager.info(A, 'p1')).toMatchObject({ status: 'exited', killed: true });
    await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 5000 });
    expect(h.notices).toEqual([]);
    expect(() => h.manager.signal(A, 'p1', 'SIGTERM')).toThrow(AppToolError);
  });

  it('stdin：写进去、关掉；不在跑的拒绝', async () => {
    const h = setup();
    await h.manager.start(A, { command: 'cat', cwd: h.root, notifyOnExit: false });
    h.manager.write(A, 'p1', 'hello\n', false);
    await vi.waitFor(() => expect(h.manager.tail(A, 'p1')).toBe('hello'), { timeout: 5000 });
    h.manager.write(A, 'p1', 'end', true);
    expect(await h.manager.wait(A, 'p1', undefined, 5000, h.never)).toEqual({ reason: 'exit' });
    expect(h.manager.tail(A, 'p1')).toBe('hello\nend');
    expect(() => h.manager.write(A, 'p1', 'x', false)).toThrow(AppToolError);
    expect(h.notices).toEqual([]);
  });

  it('会话之间看不到彼此的进程；删除会话结束它的进程，不通知', async () => {
    const h = setup();
    const started = await h.manager.start(A, { command: 'sleep 30', cwd: h.root });
    expect(() => h.manager.info(B, started.id)).toThrow(AppToolError);
    expect(h.manager.list(B)).toEqual([]);
    expect(h.manager.list(A)).toHaveLength(1);
    await h.manager.removeSessions([A]);
    expect(h.manager.list(A)).toEqual([]);
    expect(alive(started.pid as number)).toBe(false);
    expect(h.notices).toEqual([]);
  });

  it('环境去掉 WEVIR_* 与 ELECTRON_*，加 PYTHONUNBUFFERED；cwd 生效；启动失败报原因', async () => {
    const h = setup({
      PATH: process.env.PATH,
      SHELL: '/bin/sh',
      WEVIR_GATEWAY_TOKEN: 'secret',
      ELECTRON_RUN_AS_NODE: '1',
      KEEP: 'yes',
    });
    await h.manager.start(A, {
      command:
        'echo "$KEEP|$WEVIR_GATEWAY_TOKEN|$ELECTRON_RUN_AS_NODE|$PYTHONUNBUFFERED|$EXTRA"; pwd',
      cwd: h.root,
      env: { EXTRA: 'x' },
    });
    await h.manager.wait(A, 'p1', undefined, 5000, h.never);
    expect(h.manager.tail(A, 'p1')).toBe(`yes|||1|x\n${h.root}`);

    const failed = await h.manager.start(A, { command: 'true', cwd: join(h.root, 'missing') });
    await h.manager.wait(A, failed.id, undefined, 5000, h.never);
    expect(h.manager.info(A, failed.id)).toMatchObject({ status: 'exited' });
    expect(h.manager.info(A, failed.id).error).toMatch(/ENOENT/);
  });

  it('Host 退出时结束全部进程（不理 SIGTERM 的 3 秒后 SIGKILL），之后不能再起', async () => {
    const h = setup();
    const started = await h.manager.start(A, {
      command: "trap '' TERM; while true; do sleep 0.1; done",
      cwd: h.root,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const begun = Date.now();
    await h.manager.close();
    expect(Date.now() - begun).toBeGreaterThanOrEqual(2900);
    expect(alive(started.pid as number)).toBe(false);
    expect(h.notices).toEqual([]);
    await expect(h.manager.start(A, { command: 'true', cwd: h.root })).rejects.toThrow(
      AppToolError,
    );
  }, 10_000);

  it('同一会话在跑的进程有上限', async () => {
    const h = setup();
    for (let index = 0; index < 16; index += 1) {
      await h.manager.start(A, { command: 'sleep 30', cwd: h.root });
    }
    await expect(h.manager.start(A, { command: 'sleep 30', cwd: h.root })).rejects.toThrow(/limit/);
    // 别的会话不受影响。
    await h.manager.start(B, { command: 'true', cwd: h.root });
  });
});

describe('辅助函数', () => {
  it('shellCommand：POSIX 用 $SHELL -lc，没有时 /bin/sh；Windows 用 ComSpec', () => {
    expect(shellCommand('ls', 'darwin', { SHELL: '/bin/zsh' })).toEqual({
      file: '/bin/zsh',
      args: ['-lc', 'ls'],
    });
    expect(shellCommand('ls', 'linux', {})).toEqual({ file: '/bin/sh', args: ['-lc', 'ls'] });
    expect(shellCommand('ls', 'linux', { SHELL: 'zsh' }).file).toBe('/bin/sh');
    expect(shellCommand('dir', 'win32', { ComSpec: 'C:\\Windows\\cmd.exe' })).toEqual({
      file: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/s', '/c', '"dir"'],
    });
  });

  it('childEnv：Windows 上变量名不分大小写', () => {
    expect(childEnv({ Wevir_Home: 'x', Path: 'p' }, 'win32')).toEqual({
      Path: 'p',
      PYTHONUNBUFFERED: '1',
    });
  });

  it('stripAnsi 与 completeUtf8', () => {
    expect(stripAnsi('\u001b[1;32mok\u001b[0m \u001b]0;title\u0007done')).toBe('ok done');
    const buffer = Buffer.from('a文');
    expect(completeUtf8(buffer)).toBe(4);
    expect(completeUtf8(buffer.subarray(0, 3))).toBe(1);
    expect(completeUtf8(buffer.subarray(0, 2))).toBe(1);
    expect(completeUtf8(Buffer.from('abc'))).toBe(3);
  });
});

// 确认测试机上 /bin/sh 可用（runIf 只看平台）。
if (posix) execFileSync('/bin/sh', ['-c', 'true']);
