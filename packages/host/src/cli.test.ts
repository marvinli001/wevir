// T2.5：wevir-host 的参数解析与主流程。runHostCli 在进程内运行，信号、stdin 与 stdout 换成假的；
// 真正的子进程（SIGKILL 后重启等）见 scripts/gate-m2.ts，--adapter dsh 接真实 dsh 见 cli.dsh.integration.test.ts。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DshAdapter } from '@wevir/adapter-dsh';
import { CloseCode } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { describe, expect, it, vi } from 'vitest';
import {
  type AdapterKind,
  createAdapter,
  EXIT_CODE,
  type HostCliOverrides,
  parseHostArgs,
  runHostCli,
  USAGE,
} from './cli.js';
import { HOST_VERSION } from './host-process.js';
import { createLogger, LOG_FILE } from './logger.js';
import type { HostRuntimeInfo } from './runtime-file.js';
import { fakeProcess, TestRpcClient, useTempDir, waitReady } from './test-utils.js';

const tempDir = useTempDir();

describe('parseHostArgs', () => {
  it('默认值：dsh 适配器、系统分配端口、info 级别、不监听 stdin', () => {
    expect(parseHostArgs([])).toEqual({
      kind: 'run',
      options: { adapter: 'dsh', port: 0, logLevel: 'info', exitOnStdinEof: false },
    });
  });

  it('全部参数', () => {
    expect(
      parseHostArgs([
        '--home',
        './.wevir-dev',
        '--adapter',
        'echo',
        '--port',
        '7777',
        '--log-level',
        'debug',
        '--exit-on-stdin-eof',
      ]),
    ).toEqual({
      kind: 'run',
      options: {
        home: './.wevir-dev',
        adapter: 'echo',
        port: 7777,
        logLevel: 'debug',
        exitOnStdinEof: true,
      },
    });
    expect(parseHostArgs(['--home=/data', '--adapter=echo'])).toMatchObject({
      options: { home: '/data', adapter: 'echo' },
    });
  });

  it('帮助与版本', () => {
    expect(parseHostArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseHostArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseHostArgs(['-v'])).toEqual({ kind: 'version' });
  });

  it('参数错误', () => {
    for (const argv of [
      ['--bogus'],
      ['positional'],
      ['--adapter', 'acp'],
      ['--port', '-1'],
      ['--port', '1.5'],
      ['--port', '70000'],
      ['--log-level', 'trace'],
      ['--home', ''],
      ['--home'],
    ]) {
      expect(parseHostArgs(argv), argv.join(' ')).toMatchObject({ kind: 'error' });
    }
  });
});

// ── 进程内运行 runHostCli ──────────────────────────────────────────────

function runtimeInfo(home: string): HostRuntimeInfo {
  return JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as HostRuntimeInfo;
}

