// T5.1：桌面主进程的 Host 生命周期，对着真实的 wevir-host 子进程（dist/main.js，EchoAdapter），要先
// pnpm build。Electron 本身不参与：HostLifecycle 不依赖 Electron。

import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isProcessAlive } from '@wevir/host/runtime';
import { type ClientIdentity, PROTOCOL_VERSION } from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HostLifecycle,
  type HostLifecycleOptions,
  HostStartError,
  hostEnvironment,
  resolveHostEntry,
  resolveNodeExecutable,
} from './host-lifecycle.js';

const identity: ClientIdentity = {
  clientKind: 'desktop',
  deviceId: 'dev-test',
  clientId: 'desktop-test',
};
const hostEntry = resolveHostEntry();
const stubbornHost = fileURLToPath(new URL('./test-fixtures/stubborn-host.mjs', import.meta.url));

let tempDir: string;
const lifecycles: HostLifecycle[] = [];
const pids: number[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wevir-desktop-'));
});
afterEach(async () => {
  for (const lifecycle of lifecycles.splice(0)) await lifecycle.stop();
  // 用例中途失败时也不留下 Host 进程。
  for (const pid of pids.splice(0)) if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
  rmSync(tempDir, { recursive: true, force: true });
});

function runtimeFile(home: string): string {
  return join(home, 'run', 'host.json');
}

function readRuntime(home: string): { pid: number; startedAt: string; url?: string } {
  return JSON.parse(readFileSync(runtimeFile(home), 'utf8'));
}

function lifecycle(home: string, options: Partial<HostLifecycleOptions> = {}) {
  const logs: Array<{ level: string; message: string }> = [];
  const result = new HostLifecycle({
    home,
    identity,
    nodePath: process.execPath,
    hostEntry,
    hostArgs: ['--adapter', 'echo'],
    log: (level, message) => logs.push({ level, message }),
    ...options,
  });
  lifecycles.push(result);
  return { lifecycle: result, logs };
}

/** 像 `wevir host start` 那样分离启动一个不带归属管道的 Host，等它写出地址。 */
async function startDetachedHost(home: string): Promise<number> {
  const child = spawn(process.execPath, [hostEntry, '--home', home, '--adapter', 'echo'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, WEVIR_HOME: home },
  });
  child.unref();
  const pid = child.pid as number;
  pids.push(pid);
  await until(() => existsSync(runtimeFile(home)) && readRuntime(home).url !== undefined);
  return pid;
}

async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(25);
  }
}

async function exited(pid: number, timeoutMs = 15_000): Promise<void> {
  await until(() => !isProcessAlive(pid), timeoutMs);
}

