import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  CodexAdapter,
  CodexRuntime,
  resolveCodexBinary,
  resolvePromptsDir,
} from '@wevir/adapter-codex';
import { type AccountKind, SUBSCRIPTION_KINDS, type SubscriptionKind } from '@wevir/protocol';
import type { AgentRuntimeAdapter } from '@wevir/runtime-adapter';
import { type AppToolsBridge, appToolsBridge } from '@wevir/runtime-adapter/app-tools-bridge';
import {
  EchoAccounts,
  type EchoAccountsOptions,
  EchoAdapter,
  parseEchoScenarios,
} from '@wevir/runtime-adapter/echo';
import { type HistoryToolServer, historyToolServer } from '@wevir/runtime-adapter/history-tool';
import type { WebToolServer } from '@wevir/runtime-adapter/web-tool';
import { HOST_CLI_TEXT, type HostCliLocale, hostCliLocale } from './cli-text.js';
import { EngineRouter } from './engine-router.js';
import {
  isIgnorableEngineRejection,
  subscriptionAccountEngines,
  subscriptionEngines,
} from './engines.js';
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
import { WebService } from './web/service.js';

export const ADAPTER_KINDS = ['echo', 'codex'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

export { type HostCliLocale, hostCliLocale } from './cli-text.js';
export { EXIT_CODE } from './exit-code.js';

/** 帮助文字，按语言（cli-text.ts）。 */
export function hostUsage(locale: HostCliLocale = 'en'): string {
  return HOST_CLI_TEXT[locale].usage;
}

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

/** 解析命令行参数（不读环境变量，`WEVIR_HOME` 在 `resolveHome` 里处理；报错的语言由调用方给）。 */
export function parseHostArgs(
  argv: readonly string[],
  locale: HostCliLocale = 'en',
): ParsedHostArgs {
  const text = HOST_CLI_TEXT[locale];
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
    return { kind: 'error', message: text.badAdapter(ADAPTER_KINDS.join(' | '), adapter) };
  }
  const logLevel = values['log-level'] ?? 'info';
  if (!isLogLevel(logLevel)) {
    return { kind: 'error', message: text.badLogLevel(logLevel) };
  }
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!/^\d+$/.test(values.port ?? '0') || port > 65535) {
    return { kind: 'error', message: text.badPort(values.port) };
  }
  if (values.home === '') return { kind: 'error', message: text.emptyHome };

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
  /** 数据目录（绝对路径）；Codex 适配器用其中的 `engines/`（ADR-0005 决策 5）。 */
  home: string;
  /** Host 的日志；适配器的告警（旁路失效、映射不了的更新等）与网关的请求日志写进来。 */
  logger: Logger;
  /** Host 进程的环境变量（`WEVIR_ECHO_SUBSCRIPTIONS` 等）；省略时当作空。 */
  env?: NodeJS.ProcessEnv;
  /** 读历史的本机 MCP 服务（0.25.0，接力）；`createAdapter` 为 Codex 与订阅引擎写好脚本后填上。 */
  historyTool?: HistoryToolServer;
  /** 应用级工具的 stdio 桥（0.30.0）：ACP 的引擎（Grok、Antigravity、WorkBuddy）经它连 Host 的 `/mcp`。 */
  appToolsBridge?: AppToolsBridge;
  /** 联网工具的本机 MCP 服务（0.34.0，web/service.ts）；`runHostCli` 建好 Host 的联网服务后填上。 */
  webTool?: WebToolServer;
}

/** echo 的假订阅里能添加账号的种类（0.63.0），同真实引擎的第一轮。 */
const ECHO_ACCOUNT_KINDS: readonly AccountKind[] = ['claude', 'cursor', 'grok', 'antigravity'];

/** 经网关或 Codex 自己的 Provider 种类，交给默认引擎（Codex 或 echo）。 */
const GATEWAY_KINDS = [
  'deepseek-official',
  'openai-compatible',
  'google-vertex',
  'chatgpt',
] as const;

/**
 * 开发用：echo 引擎挂上假的订阅账号（`WEVIR_ECHO_SUBSCRIPTIONS`，见 runtime-adapter 的 echo-accounts.ts），订阅来源的会话也由
 * echo 回答。同真实的订阅引擎，不能代码审查（`engineFeatures` 的 `commands` 只有 `compact`）。
 */
class EchoSubscriptionEngine extends EchoAdapter {
  readonly accounts: EchoAccounts;

