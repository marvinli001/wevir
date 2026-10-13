// DshProcess 的单元测试：dsh 换成 test-fixtures/fake-dsh.mjs 这个假引擎（真实子进程、真实信号）。
// 真实 dsh 的用例在 dsh-process.integration.test.ts。

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAdapterError } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DISPOSE_TIMEOUTS,
  type DshExit,
  DshProcess,
  type DshProcessEventMap,
  type DshProcessOptions,
  dshSpawnSpec,
} from './dsh-process.js';
import { dshPaths } from './paths.js';

const FAKE_DSH = fileURLToPath(new URL('./test-fixtures/fake-dsh.mjs', import.meta.url));
const posix = process.platform !== 'win32';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wevir-adapter-dsh-')));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FAST_DISPOSE = { stdinEofMs: 400, sigtermMs: 400, sigkillMs: 400 };

function fake(
  mode: string,
  options: Partial<DshProcessOptions> & { extraEnv?: Record<string, string> } = {},
): DshProcess {
  const { extraEnv, ...rest } = options;
  const dsh = new DshProcess({
    home: tempHome(),
    entry: FAKE_DSH,
    env: { FAKE_DSH_MODE: mode, ...extraEnv },
    disposeTimeouts: FAST_DISPOSE,
    ...rest,
  });
  cleanups.push(() => dsh.dispose());
  return dsh;
}

interface FakeRecord {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  initialize?: { clientCapabilities: unknown; clientInfo?: unknown; protocolVersion: number };
  grandchild?: number;
  permissionResponse?: unknown;
  stdinClosed?: boolean;
}

