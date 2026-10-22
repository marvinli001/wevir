// T2.5：startHost 组装出的 Host（真实的存储、EchoAdapter、WebSocket 服务与 run/host.json），在进程内
// 启动与退出。进程级的行为（信号、stdin 归属管道、SIGKILL 后重启）见 cli.test.ts 与 scripts/gate-m2.ts。

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  CloseCode,
  DESKTOP_RENDERER_ORIGINS,
  ErrorCode,
  FILES_READ_CHUNK_MAX_BYTES,
  FILES_READ_FILE_MAX_BYTES,
  PROTOCOL_VERSION,
  type SessionId,
  type WevirEvent,
} from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  HOST_VERSION,
  type RunningHost,
  type ShutdownTrigger,
  type StartHostOptions,
  startHost,
} from './host-process.js';
import { createLogger } from './logger.js';
import { HostAlreadyRunningError, type HostRuntimeInfo } from './runtime-file.js';
import { loadTerminalModules } from './terminals.js';
import { identity, TestRpcClient, useTempDir } from './test-utils.js';

/** node-pty 装得上的平台（macOS、Windows）才有用户终端，退出时多一步。 */
const userTerminal = (await loadTerminalModules(() => {})) !== undefined;

const tempDir = useTempDir();
const running: RunningHost[] = [];
const clients: TestRpcClient[] = [];

// 注册在 useTempDir 之后：先断客户端、停 Host，再删临时目录。
afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const host of running.splice(0)) await host.shutdown();
});

const SHUTDOWN_STEPS = [
  'stop_verification',
  'stop_installs',
  ...(userTerminal ? ['stop_terminals'] : []),
  'stop_accepting',
  'cancel_turns',
  'dispose_adapter',
  'flush_storage',
  'close_connections',
  'remove_runtime_file',
];

async function start(
  options: Partial<
    Pick<StartHostOptions, 'home' | 'adapter' | 'port' | 'onShutdownRequest' | 'shutdownBudgetMs'>
  > = {},
) {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: 'debug',
    mirror: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const home = options.home ?? join(tempDir(), 'home');
  const host = await startHost({
    adapter: new EchoAdapter({ stepDelayMs: 1 }),
    engine: 'echo',
    logger,
    ...options,
    home,
  });
  running.push(host);
  return { host, home, lines };
}

function runtimeFile(home: string): string {
  return join(home, 'run', 'host.json');
}

function runtimeInfo(home: string): HostRuntimeInfo {
  return JSON.parse(readFileSync(runtimeFile(home), 'utf8')) as HostRuntimeInfo;
}

async function connect(host: RunningHost): Promise<TestRpcClient> {
  const client = await TestRpcClient.connect(host.url);
  clients.push(client);
  const frame = await client.hello(runtimeInfo(host.home).token as string);
  expect(frame.error).toBeUndefined();
  return client;
}

