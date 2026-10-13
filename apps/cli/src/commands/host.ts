import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ClientClosedError,
  ConnectionLostError,
  type HostHello,
  isRpcError,
} from '@wevir/client-sdk';
import {
  EXIT_CODE,
  HOME_LAYOUT,
  type HostRuntimeInfo,
  isProcessAlive,
  isRuntimeInfoStale,
  parseRuntimeInfo,
  RUNTIME_FILE,
} from '@wevir/host/runtime';
import { type Context, connect } from '../context.js';
import { CliError, describeError, EXIT } from '../errors.js';
import { formatTime, table } from '../format.js';

/** 分离启动的 Host 的 stdout / stderr 写到这里（Host 自己的结构化日志在 `logs/host.log`）。 */
export const HOST_STDIO_LOG = 'host-stdio.log';

const START_TIMEOUT_MS = 30_000;
/** Host 优雅退出的上限是 10 s（ADR-0002 §6），多等一会儿。 */
const STOP_TIMEOUT_MS = 15_000;

export interface HostStartOptions {
  adapter?: string;
  logLevel?: string;
}

type RuntimeState =
  | { kind: 'missing'; path: string }
  | { kind: 'invalid'; path: string }
  /** 文件在，写它的进程已经不在了；下一个 Host 启动时回收。 */
  | { kind: 'stale'; path: string; info: HostRuntimeInfo }
  /** 占位文件：Host 正在启动，还没写入地址。 */
  | { kind: 'starting'; path: string; info: HostRuntimeInfo }
  | { kind: 'live'; path: string; info: HostRuntimeInfo };

export async function readRuntime(home: string): Promise<RuntimeState> {
  const path = join(home, HOME_LAYOUT.runDir, RUNTIME_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', path };
    throw error;
  }
  const info = parseRuntimeInfo(text);
  if (!info) return text.trim() === '' ? { kind: 'missing', path } : { kind: 'invalid', path };
  if (isRuntimeInfoStale(info)) return { kind: 'stale', path, info };
  if (info.url === undefined) return { kind: 'starting', path, info };
  return { kind: 'live', path, info };
}

interface Probe {
  hello: HostHello;
  latencyMs: number;
}

/** 连上 Host、完成 hello 并 ping 一次。 */
async function probe(ctx: Context, connectMs = 3000): Promise<Probe> {
  const client = await connect(ctx, { connectMs });
  try {
    const started = performance.now();
    await client.request('host.ping', {}, { timeoutMs: connectMs });
    return { hello: client.hello, latencyMs: Math.round(performance.now() - started) };
  } finally {
    client.close();
  }
}

