import {
  type ErrorCodeName,
  type ErrorData,
  ErrorDataSchemas,
  errorCodeName,
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
  | 'host_unavailable';

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
  ) {
    super(
      `connection to the Wevir Host was lost${method ? ` before ${method} completed` : ''}` +
        `${closeCode === undefined ? '' : ` (close code ${closeCode}${closeReason ? `: ${closeReason}` : ''})`}`,
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