async function createSession(client: TestRpcClient): Promise<SessionId> {
  const workspaceDir = join(tempDir(), 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  const { workspace } = await client.request('workspace.add', { rootPath: workspaceDir });
  await client.request('provider.upsert', {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [],
    defaultModelId: 'deepseek-chat',
  });
  const { session } = await client.request('session.create', {
    workspaceId: workspace.id,
    providerId: 'deepseek-official',
  });
  return session.id;
}

function transitions(events: WevirEvent[]): string[] {
  return events.flatMap((e) =>
    e.type === 'session.state_changed'
      ? [`${e.payload.from}→${e.payload.to}:${e.payload.reason}`]
      : [],
  );
}

describe('startHost', () => {
  it('就绪后 host.json 带 url 与令牌；hostId 写进 host-id、跨重启不变；退出时删除 host.json', async () => {
    const { host, home } = await start();
    const info = runtimeInfo(home);
    expect(info).toEqual({
      pid: process.pid,
      startedAt: expect.any(String),
      protocolVersion: PROTOCOL_VERSION,
      hostVersion: HOST_VERSION,
      url: host.url,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(Buffer.from(info.token as string, 'base64url')).toHaveLength(32);
    expect(readFileSync(join(home, 'host-id'), 'utf8').trim()).toBe(host.hostId);
    const client = await connect(host);
    expect(await client.request('host.ping')).toEqual({});

    await host.shutdown();
    expect(existsSync(runtimeFile(home))).toBe(false);
    expect((await client.closed).code).toBe(CloseCode.GOING_AWAY);

    const again = await start({ home });
    expect(again.host.hostId).toBe(host.hostId);
    expect(runtimeInfo(home).token).not.toBe(info.token);
  });

  it('Origin 白名单是桌面渲染进程的 origin（host-api.md §1）：放行它们，拒绝其他带 Origin 的升级', async () => {
    const { host } = await start();
    const upgrade = (origin: string) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(host.url, { origin });
        ws.once('open', () => {
          ws.terminate();
          resolve('open');
        });
        ws.once('error', (error) => resolve(error.message));
      });
    expect(DESKTOP_RENDERER_ORIGINS).toEqual(['wevir://app', 'http://localhost:5199']);
    for (const origin of DESKTOP_RENDERER_ORIGINS) expect(await upgrade(origin)).toBe('open');
    for (const origin of ['http://localhost:5173', 'file://', 'null', 'wevir://evil']) {
      expect(await upgrade(origin)).toBe('Unexpected server response: 403');
    }
  });

  it('优雅退出按 ADR-0002 §6 的顺序：运行中的回合被取消、未决审批结为 cancelled（host_shutdown），订阅者在 1001 关闭前收到', async () => {
    const { host, home, lines } = await start();
    const client = await connect(host);
    const sessionId = await createSession(client);
    const { subscriptionId } = await client.request('events.subscribe', { sessionId, sinceSeq: 0 });
    await client.request('session.send', {
      sessionId,
      content: [{ type: 'text', text: 'please approve' }],
    });
    const requested = await client.until(
      () => client.events(subscriptionId).find((e) => e.type === 'approval.requested'),
      'approval.requested',
    );
    const approvalId =
      requested.type === 'approval.requested' ? requested.payload.approval.id : undefined;

    await host.shutdown({ kind: 'api' });
    expect((await client.closed).code).toBe(CloseCode.GOING_AWAY);
    const events = client.events(subscriptionId);
    expect(events.find((e) => e.type === 'approval.resolved')?.payload).toEqual({
      approvalId,
      status: 'cancelled',
      resolution: { reason: 'host_shutdown' },
    });
    expect(events.find((e) => e.type === 'turn.finished')?.payload).toMatchObject({
      outcome: 'cancelled',
    });
    expect(transitions(events).slice(-2)).toEqual([
      'awaiting_approval→cancelling:cancel_requested',
      'cancelling→idle:turn_finished',
    ]);
    expect(lines.filter((l) => l.msg === 'shutdown step done').map((l) => l.step)).toEqual(
      SHUTDOWN_STEPS,
    );
    expect(lines.some((l) => l.msg === 'shutdown step failed')).toBe(false);
    expect(existsSync(runtimeFile(home))).toBe(false);

    // 优雅退出已结清会话，重启时不需要对账。
    const again = await start({ home });
    expect(again.lines.some((l) => l.msg === 'recovered from unclean shutdown')).toBe(false);
    const client2 = await connect(again.host);
    expect((await client2.request('session.get', { sessionId })).session.state).toBe('idle');
  });

  it('引擎卡住（取消与 dispose 都不返回）：超出预算的步骤跳过，照常关闭数据库与连接、删除 host.json；下次启动对账', async () => {
    const releases: Array<() => void> = [];
    class HangingAdapter extends EchoAdapter {
      override cancel(): Promise<void> {
        return new Promise<void>(() => {});
      }
      override dispose(): Promise<void> {
        return new Promise<void>((resolve) => releases.push(() => resolve(super.dispose())));
      }
    }
    const { host, home, lines } = await start({
      adapter: new HangingAdapter({ stepDelayMs: 1 }),
      shutdownBudgetMs: 200,
    });
    const client = await connect(host);
    const sessionId = await createSession(client);
    const { subscriptionId } = await client.request('events.subscribe', { sessionId, sinceSeq: 0 });
    await client.request('session.send', {
      sessionId,
      content: [{ type: 'text', text: 'please approve' }],
    });
    await client.until(
      () => client.events(subscriptionId).find((e) => e.type === 'approval.requested'),
      'approval.requested',
    );

    const startedAt = performance.now();
    await host.shutdown();
    expect(performance.now() - startedAt).toBeLessThan(5000);
    expect((await client.closed).code).toBe(CloseCode.GOING_AWAY);
    expect(existsSync(runtimeFile(home))).toBe(false);
    // 数据库已关闭：WAL 检查点完成后伴随文件被删除。
    expect(existsSync(join(home, 'wevir.db-wal'))).toBe(false);
    expect(
      lines.filter((l) => String(l.msg).startsWith('shutdown step')).map((l) => [l.msg, l.step]),
    ).toEqual([
      ['shutdown step done', 'stop_verification'],
      ['shutdown step done', 'stop_installs'],
      ...(userTerminal ? [['shutdown step done', 'stop_terminals']] : []),
      ['shutdown step done', 'stop_accepting'],
      ['shutdown step timed out', 'cancel_turns'],
      ['shutdown step timed out', 'dispose_adapter'],
      ['shutdown step done', 'flush_storage'],
      ['shutdown step done', 'close_connections'],
      ['shutdown step done', 'remove_runtime_file'],
    ]);
    // 审批在等引擎之前已结为 cancelled（host_shutdown）；回合没能结算，会话停在 cancelling。
    expect(transitions(client.events(subscriptionId)).at(-1)).toBe(
      'awaiting_approval→cancelling:cancel_requested',
    );
    releases.shift()?.();

    const again = await start({ home });
    expect(again.lines.find((l) => l.msg === 'recovered from unclean shutdown')).toMatchObject({
      interruptedSessions: [sessionId],
    });
    const client2 = await connect(again.host);
    expect((await client2.request('session.get', { sessionId })).session.state).toBe('idle');
  });

  it('host.shutdown：默认直接优雅退出；给了 onShutdownRequest 时交给它，带发起方', async () => {
    const { host, home } = await start();
    const client = await connect(host);
    expect(await client.request('host.shutdown')).toEqual({});
    expect((await client.closed).code).toBe(CloseCode.GOING_AWAY);
    await vi.waitFor(() => expect(existsSync(runtimeFile(home))).toBe(false));

    const triggers: ShutdownTrigger[] = [];
    const other = await start({
      home: join(tempDir(), 'other'),
      onShutdownRequest: (trigger) => triggers.push(trigger),
    });
    const client2 = await connect(other.host);
    expect(await client2.request('host.shutdown')).toEqual({});
    expect(triggers).toEqual([{ kind: 'rpc', client: identity }]);
    expect(existsSync(runtimeFile(other.home))).toBe(true);
  });

  it('同一数据目录已有活着的 Host：抛 HostAlreadyRunningError，不打开数据库、不动对方的 host.json', async () => {
    const home = join(tempDir(), 'home');
    mkdirSync(join(home, 'run'), { recursive: true });
    const theirs = JSON.stringify({
      pid: process.ppid,
      startedAt: new Date().toISOString(),
      protocolVersion: PROTOCOL_VERSION,
      hostVersion: HOST_VERSION,
      url: 'ws://127.0.0.1:1/',
      token: 'theirs',
    });
    writeFileSync(runtimeFile(home), theirs);
    await expect(start({ home })).rejects.toBeInstanceOf(HostAlreadyRunningError);
    expect(readFileSync(runtimeFile(home), 'utf8')).toBe(theirs);
    expect(existsSync(join(home, 'wevir.db'))).toBe(false);
  });

  it('上一个 Host 被杀留下的 host.json：回收并记日志', async () => {
    const home = join(tempDir(), 'home');
    mkdirSync(join(home, 'run'), { recursive: true });
    const pid = spawnSync(process.execPath, ['-e', '']).pid as number;
    const stale = { pid, startedAt: new Date().toISOString() };
    writeFileSync(
      runtimeFile(home),
      JSON.stringify({ ...stale, protocolVersion: '0.1.0', hostVersion: '0.0.0', url: 'ws://x/' }),
    );
    const { host, lines } = await start({ home });
    expect(runtimeInfo(home)).toMatchObject({ pid: process.pid, url: host.url });
    expect(lines.find((l) => l.msg === 'reclaimed stale runtime file')).toMatchObject({
      stalePid: stale.pid,
      staleStartedAt: stale.startedAt,
    });
  });

  it('启动失败时回收已建好的部分：端口被占用 → 抛错、删除 host.json、dispose 适配器，之后可以再启动', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as { port: number }).port;
    const home = join(tempDir(), 'home');
    const adapter = new EchoAdapter();
    try {
      await expect(start({ home, adapter, port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      blocker.close();
    }
    expect(existsSync(runtimeFile(home))).toBe(false);
    await expect(
      adapter.createSession({ cwd: home, providerId: 'p', modelId: 'm' }),
    ).rejects.toMatchObject({
      code: 'disposed',
    });
    await start({ home });
    expect(runtimeInfo(home).pid).toBe(process.pid);
  });
});

describe('文件预览（0.32.0）', () => {
  it('hello 声明 file_preview；workspace.fileUrl 的地址在 RPC 端口上读得到，writeFile 写回', async () => {
    const { host } = await start();
    const client = await connect(host);
    const hello = await TestRpcClient.connect(host.url);
    clients.push(hello);
    expect(
      (
        (await hello.hello(runtimeInfo(host.home).token as string)).result as {
          features: Record<string, boolean>;
        }
      ).features.file_preview,
    ).toBe(true);
    const workspaceDir = join(tempDir(), 'files-ws');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, 'report.pdf'), '%PDF-1.4 demo');
    writeFileSync(join(workspaceDir, 'notes.md'), '# a\n');
    const { workspace } = await client.request('workspace.add', { rootPath: workspaceDir });

    const issued = await client.request('workspace.fileUrl', {
      workspaceId: workspace.id,
      path: 'report.pdf',
    });
    expect(issued).toMatchObject({ path: 'report.pdf', size: 13 });
    const port = new URL(host.url).port;
    expect(issued.url?.startsWith(`http://127.0.0.1:${port}/files/`)).toBe(true);
    const response = await fetch(issued.url as string);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(await response.text()).toBe('%PDF-1.4 demo');
    expect(
      await client.request('workspace.fileUrl', { workspaceId: workspace.id, path: 'notes.md' }),
    ).toEqual({ path: 'notes.md', unavailable: 'unsupported' });

    const read = await client.request('workspace.readFile', {
      workspaceId: workspace.id,
      path: 'notes.md',
    });
    const written = await client.request('workspace.writeFile', {
      workspaceId: workspace.id,
      path: 'notes.md',
      text: '# b\n',
      ...(read.mtimeMs !== undefined && { expectedMtimeMs: read.mtimeMs }),
    });
    expect(written).toMatchObject({ path: 'notes.md', size: 4 });
    expect(written.conflict).toBeUndefined();
    expect(readFileSync(join(workspaceDir, 'notes.md'), 'utf8')).toBe('# b\n');
  });
});

