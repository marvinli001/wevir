// T2.5：wevir-host 的参数解析与主流程。runHostCli 在进程内运行，信号、stdin 与 stdout 换成假的；
// 真正的子进程（SIGKILL 后重启等）见 scripts/gate-m2.ts，
// --adapter codex 接真实 codex-app-server 见 cli.codex.integration.test.ts。

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AntigravityAdapter } from '@wevir/adapter-antigravity';
import { ClaudeAdapter } from '@wevir/adapter-claude';
import { CodexRuntime } from '@wevir/adapter-codex';
import { CursorAdapter } from '@wevir/adapter-cursor';
import { GrokAdapter } from '@wevir/adapter-grok';
import { OpenCodeAdapter } from '@wevir/adapter-opencode';
import { WorkBuddyAdapter } from '@wevir/adapter-workbuddy';
import { CloseCode } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { describe, expect, it, vi } from 'vitest';
import {
  type AdapterKind,
  createAdapter,
  EXIT_CODE,
  type HostCliOverrides,
  type HostCliProcess,
  hostCliLocale,
  hostUsage,
  parseHostArgs,
  runHostCli,
} from './cli.js';
import { EngineRouter } from './engine-router.js';
import { PARENT_SHUTDOWN_MESSAGE } from './exit-code.js';
import { HOST_VERSION } from './host-process.js';
import { createLogger, LOG_FILE } from './logger.js';
import type { HostRuntimeInfo } from './runtime-file.js';
import { fakeProcess, TestRpcClient, useTempDir, waitReady } from './test-utils.js';

const tempDir = useTempDir();

