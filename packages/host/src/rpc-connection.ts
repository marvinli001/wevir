import { createHash, timingSafeEqual } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  type AccountState,
  type Channel,
  type ChannelPost,
  type ClientCapabilities,
  type ClientIdentity,
  CloseCode,
  type CloseCodeName,
  compareProtocolVersions,
  type Device,
  type DeviceId,
  type DevicePlatform,
  type EngineFeatures,
  ErrorCode,
  type ErrorCodeName,
  type HostFeatures,
  HostHelloParamsSchema,
  type HostId,
  type HostSettings,
  isMethodName,
  JSONRPC_VERSION,
  type JsonRpcId,
  type JsonRpcRequest,
  JsonRpcRequestSchema,
  type MethodName,
  type MethodParams,
  type MethodResult,
  MethodSchemas,
  MIN_PROTOCOL_VERSION,
  NOTIFICATION_PERMISSIONS,
  type NotificationName,
  type NotificationParams,
  NotificationSchemas,
  negotiateProtocolVersion,
  type PendingMessage,
  type Permission,
  PROTOCOL_VERSION,
  parseProtocolVersion,
  type RemoteStatus,
  type Session,
  type SessionId,
  SUBSCRIPTION_KINDS,
  type SubscriptionId,
  type ToolDisplay,
  type UserContentPart,
  type WevirEvent,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import type { RawData } from 'ws';
import type { BrowserBroker } from './browser-broker.js';
import type { ChannelService } from './channels/service.js';
import type { ComputerBroker } from './computer-broker.js';
import { HostError, isHostError } from './errors.js';
import { type EventStore, elideSuperseded } from './event-store.js';
import { assertSessionVisible, type HostMethods, type RequestContext } from './host-methods.js';
import { newId } from './ids.js';
import type { InboxService } from './inbox.js';
import type { MemoryChange } from './memory.js';
import type { NotificationService } from './notifications.js';
import {
  type ConnectionGrant,
  isLocalOnlyMethod,
  LOCAL_GRANT,
  missingMethodPermission,
  missingParamPermissions,
  type TestConnectionGrant,
} from './permissions.js';
import type { Presence } from './presence.js';
import type { DeviceService } from './remote/devices.js';
import type { PairingService } from './remote/pairing.js';
import type { PushService } from './remote/push.js';
import { type SessionListFeed, SessionListScope } from './session-list.js';
import { toHostError } from './simulator/errors.js';
import type { SimulatorService } from './simulator/service.js';
import type { TerminalService } from './terminals.js';

/** 一条连接的时限与容量。默认值见 `HostRpcServer`。 */
export interface ConnectionLimits {
  helloTimeoutMs: number;
  leaseMs: number;
  sendBufferLimitBytes: number;
  /** 主动关闭后等对方回关闭帧的时限，超过就直接断开 TCP。 */
  closeTimeoutMs: number;
  /** 补发时每次从事件库读多少条。 */
  replayBatchSize: number;
}

/** 连接从服务那里拿到的东西。 */
export interface ConnectionHost {
  readonly hostId: HostId;
  readonly hostVersion: string;
  /** 令牌的 SHA-256，hello 时与客户端出示的令牌的摘要做常量时间比较。 */
  readonly tokenDigest: Buffer;
  readonly storage: Storage;
  readonly events: EventStore;
  readonly methods: HostMethods;
  /** `host.hello` 结果里的功能（按引擎决定，host-api.md §10）。 */
  readonly features: HostFeatures;
  /** `host.hello` 结果里每种 Provider 的引擎能做什么（0.25.0）。 */
  readonly engineFeatures?: Readonly<Record<string, EngineFeatures>>;
  /** 引擎的账号（R6）：调过 `account.*` 的连接用它收 `account.updated`。引擎没有账号时省略。 */
  readonly accounts?: { watch(listener: (state: AccountState) => void): () => void };
  /** Host 设置（R11）：调过 `settings.*` 的连接用它收 `settings.updated`。 */
  readonly settings?: { watch(listener: (settings: HostSettings) => void): () => void };
  readonly plugins?: { watch(listener: () => void): () => void };
  /** 跨会话记忆（0.57.0）：调过 `memory.*` 的连接用它收 `memory.changed`。 */
  readonly memory?: { watch(listener: (change: MemoryChange) => void): () => void };
  /** 会话列表推送（0.101.0）：`session.list` 的结果加上它的版本，之后这条连接用它收 `sessions.changed`。 */
  readonly sessionList?: Pick<SessionListFeed, 'version' | 'watch'>;
  /** 收件箱（0.105.0）：调过 `inbox.*` 的连接用它收 `inbox.changed`。 */
  readonly inbox?: Pick<InboxService, 'watch'>;
  /**
   * 频道（0.120.0）：调过 `channel.list` 的连接收 `channels.changed`；`channel.subscribe` 登记在这条连接上，收 `channel.posted` 与
   * `channel.updated`。
   */
  readonly channels?: Pick<ChannelService, 'watch' | 'subscribe' | 'posts'>;
  /** 远程设备与配对（0.107.0）：调过 `device.*` 或 `pairing.*` 的连接用它收 `devices.changed`、`pairing.request`、`pairing.ended`。 */
  readonly remote?: {
    readonly devices: Pick<DeviceService, 'watch'>;
    readonly pairing: Pick<PairingService, 'watch'>;
    /** 远程监听（0.109.0）：同样的连接收 `remote.changed`。 */
    readonly listener?: { watch(listener: (status: RemoteStatus) => void): () => void };
    /** 推送（0.112.0）：远程设备的 `push.*`，调过的连接收 `push.changed`。 */
    readonly push?: Pick<PushService, 'stateFor' | 'register' | 'unregister' | 'onDeviceChange'>;
  };
  /** 通知意图（0.106.0）：调过 `notification.subscribe` 的连接用它收 `notification.intent`。 */
  readonly notifications?: Pick<NotificationService, 'watch'>;
  /** 在场（0.106.0）：`presence.update` 记到这里，连接关闭时删掉。 */
  readonly presence?: Pick<Presence, 'update' | 'remove'>;
  /** 用量统计（0.62.0）：调过 `usage.*` 的连接用它收 `usage.changed`。 */
  readonly usage?: { watch(listener: () => void): () => void };
  /** 自动化（0.66.0）：调过 `automation.*` 的连接用它收 `automation.changed`。 */
  readonly automations?: {
    watch(listener: (change: NotificationParams<'automation.changed'>) => void): () => void;
  };
  /** 项目环境就绪（0.70.0）：调过 `readiness.*` 的连接用它收 `readiness.changed`。 */
  readonly readiness?: {
    watch(listener: (change: NotificationParams<'readiness.changed'>) => void): () => void;
  };
  /** 语言服务器（0.71.0）：调过 `lsp.*` 的连接用它收 `lsp.changed`。 */
  readonly lsp?: {
    watch(listener: (change: NotificationParams<'lsp.changed'>) => void): () => void;
  };
  /** 进程输出（0.69.0）：调过 `process.*` 的连接用它收 `process.changed`。 */
  readonly processes?: {
    watch(listener: (change: NotificationParams<'process.changed'>) => void): () => void;
  };
  /** 开发服务器预览（0.84.0）：调过 `preview.*` 的连接用它收 `preview.changed`。 */
  readonly previews?: {
    watch(listener: (change: NotificationParams<'preview.changed'>) => void): () => void;
  };
  /** 插件市场（0.99.0）：调过 `market.*` 的连接用它收 `market.installProgress`。 */
  readonly market?: {
    watch(listener: (progress: NotificationParams<'market.installProgress'>) => void): () => void;
  };
  /** 防休眠（0.102.0）：调过 `power.*` 的连接用它收 `power.changed`。 */
  readonly power?: { watch(listener: (keepAwake: boolean) => void): () => void };
  /** 听写（0.92.0）：调过 `speech.*` 的连接用它收 `speech.changed`。 */
  readonly speech?: {
    watch(listener: (status: NotificationParams<'speech.changed'>['status']) => void): () => void;
  };
  /** 调优的档案（0.85.0）：调过 `tuning.*` 的连接用它收 `tuning.changed`；参数是范围（省略是全局或不只一个项目）。 */
  readonly tuning?: {
    watch(listener: (workspaceId: string | undefined) => void): () => void;
  };
  /** 调优的建议（0.87.0）：调过 `tuning.*` 的连接也用它收 `tuning.proposal.changed`。 */
  readonly proposals?: {
    watch(listener: (workspaceId: string | undefined) => void): () => void;
  };
  /** 护栏（0.86.0）：调过 `guardrail.*` 或 `repoHook.*` 的连接用它收 `guardrail.changed`。 */
  readonly guardrails?: {
    watch(listener: (change: NotificationParams<'guardrail.changed'>) => void): () => void;
  };
  /** 用户的交互终端（0.69.0）：`terminal.attach` 把连接登记到终端上，调过 `terminal.*` 的连接收 `terminal.changed`。 */
  readonly terminals?: Pick<TerminalService, 'attach' | 'watch'>;
  /**
   * iOS 模拟器（0.122.0）：`simulator.attach` / `detach` 以这条连接为主人，连接关闭时撤掉；调过 `simulator.*` 的连接收
   * `simulator.changed` / `simulator.orientation`，协商到 0.122.0 的连接都收 `simulator.show`。
   */
  readonly simulators?: Pick<
    SimulatorService,
    'attach' | 'detach' | 'detachOwner' | 'watch' | 'watchShow'
  >;
  /** 内置浏览器（0.33.0）：`browser.register` 把连接登记到这里。省略时（测试）登记不生效，回答一律不收。 */
  readonly browsers?: BrowserBroker;
  /** 电脑操作（0.114.0）：`computer.register` 把连接登记到这里。省略时登记不生效，回答一律不收。 */
  readonly computers?: ComputerBroker;
  /** 只给测试（permissions.ts）：hello 后让某条连接以受限的身份与权限工作。生产路径不给，连接都是 `LOCAL_GRANT`。 */
  readonly testConnectionGrant?: TestConnectionGrant;
  readonly limits: ConnectionLimits;
  readonly resultValidation: 'strict' | 'warn';
  /** 服务正在优雅退出：新请求一律 `HOST_SHUTTING_DOWN`。 */
  readonly shuttingDown: boolean;
  /** `host.shutdown` 的响应发出之后调用。 */
  requestShutdown(client: ClientIdentity): void;
  onError(error: unknown): void;
}