  constructor(scenarios: string | undefined, added?: EchoAccountsOptions['added']) {
    super();
    this.accounts = new EchoAccounts(
      added === undefined ? { scenarios: parseEchoScenarios(scenarios) } : { added },
    );
    Object.assign(this, { review: undefined });
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
      // 添加的账号（0.63.0）：每个一个只有这一种的假引擎，在应用内登录。
      return new EngineRouter(
        [
          { name: 'echo', adapter: new EchoAdapter(), kinds: GATEWAY_KINDS },
          {
            name: 'echo-subscriptions',
            adapter: new EchoSubscriptionEngine(scenarios),
            kinds: SUBSCRIPTION_KINDS,
          },
        ],
        {
          accountEngines: {
            kinds: ECHO_ACCOUNT_KINDS,
            create: (kind, { id }) =>
              new EchoSubscriptionEngine(undefined, {
                kind: kind as SubscriptionKind,
                email: `${id}@example.com`,
              }),
          },
        },
      );
    }
    case 'codex': {
      // 两个 codex-app-server 进程（网关进程与 ChatGPT 进程，ADR-0005 补记 10）都在第一次用到时才启动（Provider 只交给
      // 网关与下一次启动的配置）。二进制在这里就解析：没下载时 Host 直接启动失败并给出下载命令，而不是等到建会话才报错；
      // 版本在第一次启动前核对。网关令牌经 logger.addSecret 从日志里抹掉。
      // 读历史的工具（0.25.0）：接力过来的会话经它读之前的历史，引擎各自挂上；脚本由引擎第一次启动前写进数据目录。
      const historyTool = historyToolServer(
        homePath(context.home, 'mcpDir'),
        homePath(context.home, 'historyDir'),
      );
      // 联网工具（0.34.0）：只挂在 Codex 上，其余引擎有自己的联网工具（docs/architecture/web-tools.md §5）。
      const codexOptions = {
        home: context.home,
        binary: resolveCodexBinary(),
        promptsDir: resolvePromptsDir(context.env ?? {}),
        clientInfo: { name: 'wevir', version: HOST_VERSION },
        logger: context.logger,
        historyTool,
        ...(context.webTool !== undefined && { webTool: context.webTool }),
      };
      const codex = new CodexRuntime(codexOptions);
      // 订阅来源各自的引擎（ADR-0005 补记 14）。
      // 应用级工具（0.30.0）：Codex、Claude、Cursor 直接连 HTTP，ACP 的引擎经 stdio 桥。
      const engineContext = {
        ...context,
        historyTool,
        appToolsBridge: appToolsBridge(homePath(context.home, 'mcpDir')),
      };
      const subscriptions = subscriptionEngines(engineContext);
      // 添加的账号（0.63.0）：ChatGPT 的是又一个 ChatGPT 进程（自己的 CODEX_HOME 与 Provider ID），其余见 engines.ts。
      const accounts = subscriptionAccountEngines(engineContext);
      return new EngineRouter(
        [{ name: 'codex', adapter: codex, kinds: GATEWAY_KINDS }, ...subscriptions],
        {
          accountEngines: {
            kinds: ['chatgpt', ...accounts.kinds],
            create: (kind, account) =>
              kind === 'chatgpt'
                ? new CodexAdapter({
                    ...codexOptions,
                    mode: 'chatgpt',
                    account: {
                      codexHome: join(account.root, 'codex'),
                      providerId: account.id,
                    },
                  })
                : accounts.create(kind, account),
          },
        },
      );
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
  const locale = hostCliLocale(proc.env);
  const text = HOST_CLI_TEXT[locale];
  const parsed = parseHostArgs(proc.argv, locale);
  switch (parsed.kind) {
    case 'help':
      proc.stdout.write(`${text.usage}\n`);
      return EXIT_CODE.ok;
    case 'version':
      proc.stdout.write(`${HOST_VERSION}\n`);
      return EXIT_CODE.ok;
    case 'error':
      proc.stderr.write(`wevir-host: ${parsed.message}\n${text.seeHelp}\n`);
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

  // 联网服务（0.34.0）：引擎构造时要它的描述，Host 启动时才监听。
  const web = new WebService({
    settingsFile: homePath(home, 'webFile'),
    mcpDir: homePath(home, 'mcpDir'),
    logger,
  });
  let adapter: AgentRuntimeAdapter;
  try {
    adapter = (overrides.createAdapter ?? createAdapter)(options.adapter, {
      home,
      logger,
      env: proc.env,
      webTool: web.tool,
    });
  } catch (error) {
    logger.error('failed to create adapter', { adapter: options.adapter, error });
    logger.close();
    proc.stderr.write(
      `wevir-host: ${text.adapterFailed(options.adapter, (error as Error).message)}\n`,
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
    proc.on('unhandledRejection', (reason: unknown) => {
      if (isIgnorableEngineRejection(reason)) {
        logger.warn('engine shell spawn failed; the host keeps running', { error: reason });
        return;
      }
      onFatal(reason);
    });
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
      // 会话标题的提示词与 Codex 的基础提示词在同一个目录：安装包里是资源目录的 prompts/（ADR-0007）。
      promptsDir: resolvePromptsDir(proc.env),
      web,
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
          const { pid, startedAt } = error.existing;
          proc.stderr.write(
            `wevir-host: ${text.alreadyRunning({ home, pid, startedAt, path: error.path })}\n`,
          );
          finish(EXIT_CODE.alreadyRunning);
          return;
        }
        logger.error('failed to start', { error });
        proc.stderr.write(
          `wevir-host: ${text.startFailed((error as Error).message ?? String(error))}\n`,
        );
        finish(EXIT_CODE.failure);
      },
    );
  });
}
