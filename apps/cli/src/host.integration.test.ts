// T4.2：wevir host start | status | stop 的子进程形式。host start 以分离方式拉起真实的 wevir-host（dist/main.js，
// EchoAdapter），所以要先 pnpm build。CLI 本身在进程内运行。

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProcessAlive } from '@wevir/host/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { run, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const homes: string[] = [];
afterEach(async () => {
  // 用例中途失败时也不留下 Host 进程。
  for (const home of homes.splice(0)) {
    const path = join(home, 'run', 'host.json');
    if (!existsSync(path)) continue;
    const { pid } = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
    await run(['host', 'stop'], { home, env: process.env });
    if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
  }
});

function readPid(home: string): number {
  return (JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { pid: number }).pid;
}

describe('wevir host（分离启动的 Host 子进程）', () => {
  it('start → status → stop → start：Host 独立于 CLI 运行，重启后会话历史还在', async () => {
    const home = join(tempDir(), 'home');
    const workspace = join(tempDir(), 'project');
    mkdirSync(workspace);
    homes.push(home);
    const opts = { home, env: process.env };

    const started = await run(['host', 'start', '--adapter', 'echo'], opts);
    expect(started.code, started.err).toBe(0);
    expect(started.out).toMatch(/Host 已启动：pid \d+ · Host \S+ · 协议 \S+/);
    const pid = readPid(home);
    expect(started.out).toContain(`pid ${pid}`);
    if (process.platform !== 'win32') {
      // 自成进程组（detached），终端的 Ctrl-C 与关闭不会波及它。
      expect(() => process.kill(-pid, 0)).not.toThrow();
    }

    const again = await run(['host', 'start'], opts);
    expect(again.code).toBe(0);
    expect(again.out).toContain(`Host 已在运行：pid ${pid}`);
    const status = await run(['host', 'status'], opts);
    expect(status.code).toBe(0);
    expect(status.out).toContain('Host 运行中');
    expect(status.out).toMatch(/地址\s+ws:\/\/127\.0\.0\.1:\d+/);
    expect(status.out).not.toMatch(/token/i);

    expect(
      (
        await run(
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
            'm',
          ],
          { ...opts, input: 'k\n' },
        )
      ).code,
    ).toBe(0);
    const created = await run(['session', 'new', '-w', workspace, '--detach', 'hello'], opts);
    expect(created.code, created.err).toBe(0);
    const id = /已创建会话 (ses_\w+)/.exec(created.out)?.[1] as string;
    const watched = await run(['session', 'attach', id], opts);
    expect(watched.out).toContain('Echo: hello');

    const stopped = await run(['host', 'stop'], opts);
    expect(stopped.code, stopped.err).toBe(0);
    expect(stopped.out).toContain('Host 已停止。');
    expect(isProcessAlive(pid)).toBe(false);
    expect(existsSync(join(home, 'run', 'host.json'))).toBe(false);
    const down = await run(['host', 'status'], opts);
    expect(down.code).toBe(1);
    expect(down.out).toContain('Host 没有在运行');

    expect((await run(['host', 'start', '--adapter', 'echo'], opts)).code).toBe(0);
    const list = await run(['session', 'list'], opts);
    expect(list.out).toContain(id);
    const history = await run(['session', 'attach', id], opts);
    expect(history.out).toContain('› hello');
    expect(history.out).toContain('Echo: hello');
    expect((await run(['host', 'stop'], opts)).code).toBe(0);
  }, 60_000);

  it('Host 起不来时报告退出原因', async () => {
    const home = join(tempDir(), 'home');
    homes.push(home);
    const result = await run(['host', 'start', '--adapter', 'nope'], { home, env: process.env });
    expect(result.code).toBe(1);
    expect(result.err).toContain('Host 启动失败（退出码 2）');
    expect(result.err).toContain('--adapter 只能是 echo | dsh');
    expect(result.err).toContain('host-stdio.log');
  });
});
