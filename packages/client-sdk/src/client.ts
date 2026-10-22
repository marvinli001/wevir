import {
  type AccountKind,
  type AccountState,
  AccountUpdatedParamsSchema,
  AutomationChangedParamsSchema,
  type BrowserRequest,
  type BrowserResponse,
  type ClientCapabilities,
  type ClientIdentity,
  CloseCode,
  type Device,
  DevicesChangedParamsSchema,
  EventsSubscribeResultSchema,
  GuardrailChangedParamsSchema,
  type HostFeature,
  HostHelloResultSchema,
  type HostSettings,
  InboxChangedParamsSchema,
  LspChangedParamsSchema,
  MarketInstallProgressSchema,
  MemoryChangedParamsSchema,
  type MethodName,
  type MethodParams,
  type MethodResult,
  MethodSchemas,
  type NotificationIntent,
  NotificationIntentSchema,
  type NotificationParams,
  NotificationSchemas,
  type PairingEnded,
  PairingEndedParamsSchema,
  type PairingRequest,
  PairingRequestParamsSchema,
  type Permission,
  PING_INTERVAL_MS,
  PowerChangedParamsSchema,
  PROTOCOL_VERSION,
  PreviewChangedParamsSchema,
  ProcessChangedParamsSchema,
  ReadinessChangedParamsSchema,
  RemoteChangedParamsSchema,
  type RemoteStatus,
  type SessionId,
  SessionsChangedParamsSchema,
  SettingsUpdatedParamsSchema,
  SpeechChangedParamsSchema,
  TerminalChangedParamsSchema,
  TerminalOutputParamsSchema,
  TuningChangedParamsSchema,
  TuningProposalChangedParamsSchema,
  WevirEventEnvelopeSchema,
  type WorkspaceId,
} from '@wevir/protocol';
import { DEFAULT_CLIENT_CAPABILITIES, hostSupports } from './capabilities.js';

/** `automation.changed` 的内容（0.66.0）。 */
export type AutomationChange = NotificationParams<'automation.changed'>;
/** `lsp.changed` 的内容（0.71.0）。 */
export type LspChange = NotificationParams<'lsp.changed'>;
/** `process.changed` 的内容（0.69.0）。 */
export type ProcessChange = NotificationParams<'process.changed'>;
/** `readiness.changed` 的内容（0.70.0）。 */
export type ReadinessChange = NotificationParams<'readiness.changed'>;
/** `preview.changed` 的内容（0.84.0）。 */
export type PreviewChange = NotificationParams<'preview.changed'>;
/** `sessions.changed` 的内容（0.101.0）。 */
export type SessionsChange = NotificationParams<'sessions.changed'>;
/** `speech.changed` 的内容（0.92.0）。 */
export type SpeechChange = NotificationParams<'speech.changed'>;
/** `market.installProgress` 的内容（0.99.0）。 */
export type MarketInstallProgress = NotificationParams<'market.installProgress'>;
/** `power.changed` 的内容（0.102.0）。 */
export type PowerChange = NotificationParams<'power.changed'>;
/** `inbox.changed` 的内容（0.105.0）。 */
export type InboxChange = NotificationParams<'inbox.changed'>;
/** 设备与配对的变化（0.107.0）：`devices.changed`、`pairing.request`、`pairing.ended`，以及远程监听的 `remote.changed`（0.109.0）。 */
export type RemoteDevicesChange =
  | { kind: 'devices'; devices: Device[] }
  | { kind: 'pairing_request'; request: PairingRequest }
  | { kind: 'pairing_ended'; ended: PairingEnded }
  | { kind: 'listener'; status: RemoteStatus };
/** `tuning.changed` 的内容（0.85.0）。 */
export type TuningChange = NotificationParams<'tuning.changed'>;
/** `guardrail.changed` 的内容（0.86.0）。 */
export type GuardrailChange = NotificationParams<'guardrail.changed'>;
/** `tuning.proposal.changed` 的内容（0.87.0）。 */
export type TuningProposalChange = NotificationParams<'tuning.proposal.changed'>;
/** `terminal.changed` 与 `terminal.output` 的内容（0.69.0）。 */
export type TerminalChange = NotificationParams<'terminal.changed'>;
export type TerminalOutput = NotificationParams<'terminal.output'>;

import {
  ClientClosedError,
  ConnectionLostError,
  ConnectTimeoutError,
  FeatureUnavailableError,
  HostUnavailableError,
  isRpcError,
  ProtocolError,
  RemoteHandshakeError,
  type RemoteRelayFailure,
  RemoteUnreachableError,
  RequestTimeoutError,
  relayCloseFailure,
  WevirRpcError,
} from './errors.js';
import {
  type BackoffOptions,
  ConnectionLifecycle,
  DEFAULT_BACKOFF,
  type FailureClass,
  type LifecycleState,
  type ReconnectReason,
} from './lifecycle.js';
import { type CallHandlers, type ChannelLoss, RpcChannel } from './rpc-channel.js';
import { type EventSubscription, SessionFeed, type SubscribeOptions } from './subscription.js';
import type { TransportFactory } from './transport.js';

/** Host 的端点：`run/host.json` 里的 `url` 与 `token`（host-api.md §1），照用，不自己拼地址。 */
/** `watchAccount` 的一个监听器。 */
interface AccountWatcher {
  readonly kind: AccountKind;
  readonly listener: (account: AccountState) => void;
  readonly onError?: (error: unknown) => void;
  /** 收到的 `account.updated` 数：`account.get` 的结果晚于其间到达的通知时，它是旧的，丢掉。 */
  updates: number;
}

/** `watchAccounts` 的一个监听器（0.19.0）。 */
interface AccountListWatcher {
  readonly listener: (accounts: AccountState[]) => void;
  readonly onError?: (error: unknown) => void;
  /** 当前的全部账号，按 Host 给的顺序；通知按账号 ID 替换其中一项。 */
  accounts: AccountState[];
  /** 收到的 `account.updated` 数：读全部的结果晚于其间到达的通知时，它是旧的，丢掉。 */
  updates: number;
}

/** 账号的 ID（0.63.0）：`AccountState.id`，旧 Host 没有时是种类（那时一种只有一个账号）。 */
export function accountId(account: Pick<AccountState, 'kind' | 'id'>): string {
  return account.id ?? account.kind;
}

/** 浏览器提供方（0.33.0）：执行 Host 交来的一个请求；回答不含 `requestId`，由客户端补上。 */
export type BrowserRequestHandler = (
  request: BrowserRequest,
) => Promise<DistributiveOmit<BrowserResponse, 'requestId'>>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface BrowserProviderEntry {
  readonly commands: readonly string[];
  readonly handle: BrowserRequestHandler;
}

/** `watchSettings` 的一个监听器。 */
interface SettingsWatcher {
  readonly listener: (settings: HostSettings) => void;
  readonly onError?: (error: unknown) => void;
  /** 收到的 `settings.updated` 数：`settings.get` 的结果晚于其间到达的通知时，它是旧的，丢掉。 */
  updates: number;
}

interface PluginsWatcher {
  readonly listener: (plugins: MethodResult<'plugins.list'>) => void;
  readonly onError?: (error: unknown) => void;
  updates: number;
}

/** `watchMemory` 的一个监听器（0.57.0）。 */
interface MemoryWatcher {
  /** 在看的项目；省略时只看全局的。 */
  readonly workspaceId: WorkspaceId | undefined;
  readonly listener: (memory: MethodResult<'memory.list'>) => void;
  readonly onError?: (error: unknown) => void;
  /** 发出的读取次数：晚到的旧结果丢掉。 */
  updates: number;
}

export interface HostEndpoint {
  url: string;
  token: string;
}

/**
 * 固定的端点，或每次连接尝试前调用一次的解析函数。Host 重启会换端口和令牌，所以要跨 Host 重启自动重连，
 * 就给解析函数（Node 入口的 `connectLocalHost` 每次重读 `run/host.json`；桌面渲染进程每次向主进程要）。
 */
export type EndpointSource = HostEndpoint | (() => HostEndpoint | Promise<HostEndpoint>);

export type HostHello = MethodResult<'host.hello'>;

