import {
  type ErrorCodeName,
  type ErrorData,
  ErrorDataSchemas,
  errorCodeName,
  RelayCloseCode,
} from '@wevir/protocol';

// client-sdk 抛出的错误都是 `WevirClientError`，按 `kind` 区分；Host 回的 JSON-RPC 错误是
// `WevirRpcError`，再按错误码名区分（host-api.md §7）。

export type ClientErrorKind =
  | 'rpc'
  | 'request_timeout'
  | 'connect_timeout'
  | 'connection_lost'
  | 'client_closed'
  | 'protocol'
  | 'feature_unavailable'
  | 'host_unavailable'
  | 'remote_unreachable'
  | 'remote_handshake';

export abstract class WevirClientError extends Error {
  abstract readonly kind: ClientErrorKind;
}

type DataSchemas = typeof ErrorDataSchemas;

/** 某个错误码的 `error.data` 类型；没有结构化 data 的错误码为 `undefined`。 */
export type RpcErrorData<N extends ErrorCodeName> = N extends keyof DataSchemas
  ? ErrorData<N>
  : undefined;

/** `isRpcError` / `WevirRpcError.is` 收窄之后的类型：错误码名确定，`data` 有对应的类型。 */
export type RpcErrorOf<N extends ErrorCodeName> = WevirRpcError & {
  readonly codeName: N;
  readonly data: RpcErrorData<N> | undefined;
};

/** Host 对请求回了 JSON-RPC 错误。 */
export class WevirRpcError extends WevirClientError {
  override readonly name = 'WevirRpcError';
  readonly kind = 'rpc';
  readonly method: string;
  readonly code: number;
  /** 错误码名；Host 比客户端新、回了不认识的错误码时为 undefined。 */
  readonly codeName: ErrorCodeName | undefined;
  /**
   * 按 `ErrorDataSchemas` 解析过的 `error.data`（多余字段已剥离）。该错误码没有结构化 data、或 Host 给的
   * data 不合 schema 时为 undefined，原样的值在 `rawData`。
   */
  readonly data: unknown;
  readonly rawData: unknown;

  constructor(method: string, error: { code: number; message: string; data?: unknown }) {
    super(error.message);
    this.method = method;
    this.code = error.code;
    this.codeName = errorCodeName(error.code);
    this.rawData = error.data;
    this.data = parseErrorData(this.codeName, error.data);
  }

  is<N extends ErrorCodeName>(name: N): this is RpcErrorOf<N> {
    return this.codeName === name;
  }
}

/** `error` 是 Host 回的 JSON-RPC 错误（给了 `name` 时还要求是这个错误码）。 */
export function isRpcError<N extends ErrorCodeName>(
  error: unknown,
  name: N,
): error is RpcErrorOf<N>;
export function isRpcError(error: unknown): error is WevirRpcError;
export function isRpcError(error: unknown, name?: ErrorCodeName): boolean {
  return error instanceof WevirRpcError && (name === undefined || error.codeName === name);
}

