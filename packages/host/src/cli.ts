import { parseArgs } from 'node:util';
import { CodexRuntime, resolveCodexBinary } from '@wevir/adapter-codex';
import { DshAdapter, resolveDshEntry } from '@wevir/adapter-dsh';
import { SUBSCRIPTION_KINDS } from '@wevir/protocol';
import type { AgentRuntimeAdapter } from '@wevir/runtime-adapter';
import { EchoAccounts, EchoAdapter, parseEchoScenarios } from '@wevir/runtime-adapter/echo';
import { EngineRouter } from './engine-router.js';
import { subscriptionEngines } from './engines.js';
import { EXIT_CODE } from './exit-code.js';
import { homePath, resolveHome } from './home.js';
import {
  HOST_VERSION,
  type RunningHost,
  SHUTDOWN_TIMEOUT_MS,
  type ShutdownTrigger,
  startHost,
} from './host-process.js';
import { createLogger, isLogLevel, type Logger, type LogLevel } from './logger.js';
import { HostAlreadyRunningError } from './runtime-file.js';

export const ADAPTER_KINDS = ['echo', 'dsh', 'codex'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

export { EXIT_CODE } from './exit-code.js';

export const USAGE = `用法：wevir-host [选项]

  --home <目录>          数据目录。环境变量 WEVIR_HOME 优先于它；都没有时用平台默认
                         （macOS ~/Library/Application Support/Wevir，Windows %APPDATA%\\Wevir，
                         Linux $XDG_DATA_HOME/wevir）
  --adapter <codex|dsh|echo>
                         引擎适配器，默认 codex：codex-app-server（ADR-0005，二进制见 WEVIR_CODEX_BIN
                         或 bash scripts/fetch-codex.sh）；dsh 是 DeepSeek Harness（可选引擎）；echo 是开发用
                         的假引擎
  --port <端口>          仅调试用，默认 0（系统分配）；客户端一律以 run/host.json 里的 url 为准
  --log-level <级别>     debug | info | warn | error，默认 info；日志写到 <数据目录>/logs/host.log
  --exit-on-stdin-eof    由桌面拉起时使用：拉起方持有 stdin 管道，读到 EOF 即优雅退出
  -h, --help             显示本帮助
  -v, --version          显示版本

退出码：0 正常退出；1 运行失败或退出超时被强制结束；2 参数错误；3 该数据目录已有 Host 在运行。`;

export interface HostCliOptions {
  home?: string;
  adapter: AdapterKind;
  port: number;
  logLevel: LogLevel;
  exitOnStdinEof: boolean;
}

export type ParsedHostArgs =
  | { kind: 'run'; options: HostCliOptions }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

/** 解析命令行参数（不读环境变量，`WEVIR_HOME` 在 `resolveHome` 里处理）。 */
export function parseHostArgs(argv: readonly string[]): ParsedHostArgs {
  let values: ReturnType<typeof parse>['values'];
  try {
    ({ values } = parse(argv));
  } catch (error) {
    return { kind: 'error', message: (error as Error).message };
  }
  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };

  const adapter = values.adapter ?? 'codex';
  if (!(ADAPTER_KINDS as readonly string[]).includes(adapter)) {
    return { kind: 'error', message: `--adapter 只能是 ${ADAPTER_KINDS.join(' | ')}：${adapter}` };
  }
  const logLevel = values['log-level'] ?? 'info';
  if (!isLogLevel(logLevel)) {
    return {
      kind: 'error',
      message: `--log-level 只能是 debug | info | warn | error：${logLevel}`,
    };
  }
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!/^\d+$/.test(values.port ?? '0') || port > 65535) {
    return { kind: 'error', message: `--port 必须是 0–65535 的整数：${values.port}` };
  }
  if (values.home === '') return { kind: 'error', message: '--home 不能为空' };

  const options: HostCliOptions = {
    adapter: adapter as AdapterKind,
    port,
    logLevel,
    exitOnStdinEof: values['exit-on-stdin-eof'] ?? false,
  };
  if (values.home !== undefined) options.home = values.home;
  return { kind: 'run', options };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      home: { type: 'string' },
      adapter: { type: 'string' },
      port: { type: 'string' },
      'log-level': { type: 'string' },
      'exit-on-stdin-eof': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}

/** 构造适配器时可用的东西。 */
export interface AdapterContext {
  /** 数据目录（绝对路径）；dsh 与 Codex 适配器用其中的 `engines/`（ADR-0001 §4、ADR-0005 决策 5）。 */
  home: string;
  /** Host 的日志；适配器的告警（旁路失效、映射不了的更新等）与网关的请求日志写进来。 */
  logger: Logger;
  /** Host 进程的环境变量（`WEVIR_ECHO_SUBSCRIPTIONS` 等）；省略时当作空。 */
  env?: NodeJS.ProcessEnv;
}

