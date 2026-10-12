import type { ErrorCodeName, ErrorData, ErrorDataSchemas } from '@wevir/protocol';

type CodeWithData = keyof typeof ErrorDataSchemas;

/** 错误码对应的 `data`：取自 protocol 的 `ErrorDataSchemas`，没列出的错误码不带 `data`。 */
export type HostErrorData<C extends ErrorCodeName> = C extends CodeWithData
  ? ErrorData<C>
  : undefined;

/**
 * Host 业务方法的失败：`code` 是 host-api.md §7 的错误码名，`data` 照 `ErrorDataSchemas`。RPC 层
 * （T2.4）把它原样映射成 JSON-RPC 错误；其他异常一律当作 `INTERNAL_ERROR`。
 */
export class HostError<C extends ErrorCodeName = ErrorCodeName> extends Error {
  override readonly name = 'HostError';
  readonly code: C;
  readonly data: HostErrorData<C>;

  constructor(
    code: C,
    message: string,
    ...data: C extends CodeWithData ? [data: ErrorData<C>] : []
  ) {
    super(message);
    this.code = code;
    this.data = data[0] as HostErrorData<C>;
  }
}

export function isHostError<C extends ErrorCodeName>(
  error: unknown,
  code?: C,
): error is HostError<C> {
  return error instanceof HostError && (code === undefined || error.code === code);
}