function parseErrorData(name: ErrorCodeName | undefined, data: unknown): unknown {
  if (name === undefined || data === undefined || !Object.hasOwn(ErrorDataSchemas, name)) {
    return undefined;
  }
  const parsed = ErrorDataSchemas[name as keyof DataSchemas].safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/**
 * 请求在时限内没有得到响应。`sent` 为 true 时请求已经发给了 Host，可能已经生效；为 false 时它一直在等
 * 连接，没有发出去。
 */
export class RequestTimeoutError extends WevirClientError {
  override readonly name = 'RequestTimeoutError';
  readonly kind = 'request_timeout';

  constructor(
    readonly method: string,
    readonly timeoutMs: number,
    readonly sent: boolean,
  ) {
    super(
      `${method} timed out after ${timeoutMs} ms${sent ? '' : ' while waiting for a connection'}`,
    );
  }
}

/** 连接（含握手）没有在时限内建立。 */
export class ConnectTimeoutError extends WevirClientError {
  override readonly name = 'ConnectTimeoutError';
  readonly kind = 'connect_timeout';

  constructor(readonly timeoutMs: number) {
    super(`could not connect to the Wevir Host within ${timeoutMs} ms`);
  }
}

/**
 * 连接断了。对已发出的请求而言结果未知：Host 可能已经执行了它（`session.send` 可以带同一个
 * `clientMessageId` 重发来确认，见 host-api.md §3.1）。client-sdk 不自动重发请求。
 */
export class ConnectionLostError extends WevirClientError {
  override readonly name = 'ConnectionLostError';
  readonly kind = 'connection_lost';

  constructor(
    /** 连接断开时在等响应的方法；连接本身失败时为 undefined。 */
    readonly method: string | undefined,
    /** WebSocket 关闭码；本端放弃连接（心跳超时等）时为 undefined。 */
    readonly closeCode: number | undefined,
    readonly closeReason = '',
    /** 传输层给的原因（`TransportCloseInfo.cause`），例如远程连接的 `RemoteUnreachableError`。 */
    cause?: Error,
  ) {
    super(
      `connection to the Wevir Host was lost${method ? ` before ${method} completed` : ''}` +
        `${closeCode === undefined ? '' : ` (close code ${closeCode}${closeReason ? `: ${closeReason}` : ''})`}`,
      cause === undefined ? undefined : { cause },
    );
  }
}

/** 客户端已关闭（`close()`，或遇到不可恢复的错误）；`cause` 是后者的原因。 */
export class ClientClosedError extends WevirClientError {
  override readonly name = 'ClientClosedError';
  readonly kind = 'client_closed';

  constructor(cause?: unknown) {
    super('the Wevir client is closed', cause === undefined ? undefined : { cause });
  }
}

/** Host 发来的东西不合协议（响应不合 schema、帧不是 JSON-RPC 对象）。 */
export class ProtocolError extends WevirClientError {
  override readonly name = 'ProtocolError';
  readonly kind = 'protocol';

  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

/** Host 没有声明这项功能（host-api.md §10）：提示用户升级 Host，不走降级路径。 */
export class FeatureUnavailableError extends WevirClientError {
  override readonly name = 'FeatureUnavailableError';
  readonly kind = 'feature_unavailable';

  constructor(
    readonly feature: string,
    readonly hostVersion: string,
  ) {
    super(`Wevir Host ${hostVersion} does not support ${feature}; please upgrade the Host`);
  }
}

/** 找不到可连的 Host：`run/host.json` 不存在（没在运行）、还没写入端点（正在启动）或内容不对。 */
export class HostUnavailableError extends WevirClientError {
  override readonly name = 'HostUnavailableError';
  readonly kind = 'host_unavailable';

  constructor(
    readonly reason: 'not_running' | 'starting' | 'invalid_runtime_file',
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(
      reason === 'not_running'
        ? `no Wevir Host is running (${path} does not exist)`
        : reason === 'starting'
          ? `the Wevir Host is still starting (${path} has no endpoint yet)`
          : `cannot read the Wevir Host runtime file ${path}`,
      options,
    );
  }
}

/**
 * 经中继的路为什么没走通（0.110.0）：升级前的 HTTP 拒绝与中继的关闭码（`RelayCloseCode`）。
 * - `offline`（404）：中继上没有这台电脑（电脑离线，或没开中继）。
 * - `rate_limited`（429）：中继对这个来源限速。
 * - `busy`（503）：中继或这台电脑的路由连接数满了。
 * - `host_unavailable`（4100）：电脑没有及时接上，或它与中继之间断了。
 * - `limit_exceeded`（4103）：超过了中继的限制。
 * - `protocol_error`（4104）：中继认为这个客户端发了不合规的消息（客户端的 bug）。
 * - `host_rejected`（4105）：电脑拒绝了这条连接（没开配对窗口、限速）。
 */
export type RemoteRelayFailure =
  | 'offline'
  | 'rate_limited'
  | 'busy'
  | 'host_unavailable'
  | 'limit_exceeded'
  | 'protocol_error'
  | 'host_rejected';

/** 中继的关闭码对应的原因；不是中继的关闭码时 undefined。 */
export function relayCloseFailure(code: number | undefined): RemoteRelayFailure | undefined {
  switch (code) {
    case RelayCloseCode.HOST_UNAVAILABLE:
      return 'host_unavailable';
    case RelayCloseCode.LIMIT_EXCEEDED:
      return 'limit_exceeded';
    case RelayCloseCode.PROTOCOL_ERROR:
      return 'protocol_error';
    case RelayCloseCode.HOST_REJECTED:
      return 'host_rejected';
    default:
      return undefined;
  }
}

/**
 * 远程连接（0.109.0）：哪条路都没连上那台电脑（地址不通、电脑不在线、远程访问没开）。试过中继且中继说明了原因时 `relay` 是那个
 * 原因（0.110.0）。
 */
export class RemoteUnreachableError extends WevirClientError {
  override readonly name = 'RemoteUnreachableError';
  readonly kind = 'remote_unreachable';

  constructor(
    /** 试过的路（`RemoteRoute.key`）。 */
    readonly tried: readonly string[],
    readonly relay?: RemoteRelayFailure,
  ) {
    super(
      (tried.length === 0
        ? 'no address is known for the remote Wevir Host'
        : `could not reach the remote Wevir Host at ${tried.join(', ')}`) +
        (relay === undefined ? '' : ` (relay: ${relay})`),
    );
  }
}

/**
 * 远程连接（0.109.0）：连上了，但 Noise 握手没完成。`rejected` 是对方收下第一条消息就断开（这台设备已被移除、那边换了 Host
 * 身份，或配对窗口已经结束）；`wrong_secret` 是配对时对方的回答解不开（短码或配对链接不对、已经用过）；`host_mismatch` 是对方
 * 出示的 Host 公钥与记下的不一致，或回的不是 Wevir 的握手；`timeout` 是对方不答话。
 */
export class RemoteHandshakeError extends WevirClientError {
  override readonly name = 'RemoteHandshakeError';
  readonly kind = 'remote_handshake';

  constructor(
    readonly reason: 'rejected' | 'wrong_secret' | 'host_mismatch' | 'timeout',
    /** 出事的那条路（`RemoteRoute.key`）。 */
    readonly route: string,
  ) {
    super(`the remote Wevir Host at ${route} did not complete the handshake (${reason})`);
  }
}
