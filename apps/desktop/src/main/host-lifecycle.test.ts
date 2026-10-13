// T5.1：桌面主进程的 Host 生命周期，对着真实的 wevir-host 子进程（dist/main.js，EchoAdapter），要先
// pnpm build。Electron 本身不参与：HostLifecycle 不依赖 Electron。T5.5：拥有的 Host 意外退出后重新拉起、
// 附着的 Host 不在了等它回来，以及客户端照渲染进程的做法重连后按 seq 补齐。

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
import {
  type SubscriptionItem,
  TranscriptProjection,
  WevirClient,
  webSocketTransport,
} from '@wevir/client-sdk';
import { isProcessAlive } from '@wevir/host/runtime';
import {
  type ClientIdentity,
  PROTOCOL_VERSION,
  type SessionId,
  type WevirEvent,
} from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HostLifecycle,
  type HostLifecycleOptions,
  type HostProcessStatus,
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
const flakyHost = fileURLToPath(new URL('./test-fixtures/flaky-host.mjs', import.meta.url));

let tempDir: string;
const lifecycles: HostLifecycle[] = [];
const clients: WevirClient[] = [];
const pids: number[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wevir-desktop-'));
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
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
  const logs: Array<{ level: string; message: string; detail?: Record<string, unknown> }> = [];
  const result = new HostLifecycle({
    home,
    identity,
    nodePath: process.execPath,
    hostEntry,
    hostArgs: ['--adapter', 'echo'],
    log: (level, message, detail) => logs.push({ level, message, ...(detail && { detail }) }),
    ...options,
  });
  lifecycles.push(result);
  const statuses: HostProcessStatus[] = [];
  result.onStatus((status) => {
    statuses.push(status);
    // 拉起或附着过的 Host 都记下，用例中途失败时 afterEach 照样清掉（退出码 3 的用例借本进程当占位）。
    if (status.phase === 'running' && status.ownership.pid !== process.pid) {
      pids.push(status.ownership.pid);
    }
  });
  return { lifecycle: result, logs, statuses };
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
    await expect(host.endpoint()).rejects.toThrow((error as Error).message);
    expect(host.status).toEqual({
      phase: 'failed',
      error: (error as Error).message,
      logPath: join(home, 'logs', 'host.log'),
    });
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

/** 照渲染进程的做法连 Host：每次连接尝试前向生命周期要端点，Host 进程回到 running 时立即重连。 */
async function connect(host: HostLifecycle): Promise<WevirClient> {
  const client = await WevirClient.connect({
    endpoint: () => host.endpoint(),
    transport: webSocketTransport(WebSocket),
    identity,
    reconnect: { initialDelayMs: 50, maxDelayMs: 500 },
  });
  clients.push(client);
  host.onStatus((status) => {
    if (status.phase === 'running') client.reconnectNow();
  });
  return client;
}

async function createSession(client: WevirClient): Promise<SessionId> {
  const rootPath = join(tempDir, 'workspace');
  mkdirSync(rootPath, { recursive: true });
  const { workspace } = await client.request('workspace.add', { rootPath });
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

/** 从头回放一个会话，直到追平，得到它的投影。 */
async function replay(client: WevirClient, sessionId: SessionId) {
  const projection = new TranscriptProjection();
  const subscription = client.subscribe(sessionId);
  for await (const item of subscription) {
    if (item.type === 'event') projection.apply(item.event);
    if (item.type === 'caught_up') break;
  }
  return projection.snapshot();
}

function phases(statuses: readonly HostProcessStatus[]): string[] {
  return statuses.map((s) => (s.phase === 'restarting' ? `restarting:${s.attempt}` : s.phase));
}

describe('HostLifecycle：意外退出与重新拉起（T5.5）', () => {
  it('拥有的 Host 在流式输出中途被 SIGKILL：确认旧进程已退出后重新拉起；客户端重连后按 seq 补齐，投影与从头回放一致', async () => {
    const home = join(tempDir, 'home');
    const {
      lifecycle: host,
      logs,
      statuses,
    } = lifecycle(home, {
      hostEntry: flakyHost,
      hostArgs: ['--step-ms', '15'],
      timeouts: { restartDelaysMs: [100, 100, 100] },
    });
    const first = await host.start();
    const client = await connect(host);
    const sessionId = await createSession(client);

    // 像桌面的消息流一样：一条从 seq 0 开始的订阅，事件交给投影。
    const live = new TranscriptProjection();
    const items: SubscriptionItem[] = [];
    const subscription = client.subscribe(sessionId);
    void (async () => {
      for await (const item of subscription) {
        items.push(item);
        if (item.type === 'event') live.apply(item.event);
        else if (item.type === 'reset') live.reset();
      }
    })();
    const events = () =>
      items.flatMap((item) => (item.type === 'event' ? [item.event] : ([] as WevirEvent[])));

    await client.request('session.send', {
      sessionId,
      content: [{ type: 'text', text: '断线测试 '.repeat(60) }],
    });
    await until(() => events().filter((e) => e.type === 'assistant.delta').length >= 5);
    const before = live.snapshot();
    expect(before.state).toBe('running');

    process.kill(first.ownership.pid, 'SIGKILL');
    await until(
      () => host.status.phase === 'running' && host.ownership?.pid !== first.ownership.pid,
    );
    const second = host.ownership;
    expect(second).toMatchObject({ kind: 'owned' });
    expect(isProcessAlive(first.ownership.pid)).toBe(false);
    expect(readRuntime(home)).toMatchObject({ pid: second?.pid, startedAt: second?.startedAt });
    expect(phases(statuses)).toEqual(['running', 'restarting:1', 'running']);
    expect(statuses[1]).toMatchObject({
      maxAttempts: 3,
      reason: expect.stringMatching(/^Host 意外退出/),
    });
    // host.json 还记着旧进程：确认它已退出才拉起。
    expect(logs).toContainEqual(
      expect.objectContaining({
        message: 'the previous host has exited; launching a new one',
        detail: { pid: first.ownership.pid },
      }),
    );

    // 新 Host 启动对账把被打断的回合结掉（#15：interrupted，回到 idle），客户端续订后收到。
    await until(() => live.snapshot().state === 'idle');
    expect(live.snapshot().messages.at(-1)).toMatchObject({
      role: 'assistant',
      finished: { outcome: 'interrupted' },
    });
    // 续订之后的实时事件也照常到达：EchoAdapter 的引擎会话只在内存里，新 Host 恢复不了它，追问时会话转只读。
    await expect(
      client.request('session.send', { sessionId, content: [{ type: 'text', text: '重启之后' }] }),
    ).rejects.toThrow();
    await until(() => live.snapshot().readOnly !== undefined);

    const seqs = events().map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(items.filter((item) => item.type === 'caught_up')).toHaveLength(1);
    expect(items.some((item) => item.type === 'reset')).toBe(false);
    const fresh = await replay(client, sessionId);
    const current = live.snapshot();
    expect(current.lastSeq).toBe(fresh.lastSeq);
    expect(current.messages).toEqual(fresh.messages);
  }, 30_000);

  it('重新拉起 3 次都失败：进入 failed，带原因与日志路径；排除问题后手动重试', async () => {
    const home = join(tempDir, 'home');
    const { lifecycle: host, statuses } = lifecycle(home, {
      hostEntry: flakyHost,
      hostArgs: [],
      timeouts: { restartDelaysMs: [50, 50, 50] },
    });
    const first = await host.start();
    const marker = join(home, 'crash-on-start');
    writeFileSync(marker, '');

    process.kill(first.ownership.pid, 'SIGKILL');
    await until(() => host.status.phase === 'failed');
    expect(phases(statuses)).toEqual([
      'running',
      'restarting:1',
      'restarting:2',
      'restarting:3',
      'failed',
    ]);
    expect(host.status).toEqual({
      phase: 'failed',
      error: expect.stringMatching(
        /^Host 意外退出（.+），重新拉起 3 次都没有成功：Host 启动失败（退出码 1）：simulated startup crash$/,
      ),
      logPath: join(home, 'logs', 'host.log'),
    });
    await expect(host.endpoint()).rejects.toThrow(/重新拉起 3 次都没有成功/);

    rmSync(marker);
    await host.retry();
    expect(phases(statuses).slice(-2)).toEqual(['starting', 'running']);
    expect(host.ownership).toMatchObject({ kind: 'owned' });
    expect(host.ownership?.pid).not.toBe(first.ownership.pid);
    expect((await host.endpoint()).url).toBe(readRuntime(home).url);
  });

  it('等待重新拉起期间别人启动了 Host：附着它，不再拉起', async () => {
    const home = join(tempDir, 'home');
    const { lifecycle: host, logs } = lifecycle(home, {
      timeouts: { restartDelaysMs: [3000, 3000, 3000] },
    });
    const first = await host.start();
    process.kill(first.ownership.pid, 'SIGKILL');
    await until(() => host.status.phase === 'restarting');

    const other = await startDetachedHost(home);
    await until(() => host.status.phase === 'running');
    expect(host.ownership).toMatchObject({ kind: 'attached', pid: other });
    expect(logs.filter((l) => l.message === 'launching host')).toHaveLength(1);
    await host.stop();
    expect(isProcessAlive(other)).toBe(true);
  });

  it('附着的 Host 退出：只显示等待、不替它拉起；新的 Host 写出 host.json 后附着它', async () => {
    const home = join(tempDir, 'home');
    const existing = await startDetachedHost(home);
    const { lifecycle: host, logs, statuses } = lifecycle(home, { timeouts: { watchMs: 50 } });
    expect((await host.start()).ownership).toMatchObject({ kind: 'attached', pid: existing });

    process.kill(existing, 'SIGTERM');
    await until(() => host.status.phase === 'waiting');
    expect(host.status).toEqual({ phase: 'waiting', pid: existing });
    await sleep(300);
    expect(host.status.phase).toBe('waiting');
    expect(existsSync(runtimeFile(home))).toBe(false);
    await expect(host.endpoint()).rejects.toThrow();

    const next = await startDetachedHost(home);
    await until(() => host.status.phase === 'running');
    expect(host.ownership).toMatchObject({ kind: 'attached', pid: next });
    expect(phases(statuses)).toEqual(['running', 'waiting', 'running']);
    expect((await host.endpoint()).url).toBe(readRuntime(home).url);
    expect(logs.map((l) => l.message)).not.toContain('launching host');

    await host.stop();
    expect(isProcessAlive(next)).toBe(true);
  });

  it('等待重新拉起时退出：stop 立即返回，不再拉起', async () => {
    const home = join(tempDir, 'home');
    const { lifecycle: host, logs } = lifecycle(home, {
      timeouts: { restartDelaysMs: [10_000, 10_000, 10_000] },
    });
    const first = await host.start();
    process.kill(first.ownership.pid, 'SIGKILL');
    await until(() => host.status.phase === 'restarting');

    const started = performance.now();
    await host.stop();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(logs.map((l) => l.message)).not.toContain('restarting host');
    expect(existsSync(runtimeFile(home)) && isProcessAlive(readRuntime(home).pid)).toBe(false);
  });
});