function record(dsh: DshProcess): FakeRecord {
  return JSON.parse(readFileSync(join(dsh.paths.dshHome, 'fake-dsh.json'), 'utf8'));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function nextEvent<K extends keyof DshProcessEventMap>(
  dsh: DshProcess,
  name: K,
): Promise<DshProcessEventMap[K][0]> {
  return new Promise((resolve) => {
    (dsh as DshProcess).once(name, ((payload: DshProcessEventMap[K][0]) =>
      resolve(payload)) as never);
  });
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('dshSpawnSpec', () => {
  const paths = dshPaths('/data');

  it('dsh --profile acp，--patch 按顺序；cwd 是 DSH_HOME；默认只有 3 个 stdio', () => {
    const spec = dshSpawnSpec({
      entry: '/x/dsh/lib/bin.js',
      paths,
      nodePath: '/usr/bin/node',
      patches: ['/data/a.yml', '/data/b.yml'],
      platform: 'darwin',
      parentEnv: {},
    });
    expect(spec.command).toBe('/usr/bin/node');
    expect(spec.args).toEqual([
      '/x/dsh/lib/bin.js',
      '--profile',
      'acp',
      '--patch',
      '/data/a.yml',
      '--patch',
      '/data/b.yml',
    ]);
    expect(spec.options).toMatchObject({
      cwd: paths.dshHome,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    });
  });

  it('streamFd 时多开 fd 3；Windows 上不分离进程组', () => {
    const spec = dshSpawnSpec({ entry: 'bin.js', paths, streamFd: true, platform: 'win32' });
    expect(spec.options.stdio).toEqual(['pipe', 'pipe', 'pipe', 'pipe']);
    expect(spec.options.env.WEVIR_STREAM_FD).toBe('3');
    expect(spec.options.detached).toBe(false);
  });
});

describe('DshProcess', () => {
  it('启动：参数、cwd、白名单环境与 initialize 都符合约定', async () => {
    const dsh = fake('normal', {
      patches: ['/tmp/provider.yml'],
      extraEnv: { WEVIR_PROVIDER_DEEPSEEK_KEY: 'sk-host' },
      parentEnv: {
        PATH: process.env.PATH,
        DEEPSEEK_API_KEY: 'sk-from-shell',
        ANTHROPIC_API_KEY: 'sk-from-shell',
        DSH_HOME: '/Users/dev/.dsh',
        // 漏进去的话假引擎会因为找不到这个文件而启动失败
        NODE_OPTIONS: '--require /nonexistent/wevir-hook.js',
      },
    });
    const ready = nextEvent(dsh, 'ready');
    const init = await dsh.start();
    expect(init.agentInfo?.name).toBe('fake-dsh');
    expect(dsh.state).toBe('ready');
    expect(await ready).toMatchObject({ generation: 1, pid: dsh.pid, restarted: false });
    expect(await dsh.start()).toBe(init);

    const r = record(dsh);
    expect(r.argv).toEqual(['--profile', 'acp', '--patch', '/tmp/provider.yml']);
    expect(r.cwd).toBe(dsh.paths.dshHome);
    expect(r.env).toMatchObject({
      DSH_HOME: dsh.paths.dshHome,
      DSH_AGENTS_HOME: dsh.paths.agentsHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      WEVIR_PROVIDER_DEEPSEEK_KEY: 'sk-host',
    });
    for (const name of [
      'DEEPSEEK_API_KEY',
      'ANTHROPIC_API_KEY',
      'NODE_OPTIONS',
      'WEVIR_STREAM_FD',
    ]) {
      expect(r.env).not.toHaveProperty(name);
    }
    // 不声明 fs 与 terminal（ADR-0001 §1）
    expect(r.initialize).toMatchObject({ protocolVersion: 1, clientCapabilities: {} });
  });

  it('onStreamData 给了才打开 fd 3，读到的字节原样交出', async () => {
    const chunks: Buffer[] = [];
    const dsh = fake('normal', { onStreamData: (chunk) => chunks.push(chunk) });
    await dsh.start();
    expect(record(dsh).env.WEVIR_STREAM_FD).toBe('3');
    await waitFor(() => (chunks.length > 0 ? true : undefined));
    expect(Buffer.concat(chunks).toString()).toBe('{"tap":1}\n');
  });

  it('session/update 交给 onSessionUpdate；没有审批处理器时回复 cancelled', async () => {
    const updates: unknown[] = [];
    const dsh = fake('ask-permission', { onSessionUpdate: (params) => void updates.push(params) });
    await dsh.start();
    await waitFor(() => record(dsh).permissionResponse);
    expect(record(dsh).permissionResponse).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(updates).toEqual([
      expect.objectContaining({
        sessionId: 'fake-session',
        update: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
      }),
    ]);
  });

  it('审批交给 onRequestPermission', async () => {
    const dsh = fake('ask-permission', {
      onRequestPermission: async (params) => ({
        outcome: { outcome: 'selected', optionId: params.options[0]?.optionId ?? '' },
      }),
    });
    await dsh.start();
    await waitFor(() => record(dsh).permissionResponse);
    expect(record(dsh).permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
  });

  describe('启动失败（不自动重试）', () => {
    it('initialize 超时：报 engine_unavailable，进程被回收', async () => {
      const dsh = fake('no-initialize', { initializeTimeoutMs: 200 });
      const error = await dsh.start().catch((e: unknown) => e);
      expect(isAdapterError(error, 'engine_unavailable')).toBe(true);
      expect(String((error as Error).message)).toMatch(/initialize 在 200 ms 内没有完成/);
      expect(dsh.state).toBe('stopped');
      const exit = dsh.lastExit as DshExit;
      expect(exit.pid).toBeDefined();
      expect(alive(exit.pid as number)).toBe(false);
    });

    it('进程启动即退出：错误里带退出码与 stderr 尾部', async () => {
      const dsh = fake('exit-on-start');
      const error = await dsh.start().catch((e: unknown) => e);
      expect(isAdapterError(error, 'engine_unavailable')).toBe(true);
      expect(String((error as Error).message)).toMatch(/退出码 7.*fake dsh: cannot start/s);
      expect(dsh.state).toBe('stopped');
      expect(dsh.stderrTail).toContain('fake dsh: cannot start');
    });

    it('协议版本不符', async () => {
      const dsh = fake('wrong-protocol');
      await expect(dsh.start()).rejects.toThrow(/协议版本是 99/);
    });

    it('Node 可执行文件不存在（spawn 失败）', async () => {
      const dsh = fake('normal', { nodePath: '/nonexistent/node' });
      const error = await dsh.start().catch((e: unknown) => e);
      expect(isAdapterError(error, 'engine_unavailable')).toBe(true);
      expect(String((error as Error).message)).toMatch(/ENOENT/);
    });

    it('失败后可以再 start', async () => {
      const dsh = fake('exit-on-start');
      await expect(dsh.start()).rejects.toThrow();
      await expect(dsh.start()).rejects.toThrow();
      expect(dsh.generation).toBe(2);
    });
  });

  describe('意外退出与自动重启', () => {
    it('就绪后退出：上报 exit（含 stderr 尾部），进行中的请求以 engine_unavailable 失败，然后重启', async () => {
      const dsh = fake('crash-once', { restart: { baseDelayMs: 50 } });
      const exitEvent = nextEvent(dsh, 'exit');
      const restarting = nextEvent(dsh, 'restarting');
      await dsh.start();
      const firstPid = dsh.pid;
      const pending = dsh.connection.agent.request('fake/never-answered', {});

      const exit = await exitEvent;
      expect(exit).toMatchObject({ generation: 1, pid: firstPid, exitCode: 3, signal: null });
      expect(exit.stderrTail).toContain('fake dsh: crashed');
      const error = await pending.catch((e: unknown) => e);
      expect(isAdapterError(error, 'engine_unavailable')).toBe(true);

      const ready = nextEvent(dsh, 'ready');
      expect(await restarting).toMatchObject({ attempt: 1, maxRestarts: 3, delayMs: 50 });
      expect(dsh.state).toBe('restarting');
      expect(() => dsh.connection).toThrow(/不可用/);
      expect(await ready).toMatchObject({ generation: 2, restarted: true });
      expect(dsh.state).toBe('ready');
      expect(dsh.pid).not.toBe(firstPid);
    });

    it('次数有限、指数退避；用完后停在 failed', async () => {
      const dsh = fake('crash-after-init', { restart: { maxRestarts: 2, baseDelayMs: 40 } });
      const delays: number[] = [];
      dsh.on('restarting', (event) => delays.push(event.delayMs));
      const failed = nextEvent(dsh, 'failed');
      await dsh.start();
      expect(await failed).toMatchObject({ restarts: 2 });
      expect(delays).toEqual([40, 80]);
      expect(dsh.state).toBe('failed');
      expect(() => dsh.connection).toThrow(/不可用/);
      expect(dsh.generation).toBe(3);
    });

    it('等待重启期间 dispose：不再重启', async () => {
      const dsh = fake('crash-after-init', { restart: { baseDelayMs: 300 } });
      const restarting = nextEvent(dsh, 'restarting');
      await dsh.start();
      await restarting;
      await dsh.dispose();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(dsh.state).toBe('disposed');
      expect(dsh.generation).toBe(1);
    });
  });

  describe('dispose 阶梯', () => {
    it('第一步关 stdin：dsh 读到 EOF 自行退出，不发 exit 事件', async () => {
      const dsh = fake('normal');
      let exits = 0;
      dsh.on('exit', () => exits++);
      await dsh.start();
      const pid = dsh.pid as number;
      const t0 = performance.now();
      await dsh.dispose();
      expect(performance.now() - t0).toBeLessThan(FAST_DISPOSE.stdinEofMs);
      expect(dsh.lastExit).toMatchObject({ pid, exitCode: 0, signal: null });
      expect(record(dsh).stdinClosed).toBe(true);
      expect(alive(pid)).toBe(false);
      expect(exits).toBe(0);
      expect(dsh.state).toBe('disposed');
    });

    it('不理会 EOF：SIGTERM', async () => {
      const dsh = fake('ignore-eof');
      await dsh.start();
      await dsh.dispose();
      expect(dsh.lastExit).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
    });

    it('连 SIGTERM 也不理会：SIGKILL；POSIX 上发给整个进程组，留在组里的子进程一起结束', async () => {
      const dsh = fake('ignore-sigterm', { extraEnv: { FAKE_DSH_GRANDCHILD: '1' } });
      await dsh.start();
      const grandchild = await waitFor(() => record(dsh).grandchild);
      expect(alive(grandchild)).toBe(true);
      await dsh.dispose();
      expect(dsh.lastExit).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
      if (posix) await waitFor(() => (alive(grandchild) ? undefined : true));
      else process.kill(grandchild, 'SIGKILL');
    });

    it('默认时限下最坏情况（只能 SIGKILL）也在 5 s 内返回', async () => {
      const dsh = fake('ignore-sigterm', { disposeTimeouts: DISPOSE_TIMEOUTS });
      await dsh.start();
      const t0 = performance.now();
      await dsh.dispose();
      const elapsed = performance.now() - t0;
      expect(dsh.lastExit?.signal).toBe('SIGKILL');
      expect(elapsed).toBeGreaterThanOrEqual(
        DISPOSE_TIMEOUTS.stdinEofMs + DISPOSE_TIMEOUTS.sigtermMs - 50,
      );
      expect(elapsed).toBeLessThan(5000);
    }, 10_000);

    it('幂等；之后 start 与 connection 报 disposed', async () => {
      const dsh = fake('normal');
      await dsh.start();
      await Promise.all([dsh.dispose(), dsh.dispose()]);
      await dsh.dispose();
      const error = await dsh.start().catch((e: unknown) => e);
      expect(isAdapterError(error, 'disposed')).toBe(true);
      expect(() => dsh.connection).toThrow(expect.objectContaining({ code: 'disposed' }));
    });

    it('启动途中 dispose：start 报 disposed，进程被回收', async () => {
      const dsh = fake('no-initialize');
      const starting = dsh.start().catch((e: unknown) => e);
      await waitFor(() =>
        existsSync(join(dsh.paths.dshHome, 'fake-dsh.json')) ? true : undefined,
      );
      await dsh.dispose();
      expect(isAdapterError(await starting, 'disposed')).toBe(true);
      expect(alive(dsh.lastExit?.pid as number)).toBe(false);
    });

    it('没启动过也可以 dispose', async () => {
      const dsh = fake('normal');
      await dsh.dispose();
      expect(dsh.state).toBe('disposed');
      expect(dsh.lastExit).toBeUndefined();
    });
  });
});