/** 三种超时分开配置（ADR-0002 §5）。默认值见 `DEFAULT_TIMEOUTS`。 */
export interface ClientTimeouts {
  /** 请求的默认时限，从调用 `request` 算起，含断线期间等待连接的时间；可按请求覆盖。 */
  requestMs: number;
  /** 一次连接尝试的时限：解析端点、建立传输、完成 `host.hello`。 */
  connectMs: number;
  /** 发送 `host.ping` 的间隔。 */
  pingIntervalMs: number;
  /** 心跳超时：超过这么久没有收到 Host 的任何一帧，判定连接已死、重连。 */
  heartbeatMs: number;
}

/**
 * 默认超时（T4.1 定，host-api.md §12）：
 * - 请求 60 s：最慢的方法是 `session.create` / `session.resume`（可能要拉起引擎）与 `provider.test`
 *   （一次真实的模型请求），`session.cancel` 最多等 5 s；与 Paseo 客户端的默认 RPC 时限相同。
 * - 连接 10 s：只连本机 loopback，正常在几十毫秒内完成；比 Host 的 hello 时限（15 s）短，客户端先放弃。
 * - 心跳间隔 10 s（`PING_INTERVAL_MS`）。
 * - 心跳超时 20 s：容忍一次 ping 没有回音；远小于 Host 的 45 s 租约，Host 那边还没断，客户端已经在重连。
 */
export const DEFAULT_TIMEOUTS: ClientTimeouts = {
  requestMs: 60_000,
  connectMs: 10_000,
  pingIntervalMs: PING_INTERVAL_MS,
  heartbeatMs: 20_000,
};

/** 连接状态，供界面显示。 */
export type ConnectionState =
  | { status: 'connecting' }
  | { status: 'connected'; hello: HostHello }
  | {
      status: 'reconnecting';
      /** 自上次连上以来连续失败的次数，从 1 开始。 */
      attempt: number;
      /** 距下一次尝试的延迟。 */
      delayMs: number;
      reason: ReconnectReason;
      error?: unknown;
    }
  /** 主动关闭时没有 `error`；不可恢复的错误（协议不兼容、令牌错误且端点固定等）时有。 */
  | { status: 'closed'; error?: unknown };

export type ConnectionStatus = ConnectionState['status'];

export interface WevirClientOptions {
  endpoint: EndpointSource;
  /** 传输层，例如 `webSocketTransport(WebSocket)`。 */
  transport: TransportFactory;
  /** `host.hello` 里的 `clientKind`、`deviceId`、`clientId`（由 CLI / 桌面各自持久化）。 */
  identity: ClientIdentity;
  /** 默认 `DEFAULT_CLIENT_CAPABILITIES`。 */
  capabilities?: ClientCapabilities;
  timeouts?: Partial<ClientTimeouts>;
  /** 重连退避，默认见 `DEFAULT_BACKOFF`。 */
  reconnect?: Partial<BackoffOptions>;
  /** 同 `onStateChange()`，但从首次连接起就生效。 */
  onStateChange?: (state: ConnectionState) => void;
  /** Host 发来不合协议的东西、监听器抛错等不影响运行的问题。默认忽略。 */
  onWarning?: (message: string, detail?: Record<string, unknown>) => void;
}

/** `request` 能调用的方法：握手、订阅与退订由客户端自己管理（`subscribe`）。 */
export type RequestMethod = Exclude<
  MethodName,
  'host.hello' | 'events.subscribe' | 'events.unsubscribe'
>;

export interface RequestOptions {
  /** 默认 `timeouts.requestMs`。 */
  timeoutMs?: number;
}

/** 没有必填参数的方法可以省略 params（`Record<never, never>` 即空对象类型）。 */
export type RequestArgs<M extends RequestMethod> =
  Record<never, never> extends MethodParams<M>
    ? [params?: MethodParams<M>, options?: RequestOptions]
    : [params: MethodParams<M>, options?: RequestOptions];

/** 一条已完成握手的连接。 */
interface Connection {
  readonly channel: RpcChannel;
  readonly hello: HostHello;
}

interface PendingRequest {
  readonly method: RequestMethod;
  readonly params: object;
  readonly timeoutMs: number;
  /** `performance.now()` 的时刻。 */
  readonly deadline: number;
  /** 等连接时的超时计时器。 */
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve(result: unknown): void;
  reject(error: Error): void;
}

interface ResultSchema {
  safeParse(
    value: unknown,
  ): { success: true; data: unknown } | { success: false; error: { issues: unknown } };
}

const ignore: CallHandlers = { onResult: () => {}, onError: () => {} };

/** 关闭后不再重连的关闭码：远程设备被移除、配对被拒（host-api.md §8）。 */
function isFinalCloseCode(code: number | undefined): boolean {
  return code === CloseCode.DEVICE_REVOKED || code === CloseCode.PAIRING_DENIED;
}

/**
 * 远程连接哪条路都没走通时怎么重试（0.110.0）。中继说电脑不在（404）、限速（429）、超限（4103）或电脑拒绝（4105）时慢速重试，
 * 立即重试只会更快撞上限制；中继满了（503）或电脑没及时接上（4100）照常退避；中继说客户端发了不合规的消息（4104）是客户端的 bug，
 * 重试也一样，不再重连。中继的证书验不过（0.111.0）要用户去换证书，也慢速重试；中继本身连不上照常退避。
 */
function relayRetry(relay: RemoteRelayFailure | undefined): FailureClass {
  switch (relay) {
    case 'protocol_error':
      return { retry: false };
    case 'certificate':
    case 'offline':
    case 'rate_limited':
    case 'limit_exceeded':
    case 'host_rejected':
      return { retry: 'auth', reason: 'host_unavailable' };
    default:
      return { retry: 'normal', reason: 'host_unavailable' };
  }
}

/** 停在同一个 `seq` 上重新订阅的次数上限（见 `#resubscribe`）。 */
const MAX_RESYNCS_WITHOUT_PROGRESS = 3;

/**
 * Wevir Host 的客户端（T4.1），CLI、桌面与将来的手机端共用。
 *
 * - `WevirClient.connect()` 建立连接并自动 `host.hello`；首次连接失败即 reject。
 * - `request()` 按方法注册表类型安全地调用 Host API，结果按 schema 校验，错误映射为类型化错误
 *   （`errors.ts`）。断线期间发起的请求排队等连接；已发出、还没响应就断线的请求以
 *   `ConnectionLostError` 结束，不自动重发。
 * - `subscribe()` 返回会话事件的异步迭代器，按 `seq` 去重、补缺口，断线重连后自动续订。
 * - 每 10 s 发一次 `host.ping`；心跳超时、连接断开都按退避重连，状态经 `onStateChange` 通知。
 */
export class WevirClient {
  readonly #options: WevirClientOptions;
  readonly #timeouts: ClientTimeouts;
  readonly #lifecycle: ConnectionLifecycle<Connection>;
  readonly #listeners = new Set<(state: ConnectionState) => void>();
  /** `watchAccount` 的监听器（R6）。 */
  readonly #accountWatchers = new Set<AccountWatcher>();
  /** `watchAccounts` 的监听器（0.19.0）。 */
  readonly #accountListWatchers = new Set<AccountListWatcher>();
  readonly #settingsWatchers = new Set<SettingsWatcher>();
  readonly #pluginsWatchers = new Set<PluginsWatcher>();
  readonly #memoryWatchers = new Set<MemoryWatcher>();
  readonly #usageListeners = new Set<() => void>();
  readonly #automationListeners = new Set<(change: AutomationChange | undefined) => void>();
  readonly #processListeners = new Set<(change: ProcessChange | undefined) => void>();
  readonly #readinessListeners = new Set<(change: ReadinessChange | undefined) => void>();
  readonly #previewListeners = new Set<(change: PreviewChange | undefined) => void>();
  readonly #speechListeners = new Set<(change: SpeechChange | undefined) => void>();
  readonly #sessionsListeners = new Set<(change: SessionsChange | undefined) => void>();
  readonly #marketInstallListeners = new Set<(progress: MarketInstallProgress) => void>();
  readonly #powerListeners = new Set<(change: PowerChange | undefined) => void>();
  readonly #inboxListeners = new Set<(change: InboxChange | undefined) => void>();
  readonly #remoteDevicesListeners = new Set<(change: RemoteDevicesChange | undefined) => void>();
  readonly #notificationListeners = new Set<(intent: NotificationIntent) => void>();
  /** 最近一次 `setPresence` 的值：重连后重报。 */
  #presence: boolean | undefined;
  readonly #tuningListeners = new Set<(change: TuningChange | undefined) => void>();
  readonly #guardrailListeners = new Set<(change: GuardrailChange | undefined) => void>();
  readonly #proposalListeners = new Set<(change: TuningProposalChange | undefined) => void>();
  readonly #lspListeners = new Set<(change: LspChange | undefined) => void>();
  readonly #terminalListeners = new Set<(change: TerminalChange | undefined) => void>();
  readonly #terminalOutputListeners = new Set<(output: TerminalOutput) => void>();
  /** `provideBrowser` 登记的浏览器提供方（0.33.0），一个客户端只有一个。 */
  #browserProvider: BrowserProviderEntry | undefined;
  #state: ConnectionState = { status: 'connecting' };
  #connection: Connection | undefined;
  #hello: HostHello | undefined;
  readonly #queue = new Set<PendingRequest>();
  readonly #feeds = new Set<SessionFeed>();
  /** 服务端 `subscriptionId` → 订阅。只含当前连接上有效的订阅。 */
  readonly #routes = new Map<string, SessionFeed>();
  #closedError: ClientClosedError | undefined;

