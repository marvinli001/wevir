import { createHash, timingSafeEqual } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  type AccountState,
  type ClientCapabilities,
  type ClientIdentity,
  CloseCode,
  type CloseCodeName,
  compareProtocolVersions,
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
  type NotificationParams,
  NotificationSchemas,
  negotiateProtocolVersion,
  PERMISSIONS,
  type PendingMessage,
  PROTOCOL_VERSION,
  parseProtocolVersion,
  type Session,
  type SessionId,
  SUBSCRIPTION_KINDS,
  type SubscriptionId,
  type UserContentPart,
  type WevirEvent,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import type { RawData, WebSocket } from 'ws';
import type { BrowserBroker } from './browser-broker.js';
import { HostError, isHostError } from './errors.js';
import type { EventStore } from './event-store.js';
import { assertSessionVisible, type HostMethods, type RequestContext } from './host-methods.js';
import { newId } from './ids.js';
import type { MemoryChange } from './memory.js';
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
  /** 用量统计（0.62.0）：调过 `usage.*` 的连接用它收 `usage.changed`。 */
  readonly usage?: { watch(listener: () => void): () => void };
  /** 自动化（0.66.0）：调过 `automation.*` 的连接用它收 `automation.changed`。 */
  readonly automations?: {
    watch(listener: (change: NotificationParams<'automation.changed'>) => void): () => void;
  };
  /** 进程输出（0.69.0）：调过 `process.*` 的连接用它收 `process.changed`。 */
  /** 语言服务器（0.71.0）：调过 `lsp.*` 的连接用它收 `lsp.changed`。 */
  readonly lsp?: {
    watch(listener: (change: NotificationParams<'lsp.changed'>) => void): () => void;
  };
  readonly processes?: {
    watch(listener: (change: NotificationParams<'process.changed'>) => void): () => void;
  };
  /** 用户的交互终端（0.69.0）：`terminal.attach` 把连接登记到终端上，调过 `terminal.*` 的连接收 `terminal.changed`。 */
  readonly terminals?: Pick<TerminalService, 'attach' | 'watch'>;
  /** 内置浏览器（0.33.0）：`browser.register` 把连接登记到这里。省略时（测试）登记不生效，回答一律不收。 */
  readonly browsers?: BrowserBroker;
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
  readonly #ws: WebSocket;
  readonly #host: ConnectionHost;
  readonly #limits: ConnectionLimits;
  #phase: Phase = 'hello';
  #client: ClientIdentity | undefined;
  #capabilities: ClientCapabilities = {};
  #protocolVersion: string = PROTOCOL_VERSION;
  readonly #subscriptions = new Map<SubscriptionId, Subscription>();
  readonly #inflight = new Set<Promise<void>>();
  /** 调过 `account.*` 之后：退订 `account.updated`。 */
  #unwatchAccounts: (() => void) | undefined;
  /** 调过 `settings.*` 之后：退订 `settings.updated`。 */
  #unwatchSettings: (() => void) | undefined;
  #unwatchPlugins: (() => void) | undefined;
  /** 调过 `memory.*` 之后：退订 `memory.changed`。 */
  #unwatchMemory: (() => void) | undefined;
  /** 调过 `usage.*` 之后：退订 `usage.changed`。 */
  #unwatchUsage: (() => void) | undefined;
  /** 调过 `automation.*` 之后：退订 `automation.changed`。 */
  #unwatchAutomations: (() => void) | undefined;
  /** 调过 `process.*` 之后：退订 `process.changed`。 */
  #unwatchProcesses: (() => void) | undefined;
  /** 调过 `lsp.*` 之后：退订 `lsp.changed`。 */
  #unwatchLsp: (() => void) | undefined;
  /** 调过 `terminal.*` 之后：退订 `terminal.changed`。 */
  #unwatchTerminals: (() => void) | undefined;
  /** `terminal.attach` 过的终端：不再收它的输出。 */
  readonly #terminalAttachments = new Map<string, () => void>();
  /** `browser.register` 之后：注销这条连接的浏览器提供方。 */
  #unregisterBrowser: (() => void) | undefined;
  /** 这条连接作为浏览器提供方的标识。 */
  readonly #browserProviderId = newId('conn');
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

  constructor(ws: WebSocket, host: ConnectionHost) {
    this.#ws = ws;
    this.#host = host;
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
    if (!timingSafeEqual(sha256(hello.token), this.#host.tokenDigest)) {
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
      permissions: [...PERMISSIONS],
    });
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
      const parsed = MethodSchemas[method].params.safeParse(request.params ?? {});
      if (!parsed.success) {
        throw new HostError('INVALID_PARAMS', 'invalid params', {
          issues: toIssues(parsed.error.issues),
        });
      }
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
            return this.#send({
              jsonrpc: JSONRPC_VERSION,
              method: 'browser.request',
              params: parsed.data,
            });
          },
        });
        this.#respond(id, method, {});
        return;
      }
      case 'terminal.attach': {
        const terminals = this.#terminalService();
        const attach = params as MethodParams<'terminal.attach'>;
        this.#terminalAttachments.get(attach.terminalId)?.();
        this.#terminalAttachments.delete(attach.terminalId);
        const { result, start } = await terminals.attach(attach, {
          // 输出由 Host 自己拼出（每 16 ms 一条），不再逐条按 schema 校验。
          send: (output) =>
            this.#sendText(
              JSON.stringify({
                jsonrpc: JSONRPC_VERSION,
                method: 'terminal.output',
                params: output,
              }),
            ),
          backlog: () => this.#backlog(),
        });
        if (this.#respond(id, method, result) && this.#phase === 'ready') {
          this.#terminalAttachments.get(attach.terminalId)?.();
          this.#terminalAttachments.set(attach.terminalId, start());
        }
        this.#watchTerminals();
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
        const result = await handler(params, { client, capabilities: this.#capabilities });
        this.#respond(
          id,
          method,
          adaptResultForClient(method, result, this.#capabilities, this.#protocolVersion),
        );
        if (method.startsWith('account.')) this.#watchAccounts();
        if (method.startsWith('settings.')) this.#watchSettings();
        if (/^(plugins?|connector|skill)\./.test(method)) this.#watchPlugins();
        if (method.startsWith('memory.')) this.#watchMemory();
        if (method.startsWith('usage.')) this.#watchUsage();
        if (method.startsWith('automation.')) this.#watchAutomations();
        if (method.startsWith('process.')) this.#watchProcesses();
        if (method.startsWith('lsp.')) this.#watchLsp();
        if (method.startsWith('terminal.')) this.#watchTerminals();
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
    const { sessionId, sinceSeq } = params;
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
      this.#replay(subscription, sinceSeq, lastSeq).catch((error: unknown) => {
        // 补发失败（读库出错）时客户端会一直等不到事件；断开让它重连后重新订阅。
        this.#host.onError(error);
        this.terminate();
      }),
    );
  }

  async #replay(subscription: Subscription, sinceSeq: number, through: number): Promise<void> {
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
        const text = this.#eventFrame(subscription, event);
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
    for (const text of queue) if (!this.#sendText(text)) return;
  }

  /** 事件库提交后同步调用。 */
  #deliver(subscription: Subscription, event: WevirEvent): void {
    if (!subscription.active) return;
    const text = this.#eventFrame(subscription, event);
    if (!subscription.queue) {
      this.#sendText(text);
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
      this.#send({ jsonrpc: JSONRPC_VERSION, method: 'account.updated', params: parsed.data });
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
      this.#send({ jsonrpc: JSONRPC_VERSION, method: 'settings.updated', params: parsed.data });
    });
  }

  #watchPlugins(): void {
    if (this.#unwatchPlugins || !this.#host.plugins || this.#phase !== 'ready') return;
    this.#unwatchPlugins = this.#host.plugins.watch(() => {
      this.#send({ jsonrpc: JSONRPC_VERSION, method: 'plugins.changed', params: {} });
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
      this.#send({ jsonrpc: JSONRPC_VERSION, method: 'memory.changed', params: parsed.data });
    });
  }

  /** 调过 `usage.*` 的连接之后收 `usage.changed`（0.62.0），连接关闭即止。 */
  #watchUsage(): void {
    if (this.#unwatchUsage !== undefined || this.#host.usage === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchUsage = this.#host.usage.watch(() => {
      this.#send({ jsonrpc: JSONRPC_VERSION, method: 'usage.changed', params: {} });
    });
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
      this.#send({ jsonrpc: JSONRPC_VERSION, method: 'automation.changed', params: parsed.data });
    });
  }

  /** 调过 `process.*` 的连接之后收 `process.changed`（0.69.0），连接关闭即止。 */
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
      this.#send({ jsonrpc: JSONRPC_VERSION, method: 'lsp.changed', params: parsed.data });
    });
  }

  #watchProcesses(): void {
    if (this.#unwatchProcesses !== undefined || this.#host.processes === undefined) return;
    if (this.#phase !== 'ready') return;
    this.#unwatchProcesses = this.#host.processes.watch((change) => {
      const parsed = NotificationSchemas['process.changed'].params.safeParse(change);
      if (!parsed.success) {
        this.#host.onError(new Error(`process.changed does not match its schema: ${parsed.error}`));
        return;
      }
      this.#send({ jsonrpc: JSONRPC_VERSION, method: 'process.changed', params: parsed.data });
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
      this.#send({ jsonrpc: JSONRPC_VERSION, method: 'terminal.changed', params: parsed.data });
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
    this.#unwatchUsage?.();
    this.#unwatchUsage = undefined;
    this.#unwatchAutomations?.();
    this.#unwatchAutomations = undefined;
    this.#unwatchProcesses?.();
    this.#unwatchProcesses = undefined;
    this.#unwatchLsp?.();
    this.#unwatchLsp = undefined;
    this.#unwatchTerminals?.();
    this.#unwatchTerminals = undefined;
    for (const detach of this.#terminalAttachments.values()) detach();
    this.#terminalAttachments.clear();
    this.#unregisterBrowser?.();
    this.#unregisterBrowser = undefined;
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
  return adaptKindsAndTitles(method, value, capabilities, protocolVersion);
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

/** subscription_kinds 早于 WorkBuddy；旧版已声明该能力也不认识这个新枚举值。 */
function subscriptionKindSupported(
  kind: string,
  capabilities: ClientCapabilities,
  protocolVersion: string,
): boolean {
  return (
    !isSubscriptionKind(kind) ||
    (capabilities.subscription_kinds === true &&
      (kind !== 'workbuddy' || compareProtocolVersions(protocolVersion, '0.55.0') >= 0))
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
