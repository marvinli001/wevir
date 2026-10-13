import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { type ClientIdentity, type HostId, HostIdSchema, PROTOCOL_VERSION } from '@wevir/protocol';
import type { AgentRuntimeAdapter } from '@wevir/runtime-adapter';
import { FileSecretStore, openStorage, type Storage } from '@wevir/storage';
import packageJson from '../package.json' with { type: 'json' };
import { EventStore } from './event-store.js';
import { homePath } from './home.js';
import { createHostMethods } from './host-methods.js';
import { newId } from './ids.js';
import type { Logger } from './logger.js';
import { HostRpcServer } from './rpc-server.js';
import { RuntimeFile } from './runtime-file.js';
import { SessionManager } from './session-manager.js';

/** Host 软件版本（`@wevir/host` 的 version），写进 hello 结果与 `host.json`。 */
export const HOST_VERSION: string = packageJson.version;

/** 优雅退出的整体上限，超过就强制退出（ADR-0002 §6）。 */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** 谁触发了退出，记进日志。 */
export type ShutdownTrigger =
  | { kind: 'rpc'; client: ClientIdentity }
  | { kind: 'signal'; signal: NodeJS.Signals }
  | { kind: 'stdin_eof' }
  | { kind: 'fatal'; error: unknown }
  | { kind: 'api' };

export interface StartHostOptions {
  /** 数据目录（绝对路径），见 `resolveHome`。 */
  home: string;
  /** 引擎适配器，由 Host 独占，退出时 `dispose`。 */
  adapter: AgentRuntimeAdapter;
  /** 写进 `sessions.engine` 列与会话快照的 `engine.kind`，例如 `dsh`、`echo`。 */
  engine: string;
  logger: Logger;
  /** 仅调试用，默认 0（系统分配）。 */
  port?: number;
  /**
   * 收到 `host.shutdown` 时调用。默认直接 `shutdown()`；进程入口用它把 RPC 也接到统一的退出流程上
   * （10 s 上限、退出码）。
   */
  onShutdownRequest?: (trigger: ShutdownTrigger) => void;
}

export interface RunningHost {
  readonly home: string;
  readonly hostId: HostId;
  readonly url: string;
  readonly runtimeFile: RuntimeFile;
  /**
   * 按 ADR-0002 §6 的顺序优雅退出：停止接受新连接 → 取消运行中的回合、未决审批结为 `cancelled` →
   * dispose 适配器（回收引擎进程树）→ 刷写 SQLite → 关闭 WebSocket 连接 → 删除 `host.json`。
   * 每一步失败只记日志、继续下一步。可重复调用，返回同一个 Promise；10 s 上限由调用方负责
   * （进程入口超时后调用 `releaseRuntimeFileSync()` 再强制退出）。
   */
  shutdown(trigger?: ShutdownTrigger): Promise<void>;
  /** 强制退出前同步删除自己的 `host.json`，返回是否删除。 */
  releaseRuntimeFileSync(): boolean;
}

/**
 * 把 Host 组装起来并开始服务（T2.5）：
 *
 * 1. 占住 `run/host.json`（排他创建；已有活着的 Host 抛 `HostAlreadyRunningError`）。在打开数据库
 *    之前做，同一个数据目录不会有两个 Host 同时迁移、写库。
 * 2. 读取或生成 `hostId`；打开存储，建事件库与会话管理器，启动对账（`recover()`）。
 * 3. 生成本次启动的令牌（32 字节随机数，base64url），只在内存与 `host.json` 里。
 * 4. 监听 127.0.0.1，就绪后原子地把 `url` 与令牌写进 `host.json`。
 *
 * 任何一步失败都回收已建好的部分（含 `host.json`）后再抛出。
 */