/** 方法返回值不合注册表的 result schema（Host 自己的缺陷）。 */
export class InvalidResultError extends Error {
  override readonly name = 'InvalidResultError';
  constructor(
    readonly method: MethodName,
    readonly issues: readonly ZodIssueLike[],
  ) {
    super(`result of ${method} does not match its schema: ${JSON.stringify(issues)}`);
  }
}

/** zod issue 里用到的部分（host 不直接依赖 zod）。 */
interface ZodIssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** `sessions.changed` 从这个协议版本起有（0.101.0）。 */
const SESSION_LIST_PUSH_SINCE = '0.101.0';
/** 通知意图的 `channel` 种类（助理的帖子）从这个版本起。 */
const CHANNEL_INTENTS_SINCE = '0.121.0';
/** `simulator.show` 从这个版本起。 */
const SIMULATOR_SINCE = '0.122.0';

/** 给旧客户端的提示（host-api.md §3.2 未知方法）。 */
const UPGRADE_HINT = '请升级 Wevir Host';

type Phase = 'hello' | 'ready' | 'closing' | 'closed';

interface Subscription {
  readonly id: SubscriptionId;
  readonly sessionId: SessionId;
  /** 补发结束前到达的实时事件（已序列化）；追平后为 undefined，事件直接发出。 */
  queue: string[] | undefined;
  /** `queue` 的字节数，计入发送缓冲。 */
  queuedBytes: number;
  active: boolean;
  unsubscribe: () => void;
}

/**
 * `RpcConnection` 用到的 WebSocket 的部分。本机连接直接是 `ws` 的 WebSocket；远程连接（0.109.0，remote/noise-socket.ts）是 Noise
 * 解密之后的帧，`message` 一律是文本。
 */