/** 经网关或 Codex 自己的 Provider 种类，交给默认引擎（Codex、dsh 或 echo）。 */
const GATEWAY_KINDS = ['deepseek-official', 'openai-compatible', 'chatgpt'] as const;

/**
 * 开发用：echo 引擎挂上假的订阅账号（`WEVIR_ECHO_SUBSCRIPTIONS`，见 runtime-adapter 的 echo-accounts.ts），订阅来源的会话也由
 * echo 回答。
 */
class EchoSubscriptionEngine extends EchoAdapter {
  readonly accounts: EchoAccounts;

  constructor(scenarios: string | undefined) {
    super();
    this.accounts = new EchoAccounts({ scenarios: parseEchoScenarios(scenarios) });
  }

  override async dispose(): Promise<void> {
    this.accounts.dispose();
    await super.dispose();
  }
}

export function createAdapter(kind: AdapterKind, context: AdapterContext): AgentRuntimeAdapter {
  switch (kind) {
    case 'echo': {
      const scenarios = context.env?.WEVIR_ECHO_SUBSCRIPTIONS;
      if (scenarios === undefined || scenarios === '') return new EchoAdapter();
      return new EngineRouter([
        { name: 'echo', adapter: new EchoAdapter(), kinds: GATEWAY_KINDS },
        {
          name: 'echo-subscriptions',
          adapter: new EchoSubscriptionEngine(scenarios),
          kinds: SUBSCRIPTION_KINDS,
        },
      ]);
    }
    case 'dsh':
      // dsh 进程在第一个会话时才启动（Provider 只写 overlay）。可执行入口在这里就解析：依赖没装好或版本不对时
      // Host 直接启动失败，而不是等到建会话才报错。增量旁路默认开启（T3.2a）。
      return new DshAdapter({
        home: context.home,
        entry: resolveDshEntry().entry,
        clientInfo: { name: 'wevir', version: HOST_VERSION },
        logger: context.logger,
      });
    case 'codex': {
      // 两个 codex-app-server 进程（网关进程与 ChatGPT 进程，ADR-0005 补记 10）都在第一次用到时才启动（Provider 只交给
      // 网关与下一次启动的配置）。二进制在这里就解析：没下载时 Host 直接启动失败并给出下载命令，而不是等到建会话才报错；
      // 版本在第一次启动前核对。网关令牌经 logger.addSecret 从日志里抹掉。
      const codex = new CodexRuntime({
        home: context.home,
        binary: resolveCodexBinary(),
        clientInfo: { name: 'wevir', version: HOST_VERSION },
        logger: context.logger,
      });
      // 订阅来源各自的引擎（ADR-0005 补记 14）；没有时 Host 只有 Codex。
      const subscriptions = subscriptionEngines(context);
      if (subscriptions.length === 0) return codex;
      return new EngineRouter([
        { name: 'codex', adapter: codex, kinds: GATEWAY_KINDS },
        ...subscriptions,
      ]);
    }
  }
}

/** `runHostCli` 用到的进程能力，测试时可替换。 */
export interface HostCliProcess {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown; isTTY?: boolean };
  on(event: 'SIGINT' | 'SIGTERM', listener: (signal: NodeJS.Signals) => void): unknown;
  on(
    event: 'uncaughtException' | 'unhandledRejection',
    listener: (error: unknown) => void,
  ): unknown;
  pid: number;
}

/** 测试用：替换适配器的构造与退出时限。 */
export interface HostCliOverrides {
  createAdapter?: (kind: AdapterKind, context: AdapterContext) => AgentRuntimeAdapter;
  shutdownTimeoutMs?: number;
}

/**
 * `wevir-host` 的主流程，返回退出码（调用方负责 `process.exit`）。启动成功后一直运行，直到以下任一
 * 触发优雅退出（ADR-0002 §6）：`host.shutdown`、SIGINT / SIGTERM、`--exit-on-stdin-eof` 时 stdin
 * 读到 EOF、未捕获的异常（退出码 1）。退出流程超过 10 s，或退出期间再收到 SIGINT / SIGTERM，就删除
 * 自己的 `host.json` 后以 1 强制结束。
 *
 * 就绪后向 stdout 写一行 JSON：`{"event":"ready","pid","url","hostId","home"}`（不含令牌），方便
 * 拉起方知道何时可以读 `host.json`。
 */