describe('文件读取（0.102.0）', () => {
  it('files.read 分块读回 3 MiB 的文件，散列一致；越界、目录外、符号链接、大小上限都拒绝', async () => {
    const { host } = await start();
    const client = await connect(host);
    const workspaceDir = join(tempDir(), 'read-ws');
    const outside = join(tempDir(), 'outside');
    mkdirSync(join(workspaceDir, 'sub'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    const original = randomBytes(3 * 1024 * 1024 + 123);
    writeFileSync(join(workspaceDir, 'sub', 'big.bin'), original);
    writeFileSync(join(workspaceDir, 'notes.md'), '# Notes\n');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(workspaceDir, 'leak.txt'));
    symlinkSync(join(workspaceDir, 'notes.md'), join(workspaceDir, 'alias.md'));
    writeFileSync(join(workspaceDir, 'huge.bin'), '');
    truncateSync(join(workspaceDir, 'huge.bin'), FILES_READ_FILE_MAX_BYTES + 1);
    const { workspace } = await client.request('workspace.add', { rootPath: workspaceDir });
    const workspaceId = workspace.id as string;

    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const chunk = await client.request('files.read', {
        workspaceId,
        path: 'sub/big.bin',
        offset,
      });
      expect(chunk).toMatchObject({
        path: 'sub/big.bin',
        mime: 'application/octet-stream',
        size: original.length,
        offset,
        mtimeMs: expect.any(Number),
      });
      const bytes = Buffer.from(chunk.data, 'base64');
      expect(bytes.length).toBeLessThanOrEqual(FILES_READ_CHUNK_MAX_BYTES);
      chunks.push(bytes);
      offset += bytes.length;
      if (chunk.eof) break;
    }
    expect(chunks.length).toBe(7);
    const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
    expect(digest(Buffer.concat(chunks))).toBe(digest(original));

    expect(
      await client.request('files.read', { workspaceId, path: 'notes.md', offset: 2, length: 4 }),
    ).toEqual({
      path: 'notes.md',
      data: Buffer.from('Note').toString('base64'),
      mime: 'text/markdown; charset=utf-8',
      size: 8,
      offset: 2,
      eof: false,
      mtimeMs: expect.any(Number),
    });
    // 文件末尾：空块、eof。
    expect(
      await client.request('files.read', { workspaceId, path: 'notes.md', offset: 8 }),
    ).toMatchObject({ data: '', size: 8, offset: 8, eof: true });
    // 目录里的符号链接指到目录里，照常读。
    expect((await client.request('files.read', { workspaceId, path: 'alias.md' })).data).toBe(
      Buffer.from('# Notes\n').toString('base64'),
    );

    const rejected: Array<[Record<string, unknown>, RegExp]> = [
      [{ path: 'notes.md', offset: 9 }, /past the end/],
      [{ path: '../outside/secret.txt' }, /relative path/],
      [{ path: '/etc/hosts' }, /relative path/],
      [{ path: 'leak.txt' }, /not an existing file/],
      [{ path: 'sub' }, /not an existing file/],
      [{ path: 'missing.txt' }, /not an existing file/],
      [{ path: 'huge.bin' }, /larger than/],
      [{ path: 'notes.md', length: FILES_READ_CHUNK_MAX_BYTES + 1 }, /.*/],
    ];
    for (const [params, message] of rejected) {
      const frame = await client.call('files.read', { workspaceId, ...params });
      expect(frame.error?.code, JSON.stringify(params)).toBe(ErrorCode.INVALID_PARAMS);
      expect(frame.error?.message, JSON.stringify(params)).toMatch(message);
    }
    expect((await client.call('files.read', { path: 'notes.md' })).error?.code).toBe(
      ErrorCode.INVALID_PARAMS,
    );
  });

  it('只给 sessionId 时读会话的目录；hello 声明 files_read 与 prevent_sleep', async () => {
    const { host } = await start();
    const client = await connect(host);
    const hello = await TestRpcClient.connect(host.url);
    clients.push(hello);
    const features = (
      (await hello.hello(runtimeInfo(host.home).token as string)).result as {
        features: Record<string, boolean>;
      }
    ).features;
    expect(features.files_read).toBe(true);
    expect(features.prevent_sleep).toBe(true);
    const sessionId = await createSession(client);
    writeFileSync(join(tempDir(), 'workspace', 'a.txt'), 'hello');
    expect(await client.request('files.read', { sessionId, path: 'a.txt' })).toMatchObject({
      data: Buffer.from('hello').toString('base64'),
      mime: 'text/plain; charset=utf-8',
      eof: true,
    });
    const missing = await client.call('files.read', {
      sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQZ',
      path: 'a.txt',
    });
    expect(missing.error?.code).toBe(ErrorCode.SESSION_NOT_FOUND);
  });
});

