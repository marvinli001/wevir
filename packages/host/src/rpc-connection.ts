import { createHash, timingSafeEqual } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  type AccountState,
  type ClientCapabilities,
  type ClientIdentity,
  CloseCode,
  type CloseCodeName,
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
  NotificationSchemas,
  negotiateProtocolVersion,
  PERMISSIONS,
  PROTOCOL_VERSION,
  parseProtocolVersion,
  type Session,
  type SessionId,
  type SubscriptionId,
  type WevirEvent,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import type { RawData, WebSocket } from 'ws';
import { HostError, isHostError } from './errors.js';
import type { EventStore } from './event-store.js';
import { assertSessionVisible, type HostMethods, type RequestContext } from './host-methods.js';
import { newId } from './ids.js';

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
  /** 引擎的账号（R6）：调过 `account.*` 的连接用它收 `account.updated`。引擎没有账号时省略。 */
  readonly accounts?: { watch(listener: (state: AccountState) => void): () => void };
  /** Host 设置（R11）：调过 `settings.*` 的连接用它收 `settings.updated`。 */
  readonly settings?: { watch(listener: (settings: HostSettings) => void): () => void };
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
  readonly #subscriptions = new Map<SubscriptionId, Subscription>();
  readonly #inflight = new Set<Promise<void>>();
  /** 调过 `account.*` 之后：退订 `account.updated`。 */
  #unwatchAccounts: (() => void) | undefined;
  /** 调过 `settings.*` 之后：退订 `settings.updated`。 */
  #unwatchSettings: (() => void) | undefined;
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
    this.#phase = 'ready';
    clearTimeout(this.#helloTimer);
    this.#respond(id, 'host.hello', {
      hostId: this.#host.hostId,
      hostVersion: this.#host.hostVersion,
      protocolVersion: negotiation.protocolVersion,
      minProtocolVersion: MIN_PROTOCOL_VERSION,
      features: { ...this.#host.features },
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
      default: {
        // 参数已按该方法的 schema 校验过；按方法名取出的处理函数与参数类型一一对应。
        const handler = this.#host.methods[method] as (
          params: unknown,
          context: RequestContext,
        ) => unknown;
        const result = await handler(params, { client, capabilities: this.#capabilities });
        this.#respond(id, method, adaptResultForClient(method, result, this.#capabilities));
        if (method.startsWith('account.')) this.#watchAccounts();
        if (method.startsWith('settings.')) this.#watchSettings();
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
    this.#unwatchSettings = undefined;
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
 * 连接认不出的 `chatgpt` 类 Provider（0.7.0）。
 */
export function adaptResultForClient(
  method: MethodName,
  result: unknown,
  capabilities: ClientCapabilities,
): unknown {
  // COMPAT(providerKindChatgpt): added in 0.7.0, remove gate after 2027-06-01
  if (method === 'provider.list' && capabilities.provider_kind_chatgpt !== true) {
    const value = result as MethodResult<'provider.list'>;
    return { ...value, providers: value.providers.filter((p) => p.kind !== 'chatgpt') };
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
