import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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
import { t } from '../i18n/index.js';

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

/** 资源目录的环境变量（与 adapter-codex 的 `RESOURCES_DIR_ENV` 相同）：Host 在它下面找 codex-app-server 与提示词。 */
export const RESOURCES_DIR_ENV = 'WEVIR_RESOURCES_DIR';

/**
 * 自带 Node 的命令行包（apps/cli/scripts/package.ts）里的资源目录：CLI 的 bundle 在 `lib/cli/`，Host 的 bundle、
 * codex-app-server 与提示词在 `lib/` 下，布局与桌面端的资源目录相同。不在这样的包里（开发时）返回 undefined。
 */
export function bundledResourcesDir(from: string | URL = import.meta.url): string | undefined {
  const dir = dirname(dirname(fileURLToPath(from)));
  return existsSync(join(dir, 'host', 'dist', 'main.js')) ? dir : undefined;
}

/**
 * `wevir-host` 可执行入口：命令行包里是资源目录的 `host/dist/main.js`（`resourcesDir`），开发时是 `@wevir/host` 的
 * `bin['wevir-host']`（指向 `dist/`，要先 `pnpm build`）。
 */
export function resolveHostEntry(
  resourcesDir: string | undefined = bundledResourcesDir(),
  from: string | URL = import.meta.url,
): string {
  if (resourcesDir !== undefined) return join(resourcesDir, 'host', 'dist', 'main.js');
  const require = createRequire(from);
  const manifestPath = require.resolve('@wevir/host/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: unknown };
  const bin = (manifest.bin as Record<string, unknown> | undefined)?.['wevir-host'];
  if (typeof bin !== 'string') throw new CliError(t('host.noBin', { path: manifestPath }));
  const entry = resolve(dirname(manifestPath), bin);
  if (!existsSync(entry)) {
    throw new CliError(t('host.noEntry', { path: entry }), t('host.noEntry.hint'));
  }
  return entry;
}

export async function hostStart(ctx: Context, options: HostStartOptions): Promise<number> {
  const s = ctx.styles;
  const runtime = await readRuntime(ctx.home);
  if (runtime.kind === 'invalid') {
    throw new CliError(
      t('host.invalidRuntime', { path: runtime.path }),
      t('host.invalidRuntime.hint'),
    );
  }
  if (runtime.kind === 'live') {
    try {
      const { hello } = await probe(ctx);
      ctx.print(t('host.alreadyRunning', { pid: runtime.info.pid, version: hello.hostVersion }));
      ctx.print(s.dim(t('host.dataDir', { path: ctx.home })));
      return EXIT.ok;
    } catch (error) {
      throw new CliError(
        t('host.unreachable', { pid: runtime.info.pid, error: describeError(error).message }),
        t('host.unreachable.startHint', { log: join(ctx.home, HOME_LAYOUT.logsDir, 'host.log') }),
      );
    }
  }

  let child: ChildProcess | undefined;
  if (runtime.kind === 'starting') {
    ctx.print(t('host.waitingStart', { pid: runtime.info.pid }));
  } else {
    child = await spawnDetached(ctx, options);
  }
  const { info, hello } = await waitForHost(ctx, child);
  ctx.print(
    t('host.started', {
      pid: info.pid,
      version: hello.hostVersion,
      protocol: hello.protocolVersion,
    }),
  );
  ctx.print(s.dim(t('host.dataDir', { path: ctx.home })));
  ctx.print(s.dim(t('host.logFile', { path: join(ctx.home, HOME_LAYOUT.logsDir, 'host.log') })));
  return EXIT.ok;
}

/**
 * 以分离方式启动 Host（ADR-0002 §6）：自成进程组、不持有 stdin 归属管道，CLI 退出、终端关闭都不影响它；
 * 桌面之后附着到它，退出时也不会停止它。stdout / stderr 追加到 `logs/host-stdio.log`。
 */
async function spawnDetached(ctx: Context, options: HostStartOptions): Promise<ChildProcess> {
  const resourcesDir = bundledResourcesDir();
  const entry = resolveHostEntry(resourcesDir);
  const logsDir = join(ctx.home, HOME_LAYOUT.logsDir);
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  const out = openSync(join(logsDir, HOST_STDIO_LOG), 'a', 0o600);
  const args = [entry, '--home', ctx.home];
  if (options.adapter) args.push('--adapter', options.adapter);
  if (options.logLevel) args.push('--log-level', options.logLevel);
  try {
    // 用运行 CLI 的同一个 Node；spawn 不继承 execArgv。cwd 放在数据目录，不占用用户当前所在的目录。
    // 命令行包里把资源目录交给 Host；环境里已经有时不覆盖（与桌面端相同，排查时用别的资源目录）。
    const env =
      resourcesDir !== undefined && !ctx.io.env[RESOURCES_DIR_ENV]
        ? { ...ctx.io.env, [RESOURCES_DIR_ENV]: resourcesDir }
        : ctx.io.env;
    const child = spawn(process.execPath, args, {
      cwd: ctx.home,
      env,
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
    if (spawnError) throw new CliError(t('host.spawnFailed', { error: spawnError.message }));
    // 退出码 3：并发启动时别人先占住了数据目录，接着等那个 Host 就绪即可。
    if (exit && exit.code !== EXIT_CODE.alreadyRunning) {
      const why = exit.signal
        ? t('host.startFailed.signal', { signal: exit.signal })
        : t('host.startFailed.exitCode', { code: String(exit.code) });
      throw new CliError(
        t('host.startFailed', { why, tail: await stdioTail(ctx.home) }),
        t('host.startFailed.hint', { stdio: join(ctx.home, HOME_LAYOUT.logsDir, HOST_STDIO_LOG) }),
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
  const seconds = START_TIMEOUT_MS / 1000;
  throw new CliError(
    lastError
      ? t('host.notReadyWhy', { seconds, error: describeError(lastError).message })
      : t('host.notReady', { seconds }),
    t('host.seeLog', { log: join(ctx.home, HOME_LAYOUT.logsDir, 'host.log') }),
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
      ctx.print(t('host.notRunning'));
      ctx.print(s.dim(t('host.dataDir', { path: ctx.home })));
      ctx.print(s.dim(t('error.hint', { hint: t('host.notRunning.hint') })));
      return EXIT.failure;
    case 'stale':
      ctx.print(t('host.stale', { pid: runtime.info.pid }));
      ctx.print(s.dim(t('error.hint', { hint: t('host.stale.hint') })));
      return EXIT.failure;
    case 'invalid':
      throw new CliError(
        t('host.invalidRuntime', { path: runtime.path }),
        t('host.invalidRuntime.hint'),
      );
    case 'starting':
      ctx.print(t('host.starting', { pid: runtime.info.pid }));
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
      t('host.unreachable', { pid: info.pid, error: describeError(error).message }),
      t('host.unreachable.statusHint', { log: join(ctx.home, HOME_LAYOUT.logsDir, 'host.log') }),
    );
  }
  const { hello, latencyMs } = result;
  ctx.print(s.green(t('host.running')));
  ctx.print(
    table(
      ['', ''],
      [
        ['pid', t('host.row.pidValue', { pid: info.pid, time: formatTime(info.startedAt) })],
        [t('host.row.address'), info.url ?? ''],
        [
          t('host.row.version'),
          t('host.row.versionValue', {
            version: hello.hostVersion,
            protocol: hello.protocolVersion,
          }),
        ],
        ['Host ID', hello.hostId],
        [t('host.row.latency'), `${latencyMs} ms`],
        [t('host.row.dataDir'), ctx.home],
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
    ctx.print(t('host.notRunning'));
    return EXIT.ok;
  }
  if (runtime.kind === 'invalid') {
    throw new CliError(
      t('host.invalidRuntime', { path: runtime.path }),
      t('host.invalidRuntime.stopHint'),
    );
  }
  if (runtime.kind === 'starting') {
    throw new CliError(t('host.starting', { pid: runtime.info.pid }), t('host.starting.stopHint'));
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
  ctx.print(t('host.stopping', { pid }));
  const deadline = performance.now() + STOP_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (!isProcessAlive(pid)) {
      ctx.print(t('host.stopped'));
      return EXIT.ok;
    }
    await sleep(100);
  }
  throw new CliError(
    t('host.stopTimeout', { pid, seconds: STOP_TIMEOUT_MS / 1000 }),
    t('host.stopTimeout.hint', { log: join(ctx.home, HOME_LAYOUT.logsDir, 'host.log') }),
  );
}
