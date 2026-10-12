/**
 * 适配器方法失败时抛出的错误码。Host 据此映射成 Host API 的错误（host-api.md §7），`message` 只给人看。
 */
export type AdapterErrorCode =
  /** 适配器已 `dispose`。 */
  | 'disposed'
  /** 适配器或引擎不认识这个引擎会话 ID。 */
  | 'session_not_found'
  /** 会话不挂在引擎上：已 `close`，或引擎进程退出后尚未 `resumeSession`。 */
  | 'session_closed'
  /** 引擎拒绝恢复会话，如 cwd 与创建时不一致（ACP `-32602 session cwd does not match`）。 */
  | 'session_unavailable'
  /** 会话有回合在进行，不排队、不打断。 */
  | 'session_busy'
  /** 该会话没有这个 `requestId` 的未决审批：不存在、已决定或已结束。 */
  | 'approval_not_found'
  /** `optionId` 不在该审批请求的选项里；审批保持未决。 */
  | 'invalid_option'
  /** 参数不合法，如 `content` 为空、`cwd` 为空。 */
  | 'invalid_input'
  /** 已请求取消，但在时限内无法确认回合已停止。 */
  | 'cancel_unconfirmed'
  /** 引擎进程启动失败或调用途中不可用。 */
  | 'engine_unavailable';

export class AdapterError extends Error {
  override readonly name = 'AdapterError';
  readonly code: AdapterErrorCode;

  constructor(code: AdapterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/** 按 `name` 与 `code` 判断，不用 instanceof：调用方可能拿到另一份打包出来的 AdapterError 类。 */
export function isAdapterError(error: unknown, code?: AdapterErrorCode): error is AdapterError {
  return (
    error instanceof Error &&
    error.name === 'AdapterError' &&
    (code === undefined || (error as AdapterError).code === code)
  );
}