export async function startHost(options: StartHostOptions): Promise<RunningHost> {
  const { home, adapter, logger } = options;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const runtimeFile = await RuntimeFile.acquire({
    home,
    protocolVersion: PROTOCOL_VERSION,
    hostVersion: HOST_VERSION,
  });
  if (runtimeFile.reclaimed) {
    logger.warn('reclaimed stale runtime file', {
      path: runtimeFile.path,
      stalePid: runtimeFile.reclaimed.pid,
      staleStartedAt: runtimeFile.reclaimed.startedAt,
    });
  }

  let storage: Storage | undefined;
  let events: EventStore | undefined;
  let sessions: SessionManager | undefined;
  let rpc: HostRpcServer | undefined;
  try {
    const hostId = await loadHostId(home, logger);
    storage = openStorage({ dataDir: home });
    const store = new EventStore({
      storage,
      onError: (error) => logger.error('event store error', { error }),
    });
    events = store;
    const manager = new SessionManager({
      storage,
      events: store,
      adapter,
      engine: options.engine,
      onError: (error) => logger.error('session manager error', { error }),
    });
    sessions = manager;
    const recovery = manager.recover();
    if (
      recovery.expiredApprovals > 0 ||
      recovery.interruptedSessions.length > 0 ||
      recovery.unknownSends > 0
    ) {
      logger.warn('recovered from unclean shutdown', { ...recovery });
    }

    const token = randomBytes(32).toString('base64url');
    logger.addSecret(token);
    let requestShutdown: (trigger: ShutdownTrigger) => void = () => {};
    const server = new HostRpcServer({
      token,
      hostId,
      hostVersion: HOST_VERSION,
      storage,
      events: store,
      methods: createHostMethods({
        storage,
        events: store,
        sessions: manager,
        secrets: new FileSecretStore(home),
      }),
      ...(options.port !== undefined && { port: options.port }),
      onShutdownRequest: (client) => requestShutdown({ kind: 'rpc', client }),
      onError: (error) => logger.error('rpc error', { error }),
    });
    rpc = server;
    const url = await server.listen();
    await runtimeFile.publish(url, token);

    const db = storage;
    let stopping: Promise<void> | undefined;
    const host: RunningHost = {
      home,
      hostId,
      url,
      runtimeFile,
      shutdown: (trigger = { kind: 'api' }) => {
        stopping ??= shutdownSequence({
          trigger,
          logger,
          rpc: server,
          sessions: manager,
          adapter,
          events: store,
          storage: db,
          runtimeFile,
        });
        return stopping;
      },
      releaseRuntimeFileSync: () => runtimeFile.releaseSync(),
    };
    requestShutdown = options.onShutdownRequest ?? ((trigger) => void host.shutdown(trigger));
    logger.info('host ready', {
      url,
      hostId,
      hostVersion: HOST_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      engine: options.engine,
      home,
    });
    return host;
  } catch (error) {
    // 回收已建好的部分；这里的失败不掩盖原始错误。
    await rpc?.close().catch(() => {});
    await sessions?.dispose().catch(() => {});
    await adapter.dispose().catch(() => {});
    try {
      events?.close();
      storage?.close();
    } catch {
      // 同上。
    }
    runtimeFile.releaseSync();
    throw error;
  }
}

interface ShutdownParts {
  trigger: ShutdownTrigger;
  logger: Logger;
  rpc: HostRpcServer;
  sessions: SessionManager;
  adapter: AgentRuntimeAdapter;
  events: EventStore;
  storage: Storage;
  runtimeFile: RuntimeFile;
}

async function shutdownSequence(parts: ShutdownParts): Promise<void> {
  const { logger } = parts;
  const startedAt = performance.now();
  logger.info('shutting down', { trigger: describeTrigger(parts.trigger) });
  const step = async (name: string, run: () => unknown): Promise<void> => {
    const stepStartedAt = performance.now();
    try {
      await run();
      logger.info('shutdown step done', { step: name, ms: elapsed(stepStartedAt) });
    } catch (error) {
      logger.error('shutdown step failed', { step: name, ms: elapsed(stepStartedAt), error });
    }
  };
  // 新连接回 503、新请求回 HOST_SHUTTING_DOWN，等在途请求结束；已连上的客户端继续收事件。
  await step('stop_accepting', () => parts.rpc.stopAccepting());
  // 取消回合的事件经订阅推送出去，所以连接要留到后面再关。
  await step('cancel_turns', () => parts.sessions.shutdown());
  await step('dispose_adapter', () => parts.adapter.dispose());
  await step('flush_storage', () => {
    parts.events.close();
    parts.storage.close();
  });
  await step('close_connections', () => parts.rpc.close());
  await step('remove_runtime_file', () => {
    if (!parts.runtimeFile.releaseSync()) {
      logger.warn('runtime file was not removed (missing or owned by another process)', {
        path: parts.runtimeFile.path,
      });
    }
  });
  logger.info('host stopped', { ms: elapsed(startedAt) });
}

function describeTrigger(trigger: ShutdownTrigger): Record<string, unknown> {
  switch (trigger.kind) {
    case 'rpc':
      return { kind: 'rpc', client: trigger.client };
    case 'signal':
      return { kind: 'signal', signal: trigger.signal };
    case 'fatal':
      return { kind: 'fatal', error: trigger.error };
    default:
      return { kind: trigger.kind };
  }
}

function elapsed(since: number): number {
  return Math.round(performance.now() - since);
}

/**
 * `<数据目录>/host-id`：每个数据目录一个 `hostId`，跨重启不变（host-api.md §2）。不存在或内容不合法
 * 时生成新的，以 0600 写临时文件再 rename。
 */
async function loadHostId(home: string, logger: Logger): Promise<HostId> {
  const path = homePath(home, 'hostIdFile');
  try {
    const text = (await readFile(path, 'utf8')).trim();
    const parsed = HostIdSchema.safeParse(text);
    if (parsed.success) return parsed.data;
    logger.warn('invalid host-id file, generating a new hostId', { path });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const hostId = newId('hst');
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(`${hostId}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return hostId;
}