describe('hostCliLocale', () => {
  it('WEVIR_LANG 优先，其次 LC_ALL、LC_MESSAGES、LANG；zh* 为中文，其他为英文', () => {
    expect(hostCliLocale({})).toBe('en');
    expect(hostCliLocale({ LANG: 'zh_CN.UTF-8' })).toBe('zh');
    expect(hostCliLocale({ LC_ALL: 'C', LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(hostCliLocale({ LC_MESSAGES: 'zh_TW.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh');
    expect(hostCliLocale({ WEVIR_LANG: 'en', LC_ALL: 'zh_CN.UTF-8' })).toBe('en');
  });
});

describe('parseHostArgs', () => {
  it('默认值：codex 适配器、系统分配端口、info 级别、不监听 stdin', () => {
    expect(parseHostArgs([])).toEqual({
      kind: 'run',
      options: { adapter: 'codex', port: 0, logLevel: 'info', exitOnStdinEof: false },
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
    expect(parseHostArgs(['--adapter', 'codex'])).toMatchObject({ options: { adapter: 'codex' } });
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
async function launch(
  extra: string[] = [],
  overrides: HostCliOverrides = {},
  env = {},
  parentPort?: HostCliProcess['parentPort'],
) {
  const home = join(tempDir(), 'home');
  const fake = fakeProcess(['--home', home, '--adapter', 'echo', ...extra], env, parentPort);
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
    expect(help.out.stdout).toBe(`${hostUsage('en')}\n`);
    expect(help.out.stdout).toContain('Usage: wevir-host');
    const zhHelp = fakeProcess(['--help'], { LANG: 'zh_CN.UTF-8' });
    expect(await runHostCli(zhHelp.proc)).toBe(EXIT_CODE.ok);
    expect(zhHelp.out.stdout).toBe(`${hostUsage('zh')}\n`);
    expect(zhHelp.out.stdout).toContain('用法：wevir-host');
    const version = fakeProcess(['--version']);
    expect(await runHostCli(version.proc)).toBe(EXIT_CODE.ok);
    expect(version.out.stdout).toBe(`${HOST_VERSION}\n`);
    const bad = fakeProcess(['--port', 'x']);
    expect(await runHostCli(bad.proc)).toBe(EXIT_CODE.usage);
    expect(bad.out.stderr).toBe(
      'wevir-host: --port must be an integer from 0 to 65535: x\nRun wevir-host --help\n',
    );
  });

  it('--adapter codex：CodexRuntime 的两个进程用数据目录下的 engines/codex 与 engines/codex-chatgpt，都等到用到时才启动；订阅引擎（Claude Agent、Cursor、OpenCode、Grok、Antigravity）经 EngineRouter 挂在后面，同样不起进程', () => {
    const home = join(tempDir(), 'home');
    // 二进制只解析路径（WEVIR_CODEX_BIN），版本在第一次启动前才核对，这里不会运行它。
    const fakeBinary = join(tempDir(), 'codex-app-server');
    writeFileSync(fakeBinary, '');
    vi.stubEnv('WEVIR_CODEX_BIN', fakeBinary);
    try {
      const adapter = createAdapter('codex', { home, logger: createLogger({ mirror: () => {} }) });
      expect(adapter).toBeInstanceOf(EngineRouter);
      const router = adapter as EngineRouter;
      expect(router.routes.map((route) => [route.name, route.kinds])).toEqual([
        ['codex', ['deepseek-official', 'openai-compatible', 'google-vertex', 'chatgpt']],
        ['claude', ['claude']],
        ['cursor', ['cursor']],
        ['opencode', ['opencode']],
        ['grok', ['grok']],
        ['antigravity', ['antigravity']],
        ['workbuddy', ['workbuddy']],
      ]);
      expect(router.routes[0]?.adapter).toBeInstanceOf(CodexRuntime);
      expect(router.routes[1]?.adapter).toBeInstanceOf(ClaudeAdapter);
      expect(router.routes[2]?.adapter).toBeInstanceOf(CursorAdapter);
      expect(router.routes[3]?.adapter).toBeInstanceOf(OpenCodeAdapter);
      expect(router.routes[4]?.adapter).toBeInstanceOf(GrokAdapter);
      expect((router.routes[4]?.adapter as GrokAdapter | undefined)?.engines).toEqual([]);
      expect(router.routes[5]?.adapter).toBeInstanceOf(AntigravityAdapter);
      expect((router.routes[5]?.adapter as AntigravityAdapter | undefined)?.process.state).toBe(
        'stopped',
      );
      expect(router.routes[6]?.adapter).toBeInstanceOf(WorkBuddyAdapter);
      expect((router.routes[6]?.adapter as WorkBuddyAdapter | undefined)?.process.state).toBe(
        'stopped',
      );
      const codex = router.routes[0]?.adapter as CodexRuntime;
      expect(codex.gateway.paths.codexHome).toBe(join(home, 'engines', 'codex'));
      expect(codex.chatgpt.paths.codexHome).toBe(join(home, 'engines', 'codex-chatgpt'));
      expect(codex.gateway.process.state).toBe('stopped');
      expect(codex.chatgpt.process.state).toBe('stopped');
      expect(router.accounts?.kinds).toEqual([
        'chatgpt',
        'claude',
        'cursor',
        'opencode',
        'grok',
        'antigravity',
        'workbuddy',
      ]);
      expect(existsSync(home)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('--adapter codex 而 codex-app-server 不在：创建适配器失败，提示下载命令', () => {
    vi.stubEnv('WEVIR_CODEX_BIN', join(tempDir(), 'missing'));
    try {
      expect(() =>
        createAdapter('codex', { home: tempDir(), logger: createLogger({ mirror: () => {} }) }),
      ).toThrow('WEVIR_CODEX_BIN 指向的文件不存在');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('适配器建不起来（例如 Codex 二进制没下载）：报错并以 1 退出，日志里有原因', async () => {
    const home = join(tempDir(), 'home');
    const fake = fakeProcess(['--home', home, '--adapter', 'codex'], { WEVIR_LANG: 'zh' });
    const code = await runHostCli(fake.proc, {
      createAdapter: () => {
        throw new Error('找不到 codex-app-server');
      },
    });
    expect(code).toBe(EXIT_CODE.failure);
    expect(fake.out.stderr).toContain('无法创建 codex 适配器：找不到 codex-app-server');
    expect(logLines(home).find((l) => l.msg === 'failed to create adapter')).toMatchObject({
      adapter: 'codex',
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

  it('Cursor SDK 起 shell 失败留下的 unhandled rejection 只记日志，Host 照常运行；别的 unhandled rejection 仍然致命', async () => {
    const { home, exit, emit } = await launch();
    const spawnFailure = Object.assign(new Error('spawn /bin/zsh ENOENT'), {
      syscall: 'spawn /bin/zsh',
      code: 'ENOENT',
      spawnargs: ['-c', 'dump_zsh_state >/tmp/x; ls'],
    });
    emit('unhandledRejection', spawnFailure);
    expect(existsSync(join(home, 'run', 'host.json'))).toBe(true);
    expect(
      logLines(home).some((l) => l.msg === 'engine shell spawn failed; the host keeps running'),
    ).toBe(true);

    emit('unhandledRejection', new Error('boom'));
    expect(await exit).toBe(EXIT_CODE.failure);
    expect(logLines(home).some((l) => l.msg === 'fatal error')).toBe(true);
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

  it('utility process：parentPort 收到 PARENT_SHUTDOWN_MESSAGE 即优雅退出，别的消息不理', async () => {
    const port = new EventEmitter();
    const owned = await launch([], {}, {}, port as HostCliProcess['parentPort']);
    port.emit('message', { data: { type: 'something-else' } });
    port.emit('message', { data: 'wevir-host:shutdown' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(join(owned.home, 'run', 'host.json'))).toBe(true);
    port.emit('message', { data: PARENT_SHUTDOWN_MESSAGE });
    expect(await owned.exit).toBe(EXIT_CODE.ok);
    expect(existsSync(join(owned.home, 'run', 'host.json'))).toBe(false);
    const trigger = logLines(owned.home)
      .filter((l) => l.msg === 'shutting down')
      .at(-1)?.trigger;
    expect(trigger).toEqual({ kind: 'parent_port' });
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
    const fake = fakeProcess(['--home', home, '--adapter', 'echo'], { LANG: 'C' });
    expect(await runHostCli(fake.proc)).toBe(EXIT_CODE.alreadyRunning);
    expect(fake.out.stderr).toContain('a Host is already running');
    expect(fake.out.stderr).toContain(`pid ${process.ppid}`);
    expect(fake.out.stderr).toContain(`runtime file ${join(home, 'run', 'host.json')}`);
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
