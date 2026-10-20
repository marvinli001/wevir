// Antigravity 进程（docs/architecture/antigravity-event-mapping.md §3）：adapter-acp 的 AcpProcess 加 Antigravity 的启动器
// （找运行体、准备私有 profile、每个进程自己的临时目录）与 stdout / stderr 上的登录网址。会话进程在 initialize 之后先
// `authenticate`（照 T3 的 authenticateEagerly）：已登录时立即通过；没登录时运行体会去开浏览器，Wevir 认出登录网址就
// 停掉这个进程、报 `missing_credentials`，登录只在设置里做（accounts.ts）。

import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {
  type AcpLauncher,
  type AcpPreparedLaunch,
  AcpProcess,
  type AcpProcessHooks,
  type AdapterLogger,
} from '@wevir/adapter-acp';
import { type ClientConnection, type InitializeResponse, methods } from '@wevir/adapter-acp/sdk';
import { AdapterError } from '@wevir/runtime-adapter';
import { ANTIGRAVITY_ENGINE } from './engine.js';
import {
  type AntigravityExecutable,
  type AntigravityInstallation,
  AntigravityInstallationError,
} from './installation.js';
import {
  ANTIGRAVITY_AUTH_METHOD,
  type AntigravityAuthorizationUrl,
  antigravitySpawnSpec,
  antigravityStderrWatcher,
  antigravityStdoutFilter,
  prepareAntigravityProfile,
} from './profile.js';
import { matchesReleaseVersion } from './release.js';
import { removeAntigravityRuntimeTempDirs } from './session-files.js';

/** 会话进程启动时 `authenticate` 的时限（已登录时只是读本地凭据、必要时刷新令牌）。 */
export const SESSION_AUTH_TIMEOUT_MS = 60_000;
/** Antigravity 1.1.1 报协议版本 2，线上仍是 v1 的格式（T3 的 validate）。 */
export const ANTIGRAVITY_PROTOCOL_VERSIONS = [1, 2] as const;
export const SIGN_IN_REQUIRED_MESSAGE = 'Sign in to Antigravity in Settings before you continue.';

/** `<数据目录>/engines/antigravity` 下的各个位置。 */
export interface AntigravityPaths {
  root: string;
  /** GEMINI_HOME：运行体自己的登录与对话。 */
  profile: string;
  /** 每个进程的临时目录（run-*）的上级。 */
  temp: string;
  /** 最近一次读到的模型列表（不含凭据）。 */
  models: string;
}

export function antigravityPaths(home: string): AntigravityPaths {
  const root = path.join(home, 'engines', 'antigravity');
  return {
    root,
    profile: path.join(root, 'profile'),
    temp: path.join(root, 'tmp'),
    models: path.join(root, 'models.json'),
  };
}

/** 添加的账号（0.63.0）自己的 profile、临时目录与模型缓存，在 `<数据目录>/accounts/<id>/antigravity` 下。 */
export function antigravityAccountPaths(root: string): AntigravityPaths {
  return {
    root,
    profile: path.join(root, 'profile'),
    temp: path.join(root, 'tmp'),
    models: path.join(root, 'models.json'),
  };
}

/** 会话进程、登录进程与校验共用的东西。 */
export interface AntigravityRuntimeContext {
  installation: AntigravityInstallation;
  paths: AntigravityPaths;
  env: NodeJS.ProcessEnv;
  /** account.setPath 指定的可执行文件；null 自动查找。 */
  customPath(): string | null;
  /** BROWSER 钩子用的 Node；默认 Host 自己。 */
  nodeExecutable?: string;
  logger: AdapterLogger;
  clientInfo?: { name: string; version: string };
  initializeTimeoutMs?: number;
  /** 第一次启动任何进程之前清掉上一个 Host 留下的解包目录（只做一次）。 */
  sweep?: Promise<void>;
}