export interface RpcSocket {
  readonly bufferedAmount: number;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: 'ping' | 'pong', listener: () => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  send(data: string, cb?: (error?: Error) => void): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

/**
 * 远程连接的来历（0.109.0，ADR-0017 §4）：Noise 握手认出的设备。hello 时不查令牌，按 `grant()` 取设备当时的权限；设备已经不在
 * （移除了）时 `grant()` 返回 undefined，hello 以 `UNAUTHORIZED` 失败。
 */
export interface RemoteOrigin {
  readonly deviceId: string;
  grant(): ConnectionGrant | undefined;
}

/**
 * 一条 WebSocket 连接上的 JSON-RPC 会话（host-api.md §2–§4、§12）。
 *
 * - **握手。** 第一个请求必须是 `host.hello`，按 §2 的顺序检查：帧、方法、协议版本、参数、令牌；
 *   失败先回 JSON-RPC 错误再以对应关闭码关闭。成功后记下该连接的 `ClientIdentity` 与能力位。
 * - **分发。** 之后的请求按方法注册表校验参数，交给 `HostMethods`（握手、心跳、退出与订阅在这里
 *   处理），返回值发出前按注册表的 result schema 校验。同一连接上的请求并发执行，响应按 `id` 对应。
 * - **订阅。** 见 `#subscribe`。
 * - **健康。** 收到任何一帧都续租，超过租约以 `LEASE_EXPIRED` 断开；发送缓冲（ws 尚未写出的字节 +
 *   补发期间排队的实时事件）超过上限时以 `SEND_BUFFER_OVERFLOW` 断开这一条连接。
 * - 连接关闭时丢弃它的全部订阅，不为断开的客户端保留任何状态。
 */
export class RpcConnection {
  readonly #ws: RpcSocket;
  readonly #host: ConnectionHost;
  readonly #remote: RemoteOrigin | undefined;
  readonly #limits: ConnectionLimits;
  #phase: Phase = 'hello';
  #client: ClientIdentity | undefined;
  #capabilities: ClientCapabilities = {};
  #protocolVersion: string = PROTOCOL_VERSION;
  /** hello 时定下的身份与权限（domain-model §3.44）。 */
  #grant: ConnectionGrant = LOCAL_GRANT;
  #permissions: ReadonlySet<string> = new Set(LOCAL_GRANT.permissions);
  readonly #subscriptions = new Map<SubscriptionId, Subscription>();
  readonly #inflight = new Set<Promise<void>>();
  /** 调过 `account.*` 之后：退订 `account.updated`。 */
  #unwatchAccounts: (() => void) | undefined;
  /** 调过 `settings.*` 之后：退订 `settings.updated`。 */
  #unwatchSettings: (() => void) | undefined;
  #unwatchPlugins: (() => void) | undefined;
  /** 调过 `memory.*` 之后：退订 `memory.changed`。 */
  #unwatchMemory: (() => void) | undefined;
  /** 调过 `session.list` 之后：它的参数并集与见过的会话，以及退订 `sessions.changed`。 */
  readonly #sessionListScope = new SessionListScope();
  #unwatchSessionList: (() => void) | undefined;
  /** 调过 `inbox.*` 之后：退订 `inbox.changed`。 */
  #unwatchInbox: (() => void) | undefined;
  /** 调过 `channel.list` 之后：退订 `channels.changed`。 */
  #unwatchChannels: (() => void) | undefined;
  /** `channel.subscribe` 的订阅：订阅 ID → 退订。 */
  readonly #channelSubscriptions = new Map<string, () => void>();
  /** 调过 `device.*` 或 `pairing.*` 之后：退订设备与配对的通知。 */
  #unwatchRemote: (() => void) | undefined;
  /** `notification.subscribe` 之后：退订 `notification.intent`。 */
  #unwatchNotifications: (() => void) | undefined;
  /** 远程设备调过 `push.*` 之后：退订 `push.changed`。 */
  #unwatchPush: (() => void) | undefined;
  /** 调过 `usage.*` 之后：退订 `usage.changed`。 */
  #unwatchUsage: (() => void) | undefined;
  /** 调过 `automation.*` 之后：退订 `automation.changed`。 */
  #unwatchAutomations: (() => void) | undefined;
  /** 调过 `process.*` 之后：退订 `process.changed`。 */
  #unwatchProcesses: (() => void) | undefined;
  /** 调过 `readiness.*` 之后：退订 `readiness.changed`。 */
  #unwatchReadiness: (() => void) | undefined;
  /** 调过 `preview.*` 之后：退订 `preview.changed`。 */
  #unwatchPreviews: (() => void) | undefined;
  /** 调过 `speech.*` 之后：退订 `speech.changed`。 */
  #unwatchSpeech: (() => void) | undefined;
  /** 调过 `market.*` 之后：退订 `market.installProgress`。 */
  #unwatchMarket: (() => void) | undefined;
  /** 调过 `power.*` 之后：退订 `power.changed`。 */
  #unwatchPower: (() => void) | undefined;
  /** 调过 `tuning.*` 之后：退订 `tuning.changed`。 */
  #unwatchTuning: (() => void) | undefined;
  /** 调过 `tuning.*` 之后：退订 `tuning.proposal.changed`。 */
  #unwatchProposals: (() => void) | undefined;
  /** 调过 `guardrail.*` 或 `repoHook.*` 之后：退订 `guardrail.changed`。 */
  #unwatchGuardrails: (() => void) | undefined;
  /** 调过 `lsp.*` 之后：退订 `lsp.changed`。 */
  #unwatchLsp: (() => void) | undefined;
  /** 调过 `terminal.*` 之后：退订 `terminal.changed`。 */
  #unwatchTerminals: (() => void) | undefined;
  /** `terminal.attach` 过的终端：不再收它的输出。 */
  readonly #terminalAttachments = new Map<string, () => void>();
  /** 调过 `simulator.*` 之后：退订 `simulator.changed` / `simulator.orientation`。 */
  #unwatchSimulators: (() => void) | undefined;
  /** hello 之后（0.122.0 起）：退订 `simulator.show`。 */
  #unwatchSimulatorShow: (() => void) | undefined;
  /** `browser.register` 之后：注销这条连接的浏览器提供方。 */
  #unregisterBrowser: (() => void) | undefined;
  /** 这条连接作为浏览器提供方的标识。 */
  readonly #browserProviderId = newId('conn');
  /** `computer.register` 之后：注销这条连接的电脑操作提供方。 */
  #unregisterComputer: (() => void) | undefined;
  /** 所有订阅排队的字节数之和。 */
  #queuedBytes = 0;
  #lastActivity = performance.now();
  #helloTimer: ReturnType<typeof setTimeout> | undefined;
  #leaseTimer: ReturnType<typeof setTimeout> | undefined;
  #terminateTimer: ReturnType<typeof setTimeout> | undefined;
  #resolveClosed!: () => void;
  /** WebSocket 关闭（含被 terminate）时完成。 */
  readonly closed = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });

  constructor(ws: RpcSocket, host: ConnectionHost, remote?: RemoteOrigin) {
    this.#ws = ws;
    this.#host = host;
    this.#remote = remote;
    this.#limits = host.limits;
    ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary));
    // 客户端发 WebSocket 协议层的 ping / pong 也算“收到一帧”。
    ws.on('ping', () => this.#touch());
    ws.on('pong', () => this.#touch());
    // 协议错误（帧不合法、超过 maxPayload 等）之后 ws 会自行关闭连接，随后是 close 事件。
    ws.on('error', () => {});
    ws.on('close', () => this.#onClose());
    this.#helloTimer = unref(
      setTimeout(() => this.#close('HELLO_TIMEOUT', 'hello timeout'), this.#limits.helloTimeoutMs),
    );
    this.#armLease();
  }

  /** 完成 hello 之后才有。 */
  get client(): ClientIdentity | undefined {
    return this.#client;
  }

  /** 这条连接的身份与权限；hello 之前是 `LOCAL_GRANT`（hello 之前不分发任何请求）。 */
  get grant(): ConnectionGrant {
    return this.#grant;
  }

  get subscriptionCount(): number {
    return this.#subscriptions.size;
  }

  /** 等这条连接上在途的请求与补发全部结束（包括等待期间新到的）。 */
  async settle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.all([...this.#inflight]);
  }

  /** Host 优雅退出：以 `GOING_AWAY` 关闭。 */
  goAway(): void {
    this.#close('GOING_AWAY', 'host is shutting down');
  }

  /** 不等关闭握手，直接断开。 */
  terminate(): void {
    this.#ws.terminate();
  }

  // ── 收帧 ────────────────────────────────────────────────────────────

  #onMessage(data: RawData, isBinary: boolean): void {
    this.#touch();
    if (this.#phase === 'closing' || this.#phase === 'closed') return;
    const request = this.#parse(data, isBinary);
    if (this.#phase === 'hello') {
      if (request) this.#hello(request);
      else this.#close('HELLO_REQUIRED', 'hello required');
      return;
    }
    if (request) this.#track(this.#dispatch(request));
  }

  /** 解析一帧；不是合法的 JSON-RPC 请求时回错误并返回 undefined。 */
  #parse(data: RawData, isBinary: boolean): JsonRpcRequest | undefined {
    if (isBinary) {
      this.#sendError(null, 'INVALID_REQUEST', 'binary frames are not supported');
      return undefined;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(rawToString(data));
    } catch {
      this.#sendError(null, 'PARSE_ERROR', 'parse error');
      return undefined;
    }
    if (Array.isArray(frame)) {
      this.#sendError(null, 'INVALID_REQUEST', 'batch requests are not supported');
      return undefined;
    }
    const parsed = JsonRpcRequestSchema.safeParse(frame);
    if (!parsed.success) {
      this.#sendError(requestIdOf(frame), 'INVALID_REQUEST', 'invalid request');
      return undefined;
    }
    return parsed.data;
  }

  // ── 握手 ────────────────────────────────────────────────────────────

  /** host-api.md §2 的检查顺序；同步完成，hello 之后的帧一定看到 `ready` 或 `closing`。 */
  #hello(request: JsonRpcRequest): void {
    const { id } = request;
    if (request.method !== 'host.hello') {
      this.#reject(id, 'HELLO_REQUIRED', 'host.hello required', 'HELLO_REQUIRED');
      return;
    }
    if (this.#host.shuttingDown) {
      this.#reject(id, 'HOST_SHUTTING_DOWN', 'host is shutting down', 'GOING_AWAY');
      return;
    }
    // 版本排在完整的参数校验之前：别的主版本的客户端也该拿到“请升级”。
    const params = request.params ?? {};
    const version = params.protocolVersion;
    if (typeof version === 'string' && parseProtocolVersion(version)) {
      if (!negotiateProtocolVersion(version).ok) {
        this.#rejectVersion(id, version);
        return;
      }
    }
    const parsed = HostHelloParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.#reject(id, 'INVALID_PARAMS', 'invalid params', 'HELLO_REQUIRED', {
        issues: toIssues(parsed.error.issues),
      });
      return;
    }
    const hello = parsed.data;
    // 远程连接的身份来自 Noise 握手，不看令牌（0.109.0）。
    const remoteGrant = this.#remote?.grant();
    if (
      this.#remote === undefined
        ? !timingSafeEqual(sha256(hello.token), this.#host.tokenDigest)
        : remoteGrant === undefined
    ) {
      this.#reject(id, 'UNAUTHORIZED', 'unauthorized', 'UNAUTHORIZED');
      return;
    }
    const negotiation = negotiateProtocolVersion(hello.protocolVersion);
    if (!negotiation.ok) {
      this.#rejectVersion(id, hello.protocolVersion);
      return;
    }

    this.#client = {
      deviceId: hello.deviceId,
      clientId: hello.clientId,
      clientKind: hello.clientKind,
    };
    this.#capabilities = hello.capabilities;
    this.#protocolVersion = negotiation.protocolVersion;
    this.#grant = remoteGrant ?? this.#host.testConnectionGrant?.(this.#client) ?? LOCAL_GRANT;
    this.#permissions = new Set(this.#grant.permissions);
    this.#phase = 'ready';
    clearTimeout(this.#helloTimer);
    this.#respond(id, 'host.hello', {
      hostId: this.#host.hostId,
      hostVersion: this.#host.hostVersion,
      protocolVersion: negotiation.protocolVersion,
      minProtocolVersion: MIN_PROTOCOL_VERSION,
      features: { ...this.#host.features },
      ...(this.#host.engineFeatures !== undefined && {
        engineFeatures: structuredClone(this.#host.engineFeatures) as Record<
          string,
          EngineFeatures
        >,
      }),
      permissions: [...this.#grant.permissions],
    });
    if (compareProtocolVersions(this.#protocolVersion, SIMULATOR_SINCE) >= 0) {
      this.#unwatchSimulatorShow = this.#host.simulators?.watchShow((show) =>
        this.#notify('simulator.show', show),
      );
    }
  }

  #rejectVersion(id: JsonRpcId, version: string): void {
    this.#reject(
      id,
      'INCOMPATIBLE_PROTOCOL',
      `incompatible protocol version ${version}`,
      'INCOMPATIBLE_PROTOCOL',
      {
        hostVersion: this.#host.hostVersion,
        protocolVersion: PROTOCOL_VERSION,
        minProtocolVersion: MIN_PROTOCOL_VERSION,
      },
    );
  }

  /** 先回错误，再关闭。 */
  #reject(
    id: JsonRpcId,
    code: ErrorCodeName,
    message: string,
    closeCode: CloseCodeName,
    data?: unknown,
  ): void {
    this.#sendError(id, code, message, data);
    this.#close(closeCode, message);
  }

  // ── 分发 ────────────────────────────────────────────────────────────

  async #dispatch(request: JsonRpcRequest): Promise<void> {
    const { id, method } = request;
    try {
      if (this.#host.shuttingDown) {
        throw new HostError('HOST_SHUTTING_DOWN', 'host is shutting down');
      }
      if (method === 'host.hello') {
        throw new HostError('INVALID_REQUEST', 'host.hello already completed');
      }
      if (!isMethodName(method)) {
        throw new HostError('METHOD_NOT_FOUND', `Method not found: ${method}`, {
          hostVersion: this.#host.hostVersion,
          hint: UPGRADE_HINT,
        });
      }
      // 权限（host-api.md §3 开头）：方法级在解析参数之前，参数级在之后。
      this.#authorize(missingMethodPermission(method, this.#permissions));
      if (this.#grant.principal.kind !== 'local' && isLocalOnlyMethod(method)) {
        throw new HostError('DEVICE_FORBIDDEN', 'forbidden: local connections only', {
          missing: [MethodSchemas[method].permission ?? 'host.manage'],
        });
      }
      const parsed = MethodSchemas[method].params.safeParse(request.params ?? {});
      if (!parsed.success) {
        throw new HostError('INVALID_PARAMS', 'invalid params', {
          issues: toIssues(parsed.error.issues),
        });
      }
      this.#authorize(missingParamPermissions(method, parsed.data as never, this.#permissions));
      await this.#invoke(id, method, parsed.data);
    } catch (error) {
      if (isHostError(error)) {
        this.#sendError(id, error.code, error.message, error.data);
      } else {
        this.#host.onError(error);
        this.#sendError(id, 'INTERNAL_ERROR', 'internal error');
      }
    }
  }

  #authorize(missing: Permission[]): void {
    if (missing.length === 0) return;
    throw new HostError('DEVICE_FORBIDDEN', `forbidden: requires ${missing.join(', ')}`, {
      missing,
    });
  }

  async #invoke(id: JsonRpcId, method: MethodName, params: unknown): Promise<void> {
    const client = this.#client;
    if (!client) throw new Error('hello 之前不会分发请求');
    switch (method) {
      case 'host.hello':
        throw new Error('host.hello 在握手阶段处理');
      case 'host.ping':
        this.#respond(id, method, {});
        return;
      case 'host.shutdown':
        if (this.#respond(id, method, {})) this.#host.requestShutdown(client);
        return;
      case 'events.subscribe':
        this.#subscribe(id, params as MethodParams<'events.subscribe'>);
        return;
      case 'events.unsubscribe': {
        const { subscriptionId } = params as MethodParams<'events.unsubscribe'>;
        const subscription = this.#subscriptions.get(subscriptionId);
        if (subscription) this.#drop(subscription);
        this.#respond(id, method, {});
        return;
      }
      case 'channel.subscribe':
        this.#subscribeChannel(id, params as MethodParams<'channel.subscribe'>);
        return;
      case 'channel.unsubscribe': {
        const { subscriptionId } = params as MethodParams<'channel.unsubscribe'>;
        this.#channelSubscriptions.get(subscriptionId)?.();
        this.#channelSubscriptions.delete(subscriptionId);
        this.#respond(id, method, {});
        return;
      }
      case 'notification.subscribe':
        if (this.#respond(id, method, {})) this.#watchNotifications();
        return;
      case 'presence.update': {
        const { active } = params as MethodParams<'presence.update'>;
        this.#host.presence?.update(this, active, this.#grant.principal.kind === 'local');
        this.#respond(id, method, {});
        return;
      }
      case 'push.get':
      case 'push.register':
      case 'push.unregister': {
        const { push, deviceId } = this.#pushTarget();
        const state =
          method === 'push.register'
            ? await push.register(deviceId, params as MethodParams<'push.register'>)
            : method === 'push.unregister'
              ? await push.unregister(deviceId)
              : await push.stateFor(deviceId);
        if (this.#respond(id, method, state)) this.#watchPush(deviceId);
        return;
      }
      case 'browser.register': {
        const { commands } = params as MethodParams<'browser.register'>;
        this.#unregisterBrowser?.();
        this.#unregisterBrowser = this.#host.browsers?.register({
          id: this.#browserProviderId,
          commands,
          send: (request) => {
            const parsed = NotificationSchemas['browser.request'].params.safeParse(request);
            if (!parsed.success) {
              this.#host.onError(
                new Error(`browser.request does not match its schema: ${parsed.error}`),
              );
              return false;
            }
            return this.#notify('browser.request', parsed.data);
          },
        });
        this.#respond(id, method, {});
        return;
      }
      case 'computer.register': {
        const { commands } = params as MethodParams<'computer.register'>;
        this.#unregisterComputer?.();
        this.#unregisterComputer = this.#host.computers?.register({
          id: this.#browserProviderId,
          commands,
          send: (request) => {
            const parsed = NotificationSchemas['computer.request'].params.safeParse(request);
            if (!parsed.success) {
              this.#host.onError(
                new Error(`computer.request does not match its schema: ${parsed.error}`),
              );
              return false;
            }
            return this.#notify('computer.request', parsed.data);
          },
        });
        this.#respond(id, method, {});
        return;
      }
      case 'computer.unregister':
        this.#unregisterComputer?.();
        this.#unregisterComputer = undefined;
        this.#respond(id, method, {});
        return;
      case 'computer.respond': {
        const accepted =
          this.#host.computers?.respond(
            this.#browserProviderId,
            params as MethodParams<'computer.respond'>,
          ) ?? false;
        this.#respond(id, method, { accepted });
        return;
      }
      case 'terminal.attach': {
        const terminals = this.#terminalService();
        const attach = params as MethodParams<'terminal.attach'>;
        this.#terminalAttachments.get(attach.terminalId)?.();
        this.#terminalAttachments.delete(attach.terminalId);
        const { result, start } = await terminals.attach(attach, {
          // 输出由 Host 自己拼出（每 16 ms 一条），不再逐条按 schema 校验。
          send: (output) => this.#notify('terminal.output', output),
          backlog: () => this.#backlog(),
        });
        if (this.#respond(id, method, result) && this.#phase === 'ready') {
          this.#terminalAttachments.get(attach.terminalId)?.();
          this.#terminalAttachments.set(attach.terminalId, start());
        }
        this.#watchTerminals();
        return;
      }
      case 'simulator.attach': {
        const simulators = this.#simulatorService();
        const attach = params as MethodParams<'simulator.attach'>;
        if (attach.sessionId !== undefined)
          assertSessionVisible(this.#host.storage, attach.sessionId);
        let result: MethodResult<'simulator.attach'>;
        try {
          result = await simulators.attach(attach, this.#browserProviderId);
        } catch (error) {
          throw toHostError(error);
        }
        this.#respond(id, method, result);
        this.#watchSimulators();
        return;
      }
      case 'simulator.detach': {
        const { udid } = params as MethodParams<'simulator.detach'>;
        this.#simulatorService().detach(udid, this.#browserProviderId);
        this.#respond(id, method, {});
        this.#watchSimulators();
        return;
      }
      case 'terminal.detach': {
        const { terminalId } = params as MethodParams<'terminal.detach'>;
        this.#terminalService();
        this.#terminalAttachments.get(terminalId)?.();
        this.#terminalAttachments.delete(terminalId);
        this.#respond(id, method, {});
        this.#watchTerminals();
        return;
      }
      case 'browser.unregister':
        this.#unregisterBrowser?.();
        this.#unregisterBrowser = undefined;
        this.#respond(id, method, {});
        return;
      case 'browser.respond': {
        const accepted =
          this.#host.browsers?.respond(
            this.#browserProviderId,
            params as MethodParams<'browser.respond'>,
          ) ?? false;
        this.#respond(id, method, { accepted });
        return;
      }
      default: {
        // 参数已按该方法的 schema 校验过；按方法名取出的处理函数与参数类型一一对应。
        const handler = this.#host.methods[method] as (
          params: unknown,
          context: RequestContext,
        ) => unknown;
        let result = await handler(params, { client, capabilities: this.#capabilities });
        if (method === 'session.list' && this.#host.sessionList !== undefined) {
          result = {
            ...(result as MethodResult<'session.list'>),
            listVersion: this.#host.sessionList.version,
          };
        }
        const sent = this.#respond(
          id,
          method,
          adaptResultForClient(method, result, this.#capabilities, this.#protocolVersion),
        );
        if (sent && method === 'session.list') {
          this.#watchSessionList(
            params as MethodParams<'session.list'>,
            (result as MethodResult<'session.list'>).sessions,
          );
        }
        if (method.startsWith('inbox.')) this.#watchInbox();
        if (sent && method === 'channel.list') this.#watchChannels();
        if (/^(device|pairing|remote)\./.test(method)) this.#watchRemote();
        if (method.startsWith('account.')) this.#watchAccounts();
        if (method.startsWith('settings.')) this.#watchSettings();
        if (/^(plugins?|connector|skill)\./.test(method)) this.#watchPlugins();
        if (method.startsWith('memory.')) this.#watchMemory();
        if (method.startsWith('usage.')) this.#watchUsage();
        if (method.startsWith('automation.')) this.#watchAutomations();
        if (method.startsWith('process.')) this.#watchProcesses();
        if (method.startsWith('readiness.')) this.#watchReadiness();
        // 预览的就绪与退出走 `process.changed`。
        if (method.startsWith('preview.')) {
          this.#watchPreviews();
          this.#watchProcesses();
        }
        if (method.startsWith('lsp.')) this.#watchLsp();
        if (method.startsWith('speech.')) this.#watchSpeech();
        if (method.startsWith('market.')) this.#watchMarket();
        if (method.startsWith('power.')) this.#watchPower();
        if (method.startsWith('tuning.')) this.#watchTuning();
        if (method.startsWith('guardrail.') || method.startsWith('repoHook.')) {
          this.#watchGuardrails();
        }
        if (method.startsWith('terminal.')) this.#watchTerminals();
        if (method.startsWith('simulator.')) this.#watchSimulators();
      }
    }
  }

  /**
   * 按注册表校验后发出成功响应，返回是否发出。不合 schema 时交给 `onError`：严格模式（开发）改回
   * `INTERNAL_ERROR`，宽松模式（生产）照发原值。
   */
  #respond(id: JsonRpcId, method: MethodName, result: unknown): boolean {
    const parsed = MethodSchemas[method].result.safeParse(result);
    let payload = result;
    if (parsed.success) {
      payload = parsed.data;
    } else {
      this.#host.onError(new InvalidResultError(method, parsed.error.issues));
      if (this.#host.resultValidation === 'strict') {
        this.#sendError(id, 'INTERNAL_ERROR', 'internal error');
        return false;
      }
    }
    return this.#send({ jsonrpc: JSONRPC_VERSION, id, result: payload });
  }

  #sendError(id: JsonRpcId | null, code: ErrorCodeName, message: string, data?: unknown): void {
    const error =
      data === undefined
        ? { code: ErrorCode[code], message }
        : { code: ErrorCode[code], message, data };
    this.#send({ jsonrpc: JSONRPC_VERSION, id, error });
  }

  #track(request: Promise<void>): void {
    this.#inflight.add(request);
    void request.finally(() => this.#inflight.delete(request));
  }

  // ── 订阅 ────────────────────────────────────────────────────────────

  /**
   * `events.subscribe`（host-api.md §4）。在事件库里登记订阅、读出当时的 `lastSeq`（=
   * `replayedThroughSeq`）、发出响应，这三步在同一个同步段里完成：事件库的追加也是同步的，中间插不进
   * 任何事件，这就是“同一把会话锁”。之后补发 `(sinceSeq, replayedThroughSeq]`，补发期间到达的实时
   * 事件（`seq > replayedThroughSeq`）先排队，补完按序发出再转为直接推送。所以响应先于该订阅的第一条
   * 事件，每个 `seq` 在这个订阅上恰好出现一次。
   */
  #subscribe(id: JsonRpcId, params: MethodParams<'events.subscribe'>): void {
    const { sessionId, sinceSeq, elideSuperseded } = params;
    assertSessionVisible(this.#host.storage, sessionId);
    const subscription: Subscription = {
      id: newId('sub'),
      sessionId,
      queue: [],
      queuedBytes: 0,
      active: true,
      unsubscribe: () => {},
    };
    const { lastSeq, unsubscribe } = this.#host.events.subscribe(sessionId, (event) =>
      this.#deliver(subscription, event),
    );
    subscription.unsubscribe = unsubscribe;
    this.#subscriptions.set(subscription.id, subscription);
    const responded = this.#respond(id, 'events.subscribe', {
      subscriptionId: subscription.id,
      replayedThroughSeq: lastSeq,
    });
    if (!responded) {
      this.#drop(subscription);
      return;
    }
    // 补发也算在途：优雅退出时等它读完库再关闭数据库（`settle()`）。
    this.#track(
      this.#replay(subscription, sinceSeq, lastSeq, elideSuperseded === true).catch(
        (error: unknown) => {
          // 补发失败（读库出错）时客户端会一直等不到事件；断开让它重连后重新订阅。
          this.#host.onError(error);
          this.terminate();
        },
      ),
    );
  }

  async #replay(
    subscription: Subscription,
    sinceSeq: number,
    through: number,
    elide: boolean,
  ): Promise<void> {
    // `events.subscribe` 已经要了同一项权限；补发前再看一次，事件都经 `#mayNotify` 把关。
    if (!this.#mayNotify('events.event')) return;
    // 0.127.0：客户端要了就去掉补发范围里已被取代的内容（工具的中间输出、被已提交消息替换的增量），事件与 seq 照发。
    const superseded =
      elide && sinceSeq < through
        ? this.#host.events.supersededSince(subscription.sessionId, sinceSeq, through)
        : undefined;
    // 补发按批读库，并按发送缓冲限速：缓冲到上限的四分之一就等它写出，补发本身不会撑爆缓冲。
    const highWater = this.#limits.sendBufferLimitBytes / 4;
    let cursor = sinceSeq;
    while (cursor < through) {
      const batch = this.#host.events.readSince(
        subscription.sessionId,
        cursor,
        this.#limits.replayBatchSize,
      );
      if (batch.length === 0) break;
      for (const event of batch) {
        if (event.seq > through) break;
        cursor = event.seq;
        const text = this.#eventFrame(
          subscription,
          superseded?.has(event.seq) ? elideSuperseded(event) : event,
        );
        const sent =
          this.#ws.bufferedAmount + text.length >= highWater
            ? await this.#sendAndFlush(text)
            : this.#sendText(text);
        if (!sent || !subscription.active) return;
      }
      if (cursor >= through) break;
      await yieldToEventLoop();
      if (!subscription.active) return;
    }
    // 追平：按序发出排队的实时事件并转为直接推送，在同一个同步段里完成。
    const queue = subscription.queue ?? [];
    this.#queuedBytes -= subscription.queuedBytes;
    subscription.queue = undefined;
    subscription.queuedBytes = 0;
    for (const text of queue) if (!this.#notifyText('events.event', text)) return;
  }

  /** 事件库提交后同步调用。 */
  #deliver(subscription: Subscription, event: WevirEvent): void {
    if (!subscription.active) return;
    const text = this.#eventFrame(subscription, event);
    if (!subscription.queue) {
      this.#notifyText('events.event', text);
      return;
    }
    const bytes = Buffer.byteLength(text);
    subscription.queue.push(text);
    subscription.queuedBytes += bytes;
    this.#queuedBytes += bytes;
    if (this.#backlog() > this.#limits.sendBufferLimitBytes) this.#overflow();
  }

  #eventFrame(subscription: Subscription, event: WevirEvent): string {
    return JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      method: 'events.event',
      params: {
        subscriptionId: subscription.id,
        event: adaptEventForClient(event, this.#capabilities),
      },
    });
  }

  /**
   * 调过 `account.*` 的连接之后收 `account.updated`（host-api.md §3.1），连接关闭即止。通知在发出前按注册表校验，
   * 不合 schema 的交给 `onError`、不发。
   */
  #watchAccounts(): void {
    if (this.#unwatchAccounts !== undefined || this.#host.accounts === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchAccounts = this.#host.accounts.watch((account) => {
      // COMPAT(subscriptionKinds): added in 0.19.0, remove gate after 2027-06-01
      if (!subscriptionKindSupported(account.kind, this.#capabilities, this.#protocolVersion))
        return;
      // COMPAT(subscriptionAccounts): added in 0.63.0, remove gate after 2027-06-01
      if (!accountSupported(account, this.#capabilities)) return;
      const parsed = NotificationSchemas['account.updated'].params.safeParse({ account });
      if (!parsed.success) {
        this.#host.onError(new Error(`account.updated does not match its schema: ${parsed.error}`));
        return;
      }
      this.#notify('account.updated', parsed.data);
    });
  }

  /** 调过 `settings.*` 的连接之后收 `settings.updated`（R11，host-api.md §3.1），连接关闭即止。 */
  #watchSettings(): void {
    if (this.#unwatchSettings !== undefined || this.#host.settings === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchSettings = this.#host.settings.watch((settings) => {
      const parsed = NotificationSchemas['settings.updated'].params.safeParse({ settings });
      if (!parsed.success) {
        this.#host.onError(
          new Error(`settings.updated does not match its schema: ${parsed.error}`),
        );
        return;
      }
      this.#notify('settings.updated', parsed.data);
    });
  }

  #watchPlugins(): void {
    if (this.#unwatchPlugins || !this.#host.plugins || this.#phase !== 'ready') return;
    this.#unwatchPlugins = this.#host.plugins.watch(() => {
      this.#notify('plugins.changed', {});
    });
  }

  /** 调过 `memory.*` 的连接之后收 `memory.changed`（0.57.0），连接关闭即止。 */
  #watchMemory(): void {
    if (this.#unwatchMemory !== undefined || this.#host.memory === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchMemory = this.#host.memory.watch((change) => {
      const parsed = NotificationSchemas['memory.changed'].params.safeParse(change);
      if (!parsed.success) {
        this.#host.onError(new Error(`memory.changed does not match its schema: ${parsed.error}`));
        return;
      }
      this.#notify('memory.changed', parsed.data);
    });
  }

  /**
   * 调过 `session.list` 的连接之后收 `sessions.changed`（0.101.0，domain-model §3.46），连接关闭即止。协商版本更低的连接不认这个通知，
   * 不登记。每一批都发（与它无关时两个数组都是空的），这条连接看到的版本才是连续的。
   */
  #watchSessionList(params: MethodParams<'session.list'>, sessions: readonly Session[]): void {
    const feed = this.#host.sessionList;
    if (feed === undefined || this.#phase !== 'ready') return;
    if (compareProtocolVersions(this.#protocolVersion, SESSION_LIST_PUSH_SINCE) < 0) return;
    this.#sessionListScope.add(params, sessions);
    this.#unwatchSessionList ??= feed.watch((batch) => {
      const change = this.#sessionListScope.apply(batch);
      // COMPAT(titleSourceGenerated): added in 0.5.0, remove gate after 2027-06-01
      if (this.#capabilities.title_source_generated !== true) {
        change.upserted = change.upserted.map(adaptSession);
      }
      this.#notify('sessions.changed', change);
    });
  }

  /**
   * 调过 `inbox.*` 的连接之后收 `inbox.changed`（0.105.0，domain-model §3.47），连接关闭即止。收件箱是全局的，每一批都原样发给每条
   * 这样的连接，版本连续。
   */
  #watchInbox(): void {
    if (this.#unwatchInbox !== undefined || this.#host.inbox === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchInbox = this.#host.inbox.watch((change) => this.#notify('inbox.changed', change));
  }

  /**
   * `notification.subscribe` 之后收 `notification.intent`（0.106.0，domain-model §3.48），连接关闭即止。意图是全局的，每条都原样发给每条
   * 订阅了的连接；不补发。
   */
  #watchNotifications(): void {
    if (this.#unwatchNotifications !== undefined || this.#host.notifications === undefined) return;
    if (this.#phase !== 'ready') return;
    // 0.121.0 之前的客户端不认 `channel` 种类的意图。
    const channelKind = compareProtocolVersions(this.#protocolVersion, CHANNEL_INTENTS_SINCE) >= 0;
    this.#unwatchNotifications = this.#host.notifications.watch((intent) => {
      if (intent.kind === 'channel' && !channelKind) return;
      this.#notify('notification.intent', intent);
    });
  }

  /**
   * 调过 `device.*`、`pairing.*` 或 `remote.*` 的连接之后收 `devices.changed`、`pairing.request`、`pairing.ended`（0.107.0，
   * domain-model §3.49）与 `remote.changed`（0.109.0），连接关闭即止。只有本机连接调得了这些方法。
   */
  #watchRemote(): void {
    const remote = this.#host.remote;
    if (this.#unwatchRemote !== undefined || remote === undefined) return;
    if (this.#phase !== 'ready') return;
    const version = this.#protocolVersion;
    const unwatchDevices = remote.devices.watch((devices) =>
      this.#notify('devices.changed', { devices: devices.map((d) => deviceForClient(d, version)) }),
    );
    const unwatchPairing = remote.pairing.watch((event) => {
      if (event.type === 'request')
        this.#notify('pairing.request', deviceForClient(event.request, version));
      else this.#notify('pairing.ended', event.ended);
    });
    const unwatchListener = remote.listener?.watch((status) =>
      this.#notify('remote.changed', status),
    );
    this.#unwatchRemote = () => {
      unwatchDevices();
      unwatchPairing();
      unwatchListener?.();
    };
  }

  /** `push.*` 的对象：只有远程设备的连接有（本机连接 `INVALID_REQUEST`）。 */
  #pushTarget(): {
    push: NonNullable<NonNullable<ConnectionHost['remote']>['push']>;
    deviceId: DeviceId;
  } {
    const principal = this.#grant.principal;
    if (principal.kind !== 'device') {
      throw new HostError('INVALID_REQUEST', 'push.* is only for remote devices');
    }
    const push = this.#host.remote?.push;
    if (push === undefined) throw new HostError('INVALID_REQUEST', 'this host has no push service');
    return { push, deviceId: principal.deviceId as DeviceId };
  }

  /**
   * 远程设备调过 `push.*` 之后收 `push.changed`（0.112.0，domain-model §3.52）：只有这台设备自己的推送状态变了才发，连接关闭即止。
   */
  #watchPush(deviceId: DeviceId): void {
    const push = this.#host.remote?.push;
    if (this.#unwatchPush !== undefined || push === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchPush = push.onDeviceChange((changed) => {
      if (changed !== deviceId) return;
      push.stateFor(deviceId).then(
        (state) => this.#notify('push.changed', state),
        (error: unknown) => this.#host.onError(error),
      );
    });
  }

  /** 调过 `usage.*` 的连接之后收 `usage.changed`（0.62.0），连接关闭即止。 */
  #watchUsage(): void {
    if (this.#unwatchUsage !== undefined || this.#host.usage === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchUsage = this.#host.usage.watch(() => {
      this.#notify('usage.changed', {});
    });
  }

  /** 调过 `channel.list` 的连接之后收 `channels.changed`（0.120.0），连接关闭即止。 */
  #watchChannels(): void {
    if (this.#unwatchChannels !== undefined || this.#host.channels === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchChannels = this.#host.channels.watch((change) => {
      this.#notifyChecked(
        'channels.changed',
        channelNotificationForClient('channels.changed', change, this.#protocolVersion),
      );
    });
  }

  /**
   * `channel.subscribe`（0.120.0）：登记、发出响应、补发 `afterSeq` 之后的帖子，三步在同一个同步段里，中间插不进新帖；之后的新帖与变化
   * 照常推送。
   */
  #subscribeChannel(id: JsonRpcId, params: MethodParams<'channel.subscribe'>): void {
    const channels = this.#host.channels;
    if (channels === undefined)
      throw new HostError('INVALID_PARAMS', 'this host has no channels', { issues: [] });
    const subscriptionId = newId('sub');
    const { lastSeq, unsubscribe } = channels.subscribe(params.channelId, undefined, (message) => {
      const version = this.#protocolVersion;
      if (message.kind === 'posted') {
        this.#notifyChecked(
          'channel.posted',
          channelNotificationForClient(
            'channel.posted',
            { subscriptionId, post: message.post },
            version,
          ),
        );
      } else {
        this.#notifyChecked(
          'channel.updated',
          channelNotificationForClient(
            'channel.updated',
            { subscriptionId, ...message.update },
            version,
          ),
        );
      }
    });
    this.#channelSubscriptions.set(subscriptionId, unsubscribe);
    if (!this.#respond(id, 'channel.subscribe', { subscriptionId, lastSeq })) {
      unsubscribe();
      this.#channelSubscriptions.delete(subscriptionId);
      return;
    }
    if (params.afterSeq === undefined) return;
    let cursor = params.afterSeq;
    while (cursor < lastSeq) {
      const { posts } = channels.posts({
        channelId: params.channelId,
        afterSeq: cursor,
        limit: 200,
      });
      if (posts.length === 0) break;
      for (const post of posts) {
        if (post.seq > lastSeq) return;
        cursor = post.seq;
        this.#notifyChecked(
          'channel.posted',
          channelNotificationForClient(
            'channel.posted',
            { subscriptionId, post },
            this.#protocolVersion,
          ),
        );
      }
    }
  }

  /** 按通知的 schema 校验后发出；不合 schema 时交给 `onError`，不发。 */
  #notifyChecked<N extends 'channels.changed' | 'channel.posted' | 'channel.updated'>(
    name: N,
    params: NotificationParams<N>,
  ): void {
    const parsed = NotificationSchemas[name].params.safeParse(params);
    if (!parsed.success) {
      this.#host.onError(new Error(`${name} does not match its schema: ${parsed.error}`));
      return;
    }
    this.#notify(name, parsed.data as NotificationParams<N>);
  }

  /** 调过 `automation.*` 的连接之后收 `automation.changed`（0.66.0），连接关闭即止。 */
  #watchAutomations(): void {
    if (this.#unwatchAutomations !== undefined || this.#host.automations === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchAutomations = this.#host.automations.watch((change) => {
      const parsed = NotificationSchemas['automation.changed'].params.safeParse(change);
      if (!parsed.success) {
        this.#host.onError(
          new Error(`automation.changed does not match its schema: ${parsed.error}`),
        );
        return;
      }
      this.#notify('automation.changed', parsed.data);
    });
  }

  /** 调过 `preview.*` 的连接之后收 `preview.changed`（0.84.0），连接关闭即止。 */
  #watchPreviews(): void {
    if (this.#unwatchPreviews !== undefined || this.#host.previews === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchPreviews = this.#host.previews.watch((change) => {
      const parsed = NotificationSchemas['preview.changed'].params.safeParse(change);
      if (!parsed.success) {
        this.#host.onError(new Error(`preview.changed does not match its schema: ${parsed.error}`));
        return;
      }
      this.#notify('preview.changed', parsed.data);
    });
  }

  /** 调过 `speech.*` 的连接之后收 `speech.changed`（0.92.0），连接关闭即止。 */
  #watchSpeech(): void {
    if (this.#unwatchSpeech !== undefined || this.#host.speech === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchSpeech = this.#host.speech.watch((status) => {
      const parsed = NotificationSchemas['speech.changed'].params.safeParse({ status });
      if (!parsed.success) {
        this.#host.onError(new Error(`speech.changed does not match its schema: ${parsed.error}`));
        return;
      }
      this.#notify('speech.changed', parsed.data);
    });
  }

  /** 调过 `power.*` 的连接之后收 `power.changed`（0.102.0），连接关闭即止。 */
  #watchPower(): void {
    if (this.#unwatchPower !== undefined || this.#host.power === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchPower = this.#host.power.watch((keepAwake) => {
      this.#notify('power.changed', { keepAwake });
    });
  }

  /** 调过 `market.*` 的连接之后收 `market.installProgress`（0.99.0），连接关闭即止。 */
  #watchMarket(): void {
    if (this.#unwatchMarket !== undefined || this.#host.market === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchMarket = this.#host.market.watch((progress) => {
      const parsed = NotificationSchemas['market.installProgress'].params.safeParse(progress);
      if (!parsed.success) {
        this.#host.onError(
          new Error(`market.installProgress does not match its schema: ${parsed.error}`),
        );
        return;
      }
      this.#send({
        jsonrpc: JSONRPC_VERSION,
        method: 'market.installProgress',
        params: parsed.data,
      });
    });
  }

  /** 调过 `tuning.*` 的连接之后收 `tuning.changed`（0.85.0），连接关闭即止。 */
  #watchTuning(): void {
    if (this.#unwatchTuning !== undefined || this.#host.tuning === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchTuning = this.#host.tuning.watch((workspaceId) => {
      const params = workspaceId === undefined ? {} : { workspaceId };
      const parsed = NotificationSchemas['tuning.changed'].params.safeParse(params);
      if (!parsed.success) {
        this.#host.onError(new Error(`tuning.changed does not match its schema: ${parsed.error}`));
        return;
      }
      this.#notify('tuning.changed', parsed.data);
    });
    this.#watchProposals();
  }

  /** 调过 `tuning.*` 的连接之后也收 `tuning.proposal.changed`（0.87.0），连接关闭即止。 */
  #watchProposals(): void {
    if (this.#unwatchProposals !== undefined || this.#host.proposals === undefined) return;
    this.#unwatchProposals = this.#host.proposals.watch((workspaceId) => {
      const params = workspaceId === undefined ? {} : { workspaceId };
      const parsed = NotificationSchemas['tuning.proposal.changed'].params.safeParse(params);
      if (!parsed.success) {
        this.#host.onError(
          new Error(`tuning.proposal.changed does not match its schema: ${parsed.error}`),
        );
        return;
      }
      this.#notify('tuning.proposal.changed', parsed.data);
    });
  }

  /** 调过 `guardrail.*` 或 `repoHook.*` 的连接之后收 `guardrail.changed`（0.86.0），连接关闭即止。 */
  #watchGuardrails(): void {
    if (this.#unwatchGuardrails !== undefined || this.#host.guardrails === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchGuardrails = this.#host.guardrails.watch((change) => {
      const parsed = NotificationSchemas['guardrail.changed'].params.safeParse(change);
      if (!parsed.success) {
        this.#host.onError(
          new Error(`guardrail.changed does not match its schema: ${parsed.error}`),
        );
        return;
      }
      this.#notify('guardrail.changed', parsed.data);
    });
  }

  /** 调过 `readiness.*` 的连接之后收 `readiness.changed`（0.70.0），连接关闭即止。 */
  #watchReadiness(): void {
    if (this.#unwatchReadiness !== undefined || this.#host.readiness === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchReadiness = this.#host.readiness.watch((change) => {
      const parsed = NotificationSchemas['readiness.changed'].params.safeParse(change);
      if (!parsed.success) {
        this.#host.onError(
          new Error(`readiness.changed does not match its schema: ${parsed.error}`),
        );
        return;
      }
      this.#notify('readiness.changed', parsed.data);
    });
  }

  /** 调过 `lsp.*` 的连接之后收 `lsp.changed`（0.71.0），连接关闭即止。 */
  #watchLsp(): void {
    if (this.#unwatchLsp !== undefined || this.#host.lsp === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchLsp = this.#host.lsp.watch((change) => {
      const parsed = NotificationSchemas['lsp.changed'].params.safeParse(change);
      if (!parsed.success) {
        this.#host.onError(new Error(`lsp.changed does not match its schema: ${parsed.error}`));
        return;
      }
      this.#notify('lsp.changed', parsed.data);
    });
  }

  /** 调过 `process.*` 的连接之后收 `process.changed`（0.69.0），连接关闭即止。 */
  #watchProcesses(): void {
    if (this.#unwatchProcesses !== undefined || this.#host.processes === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchProcesses = this.#host.processes.watch((change) => {
      // COMPAT(devPreview): added in 0.84.0, remove gate after 2027-06-01
      if (
        'process' in change &&
        change.process.source.kind === 'preview' &&
        this.#capabilities.dev_preview !== true
      ) {
        return;
      }
      const parsed = NotificationSchemas['process.changed'].params.safeParse(change);
      if (!parsed.success) {
        this.#host.onError(new Error(`process.changed does not match its schema: ${parsed.error}`));
        return;
      }
      this.#notify('process.changed', parsed.data);
    });
  }

  #terminalService(): NonNullable<ConnectionHost['terminals']> {
    if (this.#host.terminals === undefined) {
      throw new HostError('INVALID_PARAMS', 'this host has no user terminal', {
        issues: [{ path: [], message: 'this host has no user terminal' }],
      });
    }
    return this.#host.terminals;
  }

  #simulatorService(): NonNullable<ConnectionHost['simulators']> {
    if (this.#host.simulators === undefined) {
      throw new HostError('INVALID_PARAMS', 'this host has no iOS simulator support', {
        issues: [{ path: [], message: 'this host has no iOS simulator support' }],
      });
    }
    return this.#host.simulators;
  }

  /** 调过 `simulator.*` 的连接之后收 `simulator.changed` 与 `simulator.orientation`（0.122.0），连接关闭即止。 */
  #watchSimulators(): void {
    if (this.#unwatchSimulators !== undefined || this.#host.simulators === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchSimulators = this.#host.simulators.watch((notice) => {
      const parsed = NotificationSchemas[notice.method].params.safeParse(notice.params);
      if (!parsed.success) {
        this.#host.onError(
          new Error(`${notice.method} does not match its schema: ${parsed.error}`),
        );
        return;
      }
      this.#notify(notice.method, parsed.data as never);
    });
  }

  /** 调过 `terminal.*` 的连接之后收 `terminal.changed`（0.69.0），连接关闭即止。 */
  #watchTerminals(): void {
    if (this.#unwatchTerminals !== undefined || this.#host.terminals === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchTerminals = this.#host.terminals.watch((change) => {
      const parsed = NotificationSchemas['terminal.changed'].params.safeParse(change);
      if (!parsed.success) {
        this.#host.onError(
          new Error(`terminal.changed does not match its schema: ${parsed.error}`),
        );
        return;
      }
      this.#notify('terminal.changed', parsed.data);
    });
  }

  #drop(subscription: Subscription): void {
    if (!subscription.active) return;
    subscription.active = false;
    subscription.unsubscribe();
    this.#queuedBytes -= subscription.queuedBytes;
    subscription.queue = undefined;
    subscription.queuedBytes = 0;
    this.#subscriptions.delete(subscription.id);
  }

  // ── 发帧 ────────────────────────────────────────────────────────────

  #send(frame: object): boolean {
    return this.#sendText(JSON.stringify(frame));
  }

  /** 这条连接有没有收这种通知的读权限（`NOTIFICATION_PERMISSIONS`）。所有通知都经它把关。 */
  #mayNotify(method: NotificationName): boolean {
    return this.#permissions.has(NOTIFICATION_PERMISSIONS[method]);
  }

  #notify<N extends NotificationName>(method: N, params: NotificationParams<N>): boolean {
    if (!this.#mayNotify(method)) return false;
    return this.#send({ jsonrpc: JSONRPC_VERSION, method, params });
  }

  /** 已经序列化好的通知帧（`events.event`）。 */
  #notifyText(method: NotificationName, text: string): boolean {
    return this.#mayNotify(method) && this.#sendText(text);
  }

  /**
   * 发出一帧，返回是否发出。积压（ws 尚未写出的字节 + 排队的实时事件）已超过上限时不再发送，以
   * `SEND_BUFFER_OVERFLOW` 断开；单个大帧本身不算超限，所以积压最多超出上限一帧。
   */
  #sendText(text: string, onFlushed?: () => void): boolean {
    if (this.#phase === 'closing' || this.#phase === 'closed') {
      onFlushed?.();
      return false;
    }
    if (this.#backlog() > this.#limits.sendBufferLimitBytes) {
      this.#overflow();
      onFlushed?.();
      return false;
    }
    this.#ws.send(text, onFlushed && (() => onFlushed()));
    return true;
  }

  /** 发出一帧并等它写到套接字（或连接关闭）。 */
  #sendAndFlush(text: string): Promise<boolean> {
    return new Promise((resolve) => {
      let sent = false;
      sent = this.#sendText(text, () => resolve(sent));
    });
  }

  #backlog(): number {
    return this.#ws.bufferedAmount + this.#queuedBytes;
  }

  #overflow(): void {
    this.#close('SEND_BUFFER_OVERFLOW', 'send buffer overflow');
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  #touch(): void {
    this.#lastActivity = performance.now();
  }

  /** 租约计时器只在到期时检查一次最后活动时间，不随每一帧重设。 */
  #armLease(): void {
    const remaining = this.#lastActivity + this.#limits.leaseMs - performance.now();
    if (remaining <= 0) {
      this.#close('LEASE_EXPIRED', 'lease expired');
      return;
    }
    this.#leaseTimer = unref(setTimeout(() => this.#armLease(), remaining));
  }

  #close(code: CloseCodeName, reason: string): void {
    if (this.#phase === 'closing' || this.#phase === 'closed') return;
    this.#phase = 'closing';
    this.#cleanup();
    this.#ws.close(CloseCode[code], reason);
    // 对方不回关闭帧（例如不再读取）时不无限等待。
    this.#terminateTimer = unref(setTimeout(() => this.terminate(), this.#limits.closeTimeoutMs));
  }

  #onClose(): void {
    this.#phase = 'closed';
    this.#cleanup();
    clearTimeout(this.#terminateTimer);
    this.#resolveClosed();
  }

  #cleanup(): void {
    clearTimeout(this.#helloTimer);
    clearTimeout(this.#leaseTimer);
    for (const subscription of [...this.#subscriptions.values()]) this.#drop(subscription);
    this.#unwatchAccounts?.();
    this.#unwatchAccounts = undefined;
    this.#unwatchSettings?.();
    this.#unwatchPlugins?.();
    this.#unwatchPlugins = undefined;
    this.#unwatchSettings = undefined;
    this.#unwatchMemory?.();
    this.#unwatchMemory = undefined;
    this.#unwatchSessionList?.();
    this.#unwatchSessionList = undefined;
    this.#unwatchInbox?.();
    this.#unwatchInbox = undefined;
    this.#unwatchChannels?.();
    this.#unwatchChannels = undefined;
    for (const unsubscribe of this.#channelSubscriptions.values()) unsubscribe();
    this.#channelSubscriptions.clear();
    this.#unwatchRemote?.();
    this.#unwatchRemote = undefined;
    this.#unwatchNotifications?.();
    this.#unwatchNotifications = undefined;
    this.#unwatchPush?.();
    this.#unwatchPush = undefined;
    this.#host.presence?.remove(this);
    this.#unwatchUsage?.();
    this.#unwatchUsage = undefined;
    this.#unwatchAutomations?.();
    this.#unwatchAutomations = undefined;
    this.#unwatchProcesses?.();
    this.#unwatchProcesses = undefined;
    this.#unwatchReadiness?.();
    this.#unwatchReadiness = undefined;
    this.#unwatchPreviews?.();
    this.#unwatchPreviews = undefined;
    this.#unwatchSpeech?.();
    this.#unwatchSpeech = undefined;
    this.#unwatchMarket?.();
    this.#unwatchMarket = undefined;
    this.#unwatchPower?.();
    this.#unwatchPower = undefined;
    this.#unwatchTuning?.();
    this.#unwatchTuning = undefined;
    this.#unwatchProposals?.();
    this.#unwatchProposals = undefined;
    this.#unwatchGuardrails?.();
    this.#unwatchGuardrails = undefined;
    this.#unwatchLsp?.();
    this.#unwatchLsp = undefined;
    this.#unwatchTerminals?.();
    this.#unwatchTerminals = undefined;
    for (const detach of this.#terminalAttachments.values()) detach();
    this.#terminalAttachments.clear();
    this.#unregisterBrowser?.();
    this.#unregisterBrowser = undefined;
    this.#unregisterComputer?.();
    this.#unregisterComputer = undefined;
    this.#unwatchSimulators?.();
    this.#unwatchSimulators = undefined;
    this.#unwatchSimulatorShow?.();
    this.#unwatchSimulatorShow = undefined;
    this.#host.simulators?.detachOwner(this.#browserProviderId);
  }
}

/**
 * 按连接的能力位调整发给它的事件（host-api.md §10）：只把已知事件类型里的新枚举值或新形状降级成该
 * 连接认得的形状，从不扣下事件，订阅内 `seq` 保持连续（ADR-0002 补记 1）。全新的事件类型照常发送，
 * 客户端忽略不认识的 `type`。新增能力位时在这里加分支，并带 `COMPAT` 标签。
 */
export function adaptEventForClient(
  event: WevirEvent,
  capabilities: ClientCapabilities,
): WevirEvent {
  // COMPAT(userImages): added in 0.28.0, remove gate after 2027-06-01
  if (capabilities.user_images !== true) {
    switch (event.type) {
      case 'user.message':
        if (hasImage(event.payload.content)) {
          return {
            ...event,
            payload: { ...event.payload, content: withoutImages(event.payload.content) },
          };
        }
        break;
      case 'user.steered':
        if (hasImage(event.payload.content)) {
          return {
            ...event,
            payload: { ...event.payload, content: withoutImages(event.payload.content) },
          };
        }
        break;
      case 'turn.started':
        if (event.payload.input !== undefined && hasImage(event.payload.input)) {
          return {
            ...event,
            payload: { ...event.payload, input: withoutImages(event.payload.input) },
          };
        }
        break;
      case 'pending.added':
      case 'pending.updated':
        if (hasImage(event.payload.pending.content)) {
          return { ...event, payload: { pending: pendingWithoutImages(event.payload.pending) } };
        }
        break;
    }
  }
  // COMPAT(questionTimeout): added in 0.72.0, remove gate after 2027-06-01
  if (
    event.type === 'question.resolved' &&
    event.payload.resolution.reason === 'timeout' &&
    capabilities.question_timeout !== true
  ) {
    return {
      ...event,
      payload: { ...event.payload, resolution: { ...event.payload.resolution, reason: 'user' } },
    };
  }
  // COMPAT(approvalRules): added in 0.80.0, remove gate after 2027-06-01
  if (
    event.type === 'approval.resolved' &&
    event.payload.resolution.reason === 'rule' &&
    capabilities.approval_rules !== true
  ) {
    return {
      ...event,
      payload: { ...event.payload, resolution: { ...event.payload.resolution, reason: 'user' } },
    };
  }
  // COMPAT(approvalTimeout): added in 0.105.0, remove gate after 2027-06-01
  if (
    event.type === 'approval.resolved' &&
    event.payload.resolution.reason === 'timeout' &&
    capabilities.approval_timeout !== true
  ) {
    return {
      ...event,
      payload: {
        ...event.payload,
        resolution: { ...event.payload.resolution, reason: 'host_restarted' },
      },
    };
  }
  // COMPAT(toolDisplayImage): added in 0.118.0, remove gate after 2027-06-01
  if (capabilities.tool_display_image !== true) {
    if (event.type === 'tool.started' && event.payload.display.kind === 'image') {
      return {
        ...event,
        payload: { ...event.payload, display: unknownDisplay(event.payload.display) },
      };
    }
    if (event.type === 'tool.updated' && event.payload.display?.kind === 'image') {
      return {
        ...event,
        payload: { ...event.payload, display: unknownDisplay(event.payload.display) },
      };
    }
  }
  // COMPAT(titleSourceGenerated): added in 0.5.0, remove gate after 2027-06-01
  if (
    event.type === 'session.title_changed' &&
    event.payload.source === 'generated' &&
    capabilities.title_source_generated !== true
  ) {
    return { ...event, payload: { ...event.payload, source: 'first_prompt' } };
  }
  return event;
}

/** 展示类型降级成 `unknown`，其余字段不变。 */
function unknownDisplay(display: ToolDisplay): ToolDisplay {
  return { ...display, kind: 'unknown' };
}

/**
 * 按连接的能力位调整方法的结果，规则同 `adaptEventForClient`：结果里的会话降级 `titleSource`；`provider.list` 去掉
 * 连接认不出的 `chatgpt` 类 Provider（0.7.0）与订阅来源（0.19.0），`account.list` 去掉订阅来源。
 */
export function adaptResultForClient(
  method: MethodName,
  result: unknown,
  capabilities: ClientCapabilities,
  protocolVersion: string = PROTOCOL_VERSION,
): unknown {
  // COMPAT(userImages): added in 0.28.0, remove gate after 2027-06-01
  const value = capabilities.user_images === true ? result : resultWithoutImages(method, result);
  // COMPAT(devPreview): added in 0.84.0, remove gate after 2027-06-01
  if (method === 'process.list' && capabilities.dev_preview !== true) {
    const listed = value as MethodResult<'process.list'>;
    return {
      ...listed,
      processes: listed.processes.filter((process) => process.source.kind !== 'preview'),
    };
  }
  // COMPAT(questionTimeout): added in 0.72.0, remove gate after 2027-06-01
  if (method === 'question.respond' && capabilities.question_timeout !== true) {
    const answered = value as MethodResult<'question.respond'>;
    if (answered.resolution.reason === 'timeout') {
      return { ...answered, resolution: { ...answered.resolution, reason: 'user' } };
    }
  }
  // COMPAT(webDevicePlatform): added in 0.117.0, remove gate after 2027-06-01
  if (compareProtocolVersions(protocolVersion, WEB_DEVICE_SINCE) < 0) {
    if (method === 'device.list') {
      const listed = value as MethodResult<'device.list'>;
      return { devices: listed.devices.map((d) => deviceForClient(d, protocolVersion)) };
    }
    if (method === 'device.update' || method === 'device.revoke' || method === 'pairing.respond') {
      const result = value as { device?: Device };
      if (result.device !== undefined)
        return { ...result, device: deviceForClient(result.device, protocolVersion) };
    }
  }
  // COMPAT(channelGroups): added in 0.132.0, remove gate after 2027-06-01
  if (
    method.startsWith('channel.') &&
    compareProtocolVersions(protocolVersion, CHANNEL_GROUPS_SINCE) < 0
  ) {
    return adaptKindsAndTitles(
      method,
      channelResultForOldClient(value),
      capabilities,
      protocolVersion,
    );
  }
  return adaptKindsAndTitles(method, value, capabilities, protocolVersion);
}

/** 助理群与 `assistant` 作者进协议的版本：更早的客户端看不到群，别的助理写的帖子给它们看成 Host 写的。 */
const CHANNEL_GROUPS_SINCE = '0.132.0';

function postForOldClient(post: ChannelPost): ChannelPost {
  return post.author.kind === 'assistant' ? { ...post, author: { kind: 'host' } } : post;
}

function channelForOldClient(channel: Channel): Channel {
  if (channel.lastPost?.author !== 'assistant') return channel;
  const { assistantId: _assistantId, ...lastPost } = channel.lastPost;
  return { ...channel, lastPost: { ...lastPost, author: 'host' } };
}

/** `channel.*` 的结果给 0.132.0 以前的客户端：去掉群，改写帖子作者。 */
function channelResultForOldClient(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const result = { ...(value as Record<string, unknown>) };
  if (Array.isArray(result.channels)) {
    result.channels = (result.channels as Channel[])
      .filter((channel) => channel.kind !== 'group')
      .map(channelForOldClient);
  }
  if (result.channel !== undefined) result.channel = channelForOldClient(result.channel as Channel);
  if (Array.isArray(result.posts))
    result.posts = (result.posts as ChannelPost[]).map(postForOldClient);
  if (result.post !== undefined) result.post = postForOldClient(result.post as ChannelPost);
  return result;
}

/** 频道的通知给 0.132.0 以前的客户端：同 `channelResultForOldClient`。 */
export function channelNotificationForClient<
  N extends 'channels.changed' | 'channel.posted' | 'channel.updated',
>(name: N, params: NotificationParams<N>, protocolVersion: string): NotificationParams<N> {
  if (compareProtocolVersions(protocolVersion, CHANNEL_GROUPS_SINCE) >= 0) return params;
  if (name === 'channels.changed') {
    const change = params as NotificationParams<'channels.changed'>;
    return {
      ...change,
      upserted: change.upserted
        .filter((channel) => channel.kind !== 'group')
        .map(channelForOldClient),
    } as NotificationParams<N>;
  }
  return channelResultForOldClient(params) as NotificationParams<N>;
}

/** 设备平台 `web` 进协议的版本：更早的客户端的枚举里没有它，给它们看 `other`。 */
const WEB_DEVICE_SINCE = '0.117.0';

function deviceForClient<T extends { platform: DevicePlatform }>(
  value: T,
  protocolVersion: string,
): T {
  return value.platform === 'web' && compareProtocolVersions(protocolVersion, WEB_DEVICE_SINCE) < 0
    ? { ...value, platform: 'other' }
    : value;
}

function adaptKindsAndTitles(
  method: MethodName,
  result: unknown,
  capabilities: ClientCapabilities,
  protocolVersion: string,
): unknown {
  // COMPAT(providerKindChatgpt): added in 0.7.0, remove gate after 2027-06-01
  // COMPAT(subscriptionKinds): added in 0.19.0, remove gate after 2027-06-01
  // COMPAT(providerKindGoogleVertex): added in 0.21.0, remove gate after 2027-06-01
  if (
    method === 'provider.list' &&
    (capabilities.provider_kind_chatgpt !== true ||
      capabilities.subscription_kinds !== true ||
      compareProtocolVersions(protocolVersion, '0.55.0') < 0 ||
      capabilities.provider_kind_google_vertex !== true)
  ) {
    const value = result as MethodResult<'provider.list'>;
    return {
      ...value,
      providers: value.providers.filter(
        (p) =>
          (p.kind !== 'chatgpt' || capabilities.provider_kind_chatgpt === true) &&
          (p.kind !== 'google-vertex' || capabilities.provider_kind_google_vertex === true) &&
          subscriptionKindSupported(p.kind, capabilities, protocolVersion),
      ),
    };
  }
  if (method === 'account.list') {
    const value = result as MethodResult<'account.list'>;
    return {
      ...value,
      accounts: value.accounts.filter(
        (a) =>
          subscriptionKindSupported(a.kind, capabilities, protocolVersion) &&
          // COMPAT(subscriptionAccounts): added in 0.63.0, remove gate after 2027-06-01
          accountSupported(a, capabilities),
      ),
    };
  }
  // COMPAT(titleSourceGenerated): added in 0.5.0, remove gate after 2027-06-01
  if (capabilities.title_source_generated === true) return result;
  switch (method) {
    case 'session.create':
    case 'session.get':
    case 'session.resume': {
      const value = result as MethodResult<'session.get'>;
      return { ...value, session: adaptSession(value.session) };
    }
    case 'session.list': {
      const value = result as MethodResult<'session.list'>;
      return { ...value, sessions: value.sessions.map(adaptSession) };
    }
    default:
      return result;
  }
}

/** 没声明 `user_images` 的连接：结果里待发消息的图片换成文本（0.28.0）。 */
function resultWithoutImages(method: MethodName, result: unknown): unknown {
  switch (method) {
    case 'session.get': {
      const value = result as MethodResult<'session.get'>;
      if (!value.pendingMessages?.some((pending) => hasImage(pending.content))) return result;
      return { ...value, pendingMessages: value.pendingMessages.map(pendingWithoutImages) };
    }
    case 'pending.update':
    case 'pending.cancel': {
      const value = result as MethodResult<'pending.update'>;
      if (!hasImage(value.pending.content)) return result;
      return { ...value, pending: pendingWithoutImages(value.pending) };
    }
    case 'pending.resume': {
      const value = result as MethodResult<'pending.resume'>;
      if (!value.pendingMessages.some((pending) => hasImage(pending.content))) return result;
      return { ...value, pendingMessages: value.pendingMessages.map(pendingWithoutImages) };
    }
    default:
      return result;
  }
}

function hasImage(content: readonly UserContentPart[]): boolean {
  return content.some((part) => part.type === 'image');
}

/** 图片换成文本 `[image]`，段数不变（`content` 至少一段）。 */
function withoutImages(content: readonly UserContentPart[]): UserContentPart[] {
  return content.map((part) => (part.type === 'image' ? { type: 'text', text: '[image]' } : part));
}

function pendingWithoutImages(pending: PendingMessage): PendingMessage {
  return hasImage(pending.content)
    ? { ...pending, content: withoutImages(pending.content) }
    : pending;
}

function adaptSession(session: Session): Session {
  return session.titleSource === 'generated'
    ? { ...session, titleSource: 'first_prompt' }
    : session;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** 令牌摘要，供 `ConnectionHost.tokenDigest` 用。 */
export function tokenDigest(token: string): Buffer {
  return sha256(token);
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** 不合法的请求里尽量取出 `id`，取不到时为 null（host-api.md §2）。 */
function requestIdOf(frame: unknown): JsonRpcId | null {
  if (typeof frame !== 'object' || frame === null || !('id' in frame)) return null;
  const { id } = frame;
  if ((typeof id === 'string' && id !== '') || Number.isInteger(id)) return id as JsonRpcId;
  return null;
}

/** zod 的 issue → `INVALID_PARAMS` 的 `data.issues`（只带路径与说明，不回显输入值）。 */
function toIssues(
  issues: readonly ZodIssueLike[],
): Array<{ path: Array<string | number>; message: string }> {
  return issues.map((issue) => ({
    path: issue.path.filter(
      (key): key is string | number => typeof key === 'string' || typeof key === 'number',
    ),
    message: issue.message,
  }));
}

function unref<T extends ReturnType<typeof setTimeout>>(timer: T): T {
  timer.unref?.();
  return timer;
}

/** 后加的订阅种类与它们进协议的版本：subscription_kinds 早于它们，旧版已声明该能力也不认识这些新枚举值。 */
const LATER_SUBSCRIPTION_KINDS: Readonly<Record<string, string>> = {
  workbuddy: '0.55.0',
  devin: '0.88.0',
  copilot: '0.125.0',
};

function subscriptionKindSupported(
  kind: string,
  capabilities: ClientCapabilities,
  protocolVersion: string,
): boolean {
  const since = LATER_SUBSCRIPTION_KINDS[kind];
  return (
    !isSubscriptionKind(kind) ||
    (capabilities.subscription_kinds === true &&
      (since === undefined || compareProtocolVersions(protocolVersion, since) >= 0))
  );
}

/** 0.63.0 之前的客户端按种类找账号：只给它们每种的首个账号（ID 等于种类）。 */
function accountSupported(
  account: { kind: string; id?: string },
  capabilities: ClientCapabilities,
): boolean {
  return (
    capabilities.subscription_accounts === true ||
    account.id === undefined ||
    account.id === account.kind
  );
}

function isSubscriptionKind(kind: string): boolean {
  return (SUBSCRIPTION_KINDS as readonly string[]).includes(kind);
}
