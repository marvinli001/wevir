// 后台进程（processes.ts）：用真实的 /bin/sh 跑小命令。Windows 上跳过（命令是 POSIX shell 写的）。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, TurnId } from '@wevir/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppToolError } from './app-mcp.js';
import {
  childEnv,
  completeUtf8,
  type ProcessManager as Manager,
  type ProcessChange,
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

function setup(
  env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SHELL: '/bin/sh' },
  extra: { logRotateBytes?: number; notifyBatchMs?: number; notifyIntervalMs?: number } = {},
) {
  const root = tempDir();
  const notices: ProcessNotice[] = [];
  const manager = new ProcessManager({
    output: new ToolOutputStore(join(root, 'tool-output')),
    onNotice: (notice) => notices.push(notice),
    env,
    ...extra,
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

  it('日志换过几次文件之后，从偏移量读到的结尾还是真正的结尾', async () => {
    const h = setup(undefined, { logRotateBytes: 256 * 1024 });
    // 突发写 900 KB（超过一次换文件），中间不给换文件的间隙留喘息。
    await h.manager.start(A, {
      command: 'yes 0123456789abcdef0123456789abcdef | head -c 900000; echo; echo FINISHED-BIG',
      cwd: h.root,
      notifyOnExit: false,
    });
    expect(await h.manager.wait(A, 'p1', undefined, 10_000, h.never)).toEqual({ reason: 'exit' });
    const info = h.manager.info(A, 'p1');
    // 换文件是异步的：read 等它做完。
    await h.manager.read(A, 'p1');
    const rotated = readFileSync(`${info.logPath}.1`).length;
    const current = readFileSync(info.logPath).length;
    // 只留一份旧的：最早的一次换出去的被盖掉，所以只能核对“当前的 + 上一份”不比总数多、且当前的连着上一份。
    expect(current).toBeLessThanOrEqual(info.bytes);
    expect(rotated + current).toBeLessThanOrEqual(info.bytes);
    const read = await h.manager.read(A, 'p1', Math.max(0, info.bytes - 64 * 1024));
    expect(read.text.trimEnd().endsWith('FINISHED-BIG')).toBe(true);
    expect(read.next).toBe(info.bytes);
  });

  it('换文件的间隙里攒下的输出不算进新文件的大小：之后写一行不会再换一次文件，结尾留在当前文件里', async () => {
    const h = setup(undefined, { logRotateBytes: 1024 });
    // 先突发写一批（头一次换文件时后面的块攒在 held 里，远超 1 KB），停一下，再写最后一行。
    await h.manager.start(A, {
      command: 'head -c 200000 /dev/zero | tr "\\0" x; echo; sleep 0.3; echo FINISHED-BIG',
      cwd: h.root,
      notifyOnExit: false,
    });
    expect(await h.manager.wait(A, 'p1', undefined, 10_000, h.never)).toEqual({ reason: 'exit' });
    const info = h.manager.info(A, 'p1');
    const read = await h.manager.read(A, 'p1', 0);
    expect(read.text.trimEnd().endsWith('FINISHED-BIG')).toBe(true);
    expect(read.next).toBe(info.bytes);
  });

  it('日志只换一次时 .1 加当前的正好等于写过的总数', async () => {
    const h = setup(undefined, { logRotateBytes: 600 * 1024 });
    await h.manager.start(A, {
      command: 'yes 0123456789abcdef0123456789abcdef | head -c 900000; echo; echo FINISHED-BIG',
      cwd: h.root,
      notifyOnExit: false,
    });
    expect(await h.manager.wait(A, 'p1', undefined, 10_000, h.never)).toEqual({ reason: 'exit' });
    const info = h.manager.info(A, 'p1');
    await h.manager.read(A, 'p1');
    expect(readFileSync(`${info.logPath}.1`).length + readFileSync(info.logPath).length).toBe(
      info.bytes,
    );
  });

  it('notifyPattern 把一阵匹配合成一条通知；wait 的模式不算之前的输出；等到的匹配不另通知', async () => {
    const h = setup(undefined, { notifyBatchMs: 100 });
    await h.manager.start(A, {
      command: 'echo starting; sleep 0.2; echo ready at 1; echo ready at 2; sleep 30',
      cwd: h.root,
      notifyPattern: /ready/,
    });
    await vi.waitFor(() => expect(h.notices).toHaveLength(1), { timeout: 5000 });
    expect(h.notices[0]).toMatchObject({
      event: 'match',
      matches: { lines: ['ready at 1', 'ready at 2'], count: 2, remaining: 9 },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
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

  it('notifyPattern 的通知之间隔开 notifyIntervalMs，发满 notifyLimit 条就停', async () => {
    const h = setup();
    const at: number[] = [];
    const manager = new ProcessManager({
      output: new ToolOutputStore(join(h.root, 'tool-output-2')),
      onNotice: (notice) => {
        at.push(Date.now());
        h.notices.push(notice);
      },
      env: { PATH: process.env.PATH, SHELL: '/bin/sh' },
      notifyBatchMs: 20,
      notifyIntervalMs: 400,
    });
    managers.push(manager);
    await manager.start(A, {
      command: 'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo tick $i; sleep 0.1; done; sleep 30',
      cwd: h.root,
      notifyPattern: /tick/,
      notifyLimit: 2,
    });
    await vi.waitFor(() => expect(h.notices).toHaveLength(2), { timeout: 5000 });
    expect(h.notices[0]?.matches).toMatchObject({ lines: ['tick 1'], count: 1, remaining: 1 });
    expect(h.notices[1]?.matches?.lines[0]).toBe('tick 2');
    expect(h.notices[1]?.matches?.count).toBeGreaterThan(1);
    expect(h.notices[1]?.matches?.remaining).toBe(0);
    expect((at[1] as number) - (at[0] as number)).toBeGreaterThanOrEqual(390);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(h.notices).toHaveLength(2);
  });

  it('不带换行的提示匹配时通知一次，补齐成一行时不再算', async () => {
    const h = setup(undefined, { notifyBatchMs: 20, notifyIntervalMs: 50 });
    await h.manager.start(A, {
      command:
        'printf "Pass"; sleep 0.2; printf "word: "; sleep 0.3; echo; sleep 0.3; echo "Password ok"; sleep 30',
      cwd: h.root,
      notifyPattern: /Password/,
    });
    await vi.waitFor(() => expect(h.notices).toHaveLength(2), { timeout: 5000 });
    expect(h.notices.map((notice) => notice.matches?.lines)).toEqual([
      ['Password: '],
      ['Password ok'],
    ]);
  });

  it('退出时还攒着的匹配并进退出通知；不通知退出时单发；被停的不发', async () => {
    const h = setup(undefined, { notifyBatchMs: 5000 });
    await h.manager.start(A, {
      command: 'echo FAIL a; exit 1',
      cwd: h.root,
      notifyPattern: /FAIL/,
    });
    await vi.waitFor(() => expect(h.notices).toHaveLength(1), { timeout: 5000 });
    expect(h.notices[0]).toMatchObject({
      event: 'exit',
      matches: { lines: ['FAIL a'], count: 1 },
      process: { exitCode: 1 },
    });
    expect(h.notices[0]?.matches?.remaining).toBeUndefined();

    await h.manager.start(A, {
      command: 'echo FAIL b; exit 0',
      cwd: h.root,
      notifyPattern: /FAIL/,
      notifyOnExit: false,
    });
    await vi.waitFor(() => expect(h.notices).toHaveLength(2), { timeout: 5000 });
    expect(h.notices[1]).toMatchObject({ event: 'match', matches: { lines: ['FAIL b'] } });

    await h.manager.start(A, {
      command: 'echo FAIL c; sleep 30',
      cwd: h.root,
      notifyPattern: /FAIL/,
    });
    await vi.waitFor(() => expect(h.manager.tail(A, 'p3')).toBe('FAIL c'), { timeout: 5000 });
    h.manager.signal(A, 'p3', 'SIGTERM');
    expect(await h.manager.wait(A, 'p3', undefined, 5000, h.never)).toEqual({ reason: 'exit' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.notices).toHaveLength(2);
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

  it('onChange：起来、输出变多（节流）、被停与忘掉都报；ID 前缀与留存上限可配，忘掉时可连日志一起删', async () => {
    const root = tempDir();
    const changes: ProcessChange[] = [];
    const manager = new ProcessManager({
      output: new ToolOutputStore(join(root, 'tool-output')),
      onNotice: () => {},
      env: { PATH: process.env.PATH, SHELL: '/bin/sh' },
      idPrefix: 'v',
      maxKept: 1,
      deleteLogsOnForget: true,
      onChange: (change) => changes.push(change),
    });
    managers.push(manager);
    const never = new AbortController().signal;
    const first = await manager.start(A, {
      command: 'i=0; while [ $i -lt 5 ]; do echo $i; i=$((i+1)); sleep 0.1; done; sleep 30',
      cwd: root,
      turnId: 'trn_1' as TurnId,
    });
    expect(first).toMatchObject({ id: 'v1', turnId: 'trn_1' });
    expect(manager.find('v1')?.id).toBe('v1');
    expect(manager.listAll().map((info) => info.id)).toEqual(['v1']);
    await vi.waitFor(() => expect(manager.find('v1')?.bytes).toBe(10), { timeout: 5000 });
    await vi.waitFor(
      () => expect(changes.some((c) => 'process' in c && c.process.bytes === 10)).toBe(true),
      { timeout: 5000 },
    );
    // 一秒里五行输出最多报三次左右（每 500 ms 一次），不是每行一次。
    const growing = changes.filter((c) => 'process' in c && c.process.status === 'running');
    expect(growing.length).toBeLessThanOrEqual(5);
    manager.signal(A, 'v1', 'SIGTERM', 'user');
    await manager.wait(A, 'v1', undefined, 5000, never);
    await vi.waitFor(() =>
      expect(changes.at(-1)).toMatchObject({
        process: { id: 'v1', status: 'exited', killed: true, stoppedBy: 'user' },
      }),
    );
    // 第二个进程起来时第一个（已退出）被忘掉，日志一起删。
    await manager.start(A, { command: 'true', cwd: root });
    expect(changes.find((c) => 'removed' in c)).toMatchObject({ removed: { id: 'v1' } });
    expect(manager.find('v1')).toBeUndefined();
    await vi.waitFor(() => expect(existsSync(first.logPath)).toBe(false));
  });

  it('read 的 until 与对齐：往前翻页读到 until 为止，起点落在半个字符上时往后挪', async () => {
    const h = setup();
    await h.manager.start(A, { command: "printf 'ab中cd'", cwd: h.root });
    await h.manager.wait(A, 'p1', undefined, 5000, h.never);
    expect(await h.manager.read(A, 'p1', 0, 2)).toMatchObject({ text: 'ab', next: 2, more: false });
    expect(await h.manager.read(A, 'p1', 3)).toMatchObject({ text: 'cd', from: 5, next: 7 });
    expect(await h.manager.read(A, 'p1', 2, 5)).toMatchObject({ text: '中', more: false });
    expect(await h.manager.read(A, 'p1', 9)).toMatchObject({ text: '', next: 7, start: 0 });
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