export function sweepOnce(context: AntigravityRuntimeContext): Promise<void> {
  context.sweep ??= removeAntigravityRuntimeTempDirs(context.paths.temp);
  return context.sweep;
}

/** 一个进程的启动方式：每次启动解析运行体、准备 profile、新建这个进程的临时目录（上一个进程的删掉）。 */
export class AntigravityLauncher implements AcpLauncher {
  readonly #context: AntigravityRuntimeContext;
  readonly #cwd: string | undefined;
  readonly #executable: AntigravityExecutable | undefined;
  #runTemp: string | undefined;
  /** 最近一次解析到的运行体。 */
  executable: AntigravityExecutable | undefined;

  constructor(
    context: AntigravityRuntimeContext,
    options: { cwd?: string; executable?: AntigravityExecutable } = {},
  ) {
    this.#context = context;
    this.#cwd = options.cwd;
    this.#executable = options.executable;
  }

  async prepare(): Promise<AcpPreparedLaunch> {
    const context = this.#context;
    await sweepOnce(context);
    await this.cleanup();
    let executable: AntigravityExecutable;
    try {
      executable = this.#executable ?? (await context.installation.resolve(context.customPath()));
    } catch (error) {
      throw error instanceof AntigravityInstallationError
        ? new Error(error.message, { cause: error })
        : error;
    }
    this.executable = executable;
    const profile = await prepareAntigravityProfile({
      profileDirectory: context.paths.profile,
      tempDirectory: context.paths.temp,
      baseEnv: context.env,
      ...(context.nodeExecutable !== undefined && { nodeExecutable: context.nodeExecutable }),
      warn: (message, fields) => context.logger.warn(message, fields),
    });
    const runTemp = await fsp.mkdtemp(path.join(profile.tempDirectory, 'run-'));
    this.#runTemp = runTemp;
    const cwd = this.#cwd ?? context.paths.root;
    return {
      spawnSpec: () =>
        antigravitySpawnSpec({
          installation: executable,
          profile,
          cwd,
          baseEnv: context.env,
          runtimeTempDirectory: runTemp,
        }),
    };
  }

  /** 删掉上一个进程的临时目录（进程已退出之后调用；Windows 上句柄可能还没放，删不掉留给下次清理）。 */
  async cleanup(): Promise<void> {
    const runTemp = this.#runTemp;
    this.#runTemp = undefined;
    if (runTemp !== undefined)
      await fsp.rm(runTemp, { recursive: true, force: true }).catch(() => {});
  }
}

export interface AntigravityProcessOptions {
  context: AntigravityRuntimeContext;
  launcher?: AntigravityLauncher;
  /** 会话进程：AcpAdapter 交来的回调。 */
  hooks?: Pick<AcpProcessHooks, 'onSessionUpdate' | 'onRequestPermission'>;
  /**
   * session：initialize 之后先 `authenticate`，要登录就停掉进程报 `missing_credentials`；none：不认证（登录、登出、
   * 校验用的进程自己决定）。
   */
  authenticate: 'session' | 'none';
  /** 认出登录网址时（登录进程用）。 */
  onAuthorizationUrl?: (url: AntigravityAuthorizationUrl) => void;
}

/** 建一个 Antigravity 的 AcpProcess（不启动）。 */
export function createAntigravityProcess(options: AntigravityProcessOptions): {
  process: AcpProcess;
  launcher: AntigravityLauncher;
} {
  const { context } = options;
  const launcher = options.launcher ?? new AntigravityLauncher(context);
  let urlListener: ((url: AntigravityAuthorizationUrl) => void) | undefined;
  const onUrl = (url: AntigravityAuthorizationUrl) => {
    options.onAuthorizationUrl?.(url);
    urlListener?.(url);
  };
  const process = new AcpProcess({
    engine: ANTIGRAVITY_ENGINE,
    launcher,
    ...(options.hooks !== undefined && {
      onSessionUpdate: options.hooks.onSessionUpdate,
      onRequestPermission: options.hooks.onRequestPermission,
    }),
    clientInfo: context.clientInfo ?? { name: 'wevir', version: '0.0.0' },
    protocolVersions: ANTIGRAVITY_PROTOCOL_VERSIONS,
    ...(context.initializeTimeoutMs !== undefined && {
      initializeTimeoutMs: context.initializeTimeoutMs,
    }),
    onStderr: antigravityStderrWatcher(onUrl),
    transformStdout: antigravityStdoutFilter(onUrl),
    ...(options.authenticate === 'session' && {
      afterInitialize: (connection: ClientConnection) =>
        authenticateSession(connection, (listener) => {
          urlListener = listener;
          return () => {
            urlListener = undefined;
          };
        }),
    }),
  });
  return { process, launcher };
}