  /** 连接到 Host 并完成握手。失败时以该错误 reject（如 `HostUnavailableError`、`WevirRpcError`）。 */
  static async connect(options: WevirClientOptions): Promise<WevirClient> {
    const client = new WevirClient(options);
    await client.#lifecycle.start();
    return client;
  }

  private constructor(options: WevirClientOptions) {
    this.#options = options;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.#lifecycle = new ConnectionLifecycle<Connection>({
      attempt: (signal) => this.#attempt(signal),
      discard: (connection) => connection.channel.abandon('client closed'),
      classify: (error) => this.#classify(error),
      onStateChange: (state) => this.#onLifecycleState(state),
      backoff: { ...DEFAULT_BACKOFF, ...options.reconnect },
    });
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** 最近一次 `host.hello` 的结果（重连后更新）。 */
  get hello(): HostHello {
    if (!this.#hello) throw new Error('not connected yet');
    return this.#hello;
  }

  /** 订阅连接状态，返回取消订阅的函数。 */
  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * 跟着一个账号的状态（R6，host-api.md §3.1）：现在与每次（重）连上之后各调一次 `account.get`，结果与之后的每条
   * `account.updated` 都交给 `listener`（Host 只给调过 `account.*` 的连接发通知，所以重连后要再调）。0.63.0 起一种可以有
   * 多个账号，这里跟的是这种的首个账号（ID 等于种类）。Host 没有
   * `chatgpt_account`（订阅来源：`subscription_sources`）功能时什么都不做。`account.get` 失败交给 `onError`。返回取消函数。
   */
  watchAccount(
    kind: AccountKind,
    listener: (account: AccountState) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const watcher: AccountWatcher = {
      kind,
      listener,
      updates: 0,
      ...(onError !== undefined && { onError }),
    };
    this.#accountWatchers.add(watcher);
    if (this.#connection !== undefined) this.#readAccount(watcher);
    return () => this.#accountWatchers.delete(watcher);
  }

  /**
   * 跟着全部账号（0.19.0，host-api.md §3.1 `account.list`）：现在与每次（重）连上之后读一次全部，之后每条 `account.updated`
   * 按账号 ID（`accountId`，0.63.0 之前的 Host 没有 ID，就是种类）替换其中一项，每次都把整张表交给 `listener`。Host 有 `subscription_sources` 时读 `account.list`；只有
   * `chatgpt_account` 时只读 ChatGPT；都没有时交给它空表。读失败交给 `onError`。返回取消函数。
   */
  watchAccounts(
    listener: (accounts: AccountState[]) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const watcher: AccountListWatcher = {
      listener,
      accounts: [],
      updates: 0,
      ...(onError !== undefined && { onError }),
    };
    this.#accountListWatchers.add(watcher);
    if (this.#connection !== undefined) this.#readAccountList(watcher);
    return () => this.#accountListWatchers.delete(watcher);
  }

  #readAccountList(watcher: AccountListWatcher): void {
    if (!this.#allowed('account.list')) return;
    const before = watcher.updates;
    const read: Promise<AccountState[]> = this.supports('subscription_sources')
      ? this.request('account.list').then(({ accounts }) => accounts)
      : this.supports('chatgpt_account')
        ? this.request('account.get', { kind: 'chatgpt' }).then(({ account }) => [account])
        : Promise.resolve([]);
    read.then(
      (accounts) => {
        if (!this.#accountListWatchers.has(watcher) || watcher.updates !== before) return;
        watcher.accounts = accounts;
        this.#deliverAccountList(watcher);
      },
      (error: unknown) => {
        if (this.#accountListWatchers.has(watcher)) watcher.onError?.(error);
      },
    );
  }

  #deliverAccountList(watcher: AccountListWatcher): void {
    try {
      watcher.listener([...watcher.accounts]);
    } catch (error) {
      this.#warn('an account list listener threw', { error });
    }
  }

  #readAccount(watcher: AccountWatcher): void {
    if (!this.supports(watcher.kind === 'chatgpt' ? 'chatgpt_account' : 'subscription_sources')) {
      return;
    }
    if (!this.#allowed('account.get')) return;
    const before = watcher.updates;
    this.request('account.get', { kind: watcher.kind }).then(
      ({ account }) => {
        if (this.#accountWatchers.has(watcher) && watcher.updates === before) {
          this.#deliverAccount(watcher, account);
        }
      },
      (error: unknown) => {
        if (this.#accountWatchers.has(watcher)) watcher.onError?.(error);
      },
    );
  }

  #deliverAccount(watcher: AccountWatcher, account: AccountState): void {
    try {
      watcher.listener(account);
    } catch (error) {
      this.#warn('an account listener threw', { error });
    }
  }

  /**
   * 跟着 Host 设置（R11，host-api.md §3.1）：现在与每次（重）连上之后各调一次 `settings.get`，结果与之后的每条
   * `settings.updated` 都交给 `listener`（Host 只给调过 `settings.*` 的连接发通知）。Host 没有 `host_settings` 功能时
   * 什么都不做（调用方用默认值）。`settings.get` 失败交给 `onError`。返回取消函数。
   */
  watchSettings(
    listener: (settings: HostSettings) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const watcher: SettingsWatcher = {
      listener,
      updates: 0,
      ...(onError !== undefined && { onError }),
    };
    this.#settingsWatchers.add(watcher);
    if (this.#connection !== undefined) this.#readSettings(watcher);
    return () => this.#settingsWatchers.delete(watcher);
  }

  #readSettings(watcher: SettingsWatcher): void {
    if (!this.supports('host_settings') || !this.#allowed('settings.get')) return;
    const before = watcher.updates;
    this.request('settings.get').then(
      ({ settings }) => {
        if (this.#settingsWatchers.has(watcher) && watcher.updates === before) {
          this.#deliverSettings(watcher, settings);
        }
      },
      (error: unknown) => {
        if (this.#settingsWatchers.has(watcher)) watcher.onError?.(error);
      },
    );
  }

  /** 全局插件：首次连接、重连和 plugins.changed 时重读。 */
  watchPlugins(
    listener: PluginsWatcher['listener'],
    onError?: PluginsWatcher['onError'],
  ): () => void {
    const watcher: PluginsWatcher = { listener, updates: 0, ...(onError && { onError }) };
    this.#pluginsWatchers.add(watcher);
    if (this.#connection) this.#readPlugins(watcher);
    return () => this.#pluginsWatchers.delete(watcher);
  }

  #readPlugins(watcher: PluginsWatcher): void {
    if (!this.supports('plugins') || !this.#allowed('plugins.list')) return;
    const before = ++watcher.updates;
    this.request('plugins.list').then(
      (plugins) => {
        if (!this.#pluginsWatchers.has(watcher) || before !== watcher.updates) return;
        try {
          watcher.listener(plugins);
        } catch (error) {
          this.#warn('a plugins listener threw', { error });
        }
      },
      (error: unknown) => {
        if (this.#pluginsWatchers.has(watcher)) watcher.onError?.(error);
      },
    );
  }

  /**
   * 跟着跨会话记忆（0.57.0，`memory.list`）：全局的与 `workspaceId` 这个项目的笔记。现在、每次（重）连上之后，以及收到相关的
   * `memory.changed`（全局的，或这个项目的）时读一次，结果交给 `listener`（Host 只给调过 `memory.*` 的连接发通知）。Host 没有
   * `memory` 功能时什么都不做。读失败交给 `onError`。返回取消函数。
   */
  watchMemory(
    workspaceId: WorkspaceId | undefined,
    listener: MemoryWatcher['listener'],
    onError?: MemoryWatcher['onError'],
  ): () => void {
    const watcher: MemoryWatcher = {
      workspaceId,
      listener,
      updates: 0,
      ...(onError !== undefined && { onError }),
    };
    this.#memoryWatchers.add(watcher);
    if (this.#connection !== undefined) this.#readMemory(watcher);
    return () => this.#memoryWatchers.delete(watcher);
  }

  /**
   * 用量统计变了（0.62.0，`usage.changed`）：有了新的请求记录或价格表换了，以及每次重连上之后（Host 只给调过 `usage.*` 的连接
   * 发通知，重连后要重新读一次才会再收到）。客户端自己重读它在看的。返回取消函数。
   */
  onUsageChanged(listener: () => void): () => void {
    this.#usageListeners.add(listener);
    return () => this.#usageListeners.delete(listener);
  }

  /**
   * 自动化变了（0.66.0，`automation.changed`）：建、改、删，或一次运行开始、状态变了（`change.run`）。重连上之后以 `undefined`
   * 调一次（Host 只给调过 `automation.*` 的连接发通知，重连后要重新读一次才会再收到），客户端整个重读。返回取消函数。
   */
  onAutomationsChanged(listener: (change: AutomationChange | undefined) => void): () => void {
    this.#automationListeners.add(listener);
    return () => this.#automationListeners.delete(listener);
  }

  /**
   * 进程变了（0.69.0，`process.changed`）：起来、退出、被停、输出变多，或被忘掉（`removed`）。重连上之后以 `undefined` 调一次（Host 只给
   * 调过 `process.*` 的连接发通知，重连后要重新列一次才会再收到），客户端重新列出、从记下的偏移量接着读。返回取消函数。
   */
  onProcessesChanged(listener: (change: ProcessChange | undefined) => void): () => void {
    this.#processListeners.add(listener);
    return () => this.#processListeners.delete(listener);
  }

  /**
   * 项目环境就绪变了（0.70.0，`readiness.changed`）：安装开始、输出变多、结束，或装完后重新预检的报告。重连上之后以 `undefined` 调一次
   * （Host 只给调过 `readiness.*` 的连接发通知），客户端重新读报告。返回取消函数。
   */
  onReadinessChanged(listener: (change: ReadinessChange | undefined) => void): () => void {
    this.#readinessListeners.add(listener);
    return () => this.#readinessListeners.delete(listener);
  }

  #readinessChanged(change: ReadinessChange | undefined): void {
    for (const listener of [...this.#readinessListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('a readiness listener threw', { error });
      }
    }
  }

  /**
   * 工作区的运行配置变了（0.84.0，`preview.changed`）：别的客户端或 Agent 保存、删除了配置。重连上之后以 `undefined` 调一次（期间的
   * 变化没收到，重读）。在跑的预览看 `onProcessesChanged`。返回取消函数。
   */
  onPreviewChanged(listener: (change: PreviewChange | undefined) => void): () => void {
    this.#previewListeners.add(listener);
    return () => this.#previewListeners.delete(listener);
  }

  #previewChanged(change: PreviewChange | undefined): void {
    for (const listener of [...this.#previewListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('a preview listener threw', { error });
      }
    }
  }

  /**
   * 市场条目的安装进度（0.99.0，`market.installProgress`）：先按字节下载，再进入安装。只有调过 `market.*` 的连接收得到；断线期间的进度
   * 不补发，安装的结果看 `market.install` 的回复。返回取消函数。
   */
  onMarketInstallProgress(listener: (progress: MarketInstallProgress) => void): () => void {
    this.#marketInstallListeners.add(listener);
    return () => this.#marketInstallListeners.delete(listener);
  }

  /**
   * 听写的本机模型状态变了（0.92.0，`speech.changed`）：下载进度、装好、失败、删除。只有调过 `speech.*` 的连接收得到。重连上之后以
   * `undefined` 调一次（期间的变化没收到，重读）。返回取消函数。
   */
  onSpeechChanged(listener: (change: SpeechChange | undefined) => void): () => void {
    this.#speechListeners.add(listener);
    return () => this.#speechListeners.delete(listener);
  }

  /**
   * 会话列表变了（0.101.0，`sessions.changed`，Host 功能 `session_list_push`）：只有调过 `session.list` 的连接收得到，`listVersion` 不等于
   * 上次（列表结果或上一条）加一时重读列表。重连上之后以 `undefined` 调一次（新连接还没读过列表，期间的变化没收到）。返回取消函数。
   */
  onSessionsChanged(listener: (change: SessionsChange | undefined) => void): () => void {
    this.#sessionsListeners.add(listener);
    return () => this.#sessionsListeners.delete(listener);
  }

  #sessionsChanged(change: SessionsChange | undefined): void {
    for (const listener of [...this.#sessionsListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('a sessions listener threw', { error });
      }
    }
  }

  /**
   * 防休眠的判定变了（0.102.0，`power.changed`）。只有调过 `power.*` 的连接收得到。重连上之后以 `undefined` 调一次（期间的变化
   * 没收到，重读 `power.get`）。返回取消函数。
   */
  onPowerChanged(listener: (change: PowerChange | undefined) => void): () => void {
    this.#powerListeners.add(listener);
    return () => this.#powerListeners.delete(listener);
  }

  /**
   * 收件箱变了（0.105.0，`inbox.changed`，Host 功能 `inbox`）：只有调过 `inbox.*` 的连接收得到，`inboxVersion` 不等于上次（列表结果或
   * 上一条）加一时重读 `inbox.list`。重连上之后以 `undefined` 调一次（期间的变化没收到，重读）。返回取消函数。
   */
  onInboxChanged(listener: (change: InboxChange | undefined) => void): () => void {
    this.#inboxListeners.add(listener);
    return () => this.#inboxListeners.delete(listener);
  }

  /**
   * 设备与配对变了（0.107.0，`devices.changed`、`pairing.request`、`pairing.ended`，Host 功能 `remote_devices`；0.109.0 起还有远程监听的
   * `remote.changed`，Host 功能 `remote_listener`）：只有调过 `device.*`、`pairing.*` 或 `remote.*` 的本机连接收得到。重连上之后以
   * `undefined` 调一次（期间的变化没收到：重读 `device.list` 与 `remote.status`，期间的配对请求也可能错过）。
   * 返回取消函数。
   */
  onRemoteDevicesChanged(listener: (change: RemoteDevicesChange | undefined) => void): () => void {
    this.#remoteDevicesListeners.add(listener);
    return () => this.#remoteDevicesListeners.delete(listener);
  }

  /**
   * 收 Host 判定的通知意图（0.106.0，`notification.intent`，Host 功能 `notification_intents`）：第一个监听者加入时与每次（重）连上之后
   * 调一次 `notification.subscribe`。断线期间的意图不补发。没有这项功能的 Host 上什么都不做。返回取消函数（最后一个取消后 Host 照样
   * 发给这条连接，这里丢掉）。
   */
  watchNotifications(listener: (intent: NotificationIntent) => void): () => void {
    const first = this.#notificationListeners.size === 0;
    this.#notificationListeners.add(listener);
    if (first && this.#connection !== undefined) this.#subscribeNotifications();
    return () => this.#notificationListeners.delete(listener);
  }

  #subscribeNotifications(): void {
    if (!this.supports('notification_intents') || !this.can('session.read')) return;
    this.request('notification.subscribe').catch((error: unknown) =>
      this.#warn('failed to subscribe to notifications', { error }),
    );
  }

  /**
   * 报告这个客户端背后有没有人在用它（0.106.0，`presence.update`）：值变了才发，（重）连上之后重报最近一次的值。没有
   * `notification_intents` 的 Host 上只记下。
   */
  setPresence(active: boolean): void {
    if (this.#presence === active) return;
    this.#presence = active;
    if (this.#connection !== undefined) this.#sendPresence(active);
  }

  #sendPresence(active: boolean): void {
    if (!this.supports('notification_intents') || !this.can('session.read')) return;
    this.request('presence.update', { active }).catch((error: unknown) =>
      this.#warn('failed to update presence', { error }),
    );
  }

  #remoteDevicesChanged(change: RemoteDevicesChange | undefined): void {
    for (const listener of [...this.#remoteDevicesListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('a remote devices listener threw', { error });
      }
    }
  }

  #inboxChanged(change: InboxChange | undefined): void {
    for (const listener of [...this.#inboxListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('an inbox listener threw', { error });
      }
    }
  }

  #powerChanged(change: PowerChange | undefined): void {
    for (const listener of [...this.#powerListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('a power listener threw', { error });
      }
    }
  }

  #speechChanged(change: SpeechChange | undefined): void {
    for (const listener of [...this.#speechListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('a speech listener threw', { error });
      }
    }
  }

  /**
   * 调优的档案可能变了（0.85.0，`tuning.changed`）：开了新版本，或记忆、设置、审批规则、插件改了。只有调过 `tuning.*` 的连接收得到。
   * 重连上之后以 `undefined` 调一次（期间的变化没收到，重读）。返回取消函数。
   */
  onTuningChanged(listener: (change: TuningChange | undefined) => void): () => void {
    this.#tuningListeners.add(listener);
    return () => this.#tuningListeners.delete(listener);
  }

  #tuningChanged(change: TuningChange | undefined): void {
    for (const listener of [...this.#tuningListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('a tuning listener threw', { error });
      }
    }
  }

  /**
   * 护栏变了（0.86.0，`guardrail.changed`）：规则的增删改与开关、命中计数，或仓库 hooks 的启用；`workspaceId` 省略是全局的规则。
   * 只有调过 `guardrail.*` 或 `repoHook.*` 的连接收得到。重连上之后以 `undefined` 调一次（期间的变化没收到，重读）。返回取消函数。
   */
  onGuardrailsChanged(listener: (change: GuardrailChange | undefined) => void): () => void {
    this.#guardrailListeners.add(listener);
    return () => this.#guardrailListeners.delete(listener);
  }

  #guardrailsChanged(change: GuardrailChange | undefined): void {
    for (const listener of [...this.#guardrailListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('a guardrail listener threw', { error });
      }
    }
  }

  /**
   * 调优的建议变了（0.87.0，`tuning.proposal.changed`）：生成、改动、采纳、拒绝、过时或删除。只有调过 `tuning.*` 的连接收得到。重连上
   * 之后以 `undefined` 调一次（期间的变化没收到，重读）。返回取消函数。
   */
  onTuningProposalsChanged(
    listener: (change: TuningProposalChange | undefined) => void,
  ): () => void {
    this.#proposalListeners.add(listener);
    return () => this.#proposalListeners.delete(listener);
  }

  #proposalsChanged(change: TuningProposalChange | undefined): void {
    for (const listener of [...this.#proposalListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('a tuning proposal listener threw', { error });
      }
    }
  }

  /**
   * 用户终端变了（0.69.0，`terminal.changed`）：开、退出、标题、前台进程、尺寸、attach 的连接数，或被忘掉（`removed`）。重连上之后以
   * `undefined` 调一次：连接断开时 Host 已经不再给这条连接发输出，客户端重新列出，并带上自己读到的位置重新 `terminal.attach`。返回取消函数。
   */
  onTerminalsChanged(listener: (change: TerminalChange | undefined) => void): () => void {
    this.#terminalListeners.add(listener);
    return () => this.#terminalListeners.delete(listener);
  }

  /** 用户终端的输出（0.69.0，`terminal.output`）：这条连接 `terminal.attach` 过的终端。返回取消函数。 */
  onTerminalOutput(listener: (output: TerminalOutput) => void): () => void {
    this.#terminalOutputListeners.add(listener);
    return () => this.#terminalOutputListeners.delete(listener);
  }

  #terminalsChanged(change: TerminalChange | undefined): void {
    for (const listener of [...this.#terminalListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('a terminal listener threw', { error });
      }
    }
  }

  /**
   * 语言服务器的状态变了（0.71.0，`lsp.changed`）：起来、退出、崩溃，或安装有进展。重连上之后以 `undefined` 调一次（Host 只给调过
   * `lsp.*` 的连接发通知，重连后要重新读一次才会再收到）。返回取消函数。
   */
  onLspChanged(listener: (change: LspChange | undefined) => void): () => void {
    this.#lspListeners.add(listener);
    return () => this.#lspListeners.delete(listener);
  }

  #lspChanged(change: LspChange | undefined): void {
    for (const listener of [...this.#lspListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('an lsp listener threw', { error });
      }
    }
  }

  #processesChanged(change: ProcessChange | undefined): void {
    for (const listener of [...this.#processListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('a process listener threw', { error });
      }
    }
  }

  #automationsChanged(change: AutomationChange | undefined): void {
    for (const listener of [...this.#automationListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('an automation listener threw', { error });
      }
    }
  }

  #usageChanged(): void {
    for (const listener of [...this.#usageListeners]) {
      try {
        listener();
      } catch (error) {
        this.#warn('a usage listener threw', { error });
      }
    }
  }

  #readMemory(watcher: MemoryWatcher): void {
    if (!this.supports('memory') || !this.#allowed('memory.list')) return;
    const before = ++watcher.updates;
    this.request(
      'memory.list',
      watcher.workspaceId === undefined ? {} : { workspaceId: watcher.workspaceId },
    ).then(
      (memory) => {
        if (!this.#memoryWatchers.has(watcher) || before !== watcher.updates) return;
        try {
          watcher.listener(memory);
        } catch (error) {
          this.#warn('a memory listener threw', { error });
        }
      },
      (error: unknown) => {
        if (this.#memoryWatchers.has(watcher)) watcher.onError?.(error);
      },
    );
  }

  #deliverSettings(watcher: SettingsWatcher, settings: HostSettings): void {
    try {
      watcher.listener(settings);
    } catch (error) {
      this.#warn('a settings listener threw', { error });
    }
  }

  /**
   * 把这个客户端登记为浏览器提供方（0.33.0，`browser.register`）：现在与每次（重）连上之后登记一次（Host 没有
   * `browser_tools` 时不登记），之后 Host 发来的 `browser.request` 交给 `handle`，它的回答经 `browser.respond` 发回；`handle`
   * 抛错时回 `browser_unknown_error`。再调一次替换之前的；返回注销的函数。
   */
  provideBrowser(commands: readonly string[], handle: BrowserRequestHandler): () => void {
    const entry: BrowserProviderEntry = { commands, handle };
    this.#browserProvider = entry;
    if (this.#connection !== undefined) this.#registerBrowser(entry);
    return () => {
      if (this.#browserProvider !== entry) return;
      this.#browserProvider = undefined;
      if (this.#connection !== undefined && this.supports('browser_tools')) {
        this.request('browser.unregister').catch(() => {});
      }
    };
  }

  #registerBrowser(entry: BrowserProviderEntry): void {
    if (!this.supports('browser_tools') || !this.#allowed('browser.register')) return;
    this.request('browser.register', { commands: [...entry.commands] }).catch((error: unknown) =>
      this.#warn('failed to register as a browser provider', { error }),
    );
  }

  #onBrowserRequest(params: unknown): void {
    const parsed = NotificationSchemas['browser.request'].params.safeParse(params);
    if (!parsed.success) {
      this.#warn('ignored a malformed browser.request notification');
      return;
    }
    const request = parsed.data;
    const entry = this.#browserProvider;
    const respond = (response: DistributiveOmit<BrowserResponse, 'requestId'>) =>
      this.request('browser.respond', {
        requestId: request.requestId,
        ...response,
      } as BrowserResponse).catch((error: unknown) =>
        this.#warn('failed to answer a browser request', { error }),
      );
    if (entry === undefined) {
      void respond({
        ok: false,
        error: { code: 'browser_no_host', message: 'This client no longer provides a browser.' },
      });
      return;
    }
    entry.handle(request).then(respond, (error: unknown) =>
      respond({
        ok: false,
        error: {
          code: 'browser_unknown_error',
          message: error instanceof Error && error.message !== '' ? error.message : String(error),
        },
      }),
    );
  }

  /** 这条连接能不能调 `method`（按注册表里它要的权限）。 */
  #allowed(method: MethodName): boolean {
    const permission = MethodSchemas[method].permission;
    return permission === null || this.can(permission);
  }

  /** Host 是否声明了这项功能（host-api.md §10）。功能是否可用只在这里判断。 */
  supports(feature: HostFeature): boolean {
    return hostSupports(this.hello.features, feature);
  }

  /**
   * 这条连接有没有这项权限（host-api.md §2 的 `permissions`）。Host 0.98.0 起按它检查请求，没有时回 `DEVICE_FORBIDDEN`；本机连接
   * 与旧 Host 总是全部权限。只用来隐藏做不了的操作，权限由 Host 判断。
   */
  can(permission: Permission): boolean {
    return this.hello.permissions.includes(permission);
  }

  /** Host 没有这项功能时抛 `FeatureUnavailableError`（提示升级 Host）。 */
  requireFeature(feature: HostFeature): void {
    if (!this.supports(feature)) throw new FeatureUnavailableError(feature, this.hello.hostVersion);
  }

  request<M extends RequestMethod>(
    method: M,
    ...[params, options]: RequestArgs<M>
  ): Promise<MethodResult<M>> {
    return new Promise<MethodResult<M>>((resolve, reject) => {
      if (this.#closedError) {
        reject(this.#closedError);
        return;
      }
      const timeoutMs = options?.timeoutMs ?? this.#timeouts.requestMs;
      const schema = MethodSchemas[method].result as ResultSchema;
      const request: PendingRequest = {
        method,
        params: params ?? {},
        timeoutMs,
        deadline: performance.now() + timeoutMs,
        timer: undefined,
        resolve: (raw) => {
          const parsed = schema.safeParse(raw);
          if (parsed.success) resolve(parsed.data as MethodResult<M>);
          else {
            reject(
              new ProtocolError(
                `result of ${method} does not match its schema`,
                parsed.error.issues,
              ),
            );
          }
        },
        reject,
      };
      const connection = this.#connection;
      if (connection) {
        this.#dispatch(request, connection);
        return;
      }
      request.timer = setTimeout(() => {
        this.#queue.delete(request);
        reject(new RequestTimeoutError(method, timeoutMs, false));
      }, timeoutMs);
      this.#queue.add(request);
    });
  }

  /**
   * 订阅一个会话的事件（host-api.md §4）。立即返回；订阅在当前或下一条连接上建立，会话不存在等错误在
   * 迭代时抛出。中途加入：先 `session.get` 取快照，再以 `sinceSeq = session.lastSeq` 订阅。
   */
  subscribe(sessionId: SessionId, options: SubscribeOptions = {}): EventSubscription {
    const feed = new SessionFeed(sessionId, options.sinceSeq ?? 0, {
      onClose: (closed) => this.#unsubscribe(closed),
      onWarning: (message, detail) => this.#warn(message, detail),
    });
    if (this.#closedError) {
      feed.fail(this.#closedError);
      return feed;
    }
    this.#feeds.add(feed);
    if (this.#connection) this.#subscribe(feed, this.#connection);
    return feed;
  }

  /**
   * 端点或令牌可能变了（例如桌面得知 Host 重启）：重置退避，没有连接时立即重连。连接健康时什么也不做。
   */
  reconnectNow(): void {
    this.#lifecycle.reconnectNow();
  }

  /** 关闭连接。在途与排队的请求以 `ClientClosedError` 结束，订阅的迭代正常结束。可重复调用。 */
  close(): void {
    this.#lifecycle.close();
  }

  // ── 连接 ────────────────────────────────────────────────────────────

  async #attempt(signal: AbortSignal): Promise<Connection> {
    const { connectMs } = this.#timeouts;
    const abort = new AbortController();
    const onAbort = () => abort.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => abort.abort(new ConnectTimeoutError(connectMs)), connectMs);
    const aborted = new Promise<never>((_, reject) => {
      if (abort.signal.aborted) reject(abort.signal.reason);
      else
        abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
    });
    aborted.catch(() => {});
    const guard = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);

    let channel: RpcChannel | undefined;
    try {
      const source = this.#options.endpoint;
      const endpoint = await guard(
        Promise.resolve().then(() => (typeof source === 'function' ? source() : source)),
      );
      // 传输层可能在构造期间同步回调（例如立即报告连不上）；那时 channel 还没赋值，回调忽略即可，
      // 连接失败由 opened 的 rejection 报告。
      channel = new RpcChannel({
        transport: this.#options.transport,
        url: endpoint.url,
        onNotification: (method, params) => {
          if (channel) this.#onNotification(channel, method, params);
        },
        onLost: (loss) => {
          if (channel) this.#onChannelLost(channel, loss);
        },
        onWarning: (message, detail) => this.#warn(message, detail),
      });
      const opened = channel;
      await guard(opened.opened);
      const raw = await guard(
        opened.request(
          'host.hello',
          {
            token: endpoint.token,
            protocolVersion: PROTOCOL_VERSION,
            ...this.#options.identity,
            capabilities: this.#options.capabilities ?? DEFAULT_CLIENT_CAPABILITIES,
          },
          connectMs,
        ),
      );
      const hello = HostHelloResultSchema.safeParse(raw);
      if (!hello.success) {
        throw new ProtocolError('host.hello result does not match its schema', hello.error.issues);
      }
      return { channel: opened, hello: hello.data };
    } catch (error) {
      channel?.abandon('connect failed');
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  #classify(error: unknown): FailureClass {
    if (error instanceof WevirRpcError) {
      // 端点固定时换不了令牌，重试也是同一个结果（host-api.md §8）；给了解析函数则每次重读，慢速重试。
      if (error.is('UNAUTHORIZED')) {
        return typeof this.#options.endpoint === 'function'
          ? { retry: 'auth', reason: 'unauthorized' }
          : { retry: false };
      }
      if (error.is('HOST_SHUTTING_DOWN')) return { retry: 'normal', reason: 'connection_lost' };
      // INCOMPATIBLE_PROTOCOL 要升级；hello 参数不合 schema 是调用方的问题。重试都不会好。
      return { retry: false };
    }
    if (error instanceof ProtocolError || error instanceof ClientClosedError)
      return { retry: false };
    if (error instanceof ConnectionLostError) {
      if (isFinalCloseCode(error.closeCode)) return { retry: false };
      // 那台电脑不认这台设备了（已移除）或换了身份：重试只会累积握手失败、被那边限速，要重新配对。
      if (error.cause instanceof RemoteHandshakeError && error.cause.reason !== 'timeout')
        return { retry: false };
      if (error.cause instanceof RemoteUnreachableError) return relayRetry(error.cause.relay);
      // 远程访问在那台电脑上被关掉了：等用户重新打开，慢速重试。
      if (error.closeCode === CloseCode.REMOTE_DISABLED)
        return { retry: 'auth', reason: 'connection_lost' };
      const relay = relayCloseFailure(error.closeCode);
      if (relay !== undefined) return relayRetry(relay);
    }
    if (error instanceof ConnectTimeoutError) return { retry: 'normal', reason: 'connect_timeout' };
    if (error instanceof HostUnavailableError)
      return { retry: 'normal', reason: 'host_unavailable' };
    return { retry: 'normal', reason: 'connection_lost' };
  }

  #onLifecycleState(state: LifecycleState<Connection>): void {
    switch (state.phase) {
      case 'connecting':
        this.#emit({ status: 'connecting' });
        return;
      case 'connected': {
        const connection = state.connection;
        this.#connection = connection;
        this.#hello = connection.hello;
        connection.channel.startHeartbeat({
          pingIntervalMs: this.#timeouts.pingIntervalMs,
          heartbeatTimeoutMs: this.#timeouts.heartbeatMs,
        });
        // 订阅先于排队的请求：重连后续订用的是断线前的 lastSeq，与请求的先后无关；先订上能少等一程。
        for (const feed of this.#feeds) this.#subscribe(feed, connection);
        for (const request of [...this.#queue]) {
          this.#queue.delete(request);
          clearTimeout(request.timer);
          this.#dispatch(request, connection);
        }
        this.#emit({ status: 'connected', hello: connection.hello });
        // 重读与“重连上了”的回调都按这条连接的权限跳过做不了的（远程设备只有部分权限，调了只会回 DEVICE_FORBIDDEN）；
        // 各 `#read*` 自己检查。
        for (const watcher of this.#accountWatchers) this.#readAccount(watcher);
        for (const watcher of this.#accountListWatchers) this.#readAccountList(watcher);
        for (const watcher of this.#settingsWatchers) this.#readSettings(watcher);
        for (const watcher of this.#pluginsWatchers) this.#readPlugins(watcher);
        for (const watcher of this.#memoryWatchers) this.#readMemory(watcher);
        const reread = (feature: HostFeature, method: MethodName) =>
          this.supports(feature) && this.#allowed(method);
        if (reread('usage_stats', 'usage.summary')) this.#usageChanged();
        if (reread('automations', 'automation.list')) this.#automationsChanged(undefined);
        if (reread('process_output', 'process.list')) this.#processesChanged(undefined);
        if (reread('workspace_readiness', 'readiness.get')) this.#readinessChanged(undefined);
        if (reread('dev_preview', 'preview.list')) this.#previewChanged(undefined);
        if (reread('speech', 'speech.status')) this.#speechChanged(undefined);
        if (reread('session_list_push', 'session.list')) this.#sessionsChanged(undefined);
        if (reread('prevent_sleep', 'power.get')) this.#powerChanged(undefined);
        if (reread('inbox', 'inbox.list')) this.#inboxChanged(undefined);
        if (reread('remote_devices', 'device.list')) this.#remoteDevicesChanged(undefined);
        if (reread('tuning', 'tuning.get')) this.#tuningChanged(undefined);
        if (reread('tuning_guardrails', 'guardrail.list')) this.#guardrailsChanged(undefined);
        if (reread('tuning_proposals', 'tuning.proposal.list')) this.#proposalsChanged(undefined);
        if (reread('lsp_status', 'lsp.status')) this.#lspChanged(undefined);
        if (reread('user_terminal', 'terminal.list')) this.#terminalsChanged(undefined);
        if (this.#browserProvider !== undefined) this.#registerBrowser(this.#browserProvider);
        if (this.#notificationListeners.size > 0) this.#subscribeNotifications();
        if (this.#presence !== undefined) this.#sendPresence(this.#presence);
        return;
      }
      case 'reconnecting':
        this.#emit({
          status: 'reconnecting',
          attempt: state.attempt,
          delayMs: state.delayMs,
          reason: state.reason,
          ...('error' in state ? { error: state.error } : {}),
        });
        return;
      case 'closed':
        this.#teardown(state.error);
        this.#emit(
          state.error === undefined
            ? { status: 'closed' }
            : { status: 'closed', error: state.error },
        );
        return;
    }
  }

  #onChannelLost(channel: RpcChannel, loss: ChannelLoss): void {
    const connection = this.#connection;
    // 握手完成之前的断开由连接尝试自己处理。
    if (!connection || connection.channel !== channel) return;
    this.#connection = undefined;
    this.#routes.clear();
    for (const feed of this.#feeds) feed.detach();
    const error = new ConnectionLostError(
      undefined,
      loss.kind === 'closed' ? loss.code : undefined,
      loss.kind === 'closed'
        ? loss.reason
        : loss.kind === 'abandoned'
          ? loss.reason
          : 'heartbeat timeout',
    );
    // 远程设备被移除、配对被拒（0.109.0）：重连也握不上手，要重新配对。
    if (isFinalCloseCode(error.closeCode)) {
      this.#lifecycle.close(error);
      return;
    }
    // 中继关掉的（0.110.0）：客户端不合规时不再重连，超限、电脑拒绝时慢速重试。
    const relay = relayCloseFailure(error.closeCode);
    const retry = relay === undefined ? undefined : relayRetry(relay);
    if (retry?.retry === false) {
      this.#lifecycle.close(error);
      return;
    }
    this.#lifecycle.lost(
      connection,
      loss.kind === 'heartbeat_timeout' ? 'heartbeat_timeout' : 'connection_lost',
      error,
      retry?.retry === 'auth' ? 'auth' : 'normal',
    );
  }

  #teardown(error: unknown): void {
    if (this.#closedError) return;
    this.#closedError = new ClientClosedError(error);
    const connection = this.#connection;
    this.#connection = undefined;
    // 在途请求在这里以 ClientClosedError 结束（见 #dispatch）。
    connection?.channel.abandon('client closed');
    for (const request of this.#queue) {
      clearTimeout(request.timer);
      request.reject(this.#closedError);
    }
    this.#queue.clear();
    this.#routes.clear();
    for (const feed of this.#feeds) {
      if (error === undefined) feed.finish();
      else feed.fail(error);
    }
    this.#feeds.clear();
  }

  // ── 请求 ────────────────────────────────────────────────────────────

  #dispatch(request: PendingRequest, connection: Connection): void {
    connection.channel.call(
      request.method,
      request.params,
      request.deadline - performance.now(),
      {
        onResult: request.resolve,
        onError: (error) => request.reject(this.#closedError ?? error),
      },
      () => new RequestTimeoutError(request.method, request.timeoutMs, true),
    );
  }

  // ── 订阅 ────────────────────────────────────────────────────────────

  /**
   * 在 `connection` 上为 `feed` 建立服务端订阅，`sinceSeq` 取它已应用的最大 `seq`。结果在收到响应的那一帧
   * 里同步处理：Host 保证响应先于该订阅的事件（host-api.md §4 第 2 条），登记好路由再处理后面的帧。
   */
  #subscribe(feed: SessionFeed, connection: Connection): void {
    const generation = ++feed.generation;
    const isCurrent = () =>
      !feed.ended && feed.generation === generation && this.#connection === connection;
    connection.channel.call(
      'events.subscribe',
      { sessionId: feed.sessionId, sinceSeq: feed.lastSeq },
      this.#timeouts.requestMs,
      {
        onResult: (raw) => {
          const parsed = EventsSubscribeResultSchema.safeParse(raw);
          if (!parsed.success) {
            if (isCurrent()) {
              this.#feeds.delete(feed);
              feed.fail(
                new ProtocolError(
                  'events.subscribe result does not match its schema',
                  parsed.error.issues,
                ),
              );
            }
            return;
          }
          const { subscriptionId, replayedThroughSeq } = parsed.data;
          if (!isCurrent()) {
            // 订阅已关闭或已被更新的一次取代。
            if (this.#connection === connection)
              this.#unsubscribeServer(connection, subscriptionId);
            return;
          }
          if (feed.attach(subscriptionId, replayedThroughSeq) === 'reset') {
            this.#unsubscribeServer(connection, subscriptionId);
            feed.reset();
            this.#subscribe(feed, connection);
            return;
          }
          this.#routes.set(subscriptionId, feed);
        },
        onError: (error) => {
          if (!isCurrent()) return;
          // 连接断了，或 Host 正在退出（随后会断开）：重连后统一续订。
          if (error instanceof ConnectionLostError || isRpcError(error, 'HOST_SHUTTING_DOWN'))
            return;
          // 订阅的响应本该立即发出（补发在响应之后），超时说明这条连接已经不正常：放弃它，重连后续订。
          if (error instanceof RequestTimeoutError) {
            connection.channel.abandon('events.subscribe timed out');
            return;
          }
          // 会话不存在、参数不对等：重试也不会好，结束这个订阅。
          this.#feeds.delete(feed);
          feed.fail(error);
        },
      },
    );
  }

  /**
   * 发现缺口（或收到不合协议的事件）：作废当前服务端订阅，以 `sinceSeq = lastSeq` 重新订阅。连续几次
   * 停在同一个 `seq` 上重新订阅都没有进展，说明 Host 每次在这里都发同样的错东西（缺陷），结束订阅而不是
   * 无限重试。
   */
  #resubscribe(feed: SessionFeed, connection: Connection): void {
    if (feed.serverId !== undefined) {
      this.#routes.delete(feed.serverId);
      this.#unsubscribeServer(connection, feed.serverId);
    }
    feed.detach();
    if (feed.lastSeq === feed.resyncSeq) feed.resyncCount += 1;
    else {
      feed.resyncSeq = feed.lastSeq;
      feed.resyncCount = 1;
    }
    if (feed.resyncCount > MAX_RESYNCS_WITHOUT_PROGRESS) {
      this.#feeds.delete(feed);
      feed.fail(
        new ProtocolError(
          `the host keeps sending an invalid or out-of-order event after seq ${feed.lastSeq}`,
          { sessionId: feed.sessionId, lastSeq: feed.lastSeq },
        ),
      );
      return;
    }
    this.#subscribe(feed, connection);
  }

  /** 上层关闭了订阅。 */
  #unsubscribe(feed: SessionFeed): void {
    this.#feeds.delete(feed);
    // 还在路上的订阅结果因此过期，到达时退订。
    feed.generation += 1;
    if (feed.serverId === undefined) return;
    this.#routes.delete(feed.serverId);
    if (this.#connection) this.#unsubscribeServer(this.#connection, feed.serverId);
    feed.detach();
  }

  #unsubscribeServer(connection: Connection, subscriptionId: string): void {
    connection.channel.call(
      'events.unsubscribe',
      { subscriptionId },
      this.#timeouts.requestMs,
      ignore,
    );
  }

  #onNotification(channel: RpcChannel, method: string, params: unknown): void {
    const connection = this.#connection;
    if (!connection || connection.channel !== channel) return;
    if (method === 'account.updated') {
      const parsed = AccountUpdatedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed account.updated notification');
        return;
      }
      const { account } = parsed.data;
      const id = accountId(account);
      for (const watcher of [...this.#accountWatchers]) {
        if (watcher.kind !== id) continue;
        watcher.updates += 1;
        this.#deliverAccount(watcher, account);
      }
      for (const watcher of [...this.#accountListWatchers]) {
        watcher.updates += 1;
        const index = watcher.accounts.findIndex((item) => accountId(item) === id);
        if (index >= 0) watcher.accounts[index] = account;
        else watcher.accounts.push(account);
        this.#deliverAccountList(watcher);
      }
      return;
    }
    if (method === 'settings.updated') {
      const parsed = SettingsUpdatedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed settings.updated notification');
        return;
      }
      for (const watcher of [...this.#settingsWatchers]) {
        watcher.updates += 1;
        this.#deliverSettings(watcher, parsed.data.settings);
      }
      return;
    }
    if (method === 'plugins.changed') {
      for (const watcher of this.#pluginsWatchers) this.#readPlugins(watcher);
      return;
    }
    if (method === 'memory.changed') {
      const parsed = MemoryChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed memory.changed notification');
        return;
      }
      const { scope, workspaceId } = parsed.data;
      for (const watcher of [...this.#memoryWatchers]) {
        if (scope === 'global' || watcher.workspaceId === workspaceId) this.#readMemory(watcher);
      }
      return;
    }
    if (method === 'usage.changed') {
      this.#usageChanged();
      return;
    }
    if (method === 'automation.changed') {
      const parsed = AutomationChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed automation.changed notification');
        return;
      }
      this.#automationsChanged(parsed.data);
      return;
    }
    if (method === 'tuning.changed') {
      const parsed = TuningChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed tuning.changed notification');
        return;
      }
      this.#tuningChanged(parsed.data);
      return;
    }
    if (method === 'tuning.proposal.changed') {
      const parsed = TuningProposalChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed tuning.proposal.changed notification');
        return;
      }
      this.#proposalsChanged(parsed.data);
      return;
    }
    if (method === 'guardrail.changed') {
      const parsed = GuardrailChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed guardrail.changed notification');
        return;
      }
      this.#guardrailsChanged(parsed.data);
      return;
    }
    if (method === 'preview.changed') {
      const parsed = PreviewChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed preview.changed notification');
        return;
      }
      this.#previewChanged(parsed.data);
      return;
    }
    if (method === 'market.installProgress') {
      const parsed = MarketInstallProgressSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed market.installProgress notification');
        return;
      }
      for (const listener of [...this.#marketInstallListeners]) {
        try {
          listener(parsed.data);
        } catch (error) {
          this.#warn('a market install listener threw', { error });
        }
      }
      return;
    }
    if (method === 'sessions.changed') {
      const parsed = SessionsChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed sessions.changed notification');
        return;
      }
      this.#sessionsChanged(parsed.data);
      return;
    }
    if (method === 'notification.intent') {
      const parsed = NotificationIntentSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed notification.intent notification');
        return;
      }
      for (const listener of [...this.#notificationListeners]) {
        try {
          listener(parsed.data);
        } catch (error) {
          this.#warn('a notification listener threw', { error });
        }
      }
      return;
    }
    if (method === 'inbox.changed') {
      const parsed = InboxChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed inbox.changed notification');
        return;
      }
      this.#inboxChanged(parsed.data);
      return;
    }
    if (method === 'devices.changed') {
      const parsed = DevicesChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed devices.changed notification');
        return;
      }
      this.#remoteDevicesChanged({ kind: 'devices', devices: parsed.data.devices });
      return;
    }
    if (method === 'pairing.request') {
      const parsed = PairingRequestParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed pairing.request notification');
        return;
      }
      this.#remoteDevicesChanged({ kind: 'pairing_request', request: parsed.data });
      return;
    }
    if (method === 'pairing.ended') {
      const parsed = PairingEndedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed pairing.ended notification');
        return;
      }
      this.#remoteDevicesChanged({ kind: 'pairing_ended', ended: parsed.data });
      return;
    }
    if (method === 'remote.changed') {
      const parsed = RemoteChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed remote.changed notification');
        return;
      }
      this.#remoteDevicesChanged({ kind: 'listener', status: parsed.data });
      return;
    }
    if (method === 'power.changed') {
      const parsed = PowerChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed power.changed notification');
        return;
      }
      this.#powerChanged(parsed.data);
      return;
    }
    if (method === 'speech.changed') {
      const parsed = SpeechChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed speech.changed notification');
        return;
      }
      this.#speechChanged(parsed.data);
      return;
    }
    if (method === 'readiness.changed') {
      const parsed = ReadinessChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed readiness.changed notification');
        return;
      }
      this.#readinessChanged(parsed.data);
      return;
    }
    if (method === 'lsp.changed') {
      const parsed = LspChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed lsp.changed notification');
        return;
      }
      this.#lspChanged(parsed.data);
      return;
    }
    if (method === 'process.changed') {
      const parsed = ProcessChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed process.changed notification');
        return;
      }
      this.#processesChanged(parsed.data);
      return;
    }
    if (method === 'terminal.output') {
      const parsed = TerminalOutputParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed terminal.output notification');
        return;
      }
      for (const listener of [...this.#terminalOutputListeners]) {
        try {
          listener(parsed.data);
        } catch (error) {
          this.#warn('a terminal output listener threw', { error });
        }
      }
      return;
    }
    if (method === 'terminal.changed') {
      const parsed = TerminalChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.#warn('ignored a malformed terminal.changed notification');
        return;
      }
      this.#terminalsChanged(parsed.data);
      return;
    }
    if (method === 'browser.request') {
      this.#onBrowserRequest(params);
      return;
    }
    if (method !== 'events.event') {
      this.#warn('ignored an unknown notification', { method });
      return;
    }
    if (!isRecord(params) || typeof params.subscriptionId !== 'string') {
      this.#warn('ignored a malformed events.event notification');
      return;
    }
    // 已退订或已作废的订阅送来的事件。
    const feed = this.#routes.get(params.subscriptionId);
    if (!feed) return;
    const envelope = WevirEventEnvelopeSchema.safeParse(params.event);
    if (!envelope.success || envelope.data.sessionId !== feed.sessionId) {
      // 不知道它的 seq 是多少：按缺口处理，从 lastSeq 重新订阅。
      this.#warn('received a malformed event; resubscribing', {
        sessionId: feed.sessionId,
        lastSeq: feed.lastSeq,
      });
      this.#resubscribe(feed, connection);
      return;
    }
    if (feed.apply(params.event, envelope.data) === 'gap') this.#resubscribe(feed, connection);
  }

  // ── 其他 ────────────────────────────────────────────────────────────

  #emit(state: ConnectionState): void {
    this.#state = state;
    const listeners = [...this.#listeners];
    if (this.#options.onStateChange) listeners.unshift(this.#options.onStateChange);
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (error) {
        this.#warn('a connection state listener threw', { error });
      }
    }
  }

  #warn(message: string, detail?: Record<string, unknown>): void {
    try {
      this.#options.onWarning?.(message, detail);
    } catch {
      // 告警回调自己出错，不再上报。
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