describe('HostLifecycle', () => {
  it('没有 Host：拉起并拥有它；stop 关闭归属管道，Host 自己优雅退出并删除 host.json', async () => {
    const home = join(tempDir, 'home');
    const { lifecycle: host, logs } = lifecycle(home);

    const ready = await host.start();
    expect(ready.ownership.kind).toBe('owned');
    const runtime = readRuntime(home);
    expect(ready.ownership).toEqual({
      kind: 'owned',
      pid: runtime.pid,
      startedAt: runtime.startedAt,
    });
    expect(ready.hello.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(await host.start()).toBe(ready);
    const endpoint = await host.endpoint();
    expect(endpoint.url).toBe(runtime.url);
    expect(endpoint.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    pids.push(runtime.pid);

    await host.stop();
    expect(isProcessAlive(runtime.pid)).toBe(false);
    expect(existsSync(runtimeFile(home))).toBe(false);
    // 关管道就够了，没有走到 host.shutdown。
    expect(logs.map((l) => l.message)).not.toContain(
      'host did not exit after the pipe closed; requesting host.shutdown',
    );
  });

  it('拉起方被强制杀掉：归属管道由操作系统关闭，Host 读到 EOF 自行退出', async () => {
    const home = join(tempDir, 'home');
    // 中间进程照 HostLifecycle 的方式拉起 Host（stdin 是管道、带 --exit-on-stdin-eof），然后被 SIGKILL。
    const launcher = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, process.argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    `;
    const parent: ChildProcess = spawn(
      process.execPath,
      ['-e', launcher, hostEntry, '--home', home, '--adapter', 'echo', '--exit-on-stdin-eof'],
      { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, WEVIR_HOME: home } },
    );
    pids.push(parent.pid as number);
    let output = '';
    parent.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    await until(() => output.includes('"event":"ready"'));
    const hostPid = readRuntime(home).pid;
    pids.push(hostPid);
    expect(hostPid).not.toBe(parent.pid);

    parent.kill('SIGKILL');
    await exited(hostPid);
    expect(existsSync(runtimeFile(home))).toBe(false);
  });

  it('已有 Host（分离启动、没有归属管道）：附着；stop 不停它', async () => {
    const home = join(tempDir, 'home');
    const existing = await startDetachedHost(home);
    const { lifecycle: host } = lifecycle(home);

    const ready = await host.start();
    expect(ready.ownership).toMatchObject({ kind: 'attached', pid: existing });
    await host.stop();
    expect(isProcessAlive(existing)).toBe(true);
    expect(readRuntime(home).pid).toBe(existing);

    process.kill(existing, 'SIGTERM');
    await exited(existing);
  });

  it('拉起的 Host 以退出码 3 结束（别的 Host 先占住了数据目录）：等它就绪后附着', async () => {
    const home = join(tempDir, 'home');
    // 占位：一个活着的进程（本测试进程）正在启动 Host，还没有地址。
    const placeholder = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      protocolVersion: PROTOCOL_VERSION,
      hostVersion: '0.0.0',
    };
    const otherHome = join(tempDir, 'other');
    await startDetachedHost(otherHome);
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(runtimeFile(home), JSON.stringify(placeholder));

    const { lifecycle: host, logs } = lifecycle(home);
    const ready = host.start();
    await until(() =>
      logs.some((l) => l.message === 'another host owns the data directory; waiting to attach'),
    );
    // “别的 Host”就绪：写出完整的 host.json（借另一个数据目录里真实 Host 的地址与令牌）。
    const { url, token } = JSON.parse(readFileSync(runtimeFile(otherHome), 'utf8'));
    writeFileSync(runtimeFile(home), JSON.stringify({ ...placeholder, url, token }));

    expect((await ready).ownership).toEqual({
      kind: 'attached',
      pid: process.pid,
      startedAt: placeholder.startedAt,
    });
    await host.stop();
    expect(existsSync(runtimeFile(home))).toBe(true);
  });

  it('拉起的 Host 启动失败：带上它的 stderr', async () => {
    const home = join(tempDir, 'home');
    const { lifecycle: host } = lifecycle(home, { hostArgs: ['--adapter', 'bogus'] });
    const error = await host.start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostStartError);
    expect((error as Error).message).toMatch(/^Host 启动失败（退出码 2）：wevir-host: --adapter/);
    // 只尝试一次。
    expect(await host.start().catch((e: unknown) => e)).toBe(error);
    await expect(host.endpoint()).rejects.toBe(error);
  });

  it('Node 可执行文件不存在：报出路径', async () => {
    const home = join(tempDir, 'home');
    const { lifecycle: host } = lifecycle(home, { nodePath: join(tempDir, 'no-such-node') });
    await expect(host.start()).rejects.toThrow(/无法启动 .*no-such-node/);
  });

  it('关闭归属管道后 Host 不退出：确认 host.json 仍是它，再发 host.shutdown', async () => {
    const home = join(tempDir, 'home');
    const { lifecycle: host, logs } = lifecycle(home, {
      hostEntry: stubbornHost,
      hostArgs: [],
      timeouts: { pipeCloseMs: 300, shutdownMs: 10_000 },
    });
    const ready = await host.start();
    expect(ready.ownership.kind).toBe('owned');
    pids.push(ready.ownership.pid);

    await host.stop();
    expect(logs.map((l) => l.message)).toContain(
      'host did not exit after the pipe closed; requesting host.shutdown',
    );
    expect(isProcessAlive(ready.ownership.pid)).toBe(false);
    expect(existsSync(runtimeFile(home))).toBe(false);
  });

  it('host.shutdown 之后仍不退出：强制结束', async () => {
    const home = join(tempDir, 'home');
    const { lifecycle: host, logs } = lifecycle(home, {
      hostEntry: stubbornHost,
      hostArgs: ['--ignore-shutdown'],
      timeouts: { pipeCloseMs: 200, shutdownMs: 300 },
    });
    const ready = await host.start();
    pids.push(ready.ownership.pid);

    await host.stop();
    expect(logs.map((l) => l.message)).toContain(
      'host did not exit after host.shutdown; killing it',
    );
    expect(isProcessAlive(ready.ownership.pid)).toBe(false);
  });

  it('Host 的环境里 WEVIR_HOME 就是数据目录：继承来的 WEVIR_HOME 不会让它用到别的目录', async () => {
    const home = join(tempDir, 'home');
    const elsewhere = join(tempDir, 'elsewhere');
    const { lifecycle: host } = lifecycle(home, {
      env: { ...hostEnvironment(process.env), WEVIR_HOME: elsewhere },
    });
    const ready = await host.start();
    pids.push(ready.ownership.pid);
    expect(readRuntime(home).pid).toBe(ready.ownership.pid);
    expect(existsSync(elsewhere)).toBe(false);
  });
});

describe('hostEnvironment', () => {
  it('去掉 Electron 与 electron-vite 的变量，其余照传', () => {
    expect(
      hostEnvironment({
        PATH: '/bin',
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_RENDERER_URL: 'http://localhost:5199',
        NODE_ENV_ELECTRON_VITE: 'development',
        WEVIR_HOME: '/data',
      }),
    ).toEqual({ PATH: '/bin', WEVIR_HOME: '/data' });
  });
});

describe('resolveNodeExecutable', () => {
  it('WEVIR_NODE 优先；否则在 PATH 里找可执行的 node', () => {
    expect(resolveNodeExecutable({ WEVIR_NODE: '/opt/node/bin/node', PATH: '' })).toBe(
      '/opt/node/bin/node',
    );
    if (process.platform !== 'win32') {
      const bin = join(tempDir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'node'), '');
      // 没有执行权限的不算。
      expect(() => resolveNodeExecutable({ PATH: bin }, 'linux')).toThrow(HostStartError);
      chmodSync(join(bin, 'node'), 0o755);
      expect(resolveNodeExecutable({ PATH: `/nonexistent:${bin}` }, 'linux')).toBe(
        join(bin, 'node'),
      );
    }
    expect(() => resolveNodeExecutable({ PATH: '' })).toThrow(/WEVIR_NODE/);
  });
});