/**
 * 会话进程的 `authenticate`：已登录时直接通过；运行体要用户去浏览器登录（认出登录网址）时报 `missing_credentials`，
 * 不等用户。
 */
async function authenticateSession(
  connection: ClientConnection,
  watch: (listener: (url: AntigravityAuthorizationUrl) => void) => () => void,
): Promise<void> {
  let unwatch: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connection.agent.request(methods.agent.authenticate, { methodId: ANTIGRAVITY_AUTH_METHOD }),
      new Promise<never>((_, reject) => {
        unwatch = watch(() =>
          reject(new AdapterError('missing_credentials', SIGN_IN_REQUIRED_MESSAGE)),
        );
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`authenticate did not finish within ${SESSION_AUTH_TIMEOUT_MS} ms`)),
          SESSION_AUTH_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === -32000) {
      throw new AdapterError('missing_credentials', SIGN_IN_REQUIRED_MESSAGE, { cause: error });
    }
    throw error;
  } finally {
    unwatch();
    clearTimeout(timer);
  }
}

/**
 * 校验下载的运行体（installation 的 `validate`，照 T3）：在临时 profile 里启动它，核对 initialize 说的是这个 Google
 * 发布：名字 `antigravity-acp`、版本、支持 resume 与 logout、有个人 Google 账号的登录方式。不认证、不建会话。
 */
export async function validateAntigravityRuntime(
  context: AntigravityRuntimeContext,
  executable: AntigravityExecutable,
  expectedVersion: string,
  signal: AbortSignal,
): Promise<void> {
  const scratch = await fsp.mkdtemp(path.join(context.paths.root, '.validate-'));
  const scoped: AntigravityRuntimeContext = {
    ...context,
    customPath: () => null,
    paths: { ...context.paths, profile: path.join(scratch, 'p'), temp: path.join(scratch, 't') },
    // 临时 profile 的解包目录在 scratch 里，随它删掉；不要清共用的 tmp。
    sweep: Promise.resolve(),
  };
  const launcher = new AntigravityLauncher(scoped, { cwd: scratch, executable });
  const { process } = createAntigravityProcess({ context: scoped, launcher, authenticate: 'none' });
  const abort = () => void process.dispose();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const initialized: InitializeResponse = await process.start();
    signal.throwIfAborted();
    const capabilities = initialized.agentCapabilities as
      | (InitializeResponse['agentCapabilities'] & {
          sessionCapabilities?: { resume?: unknown };
          auth?: { logout?: unknown };
        })
      | undefined;
    if (
      initialized.agentInfo?.name !== 'antigravity-acp' ||
      !matchesReleaseVersion(initialized.agentInfo.version, expectedVersion) ||
      capabilities?.loadSession !== true ||
      !capabilities.sessionCapabilities?.resume ||
      !capabilities.auth?.logout ||
      !initialized.authMethods?.some((method) => method.id === ANTIGRAVITY_AUTH_METHOD)
    ) {
      throw new AntigravityInstallationError(
        'verify',
        'The downloaded runtime did not identify as the expected Google Antigravity release.',
      );
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await process.dispose();
    await launcher.cleanup();
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