describe('防休眠（0.102.0）', () => {
  it('preventSleep 开着时回合在跑才保持，等审批不算；值变了发 power.changed', async () => {
    const { host } = await start();
    const client = await connect(host);
    const sessionId = await createSession(client);
    expect(await client.request('power.get')).toEqual({ keepAwake: false });
    const changes = () =>
      client.notifications('power.changed').map((params) => params.keepAwake as boolean);

    // 关着时回合照跑，不通知。
    await client.request('session.send', { sessionId, content: [{ type: 'text', text: 'hi' }] });
    const { subscriptionId } = await client.request('events.subscribe', { sessionId, sinceSeq: 0 });
    await client.until(
      () => client.events(subscriptionId).find((e) => e.type === 'turn.finished'),
      'first turn finished',
    );
    expect(changes()).toEqual([]);

    await client.request('settings.update', { settings: { preventSleep: true } });
    expect(await client.request('power.get')).toEqual({ keepAwake: false });
    await client.request('session.send', {
      sessionId,
      content: [{ type: 'text', text: 'please approve' }],
    });
    const requested = await client.until(
      () => client.events(subscriptionId).find((e) => e.type === 'approval.requested'),
      'approval.requested',
    );
    await client.until(() => (changes().length >= 2 ? true : undefined), 'awaiting approval');
    expect(changes()).toEqual([true, false]);
    if (requested.type !== 'approval.requested') throw new Error('unexpected event');
    await client.request('approval.respond', {
      approvalId: requested.payload.approval.id,
      optionId: 'allow-once',
    });
    await client.until(() => (changes().length >= 4 ? true : undefined), 'turn finished');
    expect(changes()).toEqual([true, false, true, false]);
    expect(await client.request('power.get')).toEqual({ keepAwake: false });
  });
});