function logLines(home: string): Array<Record<string, unknown>> {
  return readFileSync(join(home, 'logs', LOG_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 启动一个 echo Host，等它就绪。 */
async function launch(extra: string[] = [], overrides: HostCliOverrides = {}, env = {}) {
  const home = join(tempDir(), 'home');
  const fake = fakeProcess(['--home', home, '--adapter', 'echo', ...extra], env);
  const exit = runHostCli(fake.proc, {
    createAdapter: () => new EchoAdapter({ stepDelayMs: 1 }),
    ...overrides,
  });
  const ready = await waitReady(fake.out);
  return { ...fake, home, exit, ready };
}

describe('runHostCli', () => {
  it('--help、--version 写到 stdout，退出码 0；参数错误退出码 2', async () => {
    const help = fakeProcess(['--help']);
    expect(await runHostCli(help.proc)).toBe(EXIT_CODE.ok);
    expect(help.out.stdout).toBe(`${USAGE}\n`);
    const version = fakeProcess(['--version']);
    expect(await runHostCli(version.proc)).toBe(EXIT_CODE.ok);
    expect(version.out.stdout).toBe(`${HOST_VERSION}\n`);
    const bad = fakeProcess(['--port', 'x']);
    expect(await runHostCli(bad.proc)).toBe(EXIT_CODE.usage);
    expect(bad.out.stderr).toContain('--port');
  });

  it('--adapter dsh：DshAdapter 用数据目录下的 engines/，dsh 进程等到第一个会话才启动', () => {
    const home = join(tempDir(), 'home');
    const adapter = createAdapter('dsh', { home, logger: createLogger({ mirror: () => {} }) });
    expect(adapter).toBeInstanceOf(DshAdapter);
    const { process: dsh } = adapter as DshAdapter;
    expect(dsh.paths.dshHome).toBe(join(home, 'engines', 'dsh'));
    expect(dsh.state).toBe('stopped');
    expect(existsSync(home)).toBe(false);
    // 真实 dsh 上的端到端见 cli.dsh.integration.test.ts。
  });

  it('适配器建不起来（例如 dsh 的依赖没装好）：报错并以 1 退出，日志里有原因', async () => {
    const home = join(tempDir(), 'home');
    const fake = fakeProcess(['--home', home, '--adapter', 'dsh']);
    const code = await runHostCli(fake.proc, {
      createAdapter: () => {
        throw new Error('找不到 @deepseek-ai/dsh');
      },
    });
    expect(code).toBe(EXIT_CODE.failure);
    expect(fake.out.stderr).toContain('无法创建 dsh 适配器：找不到 @deepseek-ai/dsh');
    expect(logLines(home).find((l) => l.msg === 'failed to create adapter')).toMatchObject({
      adapter: 'dsh',
    });
    expect(existsSync(join(home, 'run', 'host.json'))).toBe(false);
  });

  it('SIGTERM 优雅退出：退出码 0、删除 host.json；日志是 JSON 行且不含令牌，就绪行也不含令牌', async () => {
    const { home, exit, ready, emit, out } = await launch();
    const info = runtimeInfo(home);
    expect(ready).toEqual({
      event: 'ready',
      pid: process.pid,
      url: info.url,
      hostId: expect.stringMatching(/^hst_/),
      home,
    });
    const client = await TestRpcClient.connect(ready.url);
    expect((await client.hello(info.token as string)).error).toBeUndefined();

    emit('SIGTERM', 'SIGTERM');
    expect(await exit).toBe(EXIT_CODE.ok);
    expect((await client.closed).code).toBe(CloseCode.GOING_AWAY);
    expect(existsSync(join(home, 'run', 'host.json'))).toBe(false);

    const lines = logLines(home);
    expect(lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining(['starting', 'host ready', 'shutting down', 'host stopped']),
    );
    expect(lines.find((l) => l.msg === 'shutting down')?.trigger).toEqual({
      kind: 'signal',
      signal: 'SIGTERM',
    });
    const text = readFileSync(join(home, 'logs', LOG_FILE), 'utf8');
    expect(text).not.toContain(info.token);
    expect(out.stdout).not.toContain(info.token);
  });

  it('WEVIR_HOME 优先于 --home；SIGINT 同样优雅退出', async () => {
    const envHome = join(tempDir(), 'env-home');
    const { exit, ready, emit, home } = await launch([], {}, { WEVIR_HOME: envHome });
    expect(ready.home).toBe(envHome);
    expect(existsSync(join(envHome, 'run', 'host.json'))).toBe(true);
    expect(existsSync(home)).toBe(false);
    emit('SIGINT', 'SIGINT');
    expect(await exit).toBe(EXIT_CODE.ok);
    expect(existsSync(join(envHome, 'run', 'host.json'))).toBe(false);
  });

  it('--exit-on-stdin-eof：stdin 读到 EOF 即优雅退出；不带这个参数时 stdin 结束不影响 Host', async () => {
    const plain = await launch();
    plain.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(join(plain.home, 'run', 'host.json'))).toBe(true);
    plain.emit('SIGTERM', 'SIGTERM');
    expect(await plain.exit).toBe(EXIT_CODE.ok);

    const owned = await launch(['--exit-on-stdin-eof']);
    owned.stdin.write('ignored\n');
    owned.stdin.end();
    expect(await owned.exit).toBe(EXIT_CODE.ok);
    expect(existsSync(join(owned.home, 'run', 'host.json'))).toBe(false);
    const trigger = logLines(owned.home)
      .filter((l) => l.msg === 'shutting down')
      .at(-1)?.trigger;
    expect(trigger).toEqual({ kind: 'stdin_eof' });
  });

  it('host.shutdown 经 RPC 触发优雅退出，退出码 0', async () => {
    const { exit, ready, home } = await launch();
    const client = await TestRpcClient.connect(ready.url);
    await client.hello(runtimeInfo(home).token as string);
    expect(await client.request('host.shutdown')).toEqual({});
    expect(await exit).toBe(EXIT_CODE.ok);
    expect(existsSync(join(home, 'run', 'host.json'))).toBe(false);
  });

  it('同一数据目录已有活着的 Host：提示附着，退出码 3', async () => {
    const home = join(tempDir(), 'home');
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(
      join(home, 'run', 'host.json'),
      JSON.stringify({
        pid: process.ppid,
        startedAt: new Date().toISOString(),
        protocolVersion: '0.1.0',
        hostVersion: HOST_VERSION,
      }),
    );
    const fake = fakeProcess(['--home', home, '--adapter', 'echo']);
    expect(await runHostCli(fake.proc)).toBe(EXIT_CODE.alreadyRunning);
    expect(fake.out.stderr).toContain('已有 Host 在运行');
    expect(fake.out.stderr).toContain(`pid ${process.ppid}`);
  });

  it('退出超时或退出期间再收到信号：删除自己的 host.json，以 1 强制结束', async () => {
    const releases: Array<() => void> = [];
    // dispose 卡住，退出流程停在 dispose_adapter。
    class StuckAdapter extends EchoAdapter {
      override dispose(): Promise<void> {
        return new Promise<void>((resolve) => releases.push(() => resolve(super.dispose())));
      }
    }
    const createAdapter = (_kind: AdapterKind) => new StuckAdapter({ stepDelayMs: 1 });

    const timedOut = await launch([], { createAdapter, shutdownTimeoutMs: 100 });
    timedOut.emit('SIGTERM', 'SIGTERM');
    expect(await timedOut.exit).toBe(EXIT_CODE.failure);
    expect(existsSync(join(timedOut.home, 'run', 'host.json'))).toBe(false);
    expect(logLines(timedOut.home).find((l) => l.msg === 'forced exit')?.reason).toBe(
      'shutdown did not finish within 100 ms',
    );
    // 放行卡住的 dispose，让这个 Host 把数据库关掉（真实进程里 exit 已经结束了一切）。
    releases.shift()?.();
    await vi.waitFor(() => expect(existsSync(join(timedOut.home, 'wevir.db-wal'))).toBe(false));

    const signalled = await launch([], { createAdapter, shutdownTimeoutMs: 60_000 });
    signalled.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    signalled.emit('SIGINT', 'SIGINT');
    expect(await signalled.exit).toBe(EXIT_CODE.failure);
    expect(existsSync(join(signalled.home, 'run', 'host.json'))).toBe(false);
    releases.shift()?.();
    await vi.waitFor(() => expect(existsSync(join(signalled.home, 'wevir.db-wal'))).toBe(false));
  });
});