export async function runHostCli(
  proc: HostCliProcess,
  overrides: HostCliOverrides = {},
): Promise<number> {
  const shutdownTimeoutMs = overrides.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const parsed = parseHostArgs(proc.argv);
  switch (parsed.kind) {
    case 'help':
      proc.stdout.write(`${USAGE}\n`);
      return EXIT_CODE.ok;
    case 'version':
      proc.stdout.write(`${HOST_VERSION}\n`);
      return EXIT_CODE.ok;
    case 'error':
      proc.stderr.write(`wevir-host: ${parsed.message}\n运行 wevir-host --help 查看用法。\n`);
      return EXIT_CODE.usage;
  }
  const { options } = parsed;

  const home = resolveHome({
    ...(options.home !== undefined && { home: options.home }),
    env: proc.env,
  });
  const logger = createLogger({
    level: options.logLevel,
    dir: homePath(home, 'logsDir'),
    base: { pid: proc.pid },
    ...(proc.stderr.isTTY && { mirror: (line: string) => proc.stderr.write(`${line}\n`) }),
  });
  logger.info('starting', {
    home,
    adapter: options.adapter,
    port: options.port,
    logLevel: options.logLevel,
    exitOnStdinEof: options.exitOnStdinEof,
    hostVersion: HOST_VERSION,
    node: process.version,
  });

  let adapter: AgentRuntimeAdapter;
  try {
    adapter = (overrides.createAdapter ?? createAdapter)(options.adapter, {
      home,
      logger,
      env: proc.env,
    });
  } catch (error) {
    logger.error('failed to create adapter', { adapter: options.adapter, error });
    logger.close();
    proc.stderr.write(
      `wevir-host: 无法创建 ${options.adapter} 适配器：${(error as Error).message}\n`,
    );
    return EXIT_CODE.failure;
  }

  return new Promise<number>((resolve) => {
    let host: RunningHost | undefined;
    /** 启动完成前到达的退出请求，启动完成后立即处理。 */
    let pending: { trigger: ShutdownTrigger; code: number } | undefined;
    let stopping = false;
    let finished = false;

    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      logger.close();
      resolve(code);
    };

    const forceExit = (reason: string): void => {
      logger.error('forced exit', { reason });
      host?.releaseRuntimeFileSync();
      finish(EXIT_CODE.failure);
    };

    const beginShutdown = (trigger: ShutdownTrigger, code: number): void => {
      if (stopping) {
        if (trigger.kind === 'signal') forceExit(`received ${trigger.signal} during shutdown`);
        return;
      }
      if (!host) {
        // 启动卡住时，第二次 Ctrl-C 仍能结束进程。
        if (pending && trigger.kind === 'signal') {
          forceExit(`received ${trigger.signal} again during startup`);
          return;
        }
        pending ??= { trigger, code };
        return;
      }
      stopping = true;
      const running = host;
      const timer = setTimeout(
        () => forceExit(`shutdown did not finish within ${shutdownTimeoutMs} ms`),
        shutdownTimeoutMs,
      );
      void running.shutdown(trigger).then(() => {
        clearTimeout(timer);
        finish(code);
      });
    };

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      proc.on(signal, () => beginShutdown({ kind: 'signal', signal }, EXIT_CODE.ok));
    }
    const onFatal = (error: unknown): void => {
      logger.error('fatal error', { error });
      if (host) beginShutdown({ kind: 'fatal', error }, EXIT_CODE.failure);
      else finish(EXIT_CODE.failure);
    };
    proc.on('uncaughtException', onFatal);
    proc.on('unhandledRejection', onFatal);
    if (options.exitOnStdinEof) {
      const onEof = () => beginShutdown({ kind: 'stdin_eof' }, EXIT_CODE.ok);
      // 内容丢弃；只关心管道何时结束（拉起方退出或崩溃）。
      proc.stdin.on('data', () => {});
      proc.stdin.once('end', onEof);
      proc.stdin.once('error', onEof);
      proc.stdin.resume();
    }

    startHost({
      home,
      adapter,
      engine: options.adapter,
      logger,
      ...(options.port !== 0 && { port: options.port }),
      onShutdownRequest: (trigger) => beginShutdown(trigger, EXIT_CODE.ok),
    }).then(
      (running) => {
        host = running;
        proc.stdout.write(
          `${JSON.stringify({
            event: 'ready',
            pid: proc.pid,
            url: running.url,
            hostId: running.hostId,
            home,
          })}\n`,
        );
        if (pending) beginShutdown(pending.trigger, pending.code);
      },
      (error: unknown) => {
        if (error instanceof HostAlreadyRunningError) {
          logger.error('another host is running', { path: error.path, existing: error.existing });
          proc.stderr.write(
            `wevir-host: 数据目录 ${home} 已有 Host 在运行（pid ${error.existing.pid}，` +
              `启动于 ${error.existing.startedAt}）。客户端请读取 ${error.path} 附着到它。\n`,
          );
          finish(EXIT_CODE.alreadyRunning);
          return;
        }
        logger.error('failed to start', { error });
        proc.stderr.write(`wevir-host: 启动失败：${(error as Error).message ?? String(error)}\n`);
        finish(EXIT_CODE.failure);
      },
    );
  });
}