/** `wevir-host` 可执行入口：`@wevir/host` 的 `bin['wevir-host']`。 */
export function resolveHostEntry(from: string | URL = import.meta.url): string {
  const require = createRequire(from);
  const manifestPath = require.resolve('@wevir/host/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: unknown };
  const bin = (manifest.bin as Record<string, unknown> | undefined)?.['wevir-host'];
  if (typeof bin !== 'string') throw new CliError(`${manifestPath} 里没有 bin.wevir-host`);
  const entry = resolve(dirname(manifestPath), bin);
  if (!existsSync(entry)) {
    throw new CliError(`找不到 Host 的可执行入口 ${entry}。`, '先在仓库根目录运行 pnpm build');
  }
  return entry;
}

export async function hostStart(ctx: Context, options: HostStartOptions): Promise<number> {
  const s = ctx.styles;
  const runtime = await readRuntime(ctx.home);
  if (runtime.kind === 'invalid') {
    throw new CliError(
      `运行时文件 ${runtime.path} 的内容不对。`,
      '确认没有 Host 在运行后删除它，再运行 wevir host start',
    );
  }
  if (runtime.kind === 'live') {
    try {
      const { hello } = await probe(ctx);
      ctx.print(`Host 已在运行：pid ${runtime.info.pid} · Host ${hello.hostVersion}`);
      ctx.print(s.dim(`数据目录 ${ctx.home}`));
      return EXIT.ok;
    } catch (error) {
      throw new CliError(
        `Host 进程（pid ${runtime.info.pid}）在运行，但连不上：${describeError(error).message}`,
        `查看日志 ${join(ctx.home, HOME_LAYOUT.logsDir, 'host.log')}；必要时结束该进程后再运行 wevir host start`,
      );
    }
  }

  let child: ChildProcess | undefined;
  if (runtime.kind === 'starting') {
    ctx.print(`Host 正在启动（pid ${runtime.info.pid}），等待它就绪…`);
  } else {
    child = await spawnDetached(ctx, options);
  }
  const { info, hello } = await waitForHost(ctx, child);
  ctx.print(
    `Host 已启动：pid ${info.pid} · Host ${hello.hostVersion} · 协议 ${hello.protocolVersion}`,
  );
  ctx.print(s.dim(`数据目录 ${ctx.home}`));
  ctx.print(s.dim(`日志 ${join(ctx.home, HOME_LAYOUT.logsDir, 'host.log')}`));
  return EXIT.ok;
}

/**
 * 以分离方式启动 Host（ADR-0002 §6）：自成进程组、不持有 stdin 归属管道，CLI 退出、终端关闭都不影响它；
 * 桌面之后附着到它，退出时也不会停止它。stdout / stderr 追加到 `logs/host-stdio.log`。
 */
async function spawnDetached(ctx: Context, options: HostStartOptions): Promise<ChildProcess> {
  const entry = resolveHostEntry();
  const logsDir = join(ctx.home, HOME_LAYOUT.logsDir);
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  const out = openSync(join(logsDir, HOST_STDIO_LOG), 'a', 0o600);
  const args = [entry, '--home', ctx.home];
  if (options.adapter) args.push('--adapter', options.adapter);
  if (options.logLevel) args.push('--log-level', options.logLevel);
  try {
    // 用运行 CLI 的同一个 Node；spawn 不继承 execArgv。cwd 放在数据目录，不占用用户当前所在的目录。
    const child = spawn(process.execPath, args, {
      cwd: ctx.home,
      env: ctx.io.env,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    child.unref();
    return child;
  } finally {
    closeSync(out);
  }
}

/** 等 `host.json` 写入地址并能连上。`child` 是本次拉起的进程，它提前退出就报错。 */
async function waitForHost(
  ctx: Context,
  child: ChildProcess | undefined,
): Promise<{ info: HostRuntimeInfo; hello: HostHello }> {
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  child?.once('exit', (code, signal) => {
    exit = { code, signal };
  });
  child?.once('error', (error) => {
    spawnError = error;
  });
  const deadline = performance.now() + START_TIMEOUT_MS;
  let lastError: unknown;
  while (performance.now() < deadline) {
    if (spawnError) throw new CliError(`无法启动 Host：${spawnError.message}`);
    // 退出码 3：并发启动时别人先占住了数据目录，接着等那个 Host 就绪即可。
    if (exit && exit.code !== EXIT_CODE.alreadyRunning) {
      throw new CliError(
        `Host 启动失败（${exit.signal ? `信号 ${exit.signal}` : `退出码 ${exit.code}`}）。${await stdioTail(ctx.home)}`,
        `完整输出见 ${join(ctx.home, HOME_LAYOUT.logsDir, HOST_STDIO_LOG)} 与 logs/host.log`,
      );
    }
    const runtime = await readRuntime(ctx.home);
    if (runtime.kind === 'live') {
      try {
        const { hello } = await probe(ctx, 2000);
        return { info: runtime.info, hello };
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(100);
  }
  throw new CliError(
    `Host 在 ${START_TIMEOUT_MS / 1000} s 内没有就绪${lastError ? `（${describeError(lastError).message}）` : ''}。`,
    `查看 ${join(ctx.home, HOME_LAYOUT.logsDir, 'host.log')}`,
  );
}

async function stdioTail(home: string): Promise<string> {
  try {
    const text = await readFile(join(home, HOME_LAYOUT.logsDir, HOST_STDIO_LOG), 'utf8');
    const lines = text.trimEnd().split('\n').slice(-5).join('\n');
    return lines ? `\n${lines}` : '';
  } catch {
    return '';
  }
}

export async function hostStatus(ctx: Context): Promise<number> {
  const s = ctx.styles;
  const runtime = await readRuntime(ctx.home);
  switch (runtime.kind) {
    case 'missing':
      ctx.print('Host 没有在运行。');
      ctx.print(s.dim(`数据目录 ${ctx.home}`));
      ctx.print(s.dim('下一步：运行 wevir host start'));
      return EXIT.failure;
    case 'stale':
      ctx.print(`Host 没有在运行（pid ${runtime.info.pid} 已退出，运行时文件是它留下的）。`);
      ctx.print(s.dim('下一步：运行 wevir host start（会自动清理旧文件）'));
      return EXIT.failure;
    case 'invalid':
      throw new CliError(
        `运行时文件 ${runtime.path} 的内容不对。`,
        '确认没有 Host 在运行后删除它，再运行 wevir host start',
      );
    case 'starting':
      ctx.print(`Host 正在启动（pid ${runtime.info.pid}）。`);
      return EXIT.failure;
    case 'live':
      break;
  }
  const { info } = runtime;
  let result: Probe;
  try {
    result = await probe(ctx);
  } catch (error) {
    throw new CliError(
      `Host 进程（pid ${info.pid}）在运行，但连不上：${describeError(error).message}`,
      `查看日志 ${join(ctx.home, HOME_LAYOUT.logsDir, 'host.log')}`,
    );
  }
  const { hello, latencyMs } = result;
  ctx.print(s.green('Host 运行中'));
  ctx.print(
    table(
      ['', ''],
      [
        ['pid', `${info.pid}（启动于 ${formatTime(info.startedAt)}）`],
        ['地址', info.url ?? ''],
        ['版本', `Host ${hello.hostVersion} · 协议 ${hello.protocolVersion}`],
        ['Host ID', hello.hostId],
        ['响应', `${latencyMs} ms`],
        ['数据目录', ctx.home],
      ],
    )
      .split('\n')
      .slice(1)
      .map((line) => `  ${line}`)
      .join('\n'),
  );
  return EXIT.ok;
}

/** 走 `host.shutdown` 让 Host 优雅退出（Windows 上不能用信号优雅停止，ADR-0002 §6）。 */
export async function hostStop(ctx: Context): Promise<number> {
  const runtime = await readRuntime(ctx.home);
  if (runtime.kind === 'missing' || runtime.kind === 'stale') {
    ctx.print('Host 没有在运行。');
    return EXIT.ok;
  }
  if (runtime.kind === 'invalid') {
    throw new CliError(`运行时文件 ${runtime.path} 的内容不对。`, '运行 wevir host status 查看');
  }
  if (runtime.kind === 'starting') {
    throw new CliError(
      `Host 正在启动（pid ${runtime.info.pid}）。`,
      '等它就绪后再运行 wevir host stop',
    );
  }
  const { pid } = runtime.info;
  const client = await connect(ctx);
  try {
    await client.request('host.shutdown', {});
  } catch (error) {
    // Host 先回响应再断开所有连接；断开先到、或它本来就在退出，同样等它退出即可。
    const exiting =
      error instanceof ConnectionLostError ||
      error instanceof ClientClosedError ||
      isRpcError(error, 'HOST_SHUTTING_DOWN');
    if (!exiting) throw error;
  } finally {
    client.close();
  }
  ctx.print(`Host（pid ${pid}）正在退出…`);
  const deadline = performance.now() + STOP_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (!isProcessAlive(pid)) {
      ctx.print('Host 已停止。');
      return EXIT.ok;
    }
    await sleep(100);
  }
  throw new CliError(
    `Host（pid ${pid}）在 ${STOP_TIMEOUT_MS / 1000} s 内没有退出。`,
    `查看 ${join(ctx.home, HOME_LAYOUT.logsDir, 'host.log')}；仍不退出时手动结束该进程`,
  );
}
